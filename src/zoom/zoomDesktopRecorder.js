import { spawn } from 'node:child_process';
import os from 'node:os';
import { config } from '../config.js';
import { recordingPath } from '../utils/files.js';
import { processRecording } from '../pipeline/openaiPipeline.js';
import { startFfmpegRecorder } from './ffmpegRecorder.js';

function sanitizeZoomUrl(joinUrl) {
  const text = String(joinUrl ?? '').trim();
  const match = text.match(/https?:\/\/[^\s<>"'`,}\]]+/i);
  const value = (match ? match[0] : text).replace(/[)>.,]+$/g, '');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Zoom URL must be http or https');
  }
  return url.toString();
}

function openUrlInDesktopClient(joinUrl) {
  const platform = os.platform();
  const url = sanitizeZoomUrl(joinUrl);
  const command = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  return url;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runZoomDesktopRecorder({
  joinUrl,
  title = 'zoom-desktop',
  note = '',
  joinDelaySeconds = 20,
  durationSeconds = 0,
  silenceTimeout = config.zoomSilenceTimeoutSeconds,
  openClient = true,
  autoTranscribe = true
}) {
  const outputFile = recordingPath(title, 'wav');
  const openedUrl = openClient ? openUrlInDesktopClient(joinUrl) : sanitizeZoomUrl(joinUrl);
  const waitSeconds = Math.max(0, Math.trunc(Number(joinDelaySeconds) || 0));

  console.log(`Zoom desktop URL: ${openedUrl}`);
  if (openClient) {
    console.log(`Waiting ${waitSeconds}s for the signed-in Zoom desktop client to join before recording.`);
    await sleep(waitSeconds * 1000);
  }

  let stopped = false;
  let durationTimer = null;
  let resolveFinished;
  const finished = new Promise((resolve) => {
    resolveFinished = resolve;
  });

  async function stop(reason = 'manual') {
    if (stopped) return null;
    stopped = true;
    if (durationTimer) clearTimeout(durationTimer);
    await recorder.stop(reason);
    if (!autoTranscribe) {
      const result = { recordingPath: outputFile, stopReason: reason };
      resolveFinished(result);
      return result;
    }
    const processed = await processRecording(outputFile, { title, note });
    const result = { recordingPath: outputFile, stopReason: reason, ...processed };
    resolveFinished(result);
    return result;
  }

  const recorder = startFfmpegRecorder(outputFile, {
    silenceTimeout,
    onSilence: () => {
      stop('silence-timeout').catch((error) => {
        console.error('Zoom desktop silence-timeout stop failed:', error);
      });
    }
  });
  console.log(`Zoom desktop recording started: ${outputFile}`);

  const seconds = Math.max(0, Math.trunc(Number(durationSeconds) || 0));
  if (seconds > 0) {
    durationTimer = setTimeout(() => {
      stop('duration-elapsed').catch((error) => {
        console.error('Zoom desktop duration stop failed:', error);
      });
    }, seconds * 1000);
  }

  process.once('SIGINT', async () => {
    await stop('manual');
  });
  return finished;
}
