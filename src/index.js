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

// Простая сессия в памяти для пошаговых сценариев
const userState = new Map(); // key: from.id, value: { action, step, data }

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function formatUserLink(user) {
  const id = escapeHtml(user.user_id);
  const nameTextRaw = `${user.first_name || ''} ${user.last_name || ''}`.trim();
  const hasName = Boolean(nameTextRaw);
  const nameText = hasName ? escapeHtml(nameTextRaw) : '';
  if (user.username) {
    const uname = escapeHtml(user.username);
    return `<a href="https://t.me/${uname}">@${uname}</a>`;
  }
  const nameSuffix = hasName ? ` (${nameText})` : '';
  return `<a href="tg://user?id=${id}">id:${id}</a>${nameSuffix}`;
}

bot.start(async (ctx) => {
  await showMainMenu(ctx, 'Привет! Я помогу собрать участников и провести розыгрыш. Выберите действие ниже.');
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
    const list = winners.map((u, i) => `${i + 1}. ${formatUserLink(u)}`).join('\n');
    await ctx.replyWithHTML(`Победители:\n${list}`, { disable_web_page_preview: true });
  } catch (err) {
    return ctx.reply(`Ошибка MProxy: ${err.message}`);
  }
});

// Кнопка массовой отправки сообщений победителям
bot.action(/msg_winners:.+/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!mproxy.isEnabled()) return ctx.reply('MTProto недоступен: не настроен MProxy.');
  const data = ctx.match.input.split(':')[1];
  let ids = [];
  try { ids = JSON.parse(decodeURIComponent(data)); } catch (e) { ids = []; }
  if (!Array.isArray(ids) || ids.length === 0) {
    return ctx.reply('Список победителей пуст.');
  }
  userState.set(ctx.from.id, { action: 'send_msg', step: 1, data: { ids } });
  await ctx.reply('Введите текст сообщения для победителей:', {
    reply_markup: { inline_keyboard: [[{ text: '⬅️ В меню', callback_data: 'menu_main' }]] },
  });
});

bot.command('whois', async (ctx) => {
  const text = ctx.message.text.trim();
  const parts = text.split(/\s+/);
  if (parts.length < 2) {
    return ctx.reply('Использование: /whois <user_id|@username>');
  }
  const arg = parts[1];
  if (arg.startsWith('@')) {
    const uname = escapeHtml(arg.slice(1));
    return ctx.replyWithHTML(`Профиль: <a href="https://t.me/${uname}">@${uname}</a>`, { disable_web_page_preview: true });
  }
  const id = String(arg).replace(/[^0-9]/g, '');
  if (!id) return ctx.reply('Некорректный id');
  return ctx.replyWithHTML(`Профиль: <a href="tg://user?id=${id}">id:${escapeHtml(id)}</a>`, { disable_web_page_preview: true });
});

// ---------- Меню и кнопки ----------
function mainMenuKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Список участников', callback_data: 'menu_members' },
          { text: 'Розыгрыш', callback_data: 'menu_draw' },
        ],
      ],
    },
  };
}

async function showMainMenu(ctx, text = 'Главное меню') {
  userState.delete(ctx.from.id);
  await ctx.reply(text, mainMenuKeyboard());
}

bot.action('menu_main', async (ctx) => {
  await ctx.answerCbQuery();
  await showMainMenu(ctx);
});

bot.action('menu_members', async (ctx) => {
  await ctx.answerCbQuery();
  if (!mproxy.isEnabled()) return ctx.reply('MTProto недоступен: не настроен MProxy.');
  // Без пагинации: всегда загружаем всех участников
  userState.set(ctx.from.id, { action: 'ask_target', nextAction: 'members_all', data: {} });
  await ctx.reply('Шаг 1. Введите username группы. Я добавлю нашего клиента и загружу всех участников.', {
    reply_markup: { inline_keyboard: [[{ text: '⬅️ В меню', callback_data: 'menu_main' }]] },
  });
});

bot.action('menu_members_all', async (ctx) => {
  await ctx.answerCbQuery();
  if (!mproxy.isEnabled()) return ctx.reply('MTProto недоступен: не настроен MProxy.');
  userState.set(ctx.from.id, { action: 'ask_target', nextAction: 'members_all', data: {} });
  await ctx.reply('Шаг 1. Введите username группы. Подключу клиента и загружу всех участников.', {
    reply_markup: { inline_keyboard: [[{ text: '⬅️ В меню', callback_data: 'menu_main' }]] },
  });
});

bot.action('menu_draw', async (ctx) => {
  await ctx.answerCbQuery();
  if (!mproxy.isEnabled()) return ctx.reply('MTProto недоступен: не настроен MProxy.');
  userState.set(ctx.from.id, { action: 'ask_target', nextAction: 'draw', data: {} });
  await ctx.reply('Шаг 1. Введите username группы. Подключу клиента и затем попрошу число победителей.', {
    reply_markup: { inline_keyboard: [[{ text: '⬅️ В меню', callback_data: 'menu_main' }]] },
  });
});

// Кнопки Whois в меню нет; команда /whois оставлена для отладки по желанию

// Общий обработчик текстов для пошаговых сценариев
bot.on('text', async (ctx, next) => {
  const st = userState.get(ctx.from.id);
  if (!st) return next();
  const text = ctx.message.text.trim();

  try {
    if (st.action === 'ask_target') {
      // Подключаем клиента к цели, затем переключаемся на следующий сценарий
      const target = text;
      await ctx.reply('Подключаю клиента к группе/каналу...');
      await mproxy.joinTarget(target);
      if (st.nextAction === 'members') {
        userState.set(ctx.from.id, { action: 'members', step: 1, data: { channel: target } });
        return ctx.reply('Подключение выполнено. Укажите limit и offset через пробел, или отправьте пусто для по умолчанию (50 0).');
      }
      if (st.nextAction === 'members_all') {
        const channel = target;
        await ctx.reply(`Загружаю всех участников ${channel}...`);
        const members = await mproxy.fetchAllMembers(channel, { pageSize: 500, hardMax: 100000 });
        if (!members.length) {
          await ctx.reply('Участники не найдены.', mainMenuKeyboard());
        } else {
          const lines = members.map((u, i) => `${i + 1}. ${formatUserLink(u)}`);
          await sendChunkedHtml(ctx, lines);
        }
        return showMainMenu(ctx, 'Готово.');
      }
      if (st.nextAction === 'draw') {
        userState.set(ctx.from.id, { action: 'draw', step: 2, data: { channel: target } });
        return ctx.reply('Шаг 2. Укажите количество победителей (число).');
      }
    }

    if (st.action === 'members') {
      // text: <group> [limit] [offset]
      const parts = text.split(/\s+/);
      const channel = st.data.channel || parts[0];
      const limit = Math.min(Math.max(parseInt(parts[1], 10) || 50, 1), 200);
      const offset = Math.max(parseInt(parts[2], 10) || 0, 0);
      await ctx.reply(`Загружаю участников ${channel} (limit=${limit}, offset=${offset})...`);
      const members = await mproxy.fetchMembers(channel, { limit, offset });
      if (!members.length) {
        await ctx.reply('Участники не найдены.', mainMenuKeyboard());
      } else {
        const lines = members.map((u, i) => `${offset + i + 1}. ${formatUserLink(u)}`);
        await sendChunkedHtml(ctx, lines);
      }
      return showMainMenu(ctx, 'Готово.');
    }

    if (st.action === 'members_all') {
      const channel = text;
      await ctx.reply(`Загружаю всех участников ${channel}...`);
      const members = await mproxy.fetchAllMembers(channel, { pageSize: 500, hardMax: 100000 });
      if (!members.length) {
        await ctx.reply('Участники не найдены.', mainMenuKeyboard());
      } else {
        const lines = members.map((u, i) => `${i + 1}. ${formatUserLink(u)}`);
        await sendChunkedHtml(ctx, lines);
      }
      return showMainMenu(ctx, 'Готово.');
    }

    if (st.action === 'draw') {
      if (st.step === 1) {
        st.data.channel = text;
        st.step = 2;
        userState.set(ctx.from.id, st);
        return ctx.reply('Шаг 2/2. Укажите количество победителей (число).', {
          reply_markup: { inline_keyboard: [[{ text: '⬅️ В меню', callback_data: 'menu_main' }]] },
        });
      }
      if (st.step === 2) {
        const winnersCount = Math.max(1, parseInt(text, 10) || 1);
        const channel = st.data.channel;
        await ctx.reply(`Собираю участников канала ${channel}...`);
        const members = await mproxy.fetchMembers(channel, { limit: 100000 });
        const humans = members.filter((m) => !m.is_bot);
        const winners = pickUniqueRandom(humans, winnersCount);
        if (!winners.length) {
          await ctx.reply('Не найдено участников для розыгрыша.', mainMenuKeyboard());
        } else {
          const list = winners.map((u, i) => `${i + 1}. ${formatUserLink(u)}`);
          const winnersIds = winners.map((u) => u.user_id);
          await ctx.replyWithHTML(`Победители:\n${list.join('\n')}`, {
            disable_web_page_preview: true,
            reply_markup: {
              inline_keyboard: [[{ text: 'Написать победителям', callback_data: `msg_winners:${encodeURIComponent(JSON.stringify(winnersIds))}` }]],
            },
          });
        }
        return showMainMenu(ctx, 'Готово.');
      }
    }

    if (st.action === 'whois') {
      if (text.startsWith('@')) {
        const uname = escapeHtml(text.slice(1));
        await ctx.replyWithHTML(`Профиль: <a href="https://t.me/${uname}">@${uname}</a>`, { disable_web_page_preview: true });
      } else {
        const id = String(text).replace(/[^0-9]/g, '');
        if (!id) return ctx.reply('Некорректный ввод. Нужен @username или числовой id.');
        await ctx.replyWithHTML(`Профиль: <a href="tg://user?id=${id}">id:${escapeHtml(id)}</a>`, { disable_web_page_preview: true });
      }
      return showMainMenu(ctx, 'Готово.');
    }

    if (st.action === 'send_msg') {
      const ids = st.data.ids || [];
      const textMessage = text;
      await ctx.reply('Отправляю сообщения победителям...');
      const result = await mproxy.sendMessages(ids, textMessage);
      await ctx.reply(`Отправлено: ${result.sent}/${result.total}`);
      return showMainMenu(ctx, 'Готово.');
    }
  } catch (err) {
    await ctx.reply(`Ошибка: ${err.message}`, mainMenuKeyboard());
    return showMainMenu(ctx);
  }

  return next();
});

async function sendChunkedHtml(ctx, lines) {
  const chunks = [];
  let current = [];
  let len = 0;
  for (const line of lines) {
    if (len + line.length + 1 > 3500) {
      chunks.push(current.join('\n'));
      current = [];
      len = 0;
    }
    current.push(line);
    len += line.length + 1;
  }
  if (current.length) chunks.push(current.join('\n'));
  for (const chunk of chunks) {
    // eslint-disable-next-line no-await-in-loop
    await ctx.replyWithHTML(chunk, { disable_web_page_preview: true });
  }
}

bot.command('members', async (ctx) => {
  if (!mproxy.isEnabled()) {
    return ctx.reply('MTProto недоступен: не настроен MProxy.');
  }
  const text = ctx.message.text.trim();
  const parts = text.split(/\s+/);
  if (parts.length < 2) {
    return ctx.reply('Использование: /members <@group|id> [limit] [offset]');
  }
  const channel = parts[1];
  const limit = Math.min(Math.max(parseInt(parts[2], 10) || 50, 1), 200);
  const offset = Math.max(parseInt(parts[3], 10) || 0, 0);
  await ctx.reply(`Загружаю участников ${channel} (limit=${limit}, offset=${offset})...`);
  try {
    const members = await mproxy.fetchMembers(channel, { limit, offset });
    if (!members.length) {
      return ctx.reply('Участники не найдены.');
    }
    const lines = members.map((u, i) => `${offset + i + 1}. ${formatUserLink(u)}`);
    const chunks = [];
    let current = [];
    let len = 0;
    for (const line of lines) {
      if (len + line.length + 1 > 3500) {
        chunks.push(current.join('\n'));
        current = [];
        len = 0;
      }
      current.push(line);
      len += line.length + 1;
    }
    if (current.length) chunks.push(current.join('\n'));
    for (const chunk of chunks) {
      // eslint-disable-next-line no-await-in-loop
      await ctx.replyWithHTML(chunk, { disable_web_page_preview: true });
    }
  } catch (err) {
    return ctx.reply(`Ошибка MProxy: ${err.message}`);
  }
});

bot.command('members_all', async (ctx) => {
  if (!mproxy.isEnabled()) {
    return ctx.reply('MTProto недоступен: не настроен MProxy.');
  }
  const text = ctx.message.text.trim();
  const parts = text.split(/\s+/);
  if (parts.length < 2) {
    return ctx.reply('Использование: /members_all <@group|id>');
  }
  const channel = parts[1];
  await ctx.reply(`Загружаю всех участников ${channel} (может занять время)...`);
  try {
    const members = await mproxy.fetchAllMembers(channel, { pageSize: 500, hardMax: 100000 });
    if (!members.length) {
      return ctx.reply('Участники не найдены.');
    }
    const lines = members.map((u, i) => `${i + 1}. ${formatUserLink(u)}`);
    const chunks = [];
    let current = [];
    let len = 0;
    for (const line of lines) {
      if (len + line.length + 1 > 3500) {
        chunks.push(current.join('\n'));
        current = [];
        len = 0;
      }
      current.push(line);
      len += line.length + 1;
    }
    if (current.length) chunks.push(current.join('\n'));
    for (const chunk of chunks) {
      // eslint-disable-next-line no-await-in-loop
      await ctx.replyWithHTML(chunk, { disable_web_page_preview: true });
    }
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


