import 'dotenv/config';
import { config } from '../config.js';

if (!config.telegram.botToken) {
  throw new Error('TELEGRAM_BOT_TOKEN is required');
}

if (!config.publicBaseUrl) {
  throw new Error('PUBLIC_BASE_URL is required');
}

const url = `${config.publicBaseUrl.replace(/\/$/, '')}/telegram/webhook`;
const response = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/setWebhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url,
    drop_pending_updates: true,
    allowed_updates: ['message']
  })
});

const result = await response.json();
console.log(JSON.stringify({
  ok: result.ok,
  description: result.description,
  webhookUrl: url
}, null, 2));
