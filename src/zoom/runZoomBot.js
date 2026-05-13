import { parseArgs, requireArg } from '../utils/args.js';
import { ensureDirs } from '../utils/files.js';
import { runZoomBot } from './zoomBot.js';

const args = parseArgs();
const joinUrl = requireArg(args, 'url');
const title = args.title ? String(args.title) : 'zoom-meeting';

await ensureDirs();
const result = await runZoomBot({ joinUrl, title });
console.log(JSON.stringify(result, null, 2));
