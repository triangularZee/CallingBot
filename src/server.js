import express from 'express';
import twilio from 'twilio';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { config } from './config.js';
import { ensureDirs, recordingPath } from './utils/files.js';
import { processRecording } from './pipeline/openaiPipeline.js';
import { runZoomBot } from './zoom/zoomBot.js';
import { dialConference } from './call/twilioCallBot.js';

await ensureDirs();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const zoomSchema = z.object({
  joinUrl: z.string().url(),
  title: z.string().default('zoom-meeting')
});

const callSchema = z.object({
  to: z.string().min(5),
  digits: z.string().default(''),
  title: z.string().default('phone-conference')
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/zoom', async (req, res, next) => {
  try {
    const job = zoomSchema.parse(req.body);
    runZoomBot(job).catch((error) => console.error('Zoom bot failed:', error));
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

app.post('/twilio/conference-twiml', (req, res) => {
  const digits = String(req.query.digits ?? '');
  const response = new twilio.twiml.VoiceResponse();

  if (digits) {
    response.pause({ length: 2 });
    response.play({ digits });
  }

  // Keep the bot leg alive while Twilio records the call. The bot is a normal dial-in participant.
  response.pause({ length: 3600 });

  res.type('text/xml').send(response.toString());
});

app.post('/twilio/recording', async (req, res) => {
  res.sendStatus(204);

  try {
    const title = String(req.query.title ?? 'phone-conference');
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

    const result = await processRecording(filePath, { title });
    await fs.writeFile(
      path.join(config.outputDir, `${req.body.CallSid ?? Date.now()}-twilio-result.json`),
      JSON.stringify({ filePath, ...result }, null, 2),
      'utf8'
    );
  } catch (error) {
    console.error('Twilio recording processing failed:', error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(400).json({ error: error.message });
});

app.listen(config.port, () => {
  console.log(`Meeting bot server listening on http://localhost:${config.port}`);
});
