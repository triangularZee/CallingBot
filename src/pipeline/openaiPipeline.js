import fs from 'node:fs';
import fsp from 'node:fs/promises';
import OpenAI from 'openai';
import { config } from '../config.js';
import { outputPath } from '../utils/files.js';
import { summarizeWithGemini } from './geminiSummary.js';

function client() {
  if (!config.openaiApiKey) {
    throw new Error('OPENAI_API_KEY is required');
  }
  return new OpenAI({ apiKey: config.openaiApiKey });
}

export async function transcribeRecording(filePath, { title = 'meeting', language = 'ko' } = {}) {
  const openai = client();
  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: 'gpt-4o-transcribe',
    language
  });

  const transcriptPath = outputPath(title, 'transcript.json');
  await fsp.writeFile(transcriptPath, JSON.stringify(transcription, null, 2), 'utf8');

  return {
    transcript: transcription,
    transcriptPath
  };
}

export async function summarizeTranscript(transcriptText, { title = 'meeting' } = {}) {
  const openai = client();
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: [
          'You summarize meeting transcripts into concise Korean notes.',
          'Return Markdown only.',
          'Include sections: 핵심 요약, 결정사항, 액션 아이템, 리스크/질문, 후속 메모.',
          'If information is missing, say 확인 필요 instead of inventing details.'
        ].join(' ')
      },
      {
        role: 'user',
        content: `회의 제목: ${title}\n\n녹취록:\n${transcriptText}`
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
  const { transcript, transcriptPath } = await transcribeRecording(filePath, options);
  const text = transcript.text ?? JSON.stringify(transcript);
  const provider = options.summaryProvider ?? 'gemini';
  const { summary, summaryPath } =
    provider === 'openai'
      ? await summarizeTranscript(text, options)
      : await summarizeWithGemini(text, options);

  return {
    transcriptPath,
    summaryPath,
    summary
  };
}
