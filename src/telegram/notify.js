import { config } from '../config.js';
import { openAsBlob } from 'node:fs';
import path from 'node:path';

export async function sendTelegramMessage(chatId, text) {
  if (!config.telegram.botToken || !chatId) return;

  const response = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram sendMessage failed: ${response.status} ${body}`);
  }
}

export async function sendTelegramDocument(chatId, filePath, caption = '') {
  if (!config.telegram.botToken || !chatId) return;

  const form = new FormData();
  const file = await openAsBlob(filePath);
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption);
  form.append('document', file, path.basename(filePath));

  const response = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/sendDocument`, {
    method: 'POST',
    body: form
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram sendDocument failed: ${response.status} ${body}`);
  }
}
