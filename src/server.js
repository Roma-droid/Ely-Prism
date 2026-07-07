import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';

import { config } from './config.js';
import {
  createAuthSession,
  verifyAuthSession,
  validateToken,
} from './auth.js';
import {
  getAvatarDetails,
  getAvatarBytes,
  uploadAvatar,
  deleteAvatar,
  equipAvatar,
} from './avatars.js';
import {
  C2S,
  decodeC2S,
  encodeAuth,
  encodePing,
  encodeEvent,
} from './protocol.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// WebSocket state: who is subscribed to whose avatar events/pings.
// ---------------------------------------------------------------------------
// uuid (avatar owner) -> Set<ws> of subscribers
const subscribers = new Map();

function subscribe(ws, uuid) {
  let set = subscribers.get(uuid);
  if (!set) subscribers.set(uuid, (set = new Set()));
  set.add(ws);
  ws._subs.add(uuid);
}

function unsubscribe(ws, uuid) {
  const set = subscribers.get(uuid);
  if (set) {
    set.delete(ws);
    if (set.size === 0) subscribers.delete(uuid);
  }
  ws._subs.delete(uuid);
}

function sendToSubscribers(uuid, payload) {
  const set = subscribers.get(uuid);
  if (!set) return;
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(payload); } catch { /* ignore */ }
    }
  }
}

/** Called by HTTP handlers after an avatar changes, so viewers reload it. */
export function broadcastEvent(uuid) {
  sendToSubscribers(uuid, encodeEvent(uuid));
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function send(res, status, body, contentType = 'text/plain; charset=utf-8') {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': buf.length });
  res.end(buf);
}

function sendJson(res, obj) {
  send(res, 200, JSON.stringify(obj), 'application/json; charset=utf-8');
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (limit && size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const LIMITS = {
  limits: {
    allowedBadges: {
      pride: new Array(25).fill(0),
      special: [1, 1, 1, 1, 1, 1],
    },
    maxAvatarSize: config.maxAvatarSize,
    maxAvatars: config.maxAvatars,
  },
  rate: { download: 50, equip: 1, pingRate: 32, pingSize: 1024, upload: 1 },
};

const MOTD = JSON.stringify([
  { text: 'Figura Ely', color: 'aqua' },
  { text: ' — авторизация через Ely.by', color: 'white' },
]);

// ---------------------------------------------------------------------------
// HTTP request handler
// ---------------------------------------------------------------------------
async function handleHttp(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const method = req.method;
  // Normalise: strip /api prefix, collapse slashes, drop leading/trailing.
  let p = url.pathname.replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  if (config.debug) console.log(`${method} /${p}`);

  if (p !== 'api' && !p.startsWith('api/')) return send(res, 404, '');
  const rest = p === 'api' ? '' : p.slice(4); // part after "api/"
  const seg = rest ? rest.split('/') : [];

  try {
    // ---- auth (no token needed) -----------------------------------------
    if (seg[0] === 'auth' && seg[1] === 'id' && method === 'GET') {
      const username = url.searchParams.get('username');
      try {
        return send(res, 200, createAuthSession(username));
      } catch (e) {
        return send(res, 400, e.message);
      }
    }
    if (seg[0] === 'auth' && seg[1] === 'verify' && method === 'GET') {
      try {
        const { token } = await verifyAuthSession(url.searchParams.get('id'));
        return send(res, 200, token);
      } catch (e) {
        return send(res, 401, e.message);
      }
    }

    // ---- public metadata ------------------------------------------------
    if (rest === 'limits' && method === 'GET') return sendJson(res, LIMITS);
    if (rest === 'version' && method === 'GET') {
      return sendJson(res, { prerelease: config.version, release: config.version });
    }
    if (rest === 'motd' && method === 'GET') {
      return send(res, 200, MOTD, 'application/json; charset=utf-8');
    }

    // ---- everything below requires a valid token ------------------------
    const session = validateToken(req.headers['token']);
    if (!session) return send(res, 401, 'Invalid session');

    // GET /api  -> token check
    if (rest === '' && method === 'GET') return send(res, 200, 'ok');

    // POST /api/equip
    if (rest === 'equip' && method === 'POST') {
      const body = await readBody(req, 1_000_000);
      let list;
      try { list = JSON.parse(body.toString('utf8')); } catch { return send(res, 400, 'bad json'); }
      equipAvatar(session.uuid, list);
      broadcastEvent(session.uuid);
      return send(res, 200, 'ok');
    }

    // GET /api/{uuid}  -> user avatar metadata
    if (seg.length === 1 && UUID_RE.test(seg[0]) && method === 'GET') {
      return sendJson(res, getAvatarDetails(seg[0].toLowerCase()));
    }

    // GET /api/{uuid}/{avatarId}  -> avatar bytes
    if (seg.length === 2 && UUID_RE.test(seg[0]) && method === 'GET') {
      const bytes = getAvatarBytes(seg[0].toLowerCase());
      if (!bytes) return send(res, 404, '');
      return send(res, 200, bytes, 'application/octet-stream');
    }

    // PUT /api/{avatarId}  -> upload own avatar bytes
    if (seg.length === 1 && !UUID_RE.test(seg[0]) && method === 'PUT') {
      const bytes = await readBody(req, config.maxAvatarSize + 1024);
      if (bytes.length > config.maxAvatarSize) return send(res, 413, 'avatar too large');
      uploadAvatar(session.uuid, bytes);
      return send(res, 200, 'ok');
    }

    // DELETE /api/{avatarId}  -> delete own avatar
    if (seg.length === 1 && !UUID_RE.test(seg[0]) && method === 'DELETE') {
      deleteAvatar(session.uuid);
      broadcastEvent(session.uuid);
      return send(res, 200, 'ok');
    }

    return send(res, 404, '');
  } catch (e) {
    console.error('[http] error:', e);
    return send(res, 400, 'error');
  }
}

// ---------------------------------------------------------------------------
// WebSocket handling
// ---------------------------------------------------------------------------
function handleWsConnection(ws) {
  ws._subs = new Set();
  ws._uuid = null; // owner uuid once authenticated

  ws.on('message', (data, isBinary) => {
    if (!isBinary) return; // Figura backend v2 ignores text frames
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const msg = decodeC2S(buf);
    if (!msg) return;

    switch (msg.type) {
      case C2S.TOKEN: {
        const session = validateToken(msg.token);
        if (!session) {
          try { ws.close(1008, 'Unauthorized'); } catch { /* ignore */ }
          return;
        }
        ws._uuid = session.uuid;
        ws.send(encodeAuth());
        break;
      }
      case C2S.PING: {
        if (!ws._uuid) return;
        // Relay this owner's ping to everyone watching this owner.
        sendToSubscribers(ws._uuid, encodePing(ws._uuid, msg.id, msg.sync, msg.data));
        break;
      }
      case C2S.SUB: {
        if (!ws._uuid) return;
        subscribe(ws, msg.uuid);
        break;
      }
      case C2S.UNSUB: {
        if (!ws._uuid) return;
        unsubscribe(ws, msg.uuid);
        break;
      }
      default:
        break;
    }
  });

  ws.on('close', () => {
    for (const uuid of [...ws._subs]) unsubscribe(ws, uuid);
  });

  ws.on('error', () => { /* swallow */ });
}

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------
function createServer() {
  if (config.tlsCert && config.tlsKey) {
    const opts = {
      cert: fs.readFileSync(config.tlsCert),
      key: fs.readFileSync(config.tlsKey),
    };
    console.log('[server] TLS enabled (direct https/wss)');
    return https.createServer(opts, (req, res) => { handleHttp(req, res); });
  }
  console.log('[server] plain http/ws (put a TLS reverse proxy in front)');
  return http.createServer((req, res) => { handleHttp(req, res); });
}

const server = createServer();
const wss = new WebSocketServer({ noServer: true });
wss.on('connection', handleWsConnection);

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname.replace(/\/+$/, '') === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

server.listen(config.port, config.host, () => {
  console.log(`[server] ${config.serverName} listening on ${config.host}:${config.port}`);
  console.log(`[server] Ely.by hasJoined: ${config.elyHasJoinedUrl}`);
  console.log(`[server] data dir: ${config.dataDir}`);
});
