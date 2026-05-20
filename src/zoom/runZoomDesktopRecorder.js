import { parseArgs, requireArg } from '../utils/args.js';
import { ensureDirs } from '../utils/files.js';
import { runZoomDesktopRecorder } from './zoomDesktopRecorder.js';

const args = parseArgs();
const joinUrl = requireArg(args, 'url');
const title = args.title ? String(args.title) : 'zoom-desktop';
const note = args.note ? String(args.note) : '';
const joinDelaySeconds = args['join-delay']
  ? Number(args['join-delay'])
  : Number(args.joinDelay ?? 20);
const durationSeconds = args.duration ? Number(args.duration) : 0;
const openClient = args.open !== 'false';
const autoTranscribe = args.transcribe !== 'false';

await ensureDirs();
const result = await runZoomDesktopRecorder({
  joinUrl,
  title,
  note,
  joinDelaySeconds,
  durationSeconds,
  openClient,
  autoTranscribe
});

console.log(JSON.stringify(result, null, 2));
