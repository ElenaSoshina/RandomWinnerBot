import { randomBytes } from 'crypto';

// In-memory finite-state machines per user
export const userState = new Map(); // key: from.id, value: { action, step, data }

// In-memory active giveaways by id
export const giveaways = new Map(); // id -> { channel, messageId, winnersCount, entries:Set<user_id>, createdBy:number, text:string }

// Ephemeral key-value store for short‑lived callback payloads
const ephemeralStore = new Map(); // token -> { value, expiresAt }

export function putEphemeral(value, ttlMs = 10 * 60 * 1000) {
  const token = randomBytes(8).toString('hex');
  const expiresAt = Date.now() + ttlMs;
  ephemeralStore.set(token, { value, expiresAt });
  setTimeout(() => ephemeralStore.delete(token), ttlMs).unref?.();
  return token;
}

export function getEphemeral(token) {
  const entry = ephemeralStore.get(token);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    ephemeralStore.delete(token);
    return undefined;
  }
  return entry.value;
}

// Simple file-based history (JSON lines) to avoid DB dependency
import fs from 'fs';
import path from 'path';

const dataDir = path.resolve(process.cwd(), 'data');
const historyFile = path.join(dataDir, 'history.jsonl');

function ensureDataDir() {
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}
}

export function appendHistory(record) {
  try {
    ensureDataDir();
    const line = JSON.stringify({ ...record, ts: Date.now() });
    fs.appendFileSync(historyFile, line + '\n', 'utf8');
  } catch {}
}

export function readHistory({ channel, limit = 10, offset = 0 } = {}) {
  try {
    if (!fs.existsSync(historyFile)) return [];
    const lines = fs.readFileSync(historyFile, 'utf8').split('\n').filter(Boolean);
    const items = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const filtered = channel ? items.filter((r) => r.channel === channel) : items;
    return filtered.slice(Math.max(0, filtered.length - offset - limit), filtered.length - offset);
  } catch {
    return [];
  }
}

export function historyCount(channel) {
  try {
    if (!fs.existsSync(historyFile)) return 0;
    const lines = fs.readFileSync(historyFile, 'utf8').split('\n').filter(Boolean);
    const items = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (!channel) return items.length;
    return items.filter((r) => r.channel === channel).length;
  } catch {
    return 0;
  }
}


