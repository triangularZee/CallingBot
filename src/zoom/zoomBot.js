import { chromium } from 'playwright';
import { config } from '../config.js';
import { recordingPath } from '../utils/files.js';
import { processRecording } from '../pipeline/openaiPipeline.js';
import { startFfmpegRecorder } from './ffmpegRecorder.js';
import path from 'node:path';
import fsp from 'node:fs/promises';

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

async function clickButtonByName(page, namePattern, timeout = 2500) {
  try {
    const locator = page.getByRole('button', { name: namePattern }).first();
    await locator.waitFor({ state: 'visible', timeout });
    await locator.click();
    return true;
  } catch {
    return false;
  }
}

async function clickButtonByText(page, text, timeout = 2500) {
  try {
    const locator = page.locator(`button:has-text("${text}")`).first();
    await locator.waitFor({ state: 'visible', timeout });
    await locator.click({ force: true });
    return true;
  } catch {
    return false;
  }
}

async function clickButtonContainingText(page, text) {
  return page.evaluate((needle) => {
    const normalizedNeedle = needle.toLowerCase();
    const buttons = Array.from(document.querySelectorAll('button'));
    const button = buttons.find((item) => (item.textContent ?? '').trim().toLowerCase().includes(normalizedNeedle));
    if (!button) return false;
    button.click();
    return true;
  }, text).catch(() => false);
}

async function saveZoomDebug(page, title, label) {
  const slug = title.replace(/[^a-z0-9가-힣_-]+/gi, '-').slice(0, 80) || 'zoom';
  const fileBase = `${Date.now()}-${slug}-${label}`;
  const screenshotPath = path.join(config.outputDir, `${fileBase}.png`);
  const htmlPath = path.join(config.outputDir, `${fileBase}.html`);
  await fsp.writeFile(htmlPath, await page.content(), 'utf8').catch(() => {});
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  console.log(`Zoom debug saved: ${screenshotPath}`);
}

async function joinFromBrowser(page) {
  await clickButtonByText(page, 'Join from browser', 8000) || await clickButtonByName(page, /join from browser/i, 1000) || await clickButtonContainingText(page, 'Join from browser');
  await clickButtonByText(page, 'Launch Meeting', 3000) || await clickButtonByName(page, /launch meeting/i, 1000) || await clickButtonContainingText(page, 'Launch Meeting');
  await clickIfVisible(page, 'text=Cancel', 1500);
  await clickButtonByText(page, 'Join from browser', 5000) || await clickButtonByName(page, /join from browser/i, 1000) || await clickButtonContainingText(page, 'Join from browser');
  await page.waitForTimeout(3000);
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
  let recorder = null;

  const browser = await chromium.launch({
    headless: config.zoomHeadless,
    args: ['--use-fake-ui-for-media-stream']
  });

  const page = await browser.newPage();
  let stopped = false;

  async function stop() {
    if (stopped) return null;
    stopped = true;
    if (recorder) await recorder.stop();
    await browser.close().catch(() => {});

    if (!autoTranscribe) {
      return { recordingPath: outputFile };
    }

    if (!recorder) {
      return { recordingPath: outputFile, summary: 'Zoom bot stopped before recording started.' };
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

  await saveZoomDebug(page, title, 'loaded');
  await joinFromBrowser(page);
  await saveZoomDebug(page, title, 'browser-join');

  const nameField = page
    .locator('input[placeholder*="name" i], input[aria-label*="name" i], input[type="text"]')
    .first();

  try {
    await nameField.waitFor({ state: 'visible', timeout: 10000 });
    await nameField.fill(config.zoomBotName);
  } catch {
    // Some authenticated/browser joins do not ask for a name.
  }

  await clickButtonByName(page, /^join$/i, 5000);
  await clickButtonByName(page, /join audio by computer/i, 15000);
  await clickButtonByName(page, /join with computer audio/i, 5000);
  await clickButtonByName(page, /continue/i, 3000);
  await clickButtonByName(page, /got it/i, 3000);
  await saveZoomDebug(page, title, 'after-join');

  recorder = startFfmpegRecorder(outputFile);

  console.log(`Zoom bot joined or is waiting. Recording: ${outputFile}`);
  console.log('Press Ctrl+C when the meeting ends.');

  await page.waitForEvent('close').catch(() => {});
  clearTimeout(maxTimer);
  return stop();
}
