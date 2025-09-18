import express from 'express';
import pino from 'pino';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

function requireEnv(name) {
  const value = (process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.MPROXY_PORT || '8081', 10);
const TOKEN = requireEnv('MPROXY_TOKEN');

// Простая аутентификация по Bearer токену
app.use((req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token !== TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// Создание TelegramClient (GramJS)
const apiId = parseInt(requireEnv('TG_API_ID'), 10);
const apiHash = requireEnv('TG_API_HASH');
const providedSession = (process.env.TG_SESSION || '').trim();
const stringSession = new StringSession(providedSession);

let client;

function buildGramJsOptionsFromEnv() {
  const options = { connectionRetries: 5 };
  // SOCKS proxy support for GramJS
  const socksUrlRaw = (process.env.SOCKS_PROXY || process.env.ALL_PROXY || '').trim();
  if (socksUrlRaw) {
    try {
      const u = new URL(socksUrlRaw);
      if (u.protocol.startsWith('socks')) {
        options.proxy = {
          ip: u.hostname,
          port: Number(u.port || 1080),
          socksType: u.protocol.includes('5') ? 5 : 4,
          ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
          ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
        };
      }
    } catch (err) {
      logger.warn({ err }, 'Invalid SOCKS proxy URL in SOCKS_PROXY/ALL_PROXY');
    }
  }
  // Optional WSS transport (uses tcp/443), env: TG_USE_WSS=true
  const useWssRaw = (process.env.TG_USE_WSS || process.env.USE_WSS || '').trim().toLowerCase();
  const enableWss = ['true', '1', 'yes', 'on'].includes(useWssRaw);
  if (enableWss) {
    options.useWSS = true;
  }
  return options;
}

async function ensureClient() {
  if (client) return client;
  const gramOptions = buildGramJsOptionsFromEnv();
  client = new TelegramClient(stringSession, apiId, apiHash, gramOptions);
  // Если сессия уже предоставлена, достаточно establish connection
  await client.connect();
  const authorized = await client.isUserAuthorized();
  if (!authorized) {
    throw new Error('TG_SESSION is invalid or expired. Please regenerate the session string.');
  }
  logger.info('MProxy Telegram client connected with existing session');
  return client;
}

app.get('/health', (req, res) => res.json({ ok: true }));

// Информация о текущем клиент-аккаунте
app.get('/me', async (req, res) => {
  try {
    const c = await ensureClient();
    const me = await c.getMe();
    res.json({
      user_id: String(me.id),
      username: me.username || null,
      first_name: me.firstName || null,
      last_name: me.lastName || null,
    });
  } catch (err) {
    logger.error({ err }, 'me error');
    res.status(500).json({ error: err.message });
  }
});

// Минимальная выборка участников канала
app.get('/channels/:idOrUsername/members', async (req, res) => {
  try {
    const { idOrUsername } = req.params;
    const role = String(req.query.role || '').toLowerCase();
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 10000);
    const offset = parseInt(req.query.offset || '0', 10);
    const c = await ensureClient();

    const filter = role === 'admins'
      ? new Api.ChannelParticipantsAdmins({})
      : new Api.ChannelParticipantsRecent({});

    const result = await c.invoke(
      new Api.channels.GetParticipants({
        channel: idOrUsername,
        filter,
        offset,
        limit,
        hash: 0,
      })
    );

    const users = result.users.map((u) => ({
      user_id: u.id.toString(),
      username: u.username || null,
      first_name: u.firstName || null,
      last_name: u.lastName || null,
      is_bot: Boolean(u.bot),
    }));
    res.json(users);
  } catch (err) {
    logger.error({ err }, 'members error');
    res.status(500).json({ error: err.message });
  }
});

// Проверка членства клиент-аккаунта в группе/канале
app.get('/channels/:idOrUsername/isMember', async (req, res) => {
  try {
    const { idOrUsername } = req.params;
    const c = await ensureClient();
    let entity;
    try {
      entity = await c.getEntity(idOrUsername);
    } catch (e) {
      return res.status(404).json({ error: 'Target not found' });
    }
    try {
      await c.invoke(new Api.channels.GetParticipant({
        channel: entity,
        participant: new Api.InputPeerSelf(),
      }));
      return res.json({ ok: true, is_member: true });
    } catch (e) {
      return res.json({ ok: true, is_member: false });
    }
  } catch (err) {
    logger.error({ err }, 'isMember error');
    res.status(500).json({ error: err.message });
  }
});

// Присоединение клиент-аккаунта к публичной группе/каналу или по инвайт-ссылке
app.post('/join', async (req, res) => {
  try {
    const { target } = req.body || {};
    if (!target || typeof target !== 'string') {
      return res.status(400).json({ error: 'target is required (username or invite link)' });
    }
    const c = await ensureClient();

    const t = target.trim();
    // Инвайт-ссылки вида https://t.me/+HASH или https://t.me/joinchat/HASH
    const inviteHashMatch = t.match(/[+/]([A-Za-z0-9_-]{16,})$/);
    if (t.includes('t.me/') && inviteHashMatch) {
      const hash = inviteHashMatch[1].replace(/^\+/, '');
      const result = await c.invoke(new Api.messages.ImportChatInvite({ hash }));
      return res.json({ ok: true, type: 'invite', result: String(result?.className || 'ok') });
    }

    // Публичные @username или короткие ссылки
    const username = t.replace(/^@/, '');
    const entity = await c.getEntity(username).catch(() => null);
    if (!entity) {
      return res.status(404).json({ error: 'Target not found' });
    }
    await c.invoke(new Api.channels.JoinChannel({ channel: entity }));
    return res.json({ ok: true, type: 'public', username });
  } catch (err) {
    logger.error({ err }, 'join error');
    res.status(500).json({ error: err.message });
  }
});

// Массовая отправка сообщений от клиент-аккаунта пользователям по их id
app.post('/sendMessages', async (req, res) => {
  try {
    const { user_ids: userIds, users, text } = req.body || {};
    const targetsRaw = Array.isArray(users) && users.length ? users : userIds;
    if (!Array.isArray(targetsRaw) || targetsRaw.length === 0 || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'users[]/user_ids[] and text are required' });
    }
    const c = await ensureClient();
    const results = [];
    for (const t of targetsRaw) {
      try {
        let entity;
        if (t && typeof t === 'object' && t.username) {
          entity = await c.getEntity(String(t.username).replace(/^@/, ''));
        } else {
          const rawId = t && typeof t === 'object' ? (t.user_id ?? t.id) : t;
          const idNum = BigInt(String(rawId));
          entity = await c.getEntity(idNum).catch(async () => c.getEntity(Number(String(rawId))));
        }
        await c.sendMessage(entity, { message: text });
        const uid = t && typeof t === 'object' ? (t.user_id ?? t.id ?? t.username) : t;
        results.push({ user_id: String(uid), ok: true });
      } catch (e) {
        const uid = t && typeof t === 'object' ? (t.user_id ?? t.id ?? t.username) : t;
        results.push({ user_id: String(uid), ok: false, error: String(e?.message || e) });
      }
    }
    const okCount = results.filter(r => r.ok).length;
    return res.json({ ok: true, sent: okCount, total: results.length, results });
  } catch (err) {
    logger.error({ err }, 'sendMessages error');
    res.status(500).json({ error: err.message });
  }
});

// Публикация поста в канал/группу от имени клиент-аккаунта с URL-кнопкой
app.post('/channels/:idOrUsername/post', async (req, res) => {
  try {
    const { idOrUsername } = req.params;
    const { text, button_text: buttonText, url } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text is required' });
    const c = await ensureClient();
    const entity = await c.getEntity(idOrUsername);
    let replyMarkup;
    if (typeof buttonText === 'string' && buttonText.trim() && typeof url === 'string' && url.trim()) {
      replyMarkup = new Api.ReplyInlineMarkup({
        rows: [
          new Api.KeyboardButtonRow({
            buttons: [new Api.KeyboardButtonUrl({ text: buttonText, url })],
          }),
        ],
      });
    }
    const result = await c.sendMessage(entity, { message: text, replyMarkup });
    const messageId = result?.id ?? result?.updates?.[0]?.id ?? null;
    return res.json({ ok: true, message_id: messageId });
  } catch (err) {
    logger.error({ err }, 'post error');
    res.status(500).json({ error: err.message });
  }
});

// Обновление текста URL-кнопки у опубликованного клиентом сообщения
app.post('/channels/:idOrUsername/editButton', async (req, res) => {
  try {
    const { idOrUsername } = req.params;
    const { message_id: messageId, button_text: buttonText, url } = req.body || {};
    if (!messageId) return res.status(400).json({ error: 'message_id is required' });
    if (typeof buttonText !== 'string' || !buttonText.trim()) return res.status(400).json({ error: 'button_text is required' });
    if (typeof url !== 'string' || !url.trim()) return res.status(400).json({ error: 'url is required' });
    const c = await ensureClient();
    const entity = await c.getEntity(idOrUsername);
    const replyMarkup = new Api.ReplyInlineMarkup({
      rows: [
        new Api.KeyboardButtonRow({
          buttons: [new Api.KeyboardButtonUrl({ text: buttonText, url })],
        }),
      ],
    });
    await c.editMessage(entity, { message: Number(messageId), replyMarkup }).catch(async () => {
      // Try BigInt id
      return c.editMessage(entity, { message: BigInt(String(messageId)), replyMarkup });
    });
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'editButton error');
    res.status(500).json({ error: err.message });
  }
});

// Обновление текста сообщения клиента
app.post('/channels/:idOrUsername/editText', async (req, res) => {
  try {
    const { idOrUsername } = req.params;
    const { message_id: messageId, text } = req.body || {};
    if (!messageId) return res.status(400).json({ error: 'message_id is required' });
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text is required' });
    const c = await ensureClient();
    const entity = await c.getEntity(idOrUsername);
    await c.editMessage(entity, { message: Number(messageId), text }).catch(async () => {
      return c.editMessage(entity, { message: BigInt(String(messageId)), text });
    });
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'editText error');
    res.status(500).json({ error: err.message });
  }
});

export function startMProxyServer() {
  app.listen(PORT, () => logger.info({ PORT }, 'MProxy listening'));
}


