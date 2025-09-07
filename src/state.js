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


