import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { config } from '../config.js';
import { outputPath } from '../utils/files.js';
import { summarizeTranscript } from '../pipeline/openaiPipeline.js';
import { sendTelegramMessage } from '../telegram/notify.js';

const activeClients = new Map();

function hmacHex(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function secureCompare(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function zoomUrlValidationResponse(body) {
  const plainToken = body?.payload?.plainToken;
  if (!plainToken) return null;
  if (!config.zoom.webhookSecretToken) {
    throw new Error('ZOOM_WEBHOOK_SECRET_TOKEN is required for Zoom webhook validation');
  }

  return {
    plainToken,
    encryptedToken: hmacHex(config.zoom.webhookSecretToken, plainToken)
  };
}

export function verifyZoomWebhook(req) {
  if (!config.zoom.webhookSecretToken) {
    throw new Error('ZOOM_WEBHOOK_SECRET_TOKEN is required');
  }

  const timestamp = req.headers['x-zm-request-timestamp'];
  const zoomSignature = req.headers['x-zm-signature'];
  if (!timestamp || !zoomSignature) return false;

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) return false;

  const bodyText = req.rawBody ?? JSON.stringify(req.body);
  const message = `v0:${timestamp}:${bodyText}`;
  const localSignature = `v0=${hmacHex(config.zoom.webhookSecretToken, message)}`;
  return secureCompare(localSignature, String(zoomSignature));
}

function streamIdFromPayload(payload = {}) {
  return payload.rtms_stream_id ?? payload.rtmsStreamId ?? payload.object?.rtms_stream_id ?? '';
}

function titleFromPayload(payload = {}, streamId = '') {
  return (
    payload.object?.topic ??
    payload.topic ??
    payload.meeting_topic ??
    `zoom-rtms-${String(streamId || Date.now()).slice(0, 12)}`
  );
}

function textFromBuffer(data) {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof Uint8Array) return Buffer.from(data).toString('utf8');
  return String(data ?? '');
}

async function loadRtmsSdk() {
  try {
    const module = await import('@zoom/rtms');
    return module.default ?? module;
  } catch (error) {
    throw new Error(
      `@zoom/rtms is not available in this runtime. It currently supports Linux/macOS; install on EC2 with npm install. Details: ${error.message}`
    );
  }
}

async function notifyRtms(text) {
  const chatId = config.zoom.rtmsNotifyChatId;
  if (!chatId) return;
  await sendTelegramMessage(chatId, text);
}

async function finalizeRtmsSession(streamId, reason = 'rtms-stopped') {
  const session = activeClients.get(streamId);
  if (!session) return null;
  activeClients.delete(streamId);

  try {
    session.client?.leave?.();
  } catch (error) {
    console.warn(`Zoom RTMS leave failed for ${streamId}: ${error.message}`);
  }

  const transcriptText = session.transcriptLines.join('\n').trim();
  const transcriptTextPath = outputPath(session.title, 'rtms-transcript.txt');
  const resultPath = outputPath(session.title, 'rtms-result.json');

  await fs.writeFile(transcriptTextPath, transcriptText || '(empty transcript)', 'utf8');

  let summary = '';
  let summaryPath = '';
  let error = '';

  if (transcriptText) {
    try {
      const result = await summarizeTranscript(transcriptText, {
        title: session.title,
        note: `Zoom RTMS stream ${streamId}`
      });
      summary = result.summary;
      summaryPath = result.summaryPath;
    } catch (summaryError) {
      error = summaryError.message;
      console.error('Zoom RTMS summary failed:', summaryError);
    }
  }

  await fs.writeFile(
    resultPath,
    JSON.stringify(
      {
        streamId,
        title: session.title,
        reason,
        startedAt: session.startedAt,
        stoppedAt: new Date().toISOString(),
        transcriptTextPath,
        summaryPath,
        transcriptLines: session.transcriptLines.length,
        audioBytes: session.audioBytes,
        error
      },
      null,
      2
    ),
    'utf8'
  );

  if (summary) {
    await notifyRtms(
      [
        `*${session.title}*`,
        '',
        summary.slice(0, 3800),
        '',
        summary.length > 3800 ? `Summary is long. File: ${summaryPath}` : `File: ${summaryPath}`
      ].join('\n')
    );
  } else {
    await notifyRtms(
      [
        `Zoom RTMS stopped: ${session.title}`,
        `reason: ${reason}`,
        `transcript: ${transcriptTextPath}`,
        error ? `error: ${error}` : ''
      ]
        .filter(Boolean)
        .join('\n')
    );
  }

  return { transcriptTextPath, summaryPath, resultPath };
}

async function startRtmsSession(payload = {}) {
  const streamId = streamIdFromPayload(payload);
  if (!streamId) throw new Error('Zoom RTMS payload did not include rtms_stream_id');
  if (activeClients.has(streamId)) {
    return { streamId, status: 'already-running' };
  }

  const rtms = await loadRtmsSdk();
  const client = new rtms.Client();
  const session = {
    streamId,
    client,
    title: titleFromPayload(payload, streamId),
    startedAt: new Date().toISOString(),
    transcriptLines: [],
    audioBytes: 0
  };

  activeClients.set(streamId, session);

  client.onTranscriptData?.((data, size, timestamp, metadata = {}) => {
    const text = textFromBuffer(data).trim();
    if (!text) return;
    const speaker = metadata.userName || metadata.user_name || metadata.userId || 'speaker';
    session.transcriptLines.push(`[${timestamp}] ${speaker}: ${text}`);
    console.log(`Zoom RTMS transcript ${streamId}: ${speaker}: ${text}`);
  });

  client.onAudioData?.((data, size) => {
    session.audioBytes += Number(size ?? data?.length ?? 0);
  });

  client.join(payload);
  await notifyRtms(`Zoom RTMS started: ${session.title}`);
  return { streamId, status: 'started' };
}

export async function handleZoomRtmsWebhook(body) {
  const event = body?.event;
  const payload = body?.payload ?? {};
  const streamId = streamIdFromPayload(payload);

  if (event === 'meeting.rtms_started') {
    if (!config.zoom.rtmsAutoStart) {
      console.log(`Zoom RTMS start event received for ${streamId}; auto-start is disabled`);
      return { streamId, status: 'ignored', reason: 'ZOOM_RTMS_AUTO_START=false' };
    }
    return startRtmsSession(payload);
  }

  if (event === 'meeting.rtms_stopped') {
    return finalizeRtmsSession(streamId, 'meeting.rtms_stopped');
  }

  console.log(`Zoom webhook ignored: ${event}`);
  return { streamId, status: 'ignored', event };
}

export function zoomRtmsStatus() {
  return {
    autoStart: config.zoom.rtmsAutoStart,
    active: Array.from(activeClients.values()).map((session) => ({
      streamId: session.streamId,
      title: session.title,
      startedAt: session.startedAt,
      transcriptLines: session.transcriptLines.length,
      audioBytes: session.audioBytes
    }))
  };
}
