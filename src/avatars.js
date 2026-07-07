import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const AVATARS_DIR = path.join(config.dataDir, 'avatars');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// Files are bucketed by the first two chars of "<uuid>.<type>" to avoid huge
// flat directories (mirrors the reference backend's on-disk layout).
function fileFor(uuid, type, create) {
  const name = `${uuid}.${type}`;
  const bucket = path.join(AVATARS_DIR, name.slice(0, 2));
  if (create) ensureDir(bucket);
  return path.join(bucket, name);
}

function md5(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

function newAvatar(uuid) {
  return {
    equipped: [],
    equippedBadges: { pride: new Array(25).fill(0), special: new Array(6).fill(0) },
    uuid,
    rank: 'default',
    lastUsed: Date.now(),
    version: config.version,
    banned: false,
    trust: config.defaultTrust,
  };
}

function readMeta(uuid) {
  const jsonPath = fileFor(uuid, 'json', false);
  if (fs.existsSync(jsonPath)) {
    try {
      return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch {
      /* fall through to rebuild */
    }
  }
  return null;
}

function writeMeta(uuid, avatar) {
  fs.writeFileSync(fileFor(uuid, 'json', true), JSON.stringify(avatar));
}

/** GET /api/{uuid} — the user's avatar metadata (equipped list w/ hashes). */
export function getAvatarDetails(uuid) {
  let avatar = readMeta(uuid);
  if (avatar) return avatar;

  const avtrPath = fileFor(uuid, 'avtr', false);
  if (fs.existsSync(avtrPath)) {
    // Avatar bytes exist without metadata: synthesise a self-equipped entry.
    avatar = newAvatar(uuid);
    avatar.equipped = [{ id: 'avatar', owner: uuid, hash: md5(fs.readFileSync(avtrPath)) }];
    writeMeta(uuid, avatar);
    return avatar;
  }
  return {};
}

/** GET /api/{owner}/{id} — raw avatar bytes, or null if absent. */
export function getAvatarBytes(uuid) {
  const p = fileFor(uuid, 'avtr', false);
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
}

/** PUT /api/{id} — store the requesting user's avatar bytes. */
export function uploadAvatar(uuid, bytes) {
  fs.writeFileSync(fileFor(uuid, 'avtr', true), bytes);
}

/** DELETE /api/{id} — remove avatar bytes and clear the equipped list. */
export function deleteAvatar(uuid) {
  const avtrPath = fileFor(uuid, 'avtr', false);
  if (fs.existsSync(avtrPath)) fs.rmSync(avtrPath, { force: true });
  const avatar = readMeta(uuid) ?? newAvatar(uuid);
  avatar.equipped = [];
  writeMeta(uuid, avatar);
}

/**
 * POST /api/equip — set the equipped list. Each entry references an owner whose
 * `.avtr` bytes are hashed so viewers can cache/detect changes.
 */
export function equipAvatar(uuid, equipped) {
  const avatar = readMeta(uuid) ?? newAvatar(uuid);
  const list = Array.isArray(equipped) ? equipped : [];
  for (const meta of list) {
    meta.id = meta.id || 'avatar';
    const ownerBytes = getAvatarBytes(meta.owner);
    if (ownerBytes) meta.hash = md5(ownerBytes);
  }
  avatar.equipped = list;
  avatar.lastUsed = Date.now();
  writeMeta(uuid, avatar);
}
