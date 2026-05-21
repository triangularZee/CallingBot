import { config } from '../config.js';
import { openAsBlob } from 'node:fs';
import path from 'node:path';

export function resolveTelegramChatId(chatId = '') {
  return String(chatId || config.telegram.chatId || config.telegram.allowedChatIds[0] || '').trim();
}

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

function splitTelegramText(text, maxLength = 3600) {
  const value = String(text ?? '');
  if (value.length <= maxLength) return [value];

  const chunks = [];
  let current = '';

  for (const line of value.split('\n')) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= maxLength) {
      current = next;
      continue;
    }

    if (current) chunks.push(current);

    if (line.length <= maxLength) {
      current = line;
      continue;
    }

    for (let offset = 0; offset < line.length; offset += maxLength) {
      chunks.push(line.slice(offset, offset + maxLength));
    }
    current = '';
  }

  if (current) chunks.push(current);
  return chunks;
}

export async function sendTelegramLongMessage(chatId, text, options = {}) {
  const targetChatId = resolveTelegramChatId(chatId);
  if (!config.telegram.botToken || !targetChatId) return false;

  const chunks = splitTelegramText(text, options.maxLength ?? 3600);
  const total = chunks.length;

  for (let index = 0; index < total; index += 1) {
    const prefix = total > 1 ? `[${index + 1}/${total}]\n` : '';
    await sendTelegramMessage(targetChatId, `${prefix}${chunks[index]}`);
  }

  return true;
}

export async function sendRecordingResult(chatId, result, options = {}) {
  const targetChatId = resolveTelegramChatId(chatId);
  if (!config.telegram.botToken || !targetChatId) return false;

  const title = options.title ?? 'meeting';
  const summary = String(result.summary ?? '').trim() || '요약 결과가 비어 있습니다.';
  const lines = [
    `*${title}*`,
    options.stopReason ? `stop: ${options.stopReason}` : '',
    '',
    summary
  ].filter((line) => line !== '');

  return sendTelegramLongMessage(targetChatId, lines.join('\n'));
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
