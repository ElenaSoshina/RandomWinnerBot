import { pickUniqueRandom } from '../giveaway.js';
import { userState, giveaways, putEphemeral, getEphemeral } from '../state.js';
import { escapeHtml, formatUserLink, sendChunkedHtml, buildExcludedUsernamesFromEnv, filterEligibleMembers } from '../utils.js';

export function registerBotHandlers({ bot, mproxy, logger, enablePostGiveaway }) {
  const EXCLUDED_USERNAMES = buildExcludedUsernamesFromEnv(process.env.EXCLUDE_USERNAMES);

  function mainMenuKeyboard() {
    return {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '👥 Список участников', callback_data: 'menu_members' },
            { text: '🎁 Розыгрыш', callback_data: 'menu_draw' },
          ],
        ],
      },
    };
  }

  async function showMainMenu(ctx, text = 'Главное меню') {
    userState.delete(ctx.from.id);
    await ctx.replyWithHTML(text, mainMenuKeyboard());
  }

  bot.start(async (ctx) => {
    await showMainMenu(
      ctx,
      '👋 <b>Привет!</b> Я помогу собрать участников и провести розыгрыш.\n\n' +
        'Как это работает:\n' +
        '1) Нажмите «👥 Список участников» — укажите <b>username группы</b>. Я покажу полный список.\n' +
        '2) Нажмите «🎁 Розыгрыш» — укажите <b>username группы</b> и <b>количество победителей</b>. После выбора появится кнопка «✉️ Написать победителям».\n\n' +
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
    const winnersCount = Math.max(1, parseInt(parts[2], 10) || 1);
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
    const ids = getEphemeral(token) || [];
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

  bot.action('menu_main', async (ctx) => {
    await ctx.answerCbQuery();
    await showMainMenu(ctx);
  });

  bot.action('menu_members', async (ctx) => {
    await ctx.answerCbQuery();
    if (!mproxy.isEnabled()) return ctx.reply('MTProto недоступен: не настроен MProxy.');
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
    userState.set(ctx.from.id, { action: 'ask_target', nextAction: 'draw', data: {} });
    await ctx.reply('Шаг 1. Введите username группы. Подключу клиента и затем попрошу число победителей.', {
      reply_markup: { inline_keyboard: [[{ text: '⬅️ В меню', callback_data: 'menu_main' }]] },
    });
  });

  bot.action('menu_draw_post', async (ctx) => {
    await ctx.answerCbQuery();
    if (!enablePostGiveaway) {
      return ctx.reply('Розыгрыш по посту временно отключён.');
    }
    userState.set(ctx.from.id, { action: 'draw_post', step: 1, data: {} });
    await ctx.reply('Шаг 1. Введите username канала/группы, где опубликовать пост розыгрыша.', {
      reply_markup: { inline_keyboard: [[{ text: '⬅️ В меню', callback_data: 'menu_main' }]] },
    });
  });

  bot.on('text', async (ctx, next) => {
    const st = userState.get(ctx.from.id);
    if (!st) return next();
    const text = ctx.message.text.trim();

    try {
      if (st.action === 'ask_target') {
        const target = text;
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
          return ctx.reply('Шаг 2. Укажите количество победителей (число).');
        }
      }

      if (st.action === 'draw_post') {
        if (st.step === 1) {
          st.data.channel = text;
          st.step = 2;
          userState.set(ctx.from.id, st);
          return ctx.reply('Шаг 2. Укажите количество победителей (число).');
        }
        if (st.step === 2) {
          const num = Math.max(1, parseInt(text, 10) || 1);
          st.data.winnersCount = num;
          st.step = 3;
          userState.set(ctx.from.id, st);
          return ctx.reply('Шаг 3. Отправьте текст поста розыгрыша (он будет опубликован с кнопкой «Участвовать»).');
        }
        if (st.step === 3) {
          const { channel, winnersCount } = st.data;
          const postText = text;
          await ctx.reply('Публикую пост в канале...');
          const giveawayId = Math.random().toString(16).slice(2, 18);
          const msg = await ctx.telegram.sendMessage(channel, `${postText}\n\nНажмите кнопку ниже, чтобы участвовать:`, {
            reply_markup: { inline_keyboard: [[{ text: '✅ Участвовать', callback_data: `gwj:${giveawayId}` }]] },
            disable_web_page_preview: true,
          }).catch(async (e) => {
            await ctx.reply(`Не удалось опубликовать пост: ${e.message}`);
            throw e;
          });
          giveaways.set(giveawayId, {
            channel,
            messageId: msg.message_id,
            winnersCount,
            entries: new Set(),
            createdBy: ctx.from.id,
            text: postText,
          });
          const finishToken = putEphemeral({ giveawayId });
          await ctx.reply('Пост опубликован. Когда будете готовы — завершите розыгрыш.', {
            reply_markup: { inline_keyboard: [[{ text: '🎉 Завершить розыгрыш', callback_data: `gwe:${finishToken}` }]] },
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
          return ctx.reply('Шаг 2/2. Укажите количество победителей (число).', {
            reply_markup: { inline_keyboard: [[{ text: '⬅️ В меню', callback_data: 'menu_main' }]] },
          });
        }
        if (st.step === 2) {
          const winnersCount = Math.max(1, parseInt(text, 10) || 1);
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
          const winnersIds = winners.map((u) => u.user_id);
          const token = putEphemeral(winnersIds);
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

  bot.action(/gwj:.+/, async (ctx) => {
    const id = ctx.match.input.split(':')[1];
    const g = giveaways.get(id);
    if (!g) {
      return ctx.answerCbQuery('Розыгрыш не найден или завершён', { show_alert: true });
    }
    g.entries.add(String(ctx.from.id));
    return ctx.answerCbQuery('Вы участвуете!', { show_alert: false });
  });

  bot.action(/gwe:.+/, async (ctx) => {
    await ctx.answerCbQuery();
    const token = ctx.match.input.split(':')[1];
    const data = getEphemeral(token);
    if (!data) return ctx.reply('Сессия завершения устарела.');
    const { giveawayId } = data;
    const g = giveaways.get(giveawayId);
    if (!g) return ctx.reply('Розыгрыш уже завершён.');
    const participants = Array.from(g.entries).map((id) => ({ user_id: id }));
    const winners = pickUniqueRandom(participants, g.winnersCount);
    const list = winners.map((u, i) => `${i + 1}. ${formatUserLink(u)}`).join('\n');
    await ctx.telegram.sendMessage(g.channel, `Итоги розыгрыша (сообщение ${g.messageId}):\n${list}`, { disable_web_page_preview: true });
    const ids = winners.map((u) => u.user_id);
    const msgToken = putEphemeral(ids);
    await ctx.reply('Розыгрыш завершён.', {
      reply_markup: { inline_keyboard: [[{ text: '✉️ Написать победителям', callback_data: `msg_winners:${msgToken}` }]] },
    });
    giveaways.delete(giveawayId);
  });

  bot.catch((err, ctx) => {
    logger.error({ err }, 'Bot error');
  });

  return { showMainMenu };
}


