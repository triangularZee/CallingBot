// Wrap Playwright with stealth + project-specific Chromium flags + optional
// proxy + Zoom-friendly context settings so meeting joins look closer to a
// real desktop browser.
import fsp from 'node:fs/promises';
import os from 'node:os';
import { config } from '../config.js';

async function loadStealthChromium() {
  if (!config.zoomUseStealth) {
    const { chromium } = await import('playwright');
    return { chromium, stealthEnabled: false };
  }
  try {
    const extraMod = await import('playwright-extra');
    const stealthMod = await import('puppeteer-extra-plugin-stealth');
    const { chromium: baseChromium } = await import('playwright');
    const addExtra = extraMod.addExtra ?? extraMod.default?.addExtra;
    const stealth = (stealthMod.default ?? stealthMod)();
    if (!addExtra) throw new Error('playwright-extra did not expose addExtra');
    const chromium = addExtra(baseChromium);
    chromium.use(stealth);
    return { chromium, stealthEnabled: true };
  } catch (error) {
    console.warn(`Zoom stealth disabled (failed to load): ${error.message}`);
    const { chromium } = await import('playwright');
    return { chromium, stealthEnabled: false };
  }
}

function parseViewport(spec) {
  const match = String(spec ?? '').match(/^(\d{3,5})\s*[xX*]\s*(\d{3,5})$/);
  if (!match) return { width: 1280, height: 720 };
  return { width: Number(match[1]), height: Number(match[2]) };
}

function buildProxy() {
  if (!config.zoomProxyServer) return undefined;
  const proxy = { server: config.zoomProxyServer };
  if (config.zoomProxyUsername) proxy.username = config.zoomProxyUsername;
  if (config.zoomProxyPassword) proxy.password = config.zoomProxyPassword;
  if (config.zoomProxyBypass) proxy.bypass = config.zoomProxyBypass;
  return proxy;
}

async function loadStorageState() {
  if (!config.zoomStorageStatePath) return undefined;
  try {
    await fsp.access(config.zoomStorageStatePath);
    return config.zoomStorageStatePath;
  } catch {
    return undefined;
  }
}

function defaultUserAgent() {
  if (config.zoomUserAgent) return config.zoomUserAgent;
  // Recent Chrome on Linux desktop. Matches what a signed-in Zoom user
  // typically presents. Override via ZOOM_USER_AGENT if needed.
  return 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
}

// Inject extra anti-fingerprint patches that stealth-plugin doesn't always
// cover well in headless-ish containerized environments.
async function applyContextInit(context) {
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    } catch (e) { /* ignore */ }
    try {
      // Force a realistic-looking languages list
      Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });
    } catch (e) { /* ignore */ }
    try {
      // Pretend we have a few plugins so the UA fingerprint isn't zero-plugin
      const fakePlugins = [
        { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: 'Native Client' }
      ];
      Object.defineProperty(navigator, 'plugins', { get: () => fakePlugins });
    } catch (e) { /* ignore */ }
    try {
      // chrome.runtime placeholder so .runtime existence checks pass
      // eslint-disable-next-line no-undef
      window.chrome = window.chrome ?? {};
      // eslint-disable-next-line no-undef
      window.chrome.runtime = window.chrome.runtime ?? {};
    } catch (e) { /* ignore */ }
    try {
      const originalQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
      if (originalQuery) {
        window.navigator.permissions.query = (params) =>
          params?.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(params);
      }
    } catch (e) { /* ignore */ }
  });
}

export async function launchStealthZoomBrowser({ mediaArgs = [] } = {}) {
  const { chromium, stealthEnabled } = await loadStealthChromium();
  const platform = os.platform();
  const viewport = parseViewport(config.zoomViewport);
  const storageStatePath = await loadStorageState();
  const proxy = buildProxy();

  const launchArgs = [
    '--use-fake-ui-for-media-stream',
    ...mediaArgs,
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
    '--use-gl=swiftshader',
    `--lang=${config.zoomLocale}`
  ];

  const launchOptions = {
    headless: config.zoomHeadless,
    args: launchArgs
  };
  if (config.zoomChannel) launchOptions.channel = config.zoomChannel;
  if (proxy) launchOptions.proxy = proxy;

  const browser = await chromium.launch(launchOptions);

  const contextOptions = {
    permissions: ['microphone', 'camera'],
    viewport,
    locale: config.zoomLocale,
    timezoneId: config.zoomTimezoneId,
    userAgent: defaultUserAgent(),
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false
  };
  if (storageStatePath) contextOptions.storageState = storageStatePath;

  const context = await browser.newContext(contextOptions);
  await applyContextInit(context);

  console.log(`Zoom stealth launch: stealth=${stealthEnabled} channel=${config.zoomChannel || 'chromium'} `
    + `proxy=${proxy ? 'on' : 'off'} storageState=${storageStatePath ? 'loaded' : 'none'} `
    + `viewport=${viewport.width}x${viewport.height} platform=${platform}`);

  return { browser, context, stealthEnabled, storageStatePath: storageStatePath || null };
}
