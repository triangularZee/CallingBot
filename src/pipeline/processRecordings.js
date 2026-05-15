import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from '../utils/args.js';
import { ensureDirs, safeSlug } from '../utils/files.js';
import { config } from '../config.js';
import { processRecording } from './openaiPipeline.js';

function titleFromFile(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  return safeSlug(base.replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-/, ''));
}

async function listAudioFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(wav|mp3|m4a|mp4|mpeg|mpga|webm)$/i.test(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

const args = parseArgs();
const dir = args.dir ? path.resolve(String(args.dir)) : config.recordingsDir;
const note = args.note ? String(args.note) : '';
const language = args.language ? String(args.language) : 'ko';
const summaryProvider = args['summary-provider'] ? String(args['summary-provider']) : undefined;
const limit = args.limit && args.limit !== true ? Number(args.limit) : Infinity;

await ensureDirs();

const files = (await listAudioFiles(dir)).slice(0, limit);
const results = [];

for (const file of files) {
  const title = args.title && args.title !== true ? String(args.title) : titleFromFile(file);
  console.error(`Processing ${file} as "${title}"`);
  try {
    const result = await processRecording(file, { title, note, language, summaryProvider });
    results.push({ file, title, ok: true, ...result });
    console.error(`Done ${file}`);
  } catch (error) {
    results.push({ file, title, ok: false, error: error.message });
    console.error(`Failed ${file}: ${error.message}`);
  }
}

console.log(JSON.stringify(results, null, 2));
