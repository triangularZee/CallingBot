// Human-ish interaction helpers: randomized waits and clicks to make the
// Zoom Web Client bot behave less like an instant robot.
import { config } from '../config.js';

function randInt(min, max) {
  const lo = Math.max(0, Math.min(min, max));
  const hi = Math.max(lo, max);
  return Math.floor(lo + Math.random() * (hi - lo + 1));
}

export function jitterMs(min = config.zoomClickJitterMin, max = config.zoomClickJitterMax) {
  return randInt(min, max);
}

export async function humanWait(page, min, max) {
  await page.waitForTimeout(jitterMs(min, max));
}

export async function humanMouseMove(page) {
  try {
    const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
    const x = randInt(Math.floor(viewport.width * 0.2), Math.floor(viewport.width * 0.8));
    const y = randInt(Math.floor(viewport.height * 0.2), Math.floor(viewport.height * 0.8));
    const steps = randInt(8, 20);
    await page.mouse.move(x, y, { steps });
  } catch {
    // ignore – mouse move is decorative
  }
}

export async function humanClickLocator(page, locator) {
  await humanMouseMove(page);
  await page.waitForTimeout(jitterMs(80, 220));
  await locator.click({ delay: jitterMs(20, 90) });
}

const KOREAN_GIVEN = [
  '민준', '서연', '도윤', '하윤', '시우', '서윤', '주원', '지유',
  '예준', '하은', '지호', '윤서', '준서', '수아', '건우', '지아',
  '은우', '서아', '민재', '채원', '현우', '소율', '도현', '예린',
  '시현', '나윤', '연우', '민서', '재윤', '유나'
];
const KOREAN_FAMILY = [
  '김', '이', '박', '최', '정', '강', '조', '윤', '장', '임',
  '한', '오', '서', '신', '권', '황', '안', '송', '류', '전'
];

export function pickRandomKoreanName() {
  const family = KOREAN_FAMILY[randInt(0, KOREAN_FAMILY.length - 1)];
  const given = KOREAN_GIVEN[randInt(0, KOREAN_GIVEN.length - 1)];
  return `${family}${given}`;
}

// Resolve the bot name for this run. If a pool is configured, sample from
// it. Otherwise, fall back to a random Korean name when the configured
// name looks like a placeholder, else the explicit name.
export function resolveBotName({ explicit, pool, fallback, randomize }) {
  if (explicit) return explicit;
  if (Array.isArray(pool) && pool.length > 0) {
    return pool[randInt(0, pool.length - 1)];
  }
  if (randomize) return pickRandomKoreanName();
  return fallback;
}
