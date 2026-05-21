import { openAsBlob } from 'node:fs';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { outputPath, safeSlug, timestamp } from '../utils/files.js';
import {
  preprocessAudioForTranscription,
  runAudioCommand,
  transcriptionAudioFilter
} from './audioPreprocess.js';
import { summarizeWithGemini } from './geminiSummary.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ensureOpenAIKey() {
  if (!config.openaiApiKey) {
    throw new Error('OPENAI_API_KEY is required');
  }
}

async function withRetry(operation, { attempts = 3, baseDelayMs = 2000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      const status = error.status ?? error.response?.status;
      if (error.code === 'insufficient_quota') break;
      const retryable = !status || status === 408 || status === 409 || status === 429 || status >= 500;
      if (!retryable || attempt === attempts) break;
      await sleep(baseDelayMs * attempt);
    }
  }
  throw lastError;
}

async function callOpenAIResponses({ model, input, temperature = 0.2, timeoutMs = 300_000 }) {
  ensureOpenAIKey();
  return withRetry(async () => {
    const apiResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model, input, temperature }),
      signal: AbortSignal.timeout(timeoutMs)
    });

    const text = await apiResponse.text();
    if (!apiResponse.ok) {
      const error = new Error(`OpenAI response failed: ${apiResponse.status} ${text}`);
      error.status = apiResponse.status;
      try {
        error.code = JSON.parse(text).error?.code;
      } catch {
        // Ignore non-JSON error bodies.
      }
      throw error;
    }
    return JSON.parse(text);
  });
}

function extractResponseText(response) {
  if (response.output_text) return response.output_text;
  return (response.output ?? [])
    .flatMap((item) => item.content ?? [])
    .map((content) => content.text ?? '')
    .join('');
}

function ffprobePath() {
  const ffmpegPath = config.ffmpegPath || 'ffmpeg';
  const parsed = path.parse(ffmpegPath);
  if (parsed.name.toLowerCase() === 'ffmpeg') {
    return path.join(parsed.dir, `${parsed.name.replace(/ffmpeg/i, 'ffprobe')}${parsed.ext}`);
  }
  return 'ffprobe';
}

async function audioDurationSeconds(filePath) {
  let stdout = '';
  await new Promise((resolve, reject) => {
    const child = spawn(ffprobePath(), [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffprobe exited with ${code}: ${stderr}`));
    });
  });

  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Could not determine audio duration for ${filePath}`);
  }
  return duration;
}

function formatTimestamp(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const hh = String(Math.floor(value / 3600)).padStart(2, '0');
  const mm = String(Math.floor((value % 3600) / 60)).padStart(2, '0');
  const ss = String(value % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

async function createTranscriptionChunks(filePath, {
  title,
  duration,
  chunkSeconds = config.transcriptionChunkSeconds,
  overlapSeconds = config.transcriptionChunkOverlapSeconds
}) {
  const safeChunkSeconds = Math.max(60, Math.min(1200, Math.trunc(Number(chunkSeconds) || 600)));
  const safeOverlapSeconds = Math.max(0, Math.min(30, Math.trunc(Number(overlapSeconds) || 0)));
  const chunkDir = path.join(config.outputDir, `${timestamp()}-${safeSlug(title)}-chunks`);
  await fsp.mkdir(chunkDir, { recursive: true });

  const chunks = [];
  for (let baseStart = 0, index = 0; baseStart < duration; baseStart += safeChunkSeconds, index += 1) {
    const hasPrevious = index > 0;
    const hasNext = baseStart + safeChunkSeconds < duration;
    const start = Math.max(0, baseStart - (hasPrevious ? safeOverlapSeconds : 0));
    const end = Math.min(duration, baseStart + safeChunkSeconds + (hasNext ? safeOverlapSeconds : 0));
    const chunkPath = path.join(chunkDir, `chunk_${String(index + 1).padStart(3, '0')}.wav`);

    await runAudioCommand(config.ffmpegPath || 'ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(start),
      '-t',
      String(end - start),
      '-i',
      filePath,
      '-af',
      transcriptionAudioFilter,
      '-ar',
      '16000',
      '-ac',
      '1',
      chunkPath
    ]);

    chunks.push({
      index: index + 1,
      start,
      end,
      path: chunkPath
    });
  }

  return chunks;
}

async function callTranscription(filePath, { title, language, transcriptionModel, preprocessAudio }) {
  ensureOpenAIKey();
  const inputPath = preprocessAudio
    ? await preprocessAudioForTranscription(filePath, { title })
    : filePath;

  return withRetry(async () => {
    const form = new FormData();
    const audio = await openAsBlob(inputPath);
    form.append('file', audio, inputPath.split(/[\\/]/).pop() ?? 'recording.wav');
    form.append('model', transcriptionModel);
    form.append('language', language);

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`
      },
      body: form,
      signal: AbortSignal.timeout(180_000)
    });

    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`OpenAI transcription failed: ${response.status} ${text}`);
      error.status = response.status;
      try {
        error.code = JSON.parse(text).error?.code;
      } catch {
        // Ignore non-JSON error bodies.
      }
      throw error;
    }
    return JSON.parse(text);
  });
}

async function transcribeRecordingSingle(filePath, {
  title = 'meeting',
  language = 'ko',
  transcriptionModel = 'gpt-4o-transcribe',
  preprocessAudio = true
} = {}) {
  const transcript = await callTranscription(filePath, { title, language, transcriptionModel, preprocessAudio });
  const transcriptPath = outputPath(title, `${transcriptionModel}.transcript.json`);
  const transcriptTextPath = outputPath(title, `${transcriptionModel}.transcript.txt`);
  const transcriptText = transcript.text ?? JSON.stringify(transcript);
  await fsp.writeFile(transcriptPath, JSON.stringify(transcript, null, 2), 'utf8');
  await fsp.writeFile(transcriptTextPath, transcriptText, 'utf8');

  return {
    transcript,
    transcriptPath,
    transcriptTextPath,
    transcriptText,
    model: transcriptionModel
  };
}

async function transcribeRecordingChunked(filePath, {
  title = 'meeting',
  language = 'ko',
  transcriptionModel = 'gpt-4o-transcribe',
  duration
} = {}) {
  const chunks = await createTranscriptionChunks(filePath, { title, duration });
  const transcriptChunks = [];

  console.log(
    `Transcribing ${formatTimestamp(duration)} audio in ${chunks.length} chunks with ${transcriptionModel}`
  );

  for (const chunk of chunks) {
    const chunkTitle = `${title}.${transcriptionModel}.chunk-${String(chunk.index).padStart(3, '0')}`;
    console.log(
      `Transcribing chunk ${chunk.index}/${chunks.length}: ${formatTimestamp(chunk.start)}-${formatTimestamp(chunk.end)}`
    );
    const result = await transcribeRecordingSingle(chunk.path, {
      title: chunkTitle,
      language,
      transcriptionModel,
      preprocessAudio: false
    });
    transcriptChunks.push({
      ...chunk,
      transcriptPath: result.transcriptPath,
      transcriptTextPath: result.transcriptTextPath,
      text: result.transcriptText
    });
  }

  const transcriptText = transcriptChunks
    .map((chunk) => [
      `[Chunk ${chunk.index} | ${formatTimestamp(chunk.start)}-${formatTimestamp(chunk.end)}]`,
      chunk.text
    ].join('\n'))
    .join('\n\n')
    .trim();

  const transcriptPath = outputPath(title, `${transcriptionModel}.chunked-transcript.json`);
  const transcriptTextPath = outputPath(title, `${transcriptionModel}.chunked-transcript.txt`);
  await fsp.writeFile(
    transcriptPath,
    JSON.stringify({
      text: transcriptText,
      model: transcriptionModel,
      duration,
      chunkSeconds: config.transcriptionChunkSeconds,
      overlapSeconds: config.transcriptionChunkOverlapSeconds,
      chunks: transcriptChunks.map((chunk) => ({
        index: chunk.index,
        start: chunk.start,
        end: chunk.end,
        path: chunk.path,
        transcriptPath: chunk.transcriptPath,
        transcriptTextPath: chunk.transcriptTextPath
      }))
    }, null, 2),
    'utf8'
  );
  await fsp.writeFile(transcriptTextPath, transcriptText, 'utf8');

  return {
    transcript: { text: transcriptText },
    transcriptPath,
    transcriptTextPath,
    transcriptText,
    model: transcriptionModel,
    chunks: transcriptChunks
  };
}

export async function transcribeRecording(filePath, {
  title = 'meeting',
  language = 'ko',
  transcriptionModel = 'gpt-4o-transcribe',
  preprocessAudio = true
} = {}) {
  const duration = await audioDurationSeconds(filePath);
  const maxSeconds = Math.max(60, Number(config.transcriptionSingleMaxSeconds) || 1300);
  if (duration > maxSeconds) {
    return transcribeRecordingChunked(filePath, { title, language, transcriptionModel, duration });
  }
  return transcribeRecordingSingle(filePath, { title, language, transcriptionModel, preprocessAudio });
}

function mergeInstructions() {
  return [
    '너는 전화 녹음 STT 결과를 병합하는 전문 편집자다.',
    '두 개의 STT 결과를 비교해서 정보량이 가장 많은 통합 녹취록을 작성하라.',
    '반복된 짧은 발화, 감탄사, 테스트 문구도 생략하지 않는다.',
    '한 결과 중 하나에만 있는 발화도 보존한다.',
    '다만 한 STT 결과가 다른 결과의 부분집합이면 같은 발화를 중복해서 붙이지 않는다.',
    '한 모델에만 등장하고 앞뒤 문맥이 전혀 없는 고립된 끝단 단어는 낮은 신뢰도로 보고 반드시 제외한다.',
    '예를 들어 완결된 문장 뒤에 한 모델만 "예약" 같은 짧은 단어를 덧붙이면 통합 녹취록에 포함하지 않는다.',
    '명백한 오인식이거나 상식적으로 보이는 환청 단어는 문맥상 확실할 때만 제거한다.',
    '원문에 없는 내용을 새로 만들지 않는다.',
    '출력은 통합 녹취 텍스트만 제공한다.'
  ].join('\n');
}

export async function mergeTranscripts({ title, primaryText, fallbackText }) {
  const response = await callOpenAIResponses({
    model: config.openaiSummaryModel,
    input: [
      { role: 'system', content: mergeInstructions() },
      {
        role: 'user',
        content: [
          `통화 제목: ${title}`,
          '',
          '[STT A: gpt-4o-transcribe]',
          primaryText || '(비어 있음)',
          '',
          '[STT B: whisper-1]',
          fallbackText || '(비어 있음)',
          '',
          '두 결과를 비교해서 정보량이 가장 많은 통합 녹취록을 작성하라.'
        ].join('\n')
      }
    ],
    temperature: 0
  });
  return extractResponseText(response).trim();
}

export async function transcribeRecordingEnsemble(filePath, {
  title = 'meeting',
  language = 'ko',
  preprocessAudio = true
} = {}) {
  const primary = await transcribeRecording(filePath, {
    title: `${title}.gpt4o`,
    language,
    transcriptionModel: 'gpt-4o-transcribe',
    preprocessAudio
  });
  const fallback = await transcribeRecording(filePath, {
    title: `${title}.whisper`,
    language,
    transcriptionModel: 'whisper-1',
    preprocessAudio
  });

  const mergedText = await mergeTranscripts({
    title,
    primaryText: primary.transcriptText,
    fallbackText: fallback.transcriptText
  });
  const transcriptPath = outputPath(title, 'merged-transcript.json');
  const transcriptTextPath = outputPath(title, 'merged-transcript.txt');
  await fsp.writeFile(
    transcriptPath,
    JSON.stringify({
      text: mergedText,
      sources: {
        gpt4o: primary.transcriptText,
        whisper: fallback.transcriptText
      },
      paths: {
        gpt4o: primary.transcriptTextPath,
        whisper: fallback.transcriptTextPath
      }
    }, null, 2),
    'utf8'
  );
  await fsp.writeFile(transcriptTextPath, mergedText, 'utf8');

  return {
    transcript: { text: mergedText },
    transcriptPath,
    transcriptTextPath,
    transcriptText: mergedText,
    sourceTranscripts: { primary, fallback }
  };
}

function summaryInstructions() {
  return [
    '너는 한국어 금융/기업 실적 컨퍼런스콜 전문 애널리스트다.',
    '아래 녹취록을 천천히 검토한 뒤 사용자가 지정한 형식에 맞춰 한국어 요약을 작성하라.',
    '출력은 Markdown 텍스트만 제공한다.',
    '',
    '중요 규칙:',
    '- 녹취록에 있는 모든 Q&A를 빠짐없이 포함한다.',
    '- "Qn)" 줄과 "An)" 줄 사이에는 반드시 줄바꿈을 둔다.',
    '- Q&A를 합치거나 생략하지 않는다.',
    '- 숫자, 회사명, 제품명, 기간, 가이던스는 가능한 한 원문에 충실하게 유지한다.',
    '- 정보가 불명확하면 "확인 필요"라고 적고 추정하지 않는다.',
    '- 사용자 메모가 있으면 요약의 초점과 해석에 반영하되, 녹취록과 충돌하는 내용을 사실처럼 쓰지 않는다.'
  ].join('\n');
}

function summaryUserPrompt({ title, note, transcriptText }) {
  return [
    '반드시 아래 구조를 따른다.',
    '',
    'YYMMDD_회사명 [핵심 태그]',
    '',
    '(1) 핵심 요약',
    '',
    '(2) 핵심 요약',
    '',
    '(3) Guidance 또는 전망',
    '■ 세부 항목',
    '■ 세부 항목',
    '',
    '필요한 만큼 번호를 이어간다.',
    '',
    '-',
    '',
    '[Q&A]',
    '',
    'Q1) 질문자 기관: 질문',
    '',
    'A1) 답변',
    '',
    'Q2) 질문자 기관: 질문',
    '',
    'A2) 답변',
    '',
    '모든 Q&A가 끝날 때까지 반복한다.',
    '',
    '-',
    '',
    '[Implication]',
    '',
    '(1) 투자/산업적 함의 제목',
    '',
    '■ 세부 해석',
    '■ 세부 해석',
    '',
    '(2) 투자/산업적 함의 제목',
    '',
    '■ 세부 해석',
    '■ 세부 해석',
    '',
    `통화 제목: ${title}`,
    '',
    '사용자 메모:',
    note || '(없음)',
    '',
    '녹취록:',
    transcriptText
  ].join('\n');
}

function exampleStyleSummaryInstructions() {
  return [
    '너는 한국어 금융/기업 실적 컨퍼런스콜 전문 애널리스트다.',
    '아래 녹취록을 천천히 검토한 뒤 사용자가 제공한 [Example]과 같은 애널리스트 노트 형식으로 한국어 요약을 작성하라.',
    '출력은 Telegram으로 바로 전송될 plain Markdown 텍스트만 제공한다. 코드블록, ```markdown, ``` 감싸기를 절대 쓰지 않는다.',
    '',
    '중요 규칙:',
    '- 첫 줄은 반드시 "YYMMDD_회사명 [핵심태그]" 형식으로 쓴다. 입력 title에 날짜/회사명이 있으면 그대로 활용한다.',
    '- 대괄호 안 핵심태그는 3~6개로 압축한다. 실적 발표라면 Beat/Miss, 시가총액, 밸류에이션 등을 녹취록에 있을 때만 넣고, 없으면 사업/제품 키워드를 넣는다.',
    '- 본문 앞부분은 (1), (2), (3)처럼 번호 항목으로 작성한다. 절대 "(1) 핵심 요약"처럼 같은 제목을 반복하지 않는다.',
    '- 각 번호 항목은 예시처럼 바로 핵심 문장을 쓴다. 문단은 짧고 밀도 있게 작성한다.',
    '- Guidance, 전망, 생산능력, CAPEX, 실적 가이던스가 있으면 별도 번호 항목으로 "Guidance 또는 전망"을 만들고, 하위 항목은 ■ 로 정리한다.',
    '- Q&A는 녹취록에 있는 모든 질문과 답변을 빠짐없이 포함한다. Q&A를 합치거나 생략하지 않는다.',
    '- Q&A 형식은 정확히 "Q1) 기관/질문자: 질문" 다음 줄에 "A1) 답변"으로 쓴다. Q와 A 사이에 빈 줄을 넣지 않는다.',
    '- 질문 기관/이름이 명확하지 않으면 "질문자"라고만 쓰고, "질문자 기관" 같은 어색한 표현은 쓰지 않는다.',
    '- 숫자, 회사명, 제품명, 기간, 가이던스는 가능한 한 원문에 충실하게 유지한다.',
    '- 정보가 불명확하면 "확인 필요"라고 적고 추정하지 않는다.',
    '- Implication은 예시처럼 짧고 날카롭게 작성한다. 각 항목은 보통 1~2문장으로 끝내고, 불필요한 ■ 하위 bullet을 남발하지 않는다.',
    '- 사용자 메모가 있으면 요약의 초점과 해석에 반영하되, 녹취록과 충돌하는 내용을 사실처럼 쓰지 않는다.'
  ].join('\n');
}

function exampleStyleSummaryUserPrompt({ title, note, transcriptText }) {
  return [
    '반드시 아래 [Example]의 톤, 구조, 압축도를 따른다.',
    '',
    '[Example]',
    '',
    '260521_FY1Q27 NVIDIA [Beat, $5.4tn, 20x]',
    '',
    '(1) 컨센서스 대비 매출액 +3%, 영업이익 +3% 상회',
    '',
    '(2) 2Q27(F) Guidance',
    '■ Revenue $89.18bn ~ $92.82bn vs. $87.36bn',
    '■ Adj. GPM 74.5% ~ 75.5% vs. 75.0%',
    '■ Adj. OPEX $8.3bn vs. $7.93bn',
    '',
    '(3) 경영진은 Blackwell/Rubin 매출이 장기적으로 $1tn에 이를 것이라는 자신감을 유지',
    '',
    '-',
    '',
    '[Q&A]',
    '',
    'Q1) Morgan Stanley: 새로운 세그먼트 차이/구분이 무엇이며, 각각 어떤 시장을 의미하는지?',
    'A1) 하이퍼스케일은 대형 클라우드 기업의 내부 AI 워크로드, 두 번째 세그먼트는 AI 네이티브/엔터프라이즈/산업/소버린 AI 시장을 의미',
    '',
    'Q2) BofA: 에이전트형 AI에서 CPU 수요는 GPU를 잠식하는지?',
    'A2) CPU 수요 증가는 GPU를 대체하는 것이 아니라 AI 에이전트 확산으로 생기는 추가 수요',
    '',
    '-',
    '',
    '[Implication]',
    '',
    '(1) NVIDIA 성장축은 하이퍼스케일러 CAPEX 중심에서 AI 인프라 전체 TAM 내 M/S 확대로 이동 중',
    '',
    '(2) Vera CPU는 GPU를 잠식하는 제품이 아니라 NVIDIA의 TAM을 넓히는 추가 성장축',
    '',
    '[Input]',
    '',
    `통화 제목: ${title}`,
    '',
    '사용자 메모:',
    note || '(없음)',
    '',
    '녹취록:',
    transcriptText
  ].join('\n');
}

export async function summarizeTranscript(transcriptText, { title = 'meeting', note = '' } = {}) {
  const response = await callOpenAIResponses({
    model: config.openaiSummaryModel,
    input: [
      { role: 'system', content: exampleStyleSummaryInstructions() },
      { role: 'user', content: exampleStyleSummaryUserPrompt({ title, note, transcriptText }) }
    ],
    temperature: 0.2
  });

  const summary = extractResponseText(response);
  const summaryPath = outputPath(title, `${config.openaiSummaryModel}-summary.md`);
  await fsp.writeFile(summaryPath, summary, 'utf8');

  return {
    summary,
    summaryPath
  };
}

export async function processRecording(filePath, options = {}) {
  const useEnsemble = options.ensembleTranscription ?? true;
  const transcription = useEnsemble
    ? await transcribeRecordingEnsemble(filePath, options)
    : await transcribeRecording(filePath, options);
  const text = transcription.transcriptText ?? transcription.transcript.text ?? JSON.stringify(transcription.transcript);
  const provider = options.summaryProvider ?? config.summaryProvider;
  const { summary, summaryPath } =
    provider === 'gemini'
      ? await summarizeWithGemini(text, options)
      : await summarizeTranscript(text, options);

  return {
    transcriptPath: transcription.transcriptPath,
    transcriptTextPath: transcription.transcriptTextPath,
    sourceTranscripts: transcription.sourceTranscripts,
    summaryPath,
    summary
  };
}
