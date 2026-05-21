import express from 'express';
import twilio from 'twilio';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { webhookCallback } from 'grammy';
import { config } from './config.js';
import { ensureDirs, recordingPath } from './utils/files.js';
import { processRecording } from './pipeline/openaiPipeline.js';
import { runZoomBot } from './zoom/zoomBot.js';
import { dialConference, hangupCalls } from './call/twilioCallBot.js';
import { attachSilenceMonitor } from './call/silenceMonitor.js';
import { resolveTelegramChatId, sendRecordingResult, sendTelegramMessage } from './telegram/notify.js';
import { createTelegramBot } from './telegram/createBot.js';

await ensureDirs();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

if (config.telegram.botToken) {
  const telegramBot = createTelegramBot();
  app.use('/telegram/webhook', webhookCallback(telegramBot, 'express'));
}

const zoomSchema = z.object({
  joinUrl: z.string().url(),
  botName: z.string().trim().min(1).max(80).optional(),
  title: z.string().default('zoom-meeting'),
  note: z.string().default(''),
  silenceTimeout: z.coerce.number().int().min(0).max(600).default(config.zoomSilenceTimeoutSeconds),
  notifyChatId: z.string().default('')
});

const callSchema = z.object({
  to: z.string().min(5),
  digits: z.string().default(''),
  title: z.string().default('phone-conference'),
  note: z.string().default(''),
  silenceTimeout: z.coerce.number().int().min(1).max(600).default(120),
  notifyChatId: z.string().default('')
});

const hangupSchema = z.object({
  callSid: z.string().default('')
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/zoom', async (req, res, next) => {
  try {
    const job = zoomSchema.parse(req.body);
    const notifyChatId = resolveTelegramChatId(job.notifyChatId);
    runZoomBot({
      ...job,
      onJoined: async ({ muteState }) => {
        if (!notifyChatId) return;
        await sendTelegramMessage(
          notifyChatId,
          [
            `*${job.title}*`,
            'Zoom 접속 완료.',
            muteState?.muted ? '마이크: 음소거 완료' : '마이크: 음소거 확인 필요',
            '녹음을 시작합니다.'
          ].join('\n')
        );
      },
      onDone: async (result) => {
        await sendRecordingResult(notifyChatId, result, {
          title: job.title,
          stopReason: result.stopReason,
          recordingPath: result.recordingPath
        });
      }
    }).catch((error) => {
      console.error('Zoom bot failed:', error);
      if (notifyChatId) {
        sendTelegramMessage(notifyChatId, `Zoom bot failed: ${error.message}`).catch(() => {});
      }
    });
    res.status(202).json({ status: 'started', ...job });
  } catch (error) {
    next(error);
  }
});

app.post('/api/call', async (req, res, next) => {
  try {
    const job = callSchema.parse(req.body);
    const call = await dialConference(job);
    res.status(202).json({ status: 'dialing', callSid: call.sid });
  } catch (error) {
    next(error);
  }
});

app.post('/api/hangup', async (req, res, next) => {
  try {
    const job = hangupSchema.parse(req.body);
    const results = await hangupCalls(job);
    res.json({ status: 'completed', count: results.length, calls: results });
  } catch (error) {
    next(error);
  }
});

app.post('/twilio/conference-twiml', (req, res) => {
  const digits = String(req.query.digits ?? '');
  const title = String(req.query.title ?? 'phone-conference');
  const note = String(req.query.note ?? '');
  const notifyChatId = resolveTelegramChatId(String(req.query.notifyChatId ?? ''));
  const rawSilenceTimeout = Number(req.query.silenceTimeout ?? 120);
  const silenceTimeout = Number.isFinite(rawSilenceTimeout)
    ? Math.min(Math.max(Math.trunc(rawSilenceTimeout), 1), 600)
    : 120;
  const response = new twilio.twiml.VoiceResponse();

  if (digits) {
    response.pause({ length: 2 });
    response.play({ digits });
  }

  const start = response.start();
  const stream = start.stream({
    url: `${config.publicBaseUrl.replace(/^http/, 'ws')}/twilio/media-stream`,
    track: 'inbound_track'
  });
  stream.parameter({ name: 'silenceTimeout', value: String(silenceTimeout) });
  stream.parameter({ name: 'title', value: title });
  stream.parameter({ name: 'notifyChatId', value: notifyChatId });

  response.pause({ length: 14400 });

  res.type('text/xml').send(response.toString());
});

app.post('/twilio/recording', async (req, res) => {
  const response = new twilio.twiml.VoiceResponse();
  response.hangup();
  res.type('text/xml').send(response.toString());

  try {
    const title = String(req.query.title ?? 'phone-conference');
    const note = String(req.query.note ?? '');
    const notifyChatId = resolveTelegramChatId(String(req.query.notifyChatId ?? ''));
    const recordingUrl = req.body.RecordingUrl;
    if (!recordingUrl) return;

    const auth = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString('base64');
    const audioResponse = await fetch(`${recordingUrl}.wav`, {
      headers: { Authorization: `Basic ${auth}` }
    });

    if (!audioResponse.ok) {
      throw new Error(`Failed to download Twilio recording: ${audioResponse.status}`);
    }

    const filePath = recordingPath(title, 'wav');
    const bytes = Buffer.from(await audioResponse.arrayBuffer());
    await fs.writeFile(filePath, bytes);

    const result = await processRecording(filePath, { title, note });
    const resultPath = path.join(config.outputDir, `${req.body.CallSid ?? Date.now()}-twilio-result.json`);
    await fs.writeFile(
      resultPath,
      JSON.stringify({ filePath, title, note, ...result }, null, 2),
      'utf8'
    );

    await sendRecordingResult(notifyChatId, result, { title, recordingPath: filePath });
  } catch (error) {
    console.error('Twilio recording processing failed:', error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(400).json({ error: error.message });
});

const server = app.listen(config.port, () => {
  console.log(`Meeting bot server listening on http://localhost:${config.port}`);
});

attachSilenceMonitor(server);
