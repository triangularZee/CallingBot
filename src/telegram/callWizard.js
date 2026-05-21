import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { dialConference } from '../call/twilioCallBot.js';
import { runZoomBot } from '../zoom/zoomBot.js';
import { normalizePhone } from './parseCommand.js';
import { sendRecordingResult, sendTelegramMessage } from './notify.js';

const DEFAULT_ZOOM_NICKNAME = config.zoomBotName || '신한 박시은';
const statePath = path.join(config.outputDir, 'telegram-call-state.json');
const sessions = new Map();
const timers = new Map();

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return { scheduled: [], history: [] };
  }
}

let state = loadState();

function saveState() {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

function shortId(id) {
  return String(id).slice(0, 14);
}

function createJobId() {
  return `call-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function mainMenuKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: '1. 일반 전화' }, { text: '2. Zoom link' }],
        [{ text: '3. 예약 목록' }, { text: '4. 통화 내역' }],
        [{ text: '/cancel' }]
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
      selective: true
    }
  };
}

function scheduleMenuKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: '예약 취소' }],
        [{ text: '1. 일반 전화' }, { text: '2. Zoom link' }],
        [{ text: '3. 예약 목록' }, { text: '4. 통화 내역' }],
        [{ text: '/cancel' }]
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
      selective: true
    }
  };
}

function forceReply() {
  return {
    reply_markup: {
      force_reply: true,
      selective: true
    }
  };
}

function normalizeChoice(text) {
  return String(text ?? '').toLowerCase().replace(/[\s.]+/g, '');
}

function isSkip(text) {
  return String(text ?? '').trim().toLowerCase() === '/skip';
}

function isCancel(text) {
  return String(text ?? '').trim().toLowerCase() === '/cancel';
}

export function formatKst(date) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date).replace('T', ' ');
}

export function callSetupBanner() {
  return [
    'CallingBot call setup을 시작합니다.',
    '예약 목록: /call schedule',
    '통화 내역: /call history',
    '중간에 취소하려면 /cancel'
  ].join('\n');
}

function kstParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

function dateFromKst({ year, month, day, hour, minute }) {
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 9, Number(minute), 0));
}

function parseSchedule(text) {
  const value = String(text ?? '').replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  const now = new Date();
  const current = kstParts(now);
  let match = value.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (match) {
    return dateFromKst({ year: match[1], month: match[2], day: match[3], hour: match[4], minute: match[5] });
  }

  match = value.match(/^(\d{2})(\d{2})(\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (match) {
    return dateFromKst({ year: `20${match[1]}`, month: match[2], day: match[3], hour: match[4], minute: match[5] });
  }

  match = value.match(/^(\d{1,2})[-/.](\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (match) {
    return dateFromKst({ year: current.year, month: match[1], day: match[2], hour: match[3], minute: match[4] });
  }

  match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (match) {
    let scheduled = dateFromKst({ year: current.year, month: current.month, day: current.day, hour: match[1], minute: match[2] });
    if (scheduled <= now) scheduled = new Date(scheduled.getTime() + 24 * 60 * 60 * 1000);
    return scheduled;
  }

  throw new Error('예약일시 형식을 확인해주세요. 예: 15:40 또는 2026-05-21 15:40');
}

function normalizeDtmfCode(text) {
  const cleaned = String(text ?? '').trim().replace(/\s+/g, '').replace(/^w+/i, '');
  const digits = cleaned.replace(/[^\d#*]/g, '');
  if (!digits) throw new Error('입력코드는 숫자, *, # 조합으로 입력해주세요. 없으면 /skip');
  return `ww${digits}`;
}

function promptForStep(step) {
  const prompts = {
    type: [
      '통화 유형을 선택해주세요.',
      '1. 일반 전화: 일반 컨퍼런스콜/ARS',
      '2. Zoom link: Zoom 링크로 브라우저 입장',
      '3. 예약 목록',
      '4. 통화 내역'
    ].join('\n'),
    phone_to: [
      '전화번호를 입력해주세요.',
      '',
      '예: 01012345678',
      '예: +821012345678',
      '',
      '취소: /cancel'
    ].join('\n'),
    code1: [
      '입력코드1을 입력해주세요.',
      '',
      '예: 572648#',
      '없으면 /skip',
      '',
      '입력한 값은 자동으로 ww가 붙습니다.'
    ].join('\n'),
    code2: [
      '입력코드2를 입력해주세요.',
      '',
      '예: 1004#',
      '없으면 /skip',
      '',
      '입력한 값은 자동으로 ww가 붙습니다.'
    ].join('\n'),
    zoom_url: [
      'Zoom 링크를 입력해주세요.',
      '',
      '예: https://us06web.zoom.us/j/...',
      '',
      '취소: /cancel'
    ].join('\n'),
    zoom_nickname: [
      'Zoom 참가 이름을 입력해주세요.',
      '',
      `기본값: ${DEFAULT_ZOOM_NICKNAME}`,
      '기본값을 쓰려면 /skip'
    ].join('\n'),
    schedule: [
      '예약일시를 입력해주세요. KST 기준입니다.',
      '',
      '예: 15:40',
      '예: 2026-05-21 15:40',
      '바로 시작하려면 /skip',
      '',
      '예약 통화는 입력한 시각보다 30초 먼저 시작됩니다.'
    ].join('\n'),
    title: [
      '제목을 입력해주세요.',
      '',
      '예: 260521_Company',
      '기본값을 쓰려면 /skip'
    ].join('\n')
  };
  return prompts[step];
}

async function ask(ctx, step) {
  await ctx.reply(promptForStep(step), step === 'type' ? mainMenuKeyboard() : forceReply());
}

function setSession(ctx, step, data = {}) {
  sessions.set(String(ctx.chat.id), { step, data });
}

function getSession(ctx) {
  return sessions.get(String(ctx.chat.id));
}

function clearSession(ctx) {
  sessions.delete(String(ctx.chat.id));
}

function addHistory(entry) {
  state.history = [
    { ...entry, updatedAt: new Date().toISOString() },
    ...(state.history ?? [])
  ].slice(0, 200);
  saveState();
}

async function startPhoneJob(job) {
  const call = await dialConference({
    to: job.to,
    digits: job.digits || '',
    title: job.title,
    note: job.note || '',
    notifyChatId: job.chatId,
    silenceTimeout: job.silenceTimeout || 120
  });

  addHistory({
    id: job.id,
    chatId: job.chatId,
    type: 'phone',
    title: job.title,
    to: job.to,
    callSid: call.sid,
    status: call.status || 'dialing',
    startedAt: new Date().toISOString()
  });

  await sendTelegramMessage(job.chatId, [
    'CallingBot call started.',
    `id: ${shortId(job.id)}`,
    `to: ${job.to}`,
    `title: ${job.title}`,
    `callSid: ${call.sid}`,
    '',
    '통화가 종료되고 녹음 파일이 준비되면 녹취 및 요약 결과를 보내겠습니다.'
  ].join('\n'));
}

async function startZoomJob(job) {
  addHistory({
    id: job.id,
    chatId: job.chatId,
    type: 'zoom',
    title: job.title,
    url: job.url,
    nickname: job.nickname,
    status: 'started',
    startedAt: new Date().toISOString()
  });

  await sendTelegramMessage(job.chatId, [
    'CallingBot Zoom job started.',
    `id: ${shortId(job.id)}`,
    `title: ${job.title}`,
    `nickname: ${job.nickname || DEFAULT_ZOOM_NICKNAME}`
  ].join('\n'));

  runZoomBot({
    joinUrl: job.url,
    botName: job.nickname || DEFAULT_ZOOM_NICKNAME,
    title: job.title,
    note: job.note || '',
    onJoined: async ({ muteState }) => {
      await sendTelegramMessage(job.chatId, [
        `*${job.title}*`,
        'Zoom 접속 완료.',
        muteState?.muted ? '마이크: 음소거 완료' : '마이크: 음소거 확인 필요',
        '녹음을 시작합니다.'
      ].join('\n'));
    },
    onDone: async (result) => {
      addHistory({
        id: job.id,
        chatId: job.chatId,
        type: 'zoom',
        title: job.title,
        status: 'completed',
        stopReason: result.stopReason,
        finishedAt: new Date().toISOString()
      });
      await sendRecordingResult(job.chatId, result, {
        title: job.title,
        stopReason: result.stopReason,
        recordingPath: result.recordingPath
      });
    }
  }).catch((error) => {
    addHistory({
      id: job.id,
      chatId: job.chatId,
      type: 'zoom',
      title: job.title,
      status: 'failed',
      error: error.message,
      finishedAt: new Date().toISOString()
    });
    sendTelegramMessage(job.chatId, `Zoom bot failed: ${error.message}`).catch(() => {});
  });
}

async function startJob(job) {
  if (job.type === 'zoom') {
    await startZoomJob(job);
    return;
  }
  await startPhoneJob(job);
}

function removeScheduledJob(id) {
  const index = (state.scheduled ?? []).findIndex((job) => job.id === id);
  if (index >= 0) state.scheduled.splice(index, 1);
  saveState();
}

async function runScheduledJob(id) {
  timers.delete(id);
  const job = (state.scheduled ?? []).find((item) => item.id === id);
  if (!job) return;
  removeScheduledJob(id);
  await sendTelegramMessage(job.chatId, [
    '예약 작업을 시작합니다.',
    `id: ${shortId(job.id)}`,
    `title: ${job.title}`
  ].join('\n')).catch(() => {});
  await startJob(job).catch((error) => {
    addHistory({
      id: job.id,
      chatId: job.chatId,
      type: job.type,
      title: job.title,
      status: 'failed',
      error: error.message,
      finishedAt: new Date().toISOString()
    });
    sendTelegramMessage(job.chatId, `예약 작업 실패: ${error.message}`).catch(() => {});
  });
}

function armSchedule(job) {
  if (timers.has(job.id)) clearTimeout(timers.get(job.id));
  const delay = Math.max(0, new Date(job.scheduledAt).getTime() - Date.now());
  const timer = setTimeout(() => {
    runScheduledJob(job.id).catch((error) => console.error('Scheduled call failed:', error));
  }, Math.min(delay, 2_147_483_647));
  timer.unref?.();
  timers.set(job.id, timer);
}

export function initCallScheduler() {
  for (const job of state.scheduled ?? []) {
    armSchedule(job);
  }
}

function scheduledTimeForJob(job) {
  if (job.requestedStartAt) return new Date(job.requestedStartAt);
  if (job.scheduledAt) return new Date(new Date(job.scheduledAt).getTime() + 30_000);
  return null;
}

function formatScheduledJob(job) {
  return [
    `id: ${shortId(job.id)}`,
    scheduledTimeForJob(job) ? `time: ${formatKst(scheduledTimeForJob(job))} KST` : '',
    job.scheduledAt ? `call starts: ${formatKst(new Date(job.scheduledAt))} KST` : '',
    job.type === 'zoom' ? 'type: Zoom link' : 'type: Call',
    job.to ? `to: ${job.to}` : '',
    job.url ? `url: ${job.url}` : '',
    job.type === 'zoom' && job.nickname ? `nickname: ${job.nickname}` : '',
    `title: ${job.title}`
  ].filter(Boolean).join('\n');
}

function formatHistoryJob(job) {
  return [
    `[${job.status}] ${job.title}`,
    `id: ${shortId(job.id)}`,
    job.type === 'zoom' ? 'type: Zoom link' : 'type: Call',
    job.to ? `to: ${job.to}` : '',
    job.url ? `url: ${job.url}` : '',
    job.callSid ? `callSid: ${job.callSid}` : '',
    job.startedAt ? `started: ${formatKst(new Date(job.startedAt))} KST` : '',
    job.finishedAt ? `finished: ${formatKst(new Date(job.finishedAt))} KST` : '',
    job.error ? `error: ${job.error}` : ''
  ].filter(Boolean).join('\n');
}

export async function showScheduledJobs(ctx) {
  const jobs = (state.scheduled ?? []).filter((job) => String(job.chatId) === String(ctx.chat.id));
  if (jobs.length === 0) {
    await ctx.reply('예약된 작업이 없습니다.', mainMenuKeyboard());
    return;
  }
  await ctx.reply([
    '예약 목록',
    '',
    jobs.map(formatScheduledJob).join('\n\n---\n\n'),
    '',
    '예약 취소: /call cancel <id>'
  ].join('\n'), scheduleMenuKeyboard());
}

export async function showJobHistory(ctx) {
  const jobs = (state.history ?? []).filter((job) => String(job.chatId) === String(ctx.chat.id)).slice(0, 10);
  if (jobs.length === 0) {
    await ctx.reply('아직 통화 내역이 없습니다.', mainMenuKeyboard());
    return;
  }
  await ctx.reply([
    '통화 내역',
    '',
    jobs.map(formatHistoryJob).join('\n\n---\n\n')
  ].join('\n'), mainMenuKeyboard());
}

export async function cancelScheduledJob(ctx, idPrefix = '') {
  const prefix = String(idPrefix).trim();
  if (!prefix) {
    await ctx.reply('취소할 예약 id를 입력해주세요.\n예: /call cancel call-abc123', mainMenuKeyboard());
    await showScheduledJobs(ctx);
    return;
  }

  const matches = (state.scheduled ?? []).filter((job) => (
    String(job.chatId) === String(ctx.chat.id) && job.id.startsWith(prefix)
  ));
  if (matches.length === 0) {
    await ctx.reply(`예약을 찾을 수 없습니다: ${prefix}`, mainMenuKeyboard());
    return;
  }
  if (matches.length > 1) {
    await ctx.reply(`예약 id가 여러 개와 일치합니다. 더 길게 입력해주세요: ${matches.map((job) => shortId(job.id)).join(', ')}`, mainMenuKeyboard());
    return;
  }

  const [job] = matches;
  if (timers.has(job.id)) clearTimeout(timers.get(job.id));
  timers.delete(job.id);
  removeScheduledJob(job.id);
  addHistory({
    id: job.id,
    chatId: job.chatId,
    type: job.type,
    title: job.title,
    status: 'cancelled',
    finishedAt: new Date().toISOString()
  });
  clearSession(ctx);
  await ctx.reply([
    '예약 취소 완료',
    `id: ${shortId(job.id)}`,
    `title: ${job.title}`,
    'status: cancelled'
  ].join('\n'), mainMenuKeyboard());
}

export async function startScheduleCancel(ctx) {
  const jobs = (state.scheduled ?? []).filter((job) => String(job.chatId) === String(ctx.chat.id));
  if (jobs.length === 0) {
    clearSession(ctx);
    await ctx.reply('예약된 작업이 없습니다.', mainMenuKeyboard());
    return;
  }
  setSession(ctx, 'cancel_job_id', {});
  await ctx.reply([
    '취소할 예약 id를 입력해주세요.',
    '',
    jobs.map(formatScheduledJob).join('\n\n---\n\n'),
    '',
    '취소하지 않으려면 /cancel'
  ].join('\n'), forceReply());
}

export async function startCallWizard(ctx) {
  setSession(ctx, 'type', {});
  await ctx.reply(callSetupBanner(), mainMenuKeyboard());
  await ask(ctx, 'type');
}

export async function startPhoneWizard(ctx) {
  setSession(ctx, 'phone_to', { type: 'phone' });
  await ask(ctx, 'phone_to');
}

export async function startZoomWizard(ctx) {
  setSession(ctx, 'zoom_url', { type: 'zoom' });
  await ask(ctx, 'zoom_url');
}

export async function cancelCallWizard(ctx) {
  if (!getSession(ctx)) {
    await ctx.reply('진행 중인 입력이 없습니다.', mainMenuKeyboard());
    return;
  }
  clearSession(ctx);
  await ctx.reply('입력을 취소했습니다.', mainMenuKeyboard());
}

function buildJobFromData(ctx, data) {
  const id = createJobId();
  const title = data.title || (data.type === 'zoom' ? 'zoom-meeting' : 'telegram-call');
  return {
    id,
    chatId: String(ctx.chat.id),
    requestedByUserId: String(ctx.from?.id ?? ''),
    type: data.type,
    title,
    to: data.to,
    url: data.url,
    nickname: data.nickname || DEFAULT_ZOOM_NICKNAME,
    digits: data.digits || '',
    note: data.note || '',
    silenceTimeout: 120,
    requestedStartAt: data.requestedStartAt || null,
    scheduledAt: data.scheduledAt || null,
    createdAt: new Date().toISOString()
  };
}

async function finishWizard(ctx, data) {
  const job = buildJobFromData(ctx, data);
  clearSession(ctx);

  if (job.scheduledAt) {
    state.scheduled = [...(state.scheduled ?? []), job];
    saveState();
    armSchedule(job);
    await ctx.reply([
      '예약 작업 등록 완료',
      `id: ${shortId(job.id)}`,
      `type: ${job.type === 'zoom' ? 'Zoom link' : 'Call'}`,
      `title: ${job.title}`,
      job.to ? `to: ${job.to}` : '',
      job.url ? `url: ${job.url}` : '',
      job.requestedStartAt ? `time: ${formatKst(new Date(job.requestedStartAt))} KST` : '',
      job.scheduledAt ? `call starts: ${formatKst(new Date(job.scheduledAt))} KST` : ''
    ].filter(Boolean).join('\n'), mainMenuKeyboard());
    return;
  }

  await ctx.reply([
    '작업을 시작합니다.',
    `id: ${shortId(job.id)}`,
    `type: ${job.type === 'zoom' ? 'Zoom link' : 'Call'}`,
    `title: ${job.title}`
  ].join('\n'), mainMenuKeyboard());
  await startJob(job);
}

export async function handleCallMenuText(ctx) {
  const choice = normalizeChoice(ctx.message?.text ?? '');
  if (['1', '1일반전화', '전화', '일반', 'phone'].includes(choice)) {
    await startPhoneWizard(ctx);
    return true;
  }
  if (['2', '2zoomlink', '2zoom', 'zoom', '줌'].includes(choice)) {
    await startZoomWizard(ctx);
    return true;
  }
  if (['3', '3예약목록', '예약목록', 'schedule', 'schedules'].includes(choice)) {
    await showScheduledJobs(ctx);
    await ask(ctx, 'type');
    return true;
  }
  if (['예약취소'].includes(choice)) {
    await startScheduleCancel(ctx);
    return true;
  }
  if (['4', '4통화내역', '통화내역', 'history'].includes(choice)) {
    await showJobHistory(ctx);
    await ask(ctx, 'type');
    return true;
  }
  return false;
}

export function isCallMenuText(text) {
  const choice = normalizeChoice(text);
  return [
    '1', '1일반전화', '전화', '일반', 'phone',
    '2', '2zoomlink', '2zoom', 'zoom', '줌',
    '3', '3예약목록', '예약목록', 'schedule', 'schedules',
    '예약취소',
    '4', '4통화내역', '통화내역', 'history'
  ].includes(choice);
}

export async function handleCallWizardInput(ctx) {
  const text = ctx.message?.text?.trim() ?? '';
  const session = getSession(ctx);
  if (!session) return false;

  if (isCancel(text)) {
    await cancelCallWizard(ctx);
    return true;
  }

  const data = { ...session.data };

  try {
    if (session.step === 'type') {
      if (await handleCallMenuText(ctx)) return true;
      await ctx.reply('1, 2, 3, 4 중에서 선택해주세요.', mainMenuKeyboard());
      await ask(ctx, 'type');
      return true;
    }

    if (session.step === 'phone_to') {
      const to = normalizePhone(text);
      if (!to || to.length < 8) throw new Error('전화번호를 다시 확인해주세요.');
      setSession(ctx, 'code1', { ...data, to });
      await ask(ctx, 'code1');
      return true;
    }

    if (session.step === 'code1') {
      if (isSkip(text)) {
        setSession(ctx, 'schedule', { ...data, digits: '' });
        await ask(ctx, 'schedule');
        return true;
      }
      setSession(ctx, 'code2', { ...data, code1: normalizeDtmfCode(text) });
      await ask(ctx, 'code2');
      return true;
    }

    if (session.step === 'code2') {
      const code2 = isSkip(text) ? '' : normalizeDtmfCode(text);
      setSession(ctx, 'schedule', { ...data, code2, digits: `${data.code1 || ''}${code2}` });
      await ask(ctx, 'schedule');
      return true;
    }

    if (session.step === 'zoom_url') {
      if (!/^https?:\/\/\S+/i.test(text)) throw new Error('Zoom 링크를 URL 형식으로 입력해주세요.');
      setSession(ctx, 'zoom_nickname', { ...data, url: text });
      await ask(ctx, 'zoom_nickname');
      return true;
    }

    if (session.step === 'zoom_nickname') {
      setSession(ctx, 'schedule', { ...data, nickname: isSkip(text) ? DEFAULT_ZOOM_NICKNAME : text });
      await ask(ctx, 'schedule');
      return true;
    }

    if (session.step === 'schedule') {
      if (isSkip(text)) {
        setSession(ctx, 'title', { ...data, scheduledAt: null, requestedStartAt: null });
        await ask(ctx, 'title');
        return true;
      }
      const requestedStart = parseSchedule(text);
      const scheduledStart = new Date(requestedStart.getTime() - 30_000);
      setSession(ctx, 'title', {
        ...data,
        requestedStartAt: requestedStart.toISOString(),
        scheduledAt: scheduledStart.toISOString()
      });
      await ask(ctx, 'title');
      return true;
    }

    if (session.step === 'title') {
      const defaultTitle = data.type === 'zoom' ? 'zoom-meeting' : 'telegram-call';
      await finishWizard(ctx, { ...data, title: isSkip(text) ? defaultTitle : text });
      return true;
    }

    if (session.step === 'cancel_job_id') {
      await cancelScheduledJob(ctx, text);
      return true;
    }
  } catch (error) {
    await ctx.reply(error.message);
    await ask(ctx, session.step);
    return true;
  }

  return false;
}
