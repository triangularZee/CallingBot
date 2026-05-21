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

export async function sendRecordingResult(chatId, result, options = {}) {
  const targetChatId = resolveTelegramChatId(chatId);
  if (!config.telegram.botToken || !targetChatId) return false;

  const title = options.title ?? 'meeting';
  const summary = result.summary ?? '';
  const summaryPath = result.summaryPath ?? '';
  const transcriptPath = result.transcriptTextPath ?? result.transcriptPath ?? '';
  const lines = [
    `*${title}*`,
    options.stopReason ? `stop: ${options.stopReason}` : '',
    '',
    summary.slice(0, 3800),
    '',
    summary.length > 3800 && summaryPath ? `Summary is long. File: ${summaryPath}` : summaryPath ? `File: ${summaryPath}` : ''
  ].filter((line) => line !== '');

  await sendTelegramMessage(targetChatId, lines.join('\n'));
  const sendOptionalDocument = async (filePath, caption) => {
    try {
      await sendTelegramDocument(targetChatId, filePath, caption);
    } catch (error) {
      console.warn(`Telegram document send skipped: ${error.message}`);
    }
  };

  if (summaryPath) {
    await sendOptionalDocument(summaryPath, `Summary: ${title}`);
  }
  if (transcriptPath) {
    await sendOptionalDocument(transcriptPath, `Transcript: ${title}`);
  }
  if (options.recordingPath) {
    await sendOptionalDocument(options.recordingPath, `Recording: ${title}`);
  }

  return true;
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
