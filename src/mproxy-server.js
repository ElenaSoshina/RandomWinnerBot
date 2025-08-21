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

async function ensureClient() {
  if (client) return client;
  client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
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

// Минимальная выборка участников канала
app.get('/channels/:idOrUsername/members', async (req, res) => {
  try {
    const { idOrUsername } = req.params;
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 10000);
    const offset = parseInt(req.query.offset || '0', 10);
    const c = await ensureClient();

    const result = await c.invoke(
      new Api.channels.GetParticipants({
        channel: idOrUsername,
        filter: new Api.ChannelParticipantsRecent({}),
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
    const { user_ids: userIds, text } = req.body || {};
    if (!Array.isArray(userIds) || userIds.length === 0 || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'user_ids[] and text are required' });
    }
    const c = await ensureClient();
    const results = [];
    for (const rawId of userIds) {
      try {
        const idNum = BigInt(String(rawId));
        const entity = await c.getEntity(idNum).catch(async () => {
          // Fallback: try as number
          return c.getEntity(Number(String(rawId)));
        });
        await c.sendMessage(entity, { message: text });
        results.push({ user_id: String(rawId), ok: true });
      } catch (e) {
        results.push({ user_id: String(rawId), ok: false, error: String(e?.message || e) });
      }
    }
    const okCount = results.filter(r => r.ok).length;
    return res.json({ ok: true, sent: okCount, total: results.length, results });
  } catch (err) {
    logger.error({ err }, 'sendMessages error');
    res.status(500).json({ error: err.message });
  }
});

export function startMProxyServer() {
  app.listen(PORT, () => logger.info({ PORT }, 'MProxy listening'));
}


