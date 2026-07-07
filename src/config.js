import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function env(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

function envInt(name, def) {
  const v = parseInt(env(name, String(def)), 10);
  return Number.isFinite(v) ? v : def;
}

export const config = {
  // Where the Node process listens. Put a reverse proxy (Caddy/nginx) in front
  // for TLS, OR provide TLS_CERT/TLS_KEY to terminate TLS here directly.
  host: env('HOST', '0.0.0.0'),
  port: envInt('PORT', 4000),

  // Optional direct TLS termination (paths to PEM files). If both are set, the
  // server listens with https + wss instead of plain http + ws.
  tlsCert: env('TLS_CERT', ''),
  tlsKey: env('TLS_KEY', ''),

  // Avatar + metadata storage.
  dataDir: path.resolve(env('DATA_DIR', path.join(__dirname, '..', 'data'))),

  // Ely.by session verification endpoint (authlib-injector sessionserver).
  // This MUST match the sessionserver your client's `join` request goes to.
  // Under ElyPrismLauncher / authlib-injector=ely.by that is the injector path below.
  elyHasJoinedUrl: env(
    'ELY_HASJOINED_URL',
    'https://authserver.ely.by/api/authlib-injector/sessionserver/session/minecraft/hasJoined',
  ),

  // Lifetimes.
  authSessionTtlMs: envInt('AUTH_SESSION_TTL_MS', 120_000), // pending join window
  tokenTtlMs: envInt('TOKEN_TTL_MS', 24 * 60 * 60 * 1000), // verified session token

  // Advertised limits (sent to the client verbatim).
  maxAvatarSize: envInt('MAX_AVATAR_SIZE', 100_000),
  maxAvatars: envInt('MAX_AVATARS', 10),

  // Default avatar trust/permission level reported for users.
  defaultTrust: envInt('DEFAULT_TRUST', 1),

  // Reported backend "release" string.
  version: env('FIGURA_VERSION', '0.1.4'),
  serverName: env('SERVER_NAME', 'Figura Ely Backend'),

  // Verbose request logging.
  debug: env('DEBUG', 'false') === 'true',
};
