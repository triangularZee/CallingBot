import { openAsBlob } from 'node:fs';
import fsp from 'node:fs/promises';
import { config } from '../config.js';
import { outputPath } from '../utils/files.js';
import { preprocessAudioForTranscription } from './audioPreprocess.js';
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

export async function transcribeRecording(filePath, {
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

function mergeInstructions() {
  return [
    '너는 전화 녹음 STT 결과를 병합하는 전문 편집자다.',
    '두 개의 STT 결과를 비교해서 정보량이 가장 많은 통합 녹취록을 작성하라.',
    '반복된 짧은 발화, 감탄사, 테스트 문구도 생략하지 않는다.',
    '한 결과 중 하나에만 있는 발화도 보존한다.',
    '다만 한 STT 결과가 다른 결과의 부분집합이면 같은 발화를 중복해서 붙이지 않는다.',
    '한 모델에만 등장하고 앞뒤 문맥이 전혀 없는 고립된 끝단 단어는 낮은 신뢰도로 보고 제외한다.',
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

export async function summarizeTranscript(transcriptText, { title = 'meeting', note = '' } = {}) {
  const response = await callOpenAIResponses({
    model: config.openaiSummaryModel,
    input: [
      { role: 'system', content: summaryInstructions() },
      { role: 'user', content: summaryUserPrompt({ title, note, transcriptText }) }
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
