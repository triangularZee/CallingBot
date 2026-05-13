import 'dotenv/config';
import { createTelegramBot } from './createBot.js';

const bot = createTelegramBot();
bot.start();
console.log('Telegram bot started with long polling');
