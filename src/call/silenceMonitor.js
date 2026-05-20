import twilio from 'twilio';
import { WebSocketServer } from 'ws';
import { config } from '../config.js';
import { sendTelegramMessage } from '../telegram/notify.js';

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

function mulawSampleToLinear(sample) {
  let value = ~sample & 0xff;
  const sign = value & 0x80;
  const exponent = (value >> 4) & 0x07;
  const mantissa = value & 0x0f;
  let decoded = ((mantissa << 3) + MULAW_BIAS) << exponent;
  decoded -= MULAW_BIAS;
  decoded = Math.min(decoded, MULAW_CLIP);
  return sign ? -decoded : decoded;
}

function rmsMulaw(payload) {
  const audio = Buffer.from(payload, 'base64');
  if (!audio.length) return 0;

  let sum = 0;
  for (const byte of audio) {
    const sample = mulawSampleToLinear(byte);
    sum += sample * sample;
  }
  return Math.sqrt(sum / audio.length);
}

function twilioClient() {
  const { accountSid, authToken } = config.twilio;
  if (!accountSid || !authToken) {
    throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required');
  }
  return twilio(accountSid, authToken);
}

export function attachSilenceMonitor(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    if (new URL(request.url, 'http://localhost').pathname !== '/twilio/media-stream') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws) => {
    const state = {
      callSid: '',
      title: 'phone-conference',
      notifyChatId: '',
      silenceTimeoutMs: 120_000,
      silenceThreshold: 180,
      lastVoiceAt: Date.now(),
      notifiedStart: false,
      ended: false
    };

    async function notifyCallConnected() {
      if (!state.notifyChatId || state.notifiedStart) return;
      state.notifiedStart = true;
      try {
        await sendTelegramMessage(
          state.notifyChatId,
          [
            `*${state.title}*`,
            '전화 통화 연결 완료.',
            `callSid: ${state.callSid || '(unknown)'}`,
            `무음 종료: ${Math.round(state.silenceTimeoutMs / 1000)}초`,
            '녹음 및 오디오 감시를 시작합니다.'
          ].join('\n')
        );
      } catch (error) {
        console.error('Failed to notify phone call connection:', error);
      }
    }

    async function notifySilentHangup() {
      if (!state.notifyChatId) return;
      try {
        await sendTelegramMessage(
          state.notifyChatId,
          [
            `*${state.title}*`,
            `무음 ${Math.round(state.silenceTimeoutMs / 1000)}초가 지나 통화를 종료합니다.`,
            state.callSid ? `callSid: ${state.callSid}` : ''
          ].filter(Boolean).join('\n')
        );
      } catch (error) {
        console.error('Failed to notify silent call hangup:', error);
      }
    }

    async function endSilentCall() {
      if (state.ended || !state.callSid) return;
      state.ended = true;
      try {
        await twilioClient().calls(state.callSid).update({ status: 'completed' });
        await notifySilentHangup();
      } catch (error) {
        console.error('Failed to hang up silent call:', error);
      } finally {
        try {
          ws.close();
        } catch {
          // Ignore close failures.
        }
      }
    }

    ws.on('message', async (raw) => {
      let event;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (event.event === 'start') {
        state.callSid = event.start?.callSid ?? '';
        const params = event.start?.customParameters ?? {};
        state.title = String(params.title ?? 'phone-conference');
        state.notifyChatId = String(params.notifyChatId ?? '');
        const seconds = Number(params.silenceTimeout ?? 120);
        if (Number.isFinite(seconds)) state.silenceTimeoutMs = Math.max(1, Math.min(seconds, 600)) * 1000;
        const threshold = Number(params.silenceThreshold ?? 180);
        if (Number.isFinite(threshold)) state.silenceThreshold = Math.max(1, threshold);
        state.lastVoiceAt = Date.now();
        await notifyCallConnected();
        return;
      }

      if (event.event !== 'media') return;

      const level = rmsMulaw(event.media?.payload ?? '');
      const now = Date.now();
      if (level >= state.silenceThreshold) {
        state.lastVoiceAt = now;
      } else if (now - state.lastVoiceAt >= state.silenceTimeoutMs) {
        await endSilentCall();
      }
    });
  });
}
