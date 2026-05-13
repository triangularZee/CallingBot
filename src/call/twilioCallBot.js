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

export async function dialConference({ to, digits = '', title = 'phone-conference' }) {
  const client = twilioClient();
  const encodedTitle = encodeURIComponent(title);
  const encodedDigits = encodeURIComponent(digits);

  return client.calls.create({
    to,
    from: config.twilio.fromNumber,
    url: `${config.publicBaseUrl}/twilio/conference-twiml?title=${encodedTitle}&digits=${encodedDigits}`,
    record: true,
    recordingChannels: 'mono',
    recordingStatusCallback: `${config.publicBaseUrl}/twilio/recording?title=${encodedTitle}`,
    recordingStatusCallbackEvent: ['completed']
  });
}
