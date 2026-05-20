// One-time interactive Zoom login: opens a non-headless browser, lets a
// human sign in, then saves storageState so subsequent runZoomBot calls
// reuse the authenticated session. Authenticated users are far less likely
// to trip Zoom's anti-bot signal than guest joins.
import path from 'node:path';
import fsp from 'node:fs/promises';
import readline from 'node:readline';
import { config } from '../config.js';
import { launchStealthZoomBrowser } from './stealthLaunch.js';

const LOGIN_URL = 'https://zoom.us/signin';
const AUTHENTICATED_HOSTS = ['zoom.us', 'us05web.zoom.us'];

function waitForEnter(message) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

async function ensureDir(filePath) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

async function looksAuthenticated(context) {
  const cookies = await context.cookies();
  const sessionMarkers = ['_zm_ssid', 'zm_aid', '_zm_lang', 'cred'];
  return cookies.some((cookie) =>
    AUTHENTICATED_HOSTS.some((host) => cookie.domain.endsWith(host))
      && sessionMarkers.includes(cookie.name)
  );
}

export async function runZoomLogin({
  storageStatePath = config.zoomStorageStatePath,
  waitForUserMs = 0
} = {}) {
  if (!storageStatePath) {
    throw new Error('ZOOM_STORAGE_STATE_PATH is required to save Zoom session.');
  }
  if (config.zoomHeadless) {
    console.warn('ZOOM_HEADLESS=true is set; opening anyway because login needs a UI.');
  }

  process.env.ZOOM_HEADLESS = 'false';

  const { browser, context } = await launchStealthZoomBrowser();
  const page = await context.newPage();

  console.log(`Opening ${LOGIN_URL} for manual sign-in.`);
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  console.log('Please sign in to your Zoom Pro bot account in the opened browser window.');
  console.log('After you reach the Zoom profile/dashboard, return here and press Enter.');

  if (waitForUserMs > 0) {
    await page.waitForTimeout(waitForUserMs);
  } else {
    await waitForEnter('Press Enter once signed in... ');
  }

  if (!(await looksAuthenticated(context))) {
    console.warn('No Zoom session cookies detected. Saving storageState anyway; verify by retrying the bot.');
  }

  await ensureDir(storageStatePath);
  await context.storageState({ path: storageStatePath });
  console.log(`Saved Zoom storageState to: ${storageStatePath}`);

  await context.close().catch(() => {});
  await browser.close().catch(() => {});
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`
  || process.argv[1]?.endsWith('zoomLogin.js')) {
  runZoomLogin().catch((error) => {
    console.error('Zoom login failed:', error);
    process.exit(1);
  });
}
