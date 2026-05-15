import { openAsBlob } from 'node:fs';
import fsp from 'node:fs/promises';
import OpenAI from 'openai';
import { config } from '../config.js';
import { outputPath } from '../utils/files.js';
import { summarizeWithGemini } from './geminiSummary.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function client() {
  if (!config.openaiApiKey) {
    throw new Error('OPENAI_API_KEY is required');
  }
  return new OpenAI({ apiKey: config.openaiApiKey });
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

export async function transcribeRecording(filePath, {
  title = 'meeting',
  language = 'ko',
  transcriptionModel = 'gpt-4o-transcribe'
} = {}) {
  const transcription = await withRetry(async () => {
    const form = new FormData();
    const audio = await openAsBlob(filePath);
    form.append('file', audio, filePath.split(/[\\/]/).pop() ?? 'recording.wav');
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

  const transcriptPath = outputPath(title, 'transcript.json');
  const transcriptTextPath = outputPath(title, 'transcript.txt');
  const transcriptText = transcription.text ?? JSON.stringify(transcription);
  await fsp.writeFile(transcriptPath, JSON.stringify(transcription, null, 2), 'utf8');
  await fsp.writeFile(transcriptTextPath, transcriptText, 'utf8');

  return {
    transcript: transcription,
    transcriptPath,
    transcriptTextPath
  };
}

export async function summarizeTranscript(transcriptText, { title = 'meeting', note = '' } = {}) {
  const openai = client();
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: [
          'You summarize meeting transcripts into concise Korean notes.',
          'Return Markdown only.',
          'Include the user note as context when it is provided.',
          'If information is missing, say 확인 필요 instead of inventing details.'
        ].join(' ')
      },
      {
        role: 'user',
        content: [
          `통화 제목: ${title}`,
          '',
          '사용자 메모:',
          note || '(없음)',
          '',
          '녹취록:',
          transcriptText
        ].join('\n')
      }
    ],
    temperature: 0.2
  });

  const summary = response.choices[0]?.message?.content ?? '';
  const summaryPath = outputPath(title, 'summary.md');
  await fsp.writeFile(summaryPath, summary, 'utf8');

  return {
    summary,
    summaryPath
  };
}

export async function processRecording(filePath, options = {}) {
  const { transcript, transcriptPath, transcriptTextPath } = await transcribeRecording(filePath, options);
  const text = transcript.text ?? JSON.stringify(transcript);
  const provider = options.summaryProvider ?? 'gemini';
  const { summary, summaryPath } =
    provider === 'openai'
      ? await summarizeTranscript(text, options)
      : await summarizeWithGemini(text, options);

  return {
    transcriptPath,
    transcriptTextPath,
    summaryPath,
    summary
  };
}
