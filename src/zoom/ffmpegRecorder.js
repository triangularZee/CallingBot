import { spawn } from 'node:child_process';
import os from 'node:os';
import { config } from '../config.js';

export function startFfmpegRecorder(outputFile, {
  silenceTimeout = 0,
  silenceNoiseDb = config.zoomSilenceNoiseDb,
  onSilence = null
} = {}) {
  if (!config.audioInputDevice) {
    throw new Error('AUDIO_INPUT_DEVICE is required for Zoom recording');
  }

  const platform = os.platform();
  const args = ['-y'];

  if (platform === 'win32') {
    args.push('-f', 'dshow', '-i', config.audioInputDevice);
  } else if (platform === 'darwin') {
    args.push('-f', 'avfoundation', '-i', config.audioInputDevice);
  } else {
    args.push('-f', 'pulse', '-i', config.audioInputDevice);
  }

  const silenceSeconds = Math.trunc(Number(silenceTimeout));
  if (silenceSeconds > 0) {
    args.push('-af', `silencedetect=noise=${Number(silenceNoiseDb)}dB:d=${silenceSeconds}`);
  }

  args.push('-ac', '1', '-ar', '16000', outputFile);

  const child = spawn(config.ffmpegPath, args, {
    stdio: ['pipe', 'inherit', 'pipe']
  });

  let silenceTriggered = false;
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    process.stderr.write(text);
    if (!silenceTriggered && /silence_start:/i.test(text)) {
      silenceTriggered = true;
      onSilence?.();
    }
  });

  return {
    process: child,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once('exit', resolve);
        child.stdin.write('q');
        child.stdin.end();
      })
  };
}
