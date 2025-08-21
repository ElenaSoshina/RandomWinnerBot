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

export function startMProxyServer() {
  app.listen(PORT, () => logger.info({ PORT }, 'MProxy listening'));
}


