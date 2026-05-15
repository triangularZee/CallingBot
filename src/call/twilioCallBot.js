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
