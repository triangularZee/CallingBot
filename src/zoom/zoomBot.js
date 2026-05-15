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

async function clickZoomAudioJoin(page) {
  const candidates = [
    () => clickButtonByName(page, /join audio by computer/i, 1500),
    () => clickButtonByName(page, /join with computer audio/i, 1200),
    () => clickButtonByName(page, /computer audio/i, 1000),
    () => clickButtonByText(page, 'Join Audio by Computer', 1000),
    () => clickButtonByText(page, 'Join with Computer Audio', 1000),
    () => clickButtonContainingText(page, 'Join Audio by Computer'),
    () => clickButtonContainingText(page, 'Join with Computer Audio')
  ];

  for (const candidate of candidates) {
    if (await candidate()) return true;
  }

  return false;
}

function zoomNameField(page) {
  return page
    .locator('input[placeholder*="name" i], input[aria-label*="name" i], input[type="text"]')
    .first();
}

async function isNamePromptVisible(page, timeout = 1500) {
  try {
    await zoomNameField(page).waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
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

function startMeetingEndWatcher(page, onEnded) {
  const endedPatterns = [
    /meeting has been ended/i,
    /host ended this meeting/i,
    /this meeting has ended/i,
    /you have been removed/i,
    /removed from the meeting/i,
    /disconnected/i,
    /reconnect/i,
    /회의가 종료/i,
    /미팅이 종료/i,
    /연결이 끊/i
  ];

  const timer = setInterval(async () => {
    try {
      const text = await page.locator('body').innerText({ timeout: 1000 });
      if (endedPatterns.some((pattern) => pattern.test(text))) {
        onEnded();
      }
    } catch {
      onEnded();
    }
  }, 10_000);

  return () => clearInterval(timer);
}

async function joinFromBrowser(page) {
  if (await isNamePromptVisible(page, 2500)) return;

  await clickButtonByText(page, 'Join from browser', 2500)
    || await clickButtonByName(page, /join from browser/i, 800)
    || await clickButtonContainingText(page, 'Join from browser');

  if (await isNamePromptVisible(page, 1500)) return;

  await clickButtonByText(page, 'Launch Meeting', 1500)
    || await clickButtonByName(page, /launch meeting/i, 800)
    || await clickButtonContainingText(page, 'Launch Meeting');

  await clickIfVisible(page, 'text=Cancel', 800);

  await clickButtonByText(page, 'Join from browser', 2500)
    || await clickButtonByName(page, /join from browser/i, 800)
    || await clickButtonContainingText(page, 'Join from browser');

  await isNamePromptVisible(page, 3000);
}

function toZoomWebClientUrl(joinUrl) {
  const url = new URL(joinUrl);
  const match = url.pathname.match(/^\/j\/(\d+)/);
  if (match) {
    url.pathname = `/wc/join/${match[1]}`;
  }
  return url.toString();
}

export async function runZoomBot({
  joinUrl,
  botName = config.zoomBotName,
  title = 'zoom-meeting',
  note = '',
  autoTranscribe = true,
  maxMinutes = 120,
  silenceTimeout = 120,
  onDone = null
}) {
  const outputFile = recordingPath(title, 'wav');
  let recorder = null;
  let maxTimer = null;
  let stopMeetingEndWatcher = null;
  let stopReason = 'manual';

  const browser = await chromium.launch({
    headless: config.zoomHeadless,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  const context = await browser.newContext({
    permissions: ['microphone', 'camera']
  });
  const page = await context.newPage();
  let stopped = false;

  async function stop(reason = 'manual') {
    if (stopped) return null;
    stopped = true;
    stopReason = reason;
    if (maxTimer) clearTimeout(maxTimer);
    stopMeetingEndWatcher?.();
    if (recorder) await recorder.stop();
    await browser.close().catch(() => {});

    if (!autoTranscribe) {
      return { recordingPath: outputFile, stopReason };
    }

    if (!recorder) {
      return { recordingPath: outputFile, stopReason, summary: 'Zoom bot stopped before recording started.' };
    }

    const processed = await processRecording(outputFile, { title, note });
    const result = { recordingPath: outputFile, stopReason, ...processed };
    if (onDone) await onDone(result);
    return result;
  }

  process.once('SIGINT', async () => {
    const result = await stop('manual');
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  });

  const maxDurationMs = Math.max(1, Number(maxMinutes)) * 60 * 1000;

  const webClientUrl = toZoomWebClientUrl(joinUrl);
  console.log(`Zoom web client URL: ${webClientUrl}`);
  await context.grantPermissions(['microphone', 'camera'], { origin: new URL(webClientUrl).origin }).catch(() => {});
  await page.goto(webClientUrl, { waitUntil: 'domcontentloaded' });

  await saveZoomDebug(page, title, 'loaded');
  await joinFromBrowser(page);
  await saveZoomDebug(page, title, 'browser-join');

  const stillOnJoinLauncher = await page.locator('button:has-text("Join from browser")').count().catch(() => 0);
  if (stillOnJoinLauncher > 0) {
    throw new Error('Zoom browser join did not open. The meeting may block web client access, or Zoom changed the join flow.');
  }

  const nameField = zoomNameField(page);

  try {
    await nameField.waitFor({ state: 'visible', timeout: 10000 });
    await nameField.fill(botName);
  } catch {
    // Some authenticated/browser joins do not ask for a name.
  }

  await clickButtonByName(page, /^join$/i, 5000);
  await page.waitForTimeout(1500);
  await clickZoomAudioJoin(page);
  await clickButtonByName(page, /continue/i, 1000);
  await clickButtonByName(page, /got it/i, 1000);
  await saveZoomDebug(page, title, 'after-join');

  stopMeetingEndWatcher = startMeetingEndWatcher(page, () => {
    stop('meeting-ended').catch((error) => console.error('Zoom meeting-end stop failed:', error));
  });

  recorder = startFfmpegRecorder(outputFile, {
    silenceTimeout,
    onSilence: () => {
      stop('silence-timeout').catch((error) => console.error('Zoom silence stop failed:', error));
    }
  });
  maxTimer = setTimeout(() => {
    stop('max-duration').catch((error) => console.error('Zoom bot max duration stop failed:', error));
  }, maxDurationMs);

  console.log(`Zoom bot joined or is waiting. Recording: ${outputFile}`);
  console.log(`Zoom bot will stop after ${silenceTimeout}s of silence.`);
  console.log('Press Ctrl+C when the meeting ends.');

  await page.waitForEvent('close').catch(() => {});
  return stop('page-closed');
}
