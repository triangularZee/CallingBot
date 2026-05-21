import { parseArgs, requireArg } from '../utils/args.js';
import { ensureDirs } from '../utils/files.js';
import { processRecording } from './openaiPipeline.js';
import { resolveTelegramChatId, sendRecordingResult } from '../telegram/notify.js';

const args = parseArgs();
const file = requireArg(args, 'file');
const title = args.title ? String(args.title) : 'meeting';
const note = args.note ? String(args.note) : '';
const language = args.language ? String(args.language) : 'ko';
const summaryProvider = args['summary-provider'] ? String(args['summary-provider']) : undefined;
const preprocessAudio = args['no-preprocess'] ? false : true;
const ensembleTranscription = args['single-stt'] ? false : true;
const notifyChatId = args['notify-chat-id'] && args['notify-chat-id'] !== true ? String(args['notify-chat-id']) : '';
const shouldNotify = !args['no-telegram'] && Boolean(resolveTelegramChatId(notifyChatId));

await ensureDirs();
const result = await processRecording(file, { title, note, language, summaryProvider, preprocessAudio, ensembleTranscription });
if (shouldNotify) {
  await sendRecordingResult(notifyChatId, result, { title });
}

console.log(JSON.stringify(result, null, 2));
