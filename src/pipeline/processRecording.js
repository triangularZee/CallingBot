import { parseArgs, requireArg } from '../utils/args.js';
import { ensureDirs } from '../utils/files.js';
import { processRecording } from './openaiPipeline.js';

const args = parseArgs();
const file = requireArg(args, 'file');
const title = args.title ? String(args.title) : 'meeting';
const note = args.note ? String(args.note) : '';
const language = args.language ? String(args.language) : 'ko';
const summaryProvider = args['summary-provider'] ? String(args['summary-provider']) : undefined;
const preprocessAudio = args['no-preprocess'] ? false : true;

await ensureDirs();
const result = await processRecording(file, { title, note, language, summaryProvider, preprocessAudio });

console.log(JSON.stringify(result, null, 2));
