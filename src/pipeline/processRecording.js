import { parseArgs, requireArg } from '../utils/args.js';
import { ensureDirs } from '../utils/files.js';
import { processRecording } from './openaiPipeline.js';

const args = parseArgs();
const file = requireArg(args, 'file');
const title = args.title ? String(args.title) : 'meeting';

await ensureDirs();
const result = await processRecording(file, { title });

console.log(JSON.stringify(result, null, 2));
