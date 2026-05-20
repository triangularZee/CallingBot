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

async function isButtonVisibleByName(page, namePattern, timeout = 500) {
  try {
    const locator = page.getByRole('button', { name: namePattern }).first();
    await locator.waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

async function ensureZoomMicrophoneMuted(page) {
  const unmutePattern = /(^|\b)unmute(\b|$)|unmute audio|음소거 해제|마이크.*켜기/i;
  const mutePattern = /(^|\b)mute(\b|$)|mute audio|음소거|마이크.*끄기/i;

  if (await isButtonVisibleByName(page, unmutePattern)) {
    return { muted: true, action: 'already-muted' };
  }

  if (await clickButtonByName(page, mutePattern, 2500)) {
    await page.waitForTimeout(500);
    return {
      muted: await isButtonVisibleByName(page, unmutePattern, 1500),
      action: 'clicked-mute'
    };
  }

  const muted = await page.evaluate(() => {
    const unmutePattern = /(^|\b)unmute(\b|$)|unmute audio|음소거 해제|마이크.*켜기/i;
    const mutePattern = /(^|\b)mute(\b|$)|mute audio|음소거|마이크.*끄기/i;
    const buttons = Array.from(document.querySelectorAll('button'));

    if (buttons.some((button) => unmutePattern.test([
      button.textContent,
      button.getAttribute('aria-label'),
      button.getAttribute('title')
    ].filter(Boolean).join(' ')))) {
      return true;
    }

    const muteButton = buttons.find((button) => {
      const text = [
        button.textContent,
        button.getAttribute('aria-label'),
        button.getAttribute('title')
      ].filter(Boolean).join(' ');
      return mutePattern.test(text) && !unmutePattern.test(text);
    });

    if (!muteButton) return false;
    muteButton.click();
    return true;
  }).catch(() => false);

  return { muted, action: muted ? 'clicked-mute-dom' : 'not-found' };
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

async function assertZoomJoinable(page) {
  const errorPatterns = [
    /meeting link is invalid/i,
    /invalid meeting/i,
    /meeting id is invalid/i,
    /this meeting has been ended/i,
    /unable to join/i,
    /error code:\s*\d+/i,
    /\\(3,001\\)/i,
    /유효하지.*미팅/i,
    /잘못된.*링크/i,
    /종료된.*미팅/i
  ];

  const text = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
  const matched = errorPatterns.find((pattern) => pattern.test(text));
  if (matched) {
    const compact = text.replace(/\s+/g, ' ').trim().slice(0, 240);
    throw new Error(`Zoom join failed before recording: ${compact || matched.source}`);
  }
}

function isWaitingForHost(text) {
  return [
    /waiting for the host to start/i,
    /please wait.*host/i,
    /host has another meeting in progress/i,
    /meeting host will let you in soon/i,
    /wait.*meeting host/i
  ].some((pattern) => pattern.test(text));
}

async function waitForHostToStart(page, { timeoutMs = 60 * 60 * 1000 } = {}) {
  const startedAt = Date.now();

  while (true) {
    await assertZoomJoinable(page);
    const text = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    if (!isWaitingForHost(text)) return;

    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Zoom meeting did not start before host wait timeout. Recording was not started.');
    }

    console.log('Zoom meeting is waiting for host; recording has not started yet.');
    await page.waitForTimeout(10_000);
  }
}

function startMeetingEndWatcher(page, onEnded) {
  const endedPatterns = [
    /meeting has been ended/i,
    /host ended this meeting/i,
    /this meeting has ended/i,
    /you have been removed/i,
    /removed from the meeting/i,
    /you are disconnected from the meeting/i,
    /meeting disconnected/i,
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

function normalizeBotName(value) {
  const name = String(value ?? '').trim();
  if (!name || /^[?\s]+$/.test(name)) return config.zoomBotName;
  return name.slice(0, 80);
}

export async function runZoomBot({
  joinUrl,
  botName = config.zoomBotName,
  title = 'zoom-meeting',
  note = '',
  autoTranscribe = true,
  maxMinutes = 120,
  silenceTimeout = 120,
  onJoined = null,
  onDone = null
}) {
  botName = normalizeBotName(botName);
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
    console.log(`Zoom bot stopping: ${stopReason}`);
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
  await assertZoomJoinable(page);
  await joinFromBrowser(page);
  await saveZoomDebug(page, title, 'browser-join');
  await assertZoomJoinable(page);

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
  await assertZoomJoinable(page);
  await waitForHostToStart(page);
  const muteState = await ensureZoomMicrophoneMuted(page);

  if (onJoined) {
    try {
      await onJoined({ title, botName, recordingPath: outputFile, muteState });
    } catch (error) {
      console.error('Zoom join notification failed:', error);
    }
  }

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
