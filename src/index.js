import dotenv from 'dotenv';
import { Telegraf } from 'telegraf';
import pino from 'pino';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

dotenv.config();

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const botToken = process.env.BOT_TOKEN;
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

bot.start(async (ctx) => {
  await ctx.reply('Привет! Я готов к розыгрышам. Добавьте меня в канал как администратора для доступа к участникам.  ');
});

bot.command('ping', async (ctx) => {
  await ctx.reply('pong');
});

bot.catch((err, ctx) => {
  logger.error({ err }, 'Bot error');
});

async function launch() {
  logger.info('Launching bot...');
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


