import { pickUniqueRandom, pickUniqueWeighted } from '../giveaway.js';
import { userState, giveaways, putEphemeral, getEphemeral, appendHistory, readHistory, historyCount } from '../state.js';
import { escapeHtml, formatUserLink, sendChunkedHtml, buildExcludedUsernamesFromEnv, filterEligibleMembers } from '../utils.js';

export function registerBotHandlers({ bot, mproxy, logger, enablePostGiveaway }) {
  const EXCLUDED_USERNAMES = buildExcludedUsernamesFromEnv(process.env.EXCLUDE_USERNAMES);
  const DEFAULT_GROUP = process.env.DEFAULT_GROUP || '@MS_Geldbaum';
  const pendingReferrals = new Map(); // userId -> { giveawayId, referrerId, ts }

  function mainMenuKeyboard() {
    return {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '👥 Список участников', callback_data: 'menu_members' },
            { text: '🎁 Розыгрыш', callback_data: 'menu_draw' },
            ...(enablePostGiveaway ? [{ text: '🎯 Розыгрыш постом', callback_data: 'menu_draw_post' }] : []),
          ],
          [
            { text: '📜 История', callback_data: 'menu_history' },
          ],
        ],
      },
    };
  }

  async function askDrawPostChannel(ctx, errorText = '') {
    const prefix = errorText
      ? `❌ ${errorText}\n\n`
      : '';
    return ctx.reply(
      `${prefix}Шаг 1. Укажите канал/группу в формате @username (например, @my_group), где будет опубликован розыгрыш.\nВведите значение ещё раз:`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: DEFAULT_GROUP, callback_data: 'target_default' }],
            [{ text: '⬅️ В меню', callback_data: 'menu_main' }],
          ],
        },
      }
    );
  }

  async function showMainMenu(ctx, text = 'Главное меню') {
    userState.delete(ctx.from.id);
    await ctx.replyWithHTML(text, mainMenuKeyboard());
  }

  function parseStartPayload(payload) {
    const sepIdx = payload.indexOf('_');
    if (sepIdx === -1) return { giveawayId: payload, referrerId: '' };
    return {
      giveawayId: payload.slice(0, sepIdx),
      referrerId: payload.slice(sepIdx + 1),
    };
  }

  function buildEntryUser(ctx) {
    return {
      user_id: String(ctx.from.id),
      username: ctx.from.username || null,
      first_name: ctx.from.first_name || null,
      last_name: ctx.from.last_name || null,
    };
  }

  async function isSubscribedToTarget(ctx, target, userId) {
    try {
      const chat = await ctx.telegram.getChat(target);
      const member = await ctx.telegram.getChatMember(chat.id, userId);
      return ['creator', 'administrator', 'member', 'restricted'].includes(member.status);
    } catch (e) {
      return false;
    }
  }

  function parsePositiveIntInRange(raw, { min = 1, max = 1000 } = {}) {
    const s = String(raw || '').trim();
    if (!/^\d+$/.test(s)) return 0;
    const n = parseInt(s, 10);
    if (n < min || n > max) return 0;
    return n;
  }

  function isValidTelegramUsername(value) {
    const target = String(value || '').trim();
    return /^@[A-Za-z0-9_]{4,}$/.test(target);
  }

  function isValidChannelRef(value) {
    const s = String(value || '').trim();
    return isValidTelegramUsername(s) || /^-?\d+$/.test(s);
  }

  function drawPostWinnersPrompt(errorText = '') {
    const prefix = errorText ? `❌ ${errorText}\n\n` : '';
    return `${prefix}Шаг 2. Укажите количество победителей (целое число от 1 до 1000).\nВведите значение ещё раз:`;
  }

  function drawWinnersPrompt(errorText = '') {
    const prefix = errorText ? `❌ ${errorText}\n\n` : '';
    return `${prefix}Шаг 2/2. Укажите количество победителей (целое число от 1 до 1000).`;
  }

  async function validatePostTarget(ctx, rawTarget) {
    const target = String(rawTarget || '').trim();
    if (!target) {
      return { ok: false, error: 'Введите username канала/группы в формате @channel.' };
    }
    if (!isValidTelegramUsername(target)) {
      return { ok: false, error: 'Некорректный username. Пример: @my_group' };
    }
    try {
      const chat = await ctx.telegram.getChat(target);
      const botMe = await ctx.telegram.getMe();
      const member = await ctx.telegram.getChatMember(chat.id, botMe.id).catch(() => null);
      if (!member || ['left', 'kicked'].includes(member.status)) {
        return { ok: false, error: 'Бот не добавлен в этот чат. Добавьте бота и попробуйте снова.' };
      }
      if (chat.type === 'channel' && !['creator', 'administrator'].includes(member.status)) {
        return { ok: false, error: 'Для канала у бота должны быть права администратора на публикацию.' };
      }
      if (member.status === 'restricted' && member.can_send_messages === false) {
        return { ok: false, error: 'У бота нет права отправки сообщений в этом чате.' };
      }
      const normalized = chat.username ? `@${chat.username}` : target;
      return { ok: true, channel: normalized };
    } catch (err) {
      return { ok: false, error: 'Не удалось найти чат. Проверьте username и доступ бота.' };
    }
  }

  async function registerGiveawayEntry({ ctx, giveawayId, referrerId = '' }) {
    const g = giveaways.get(giveawayId);
    if (!g) return { ok: false, reason: 'not_found' };
    if (!(g.referrerByInvitee instanceof Map)) g.referrerByInvitee = new Map();
    if (!(g.referralsByUser instanceof Map)) g.referralsByUser = new Map();

    const user = buildEntryUser(ctx);
    const uid = String(user.user_id);
    const isSubscribed = await isSubscribedToTarget(ctx, g.channel, ctx.from.id);
    if (!isSubscribed) {
      return { ok: false, reason: 'not_subscribed' };
    }
    const wasNewParticipant = !g.entries.has(uid);
    if (wasNewParticipant) g.entries.set(uid, user);

    const normalizedReferrerId = String(referrerId || '').replace(/[^0-9]/g, '');
    let creditedReferrerId = '';
    if (wasNewParticipant && normalizedReferrerId) {
      if (normalizedReferrerId !== uid && g.entries.has(normalizedReferrerId) && !g.referrerByInvitee.has(uid)) {
        g.referrerByInvitee.set(uid, normalizedReferrerId);
        const refs = g.referralsByUser.get(normalizedReferrerId) || new Set();
        refs.add(uid);
        g.referralsByUser.set(normalizedReferrerId, refs);
        creditedReferrerId = normalizedReferrerId;
      }
    }

    const count = g.entries.size;
    if (g.botMessageId) {
      await ctx.telegram.editMessageReplyMarkup(g.channel, g.botMessageId, undefined, {
        inline_keyboard: [[{ text: `✅ Участвовать (${count})`, callback_data: `gwj:${giveawayId}` }]],
      }).catch(() => {});
    }

    const botMe = await ctx.telegram.getMe();
    const deepLink = `https://t.me/${botMe.username}?start=${giveawayId}_${uid}`;
    const ownReferrals = g.referralsByUser.get(uid)?.size || 0;
    const ownTickets = 1 + ownReferrals;
    await ctx.telegram.sendMessage(
      ctx.from.id,
      `✅ Вы выполнили условия и участвуете в розыгрыше!\n\nВаша реферальная ссылка:\n${deepLink}\n\nПриглашено друзей: ${ownReferrals}\nВаших билетов: ${ownTickets}`,
      { disable_web_page_preview: true }
    ).catch(() => {});

    if (creditedReferrerId) {
      const refCount = g.referralsByUser.get(creditedReferrerId)?.size || 0;
      const refTickets = 1 + refCount;
      await ctx.telegram.sendMessage(
        Number(creditedReferrerId),
        `🎉 Новый приглашённый подтверждён!\nПриглашено друзей: ${refCount}\nВаших билетов: ${refTickets}`
      ).catch(() => {});
    }

    return { ok: true, wasNewParticipant };
  }

  async function handleAskTarget(ctx, st, target) {
    if (!isValidTelegramUsername(target)) {
      return ctx.reply('Некорректный username. Используйте формат @group_name и введите ещё раз.');
    }
    await ctx.reply('Проверяю права и подключение...');
    const botMe = await ctx.telegram.getMe();
    const clientMe = await mproxy.me().catch(() => null);
    let botStatus = 'не в канале';
    try {
      const chat = await ctx.telegram.getChat(target);
      const member = await ctx.telegram.getChatMember(chat.id, botMe.id);
      botStatus = member.status;
    } catch (e) {}
    const clientMember = await mproxy.isMember(target).catch(() => ({ is_member: false }));
    if (!clientMember.is_member) {
      await ctx.reply(`Клиент ${clientMe?.username ? '@' + clientMe.username : clientMe?.first_name || 'аккаунт'} не в группе — добавляю...`);
      await mproxy.joinTarget(target);
    }
    if (st.nextAction === 'members') {
      userState.set(ctx.from.id, { action: 'members', step: 1, data: { channel: target } });
      return ctx.reply('Подключение выполнено. Загружаю участников...');
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
      return ctx.reply(drawWinnersPrompt());
    }
    return undefined;
  }

  bot.start(async (ctx) => {
    // deep-link регистрация участия в розыгрыше по start=<giveawayId>[_<referrerId>]
    const payload = (ctx.startPayload || '').trim();
    if (payload) {
      const { giveawayId, referrerId } = parseStartPayload(payload);
      if (giveaways.has(giveawayId)) {
        const uid = String(ctx.from.id);
        const cleanReferrerId = String(referrerId || '').replace(/[^0-9]/g, '');
        pendingReferrals.set(uid, { giveawayId, referrerId: cleanReferrerId, ts: Date.now() });
        await ctx.reply(
          'Чтобы стать участником, подпишитесь на канал @self_detail и нажмите кнопку «✅ Участвовать».',
          {
            reply_markup: {
              inline_keyboard: [[{ text: '✅ Участвовать', callback_data: `gwj:${giveawayId}` }]],
            },
          }
        );
        return;
      }
    }
    await showMainMenu(
      ctx,
      '👋 <b>Привет!</b> Я помогу собрать участников и провести розыгрыш.\n\n' +
        'Как это работает:\n' +
        '1) Нажмите «👥 Список участников» — укажите <b>username группы</b>. Я покажу полный список.\n' +
        '2) Нажмите «🎁 Розыгрыш» — укажите <b>username группы</b> и <b>количество победителей</b>. После выбора появится кнопка «✉️ Написать победителям».\n' +
        (enablePostGiveaway ? '3) Или «🎯 Розыгрыш постом» — опубликуйте пост с кнопкой «Участвовать» и укажите время завершения.\n\n' : '\n') +
        'ℹ️ Используйте <b>группу/обсуждение</b>, а не канал‑трансляцию.'
    );
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
    if (!isValidChannelRef(channel)) {
      return ctx.reply('Некорректный канал. Используйте @channel_username или числовой id.');
    }
    const winnersCount = parsePositiveIntInRange(parts[2], { min: 1, max: 1000 });
    if (!winnersCount) {
      return ctx.reply('Количество победителей должно быть целым числом от 1 до 1000.');
    }
    await ctx.reply(`Собираю участников канала ${channel}...`);
    try {
      const members = await mproxy.fetchMembers(channel, { limit: 100000 });
      const eligible = await filterEligibleMembers({ mproxy, channel, members, excludedUsernames: EXCLUDED_USERNAMES });
      const winners = pickUniqueRandom(eligible, winnersCount);
      if (!winners.length) {
        return ctx.reply('Не найдено участников для розыгрыша.');
      }
      const list = winners.map((u, i) => `${i + 1}. ${formatUserLink(u)}`).join('\n');
      await ctx.replyWithHTML(`Победители:\n${list}`, { disable_web_page_preview: true });
    } catch (err) {
      return ctx.reply(`Ошибка MProxy: ${err.message}`);
    }
  });

  // Массовая отправка сообщений победителям
  bot.action(/msg_winners:.+/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!mproxy.isEnabled()) return ctx.reply('MTProto недоступен: не настроен MProxy.');
    const token = ctx.match.input.split(':')[1];
    const recipients = getEphemeral(token) || [];
    if (!Array.isArray(recipients) || recipients.length === 0) {
      return ctx.reply('Список победителей пуст.');
    }
    userState.set(ctx.from.id, { action: 'send_msg', step: 1, data: { recipients } });
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

  bot.action('menu_main', async (ctx) => {
    await ctx.answerCbQuery();
    await showMainMenu(ctx);
  });

  bot.action('menu_members', async (ctx) => {
    await ctx.answerCbQuery();
    if (!mproxy.isEnabled()) return ctx.reply('MTProto недоступен: не настроен MProxy.');
    userState.set(ctx.from.id, { action: 'ask_target', nextAction: 'members_all', data: {} });
    await ctx.reply('Шаг 1. Введите username группы. Я добавлю нашего клиента и загружу всех участников.', {
      reply_markup: { inline_keyboard: [
        [{ text: DEFAULT_GROUP, callback_data: 'target_default' }],
        [{ text: '⬅️ В меню', callback_data: 'menu_main' }],
      ] },
    });
  });

  bot.action('menu_members_all', async (ctx) => {
    await ctx.answerCbQuery();
    if (!mproxy.isEnabled()) return ctx.reply('MTProto недоступен: не настроен MProxy.');
    userState.set(ctx.from.id, { action: 'ask_target', nextAction: 'members_all', data: {} });
    await ctx.reply('Шаг 1. Введите username группы. Подключу клиента и загружу всех участников.', {
      reply_markup: { inline_keyboard: [
        [{ text: DEFAULT_GROUP, callback_data: 'target_default' }],
        [{ text: '⬅️ В меню', callback_data: 'menu_main' }],
      ] },
    });
  });

  bot.action('menu_draw', async (ctx) => {
    await ctx.answerCbQuery();
    userState.set(ctx.from.id, { action: 'ask_target', nextAction: 'draw', data: {} });
    await ctx.reply('Шаг 1. Введите username группы. Подключу клиента и затем попрошу число победителей.', {
      reply_markup: { inline_keyboard: [
        [{ text: DEFAULT_GROUP, callback_data: 'target_default' }],
        [{ text: '⬅️ В меню', callback_data: 'menu_main' }],
      ] },
    });
  });

  bot.action('menu_draw_post', async (ctx) => {
    await ctx.answerCbQuery();
    if (!enablePostGiveaway) {
      return ctx.reply('Розыгрыш по посту временно отключён.');
    }
    userState.set(ctx.from.id, { action: 'draw_post', step: 1, data: {} });
    await askDrawPostChannel(ctx);
  });

  bot.action('menu_history', async (ctx) => {
    await ctx.answerCbQuery();
    userState.set(ctx.from.id, { action: 'history', step: 1, data: {} });
    await ctx.reply('Введите username группы для просмотра истории (например, @group).', {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '@MS_Geldbaum', callback_data: 'history_default' },
            { text: '⬅️ В меню', callback_data: 'menu_main' },
          ],
        ],
      },
    });
  });

  bot.action('history_more', async (ctx) => {
    await ctx.answerCbQuery();
    const st = userState.get(ctx.from.id);
    if (!st || st.action !== 'history') {
      return ctx.reply('Сессия истории не найдена. Нажмите «📜 История».');
    }
    // Триггерим повторный проход обработчика текста с текущими параметрами
    const fakeText = st.data.channel;
    ctx.message = { text: fakeText }; // небольшая имитация
    return bot.handleUpdate(ctx.update);
  });

  bot.action('history_default', async (ctx) => {
    await ctx.answerCbQuery();
    const channel = '@MS_Geldbaum';
    const st = { action: 'history', step: 1, data: { channel, offset: 0 } };
    userState.set(ctx.from.id, st);
    const pageSize = 5;
    const total = historyCount(channel);
    const items = readHistory({ channel, limit: pageSize, offset: 0 });
    if (!items.length) {
      await ctx.reply('История пуста для указанной группы.', mainMenuKeyboard());
      return showMainMenu(ctx, 'Готово.');
    }
    const startIndex = Math.max(0, total - items.length) + 1;
    const lines = items.map((r, i) => {
      const when = new Date(r.ts || r.time || Date.now()).toLocaleString('ru-RU');
      const winnersFmt = (r.winners || []).map((u, idx) => `${idx + 1}. ${formatUserLink(u)}`).join('\n');
      return `#${startIndex + i} — ${when}\nТекст: ${escapeHtml(r.text || '')}\nПобедители:\n${winnersFmt}`;
    });
    await sendChunkedHtml(ctx, lines);
    const hasMore = pageSize < total;
    if (hasMore) {
      st.data.offset = pageSize;
      userState.set(ctx.from.id, st);
      await ctx.reply('Показать ещё?', {
        reply_markup: { inline_keyboard: [[{ text: '⬇️ Ещё', callback_data: 'history_more' }, { text: '⬅️ В меню', callback_data: 'menu_main' }]] },
      });
      return;
    }
    return showMainMenu(ctx, 'Готово.');
  });

  bot.action('target_default', async (ctx) => {
    await ctx.answerCbQuery();
    const st = userState.get(ctx.from.id);
    if (!st) return;
    // Автоподстановка для обычных сценариев выбора группы
    if (st.action === 'ask_target') {
      return handleAskTarget(ctx, st, DEFAULT_GROUP);
    }
    // Автоподстановка для розыгрыша по посту (шаг 1)
    if (st.action === 'draw_post' && st.step === 1) {
      const targetValidation = await validatePostTarget(ctx, DEFAULT_GROUP);
      if (!targetValidation.ok) {
        return askDrawPostChannel(ctx, targetValidation.error);
      }
      st.data.channel = targetValidation.channel;
      st.step = 2;
      userState.set(ctx.from.id, st);
      return ctx.reply('Шаг 2. Укажите количество победителей (число).');
    }
    return;
  });

  bot.on('text', async (ctx, next) => {
    const st = userState.get(ctx.from.id);
    if (!st) return next();
    const text = ctx.message.text.trim();

    try {
      if (st.action === 'ask_target') {
        const target = text;
        const res = await handleAskTarget(ctx, st, target);
        if (res !== undefined) return res;
      }

      if (st.action === 'draw_post') {
        if (st.step === 1) {
          const targetValidation = await validatePostTarget(ctx, text);
          if (!targetValidation.ok) {
            return askDrawPostChannel(ctx, targetValidation.error);
          }
          st.data.channel = targetValidation.channel;
          st.step = 2;
          userState.set(ctx.from.id, st);
          return ctx.reply(drawPostWinnersPrompt());
        }
        if (st.step === 2) {
          const num = parsePositiveIntInRange(text, { min: 1, max: 1000 });
          if (!num) {
            return ctx.reply(drawPostWinnersPrompt('Некорректное количество победителей.'));
          }
          st.data.winnersCount = num;
          st.step = 3;
          userState.set(ctx.from.id, st);
          return ctx.reply('Шаг 3. Отправьте текст поста или фото с подписью (будет опубликовано с кнопкой «Участвовать»).');
        }
        if (st.step === 3) {
          st.data.postText = text;
          st.step = 4;
          userState.set(ctx.from.id, st);
          return ctx.reply('Шаг 4. Укажите дату проведения (МСК), например: 16 сентября.');
        }
        if (st.step === 4) {
          const dateStr = text.trim();
          const parsedDate = parseRusDateToISO(dateStr);
          if (!parsedDate) {
            return ctx.reply('Некорректная дата. Примеры: 16 сентября, 05 марта');
          }
          st.data.date = parsedDate; // YYYY-MM-DD
          st.step = 5;
          userState.set(ctx.from.id, st);
          return ctx.reply('Шаг 5. Укажите время (МСК) в формате HH:mm или отправьте now для немедленного завершения.');
        }
        if (st.step === 5) {
          const timeStrRaw = text.trim();
          let ts;
          if (/^(now|сейчас)$/i.test(timeStrRaw)) {
            ts = Date.now();
          } else {
            const tsParsed = parseMskDateTime(st.data.date, timeStrRaw);
            if (!tsParsed) {
              return ctx.reply('Некорректное время. Пример: 18:30 или now.');
            }
            ts = tsParsed;
          }
          const { channel, winnersCount, postText, photoId } = st.data;
          await ctx.reply('Публикую пост в канале от имени бота...');
          const giveawayId = Math.random().toString(16).slice(2, 18);
          const joinBtnText = '✅ Участвовать (0)';
          let botButtonMessageId = null;
          try {
            let botMsg;
            if (photoId) {
              botMsg = await ctx.telegram.sendPhoto(channel, photoId, {
                caption: `${postText}\n\nНажмите кнопку ниже, чтобы участвовать:`,
                reply_markup: { inline_keyboard: [[{ text: joinBtnText, callback_data: `gwj:${giveawayId}` }]] },
              });
            } else {
              botMsg = await ctx.telegram.sendMessage(channel, `${postText}\n\nНажмите кнопку ниже, чтобы участвовать:`, {
                reply_markup: { inline_keyboard: [[{ text: joinBtnText, callback_data: `gwj:${giveawayId}` }]] },
                disable_web_page_preview: true,
              });
            }
            botButtonMessageId = botMsg.message_id;
          } catch (e) {
            await ctx.reply('Не удалось опубликовать пост от имени бота. Добавьте бота в группу и дайте право писать сообщения.');
            throw e;
          }

          giveaways.set(giveawayId, {
            channel,
            messageId: undefined,
            botMessageId: botButtonMessageId,
            winnersCount,
            entries: new Map(),
            referrerByInvitee: new Map(),
            referralsByUser: new Map(),
            createdBy: ctx.from.id,
            text: postText,
            scheduledAt: ts,
          });
          const finishToken = putEphemeral({ giveawayId });
          scheduleAutoFinish({ ctx, giveawayId, at: ts });
          await ctx.reply(`Пост опубликован. Розыгрыш будет завершён по расписанию.`, {
            reply_markup: { inline_keyboard: [[{ text: '🎉 Завершить сейчас', callback_data: `gwe:${finishToken}` }]] },
          });
          return showMainMenu(ctx, 'Готово. Розыгрыш запущен.');
        }
      }

      if (st.action === 'members') {
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
          return ctx.reply(drawWinnersPrompt(), {
            reply_markup: { inline_keyboard: [[{ text: '⬅️ В меню', callback_data: 'menu_main' }]] },
          });
        }
        if (st.step === 2) {
          const winnersCount = parsePositiveIntInRange(text, { min: 1, max: 1000 });
          if (!winnersCount) {
            return ctx.reply(drawWinnersPrompt('Некорректное количество победителей.'), {
              reply_markup: { inline_keyboard: [[{ text: '⬅️ В меню', callback_data: 'menu_main' }]] },
            });
          }
          const channel = st.data.channel;
          await ctx.reply(`Собираю участников канала ${channel}...`);
          const members = await mproxy.fetchMembers(channel, { limit: 100000 });
          const eligible = await filterEligibleMembers({ mproxy, channel, members, excludedUsernames: EXCLUDED_USERNAMES });
          const winners = pickUniqueRandom(eligible, winnersCount);
          if (!winners.length) {
            await ctx.reply('Не найдено участников для розыгрыша.', mainMenuKeyboard());
            return;
          }
          const list = winners.map((u, i) => `${i + 1}. ${formatUserLink(u)}`);
          const token = putEphemeral(winners);
          await ctx.replyWithHTML(`Победители:\n${list.join('\n')}`, {
            disable_web_page_preview: true,
            reply_markup: {
              inline_keyboard: [[{ text: '✉️ Написать победителям', callback_data: `msg_winners:${token}` }]],
            },
          });
          return;
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

      if (st.action === 'history') {
        const channel = st.data.channel || text.trim();
        if (!st.data.channel) {
          st.data.channel = channel;
          st.data.offset = 0;
        }
        const pageSize = 5;
        const total = historyCount(channel);
        const offset = st.data.offset || 0;
        const items = readHistory({ channel, limit: pageSize, offset });
        if (!items.length && offset === 0) {
          await ctx.reply('История пуста для указанной группы.', mainMenuKeyboard());
          return showMainMenu(ctx, 'Готово.');
        }
        const startIndex = Math.max(0, total - offset - items.length) + 1;
        const lines = items.map((r, i) => {
          const when = new Date(r.ts || r.time || Date.now()).toLocaleString('ru-RU');
          const winnersFmt = (r.winners || []).map((u, idx) => `${idx + 1}. ${formatUserLink(u)}`).join('\n');
          return `#${startIndex + i} — ${when}\nТекст: ${escapeHtml(r.text || '')}\nПобедители:\n${winnersFmt}`;
        });
        await sendChunkedHtml(ctx, lines);
        const hasMore = offset + pageSize < total;
        if (hasMore) {
          st.data.offset = offset + pageSize;
          userState.set(ctx.from.id, st);
          await ctx.reply('Показать ещё?', {
            reply_markup: { inline_keyboard: [[{ text: '⬇️ Ещё', callback_data: 'history_more' }, { text: '⬅️ В меню', callback_data: 'menu_main' }]] },
          });
          return;
        }
        return showMainMenu(ctx, 'Готово.');
      }

      if (st.action === 'send_msg') {
        const recipients = st.data.recipients || [];
        const textMessage = text;
        await ctx.reply('Отправляю сообщения победителям...');
        const result = await mproxy.sendMessages(recipients, textMessage);
        await ctx.reply(`Отправлено: ${result.sent}/${result.total}`);
        return showMainMenu(ctx, 'Готово.');
      }
    } catch (err) {
      await ctx.reply(`Ошибка: ${err.message}`, mainMenuKeyboard());
      return showMainMenu(ctx);
    }

    return next();
  });

  // Принимаем фото/документ на шаге 3, используем подпись как текст поста
  bot.on(['photo', 'document'], async (ctx, next) => {
    const st = userState.get(ctx.from.id);
    if (!st || st.action !== 'draw_post' || st.step !== 3) return next();
    try {
      const caption = (ctx.message.caption || '').trim();
      if (!caption) {
        return ctx.reply('Добавьте подпись к медиа — это и будет текст поста.');
      }
      let fileId = null;
      if (ctx.message.photo && Array.isArray(ctx.message.photo) && ctx.message.photo.length) {
        fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
      } else if (ctx.message.document && ctx.message.document.mime_type?.startsWith('image/')) {
        fileId = ctx.message.document.file_id;
      }
      if (!fileId) {
        return ctx.reply('Поддерживаются фото или изображения как документ. Попробуйте отправить изображение.');
      }
      st.data.postText = caption;
      st.data.photoId = fileId;
      st.step = 4;
      userState.set(ctx.from.id, st);
      return ctx.reply('Шаг 4. Укажите дату проведения (МСК), например: 16 сентября.');
    } catch (err) {
      await ctx.reply(`Ошибка обработки медиа: ${err.message}`);
    }
  });

  bot.action(/gwj:.+/, async (ctx) => {
    const id = ctx.match.input.split(':')[1];
    if (!giveaways.has(id)) {
      return ctx.answerCbQuery('Розыгрыш не найден или завершён', { show_alert: true });
    }
    const uid = String(ctx.from.id);
    const pending = pendingReferrals.get(uid);
    const referrerId = pending && pending.giveawayId === id ? pending.referrerId : '';
    const regResult = await registerGiveawayEntry({ ctx, giveawayId: id, referrerId });
    if (regResult.ok && pending && pending.giveawayId === id) {
      pendingReferrals.delete(uid);
    }
    if (!regResult.ok && regResult.reason === 'not_subscribed') {
      return ctx.answerCbQuery('Сначала подпишитесь на канал розыгрыша', { show_alert: true });
    }
    if (!regResult.ok) {
      return ctx.answerCbQuery('Розыгрыш не найден или завершён', { show_alert: true });
    }
    return ctx.answerCbQuery(regResult.wasNewParticipant ? 'Вы участвуете!' : 'Вы уже участвуете!', { show_alert: false });
  });

  bot.action(/gwe:.+/, async (ctx) => {
    await ctx.answerCbQuery();
    const token = ctx.match.input.split(':')[1];
    const data = getEphemeral(token);
    if (!data) return ctx.reply('Сессия завершения устарела.');
    const { giveawayId } = data;
    const ok = await finishGiveawayById({ botCtx: ctx, giveawayId });
    if (!ok) return; // сообщения уже отправлены внутри
  });

  bot.catch((err, ctx) => {
    logger.error({ err }, 'Bot error');
  });

  return { showMainMenu };
}

function parseScheduleToTs(str) {
  const sRaw = String(str || '').trim();
  const s = sRaw.toLowerCase();
  if (s === 'now' || s === 'сейчас') return Date.now();

  // If user provided explicit timezone like Z or +03:00, trust Date.parse
  if (/[zZ]|[+\-]\d{2}:?\d{2}$/.test(sRaw)) {
    const t = Date.parse(sRaw.replace(' ', 'T'));
    return Number.isFinite(t) ? t : 0;
  }

  // Treat bare datetime as Moscow time (UTC+3)
  const m = sRaw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return 0;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10) - 1; // 0-based
  const day = parseInt(m[3], 10);
  const hour = parseInt(m[4], 10);
  const minute = parseInt(m[5], 10);
  const second = m[6] ? parseInt(m[6], 10) : 0;
  // Moscow is UTC+3 → convert to UTC by subtracting 3 hours
  const ts = Date.UTC(year, month, day, hour - 3, minute, second, 0);
  return ts;
}

async function finishGiveawayById({ botCtx, giveawayId }) {
  const g = giveaways.get(giveawayId);
  if (!g) {
    await botCtx.reply('Розыгрыш уже завершён.');
    return false;
  }
  const participants = Array.from(g.entries.values());
  const winners = pickUniqueWeighted(
    participants,
    g.winnersCount,
    (u) => 1 + (g.referralsByUser?.get(String(u.user_id))?.size || 0)
  );
  const list = winners.map((u, i) => `<b>${i + 1}</b>. ${formatUserLink(u)}`).join('\n');
  try {
    const fancyHeader = '🎉 <b>Итоги розыгрыша</b> 🎉';
    const fancyFooter = '\n\n🚀 Поздравляем победителей! Спасибо всем за участие!';
    await botCtx.telegram.sendMessage(g.channel, `${fancyHeader}\n\n${list}${fancyFooter}`, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    if (g.botMessageId) {
      await botCtx.telegram.editMessageReplyMarkup(g.channel, g.botMessageId, undefined, {
        inline_keyboard: [[{ text: `⏹ Участие закрыто (${g.entries.size})`, callback_data: 'noop' }]],
      }).catch(() => {});
    }
  } catch (e) {
    await botCtx.reply(`Ошибка публикации итогов: ${e.message}`);
  }
  const msgToken = putEphemeral(winners);
  await botCtx.reply('Розыгрыш завершён.', {
    reply_markup: { inline_keyboard: [[{ text: '✉️ Написать победителям', callback_data: `msg_winners:${msgToken}` }]] },
  });
  // Append to file-based history
  appendHistory({
    channel: g.channel,
    messageId: g.botMessageId || g.messageId,
    winnersCount: g.winnersCount,
    winners,
    text: g.text,
  });
  giveaways.delete(giveawayId);
  return true;
}

function scheduleAutoFinish({ ctx, giveawayId, at }) {
  const delay = Math.max(0, at - Date.now());
  const timer = setTimeout(async () => {
    try {
      await finishGiveawayById({ botCtx: ctx, giveawayId });
    } catch (e) {}
  }, delay);
  timer.unref?.();
}

function parseMskDateTime(dateStr, timeStr) {
  const d = String(dateStr || '').trim();
  const t = String(timeStr || '').trim();
  const mDate = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const mTime = t.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!mDate || !mTime) return 0;
  const year = parseInt(mDate[1], 10);
  const month = parseInt(mDate[2], 10) - 1;
  const day = parseInt(mDate[3], 10);
  const hour = parseInt(mTime[1], 10);
  const minute = parseInt(mTime[2], 10);
  const second = mTime[3] ? parseInt(mTime[3], 10) : 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return 0;
  const checkDate = new Date(Date.UTC(year, month, day));
  if (
    checkDate.getUTCFullYear() !== year ||
    checkDate.getUTCMonth() !== month ||
    checkDate.getUTCDate() !== day
  ) return 0;
  // Treat as MSK (UTC+3)
  const ts = Date.UTC(year, month, day, hour - 3, minute, second, 0);
  return ts;
}

function parseRusDateToISO(input) {
  const months = {
    'января': 0,
    'февраля': 1,
    'марта': 2,
    'апреля': 3,
    'мая': 4,
    'июня': 5,
    'июля': 6,
    'августа': 7,
    'сентября': 8,
    'октября': 9,
    'ноября': 10,
    'декабря': 11,
  };
  const m = String(input || '').trim().toLowerCase().match(/^(\d{1,2})\s+([а-яё]+)$/i);
  if (!m) return '';
  const day = parseInt(m[1], 10);
  const month = months[m[2]];
  if (month === undefined || day < 1 || day > 31) return '';
  const now = new Date();
  const year = now.getUTCFullYear();
  const checkDate = new Date(Date.UTC(year, month, day));
  if (
    checkDate.getUTCFullYear() !== year ||
    checkDate.getUTCMonth() !== month ||
    checkDate.getUTCDate() !== day
  ) return '';
  const mm = String(month + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}


