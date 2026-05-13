import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

export async function ensureDirs() {
  await fs.mkdir(config.recordingsDir, { recursive: true });
  await fs.mkdir(config.outputDir, { recursive: true });
}

export function safeSlug(value = 'meeting') {
  return String(value)
    .trim()
    .replace(/[^a-zA-Z0-9가-힣._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'meeting';
}

export function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function recordingPath(title, ext = 'wav') {
  return path.join(config.recordingsDir, `${timestamp()}-${safeSlug(title)}.${ext}`);
}

export function outputPath(title, suffix) {
  return path.join(config.outputDir, `${timestamp()}-${safeSlug(title)}.${suffix}`);
}
