import twilio from 'twilio';
import { config } from '../config.js';

function twilioClient() {
  const { accountSid, authToken, fromNumber } = config.twilio;
  if (!accountSid || !authToken || !fromNumber) {
    throw new Error('TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER are required');
  }
  if (!config.publicBaseUrl) {
    throw new Error('PUBLIC_BASE_URL is required for Twilio webhooks');
  }
  return twilio(accountSid, authToken);
}

export async function dialConference({
  to,
  digits = '',
  title = 'phone-conference',
  note = '',
  notifyChatId = '',
  silenceTimeout = 120
}) {
  const client = twilioClient();
  const encodedTitle = encodeURIComponent(title);
  const encodedDigits = encodeURIComponent(digits);
  const encodedNote = encodeURIComponent(note);
  const encodedNotifyChatId = encodeURIComponent(notifyChatId);
  const encodedSilenceTimeout = encodeURIComponent(String(silenceTimeout));

  return client.calls.create({
    to,
    from: config.twilio.fromNumber,
    url: `${config.publicBaseUrl}/twilio/conference-twiml?title=${encodedTitle}&digits=${encodedDigits}&note=${encodedNote}&notifyChatId=${encodedNotifyChatId}&silenceTimeout=${encodedSilenceTimeout}`,
    record: true,
    recordingChannels: 'mono',
    recordingStatusCallback: `${config.publicBaseUrl}/twilio/recording?title=${encodedTitle}&note=${encodedNote}&notifyChatId=${encodedNotifyChatId}`,
    recordingStatusCallbackEvent: ['completed']
  });
}

export async function hangupCalls({ callSid = '' } = {}) {
  const client = twilioClient();

  if (callSid) {
    const call = await client.calls(callSid).update({ status: 'completed' });
    return [{ sid: call.sid, status: call.status }];
  }

  const statuses = ['queued', 'ringing', 'in-progress'];
  const calls = [];
  for (const status of statuses) {
    const batch = await client.calls.list({ status, limit: 20 });
    calls.push(...batch);
  }

  const outboundCalls = calls.filter((call) => call.from === config.twilio.fromNumber);
  const uniqueCalls = [...new Map(outboundCalls.map((call) => [call.sid, call])).values()];
  const results = [];

  for (const call of uniqueCalls) {
    const updated = await client.calls(call.sid).update({ status: 'completed' });
    results.push({ sid: updated.sid, status: updated.status });
  }

  return results;
}
