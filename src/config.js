import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const telegramAllowedChatIds = (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? process.env.TELEGRAM_CHAT_ID ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
const telegramChatId = (process.env.TELEGRAM_CHAT_ID ?? telegramAllowedChatIds[0] ?? '').trim();

function parseList(value) {
  return String(value ?? '')
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

// Resolve a path env var against the repo root if it's relative.
// Absolute paths are returned as-is. This keeps "login saves here, bot loads
// from there" symmetric regardless of which working directory invoked Node.
function resolveRepoPath(value, fallback) {
  const raw = String(value ?? '').trim() || fallback;
  return path.isAbsolute(raw) ? raw : path.resolve(rootDir, raw);
}

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

  // Bot identity
  zoomBotName: process.env.ZOOM_BOT_NAME ?? '',
  zoomBotNamePool: parseList(process.env.ZOOM_BOT_NAME_POOL),
  zoomRandomizeName: (process.env.ZOOM_RANDOMIZE_NAME ?? 'true').toLowerCase() === 'true',

  // Audio recording / playback
  zoomSilentMicSeconds: Number(process.env.ZOOM_SILENT_MIC_SECONDS ?? 8 * 60 * 60),
  zoomUseFakeMicFile: (process.env.ZOOM_USE_FAKE_MIC_FILE ?? 'false').toLowerCase() === 'true',
  zoomSilenceNoiseDb: Number(process.env.ZOOM_SILENCE_NOISE_DB ?? -30),
  zoomRecordGainDb: Number(process.env.ZOOM_RECORD_GAIN_DB ?? 24),
  zoomHeadless: (process.env.ZOOM_HEADLESS ?? 'false').toLowerCase() === 'true',

  // Stealth / browser
  zoomUseStealth: (process.env.ZOOM_USE_STEALTH ?? 'true').toLowerCase() === 'true',
  zoomChannel: process.env.ZOOM_CHROME_CHANNEL ?? '',
  zoomStorageStatePath: resolveRepoPath(
    process.env.ZOOM_STORAGE_STATE_PATH,
    './state/zoom-storage-state.json'
  ),
  zoomUserAgent: process.env.ZOOM_USER_AGENT ?? '',
  zoomLocale: process.env.ZOOM_LOCALE ?? 'ko-KR',
  zoomTimezoneId: process.env.ZOOM_TIMEZONE_ID ?? 'Asia/Seoul',
  zoomViewport: process.env.ZOOM_VIEWPORT ?? '1280x720',

  // Behavior jitter
  zoomClickJitterMin: Number(process.env.ZOOM_CLICK_JITTER_MIN_MS ?? 120),
  zoomClickJitterMax: Number(process.env.ZOOM_CLICK_JITTER_MAX_MS ?? 480),

  // Virtual devices (Linux)
  zoomVirtualCamera: process.env.ZOOM_VIRTUAL_CAMERA ?? '',

  // Residential proxy (HTTP/HTTPS/SOCKS5)
  zoomProxyServer: process.env.ZOOM_PROXY_SERVER ?? '',
  zoomProxyUsername: process.env.ZOOM_PROXY_USERNAME ?? '',
  zoomProxyPassword: process.env.ZOOM_PROXY_PASSWORD ?? '',
  zoomProxyBypass: process.env.ZOOM_PROXY_BYPASS ?? '',

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID ?? '',
    authToken: process.env.TWILIO_AUTH_TOKEN ?? '',
    fromNumber: process.env.TWILIO_FROM_NUMBER ?? ''
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    chatId: telegramChatId,
    allowedChatIds: telegramAllowedChatIds
  }
};
