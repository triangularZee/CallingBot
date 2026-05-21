import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

export const config = {
  rootDir,
  port: Number(process.env.PORT ?? 3000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? '',
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  openaiSummaryModel: process.env.OPENAI_SUMMARY_MODEL ?? 'gpt-5.4',
  summaryProvider: process.env.SUMMARY_PROVIDER ?? 'openai',
  geminiApiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_API_KEY ?? '',
  geminiModel: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
  recordingsDir: path.resolve(rootDir, process.env.RECORDINGS_DIR ?? './recordings'),
  outputDir: path.resolve(rootDir, process.env.OUTPUT_DIR ?? './outputs'),
  ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg',
  transcriptionSingleMaxSeconds: Number(process.env.TRANSCRIPTION_SINGLE_MAX_SECONDS ?? 1300),
  transcriptionChunkSeconds: Number(process.env.TRANSCRIPTION_CHUNK_SECONDS ?? 600),
  transcriptionChunkOverlapSeconds: Number(process.env.TRANSCRIPTION_CHUNK_OVERLAP_SECONDS ?? 8),
  audioInputDevice: process.env.AUDIO_INPUT_DEVICE ?? '',
  zoomBotName: process.env.ZOOM_BOT_NAME ?? '신한 박시은',
  zoomSilentMicSeconds: Number(process.env.ZOOM_SILENT_MIC_SECONDS ?? 8 * 60 * 60),
  zoomUseFakeMicFile: (process.env.ZOOM_USE_FAKE_MIC_FILE ?? 'false').toLowerCase() === 'true',
  zoomSilenceNoiseDb: Number(process.env.ZOOM_SILENCE_NOISE_DB ?? -30),
  zoomRecordGainDb: Number(process.env.ZOOM_RECORD_GAIN_DB ?? 24),
  zoomHeadless: (process.env.ZOOM_HEADLESS ?? 'false').toLowerCase() === 'true',
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID ?? '',
    authToken: process.env.TWILIO_AUTH_TOKEN ?? '',
    fromNumber: process.env.TWILIO_FROM_NUMBER ?? ''
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    allowedChatIds: (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? process.env.TELEGRAM_CHAT_ID ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  }
};
