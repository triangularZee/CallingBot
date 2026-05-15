import { chromium } from 'playwright';
import { config } from '../config.js';
import { recordingPath } from '../utils/files.js';
import { processRecording } from '../pipeline/openaiPipeline.js';
import { startFfmpegRecorder } from './ffmpegRecorder.js';

async function clickIfVisible(page, selector, timeout = 2500) {
  try {
    const locator = page.locator(selector).first();
    await locator.waitFor({ state: 'visible', timeout });
    await locator.click();
    return true;
  } catch {
    return false;
  }
}

export async function runZoomBot({
  joinUrl,
  title = 'zoom-meeting',
  note = '',
  autoTranscribe = true,
  maxMinutes = 120,
  onDone = null
}) {
  const outputFile = recordingPath(title, 'wav');
  const recorder = startFfmpegRecorder(outputFile);

  const browser = await chromium.launch({
    headless: config.zoomHeadless,
    args: ['--use-fake-ui-for-media-stream']
  });

  const page = await browser.newPage();
  let stopped = false;

  async function stop() {
    if (stopped) return null;
    stopped = true;
    await recorder.stop();
    await browser.close().catch(() => {});

    if (!autoTranscribe) {
      return { recordingPath: outputFile };
    }

    const processed = await processRecording(outputFile, { title, note });
    const result = { recordingPath: outputFile, ...processed };
    if (onDone) await onDone(result);
    return result;
  }

  process.once('SIGINT', async () => {
    const result = await stop();
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  });

  const maxDurationMs = Math.max(1, Number(maxMinutes)) * 60 * 1000;
  const maxTimer = setTimeout(() => {
    stop().catch((error) => console.error('Zoom bot max duration stop failed:', error));
  }, maxDurationMs);

  await page.goto(joinUrl, { waitUntil: 'domcontentloaded' });

  await clickIfVisible(page, 'text=Join from Your Browser', 8000);
  await clickIfVisible(page, 'text=Launch Meeting', 3000);
  await clickIfVisible(page, 'text=Join from Your Browser', 5000);

  const nameField = page
    .locator('input[placeholder*="name" i], input[aria-label*="name" i], input[type="text"]')
    .first();

  try {
    await nameField.waitFor({ state: 'visible', timeout: 10000 });
    await nameField.fill(config.zoomBotName);
  } catch {
    // Some authenticated/browser joins do not ask for a name.
  }

  await clickIfVisible(page, 'button:has-text("Join")', 5000);
  await clickIfVisible(page, 'button:has-text("Join Audio by Computer")', 15000);
  await clickIfVisible(page, 'button:has-text("Join with Computer Audio")', 5000);

  console.log(`Zoom bot joined or is waiting. Recording: ${outputFile}`);
  console.log('Press Ctrl+C when the meeting ends.');

  await page.waitForEvent('close').catch(() => {});
  clearTimeout(maxTimer);
  return stop();
}
