import { parseArgs, requireArg } from '../utils/args.js';
import { ensureDirs } from '../utils/files.js';
import { runZoomBot } from './zoomBot.js';

const args = parseArgs();
const joinUrl = requireArg(args, 'url');
const title = args.title ? String(args.title) : 'zoom-meeting';
const silenceTimeout = args['silence-timeout']
  ? Number(args['silence-timeout'])
  : Number(args.silenceTimeout ?? undefined);

await ensureDirs();
const result = await runZoomBot({
  joinUrl,
  title,
  ...(Number.isFinite(silenceTimeout) ? { silenceTimeout } : {})
});
console.log(JSON.stringify(result, null, 2));
