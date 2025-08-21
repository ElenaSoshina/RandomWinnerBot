import dotenv from 'dotenv';
import { Telegraf } from 'telegraf';
import pino from 'pino';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { buildMProxyFromEnv } from './mproxyClient.js';
import { startMProxyServer } from './mproxy-server.js';
import { pickUniqueRandom } from './giveaway.js';

dotenv.config();

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Читаем токен из переменных окружения и страхуемся от лишних пробелов/переводов строки
const rawToken = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const botToken = rawToken.trim();
if (!botToken) {
  logger.error('BOT_TOKEN is required');
  process.exit(1);
}

function buildAgentFromEnv() {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || '';
  if (!proxyUrl) return undefined;
  try {
    if (proxyUrl.startsWith('socks')) {
      return new SocksProxyAgent(proxyUrl);
    }
    return new HttpsProxyAgent(proxyUrl);
  } catch (err) {
    logger.warn({ err }, 'Failed to configure proxy agent');
    return undefined;
  }
}

const telegrafOptions = {};
const agent = buildAgentFromEnv();
if (agent) {
  telegrafOptions.telegram = { agent };
}

const bot = new Telegraf(botToken, telegrafOptions);
const mproxy = buildMProxyFromEnv();

bot.start(async (ctx) => {
  await ctx.reply('Привет! Я готов к розыгрышам. Добавьте меня в канал как администратора для доступа к участникам.  ');
});

bot.command('ping', async (ctx) => {
  await ctx.reply('pong');
});

bot.command('draw', async (ctx) => {
  if (!mproxy.isEnabled()) {
    return ctx.reply('MTProto недоступен: не настроен MProxy.');
  }
  const text = ctx.message.text.trim();
  const parts = text.split(/\s+/);
  if (parts.length < 3) {
    return ctx.reply('Использование: /draw <@channel|id> <кол-во_победителей>');
  }
  const channel = parts[1];
  const winnersCount = Math.max(1, parseInt(parts[2], 10) || 1);
  await ctx.reply(`Собираю участников канала ${channel}...`);
  try {
    const members = await mproxy.fetchMembers(channel, { limit: 100000 });
    const humans = members.filter((m) => !m.is_bot);
    const winners = pickUniqueRandom(humans, winnersCount);
    if (!winners.length) {
      return ctx.reply('Не найдено участников для розыгрыша.');
    }
    const list = winners.map((u, i) => `${i + 1}. ${u.username ? '@' + u.username : u.user_id}`).join('\n');
    await ctx.reply(`Победители:\n${list}`);
  } catch (err) {
    return ctx.reply(`Ошибка MProxy: ${err.message}`);
  }
});

bot.catch((err, ctx) => {
  logger.error({ err }, 'Bot error');
});

async function launch() {
  logger.info('Launching bot...');

  // Опциональный запуск встроенного MProxy с гибкой интерпретацией флага — запускаем до бота
  const rawFlag = (process.env.ENABLE_MPROXY || '').trim().toLowerCase();
  const normalizedFlag = rawFlag.replace(/^["']|["']$/g, '');
  const enableMproxy = ['true', '1', 'yes', 'on'].includes(normalizedFlag);
  if (enableMproxy) {
    logger.info('ENABLE_MPROXY is true; starting embedded MProxy server');
    startMProxyServer();
  } else {
    logger.info({ ENABLE_MPROXY: process.env.ENABLE_MPROXY }, 'Embedded MProxy disabled');
  }

  await bot.launch();
  logger.info('Bot launched');

  const signals = ['SIGINT', 'SIGTERM', 'SIGQUIT'];
  for (const signal of signals) {
    process.once(signal, async () => {
      logger.info({ signal }, 'Shutting down');
      await bot.stop('graceful-stop');
      process.exit(0);
    });
  }
}

launch().catch((err) => {
  logger.error({ err }, 'Failed to launch bot');
  process.exit(1);
});


