import 'dotenv/config';
import { Bot } from 'grammy';
import { config } from '../config.js';
import { dialConference } from '../call/twilioCallBot.js';
import { parseCallCommand, callCommandHelp } from './parseCommand.js';

if (!config.telegram.botToken) {
  throw new Error('TELEGRAM_BOT_TOKEN is required');
}

function isAllowed(ctx) {
  if (config.telegram.allowedChatIds.length === 0) return true;
  return config.telegram.allowedChatIds.includes(String(ctx.chat?.id));
}

const bot = new Bot(config.telegram.botToken);

bot.command('start', async (ctx) => {
  if (!isAllowed(ctx)) return;
  await ctx.reply(callCommandHelp());
});

bot.command('help', async (ctx) => {
  if (!isAllowed(ctx)) return;
  await ctx.reply(callCommandHelp());
});

bot.command('call', async (ctx) => {
  if (!isAllowed(ctx)) {
    await ctx.reply('이 채팅은 허용 목록에 없습니다.');
    return;
  }

  try {
    const job = parseCallCommand(ctx.message?.text ?? '');
    const call = await dialConference({
      ...job,
      notifyChatId: String(ctx.chat.id)
    });

    await ctx.reply([
      '전화 연결을 시작했습니다.',
      `to: ${job.to}`,
      `title: ${job.title}`,
      `callSid: ${call.sid}`,
      '',
      '통화가 종료되고 녹음 파일이 준비되면 녹취 및 Gemini 요약 결과를 보내겠습니다.'
    ].join('\n'));
  } catch (error) {
    await ctx.reply(`${error.message}\n\n${callCommandHelp()}`);
  }
});

bot.catch((error) => {
  console.error('Telegram bot error:', error);
});

bot.start();
console.log('Telegram bot started with long polling');
