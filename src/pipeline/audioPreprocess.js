import { spawn } from 'node:child_process';
import path from 'node:path';
import { config } from '../config.js';
import { outputPath } from '../utils/files.js';

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}: ${stderr}`));
    });
  });
}

export async function preprocessAudioForTranscription(filePath, { title = 'meeting' } = {}) {
  const ffmpegPath = config.ffmpegPath || 'ffmpeg';
  const enhancedPath = outputPath(title, 'enhanced.wav');
  await run(ffmpegPath, [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    filePath,
    '-af',
    'highpass=f=180,lowpass=f=3600,afftdn=nf=-25,loudnorm=I=-16:TP=-1.5:LRA=11,volume=8dB',
    '-ar',
    '16000',
    '-ac',
    '1',
    enhancedPath
  ]);
  return path.resolve(enhancedPath);
}
