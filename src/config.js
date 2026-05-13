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
  recordingsDir: path.resolve(rootDir, process.env.RECORDINGS_DIR ?? './recordings'),
  outputDir: path.resolve(rootDir, process.env.OUTPUT_DIR ?? './outputs'),
  ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg',
  audioInputDevice: process.env.AUDIO_INPUT_DEVICE ?? '',
  zoomBotName: process.env.ZOOM_BOT_NAME ?? 'AI Notes Bot',
  zoomHeadless: (process.env.ZOOM_HEADLESS ?? 'false').toLowerCase() === 'true',
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID ?? '',
    authToken: process.env.TWILIO_AUTH_TOKEN ?? '',
    fromNumber: process.env.TWILIO_FROM_NUMBER ?? ''
  }
};
