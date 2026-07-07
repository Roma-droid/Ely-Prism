import crypto from 'node:crypto';
import { config } from './config.js';

// Pending "join" sessions: serverId -> { username, createdAt }
const authSessions = new Map();
// Verified session tokens: token -> { username, uuid, createdAt }
const tokens = new Map();
// Reverse index so a re-auth invalidates the previous token: uuid -> token
const tokenByUuid = new Map();

function now() {
  return Date.now();
}

function sweep() {
  const t = now();
  for (const [id, s] of authSessions) {
    if (t - s.createdAt > config.authSessionTtlMs) authSessions.delete(id);
  }
  for (const [tok, s] of tokens) {
    if (t - s.createdAt > config.tokenTtlMs) {
      tokens.delete(tok);
      if (tokenByUuid.get(s.uuid) === tok) tokenByUuid.delete(s.uuid);
    }
  }
}
setInterval(sweep, 60_000).unref?.();

/** Step 1: client asks for a serverId to hand to the session server. */
export function createAuthSession(username) {
  if (!username) throw new Error('missing username');
  const serverId = crypto.randomBytes(20).toString('hex');
  authSessions.set(serverId, { username, createdAt: now() });
  return serverId;
}

/**
 * Step 2: after the client called joinServer against Ely.by, verify the join
 * and issue a session token. Returns { token, username, uuid } or throws.
 */
export async function verifyAuthSession(serverId) {
  if (!serverId) throw new Error('missing id');
  const pending = authSessions.get(serverId);
  authSessions.delete(serverId);
  if (!pending) throw new Error('unknown or expired session id');

  const profile = await elyHasJoined(pending.username, serverId);
  if (!profile || !profile.name) throw new Error('Ely.by did not confirm the join');
  // Ely.by is case-insensitive on names; compare loosely.
  if (profile.name.toLowerCase() !== pending.username.toLowerCase()) {
    throw new Error('username mismatch');
  }

  const uuid = dashUuid(profile.id);
  const token = crypto.randomBytes(24).toString('base64url');

  // Drop any previous token for this user.
  const prev = tokenByUuid.get(uuid);
  if (prev) tokens.delete(prev);

  tokens.set(token, { username: profile.name, uuid, createdAt: now() });
  tokenByUuid.set(uuid, token);
  return { token, username: profile.name, uuid };
}

/** Validate a token from an HTTP `token` header or a WS auth frame. */
export function validateToken(token) {
  if (!token) return null;
  const s = tokens.get(token);
  if (!s) return null;
  if (now() - s.createdAt > config.tokenTtlMs) {
    tokens.delete(token);
    if (tokenByUuid.get(s.uuid) === token) tokenByUuid.delete(s.uuid);
    return null;
  }
  return s; // { username, uuid, createdAt }
}

/** Call Ely.by's authlib-injector sessionserver hasJoined. */
async function elyHasJoined(username, serverId) {
  const url = `${config.elyHasJoinedUrl}?username=${encodeURIComponent(username)}&serverId=${encodeURIComponent(serverId)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'figura-ely-backend' },
      signal: controller.signal,
    });
    // 200 => joined (profile JSON). 204/empty/401 => not joined.
    if (res.status !== 200) return null;
    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch (e) {
    if (config.debug) console.error('[auth] hasJoined error:', e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Ely.by returns undashed UUIDs; normalise to canonical dashed lowercase. */
export function dashUuid(id) {
  if (!id) return id;
  const h = id.replace(/-/g, '').toLowerCase();
  if (h.length !== 32) return id;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
