// End-to-end smoke test with a mocked Ely.by hasJoined endpoint.
// Exercises: static endpoints, the full auth handshake, avatar upload/equip/
// download, token enforcement, and WebSocket ping-relay + event broadcast.
import assert from 'node:assert';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { WebSocket } from 'ws';

const PORT = 4599;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'figura-ely-'));

process.env.PORT = String(PORT);
process.env.HOST = '127.0.0.1';
process.env.DATA_DIR = DATA;

// --- mock Ely.by: return a profile whose id is derived from the username ---
function uuidFor(name) {
  return crypto.createHash('md5').update(name).digest('hex'); // 32 hex, undashed
}
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = new URL(url);
  if (u.pathname.endsWith('/hasJoined')) {
    const username = u.searchParams.get('username');
    // pretend every requested join succeeded
    return new Response(JSON.stringify({ id: uuidFor(username), name: username }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return realFetch(url, opts);
};

await import('../src/server.js');
await new Promise((r) => setTimeout(r, 300)); // let it bind

let failures = 0;
function ok(name) { console.log('  PASS', name); }
function bad(name, e) { failures++; console.error('  FAIL', name, '-', e?.message ?? e); }
async function test(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }

const text = (r) => r.text();
const json = (r) => r.json();

async function authenticate(username) {
  const serverId = await fetch(`${BASE}/api/auth/id?username=${username}`).then(text);
  assert.match(serverId, /^[0-9a-f]+$/, 'serverId is hex');
  const token = await fetch(`${BASE}/api/auth/verify?id=${serverId}`).then(text);
  assert.ok(token.length > 10, 'got a token');
  const uuid = dash(uuidFor(username));
  return { token, uuid };
}
function dash(h) {
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

await test('GET /api/version', async () => {
  const v = await fetch(`${BASE}/api/version`).then(json);
  assert.ok(v.release, 'has release');
});

await test('GET /api/limits', async () => {
  const l = await fetch(`${BASE}/api/limits`).then(json);
  assert.equal(l.limits.maxAvatars, 10);
});

await test('GET /api/motd', async () => {
  const r = await fetch(`${BASE}/api/motd`);
  assert.equal(r.status, 200);
});

await test('token is required for protected routes', async () => {
  const r = await fetch(`${BASE}/api`);
  assert.equal(r.status, 401, 'no token -> 401');
});

let owner;
await test('auth handshake issues a token', async () => {
  owner = await authenticate('OwnerGuy');
  const r = await fetch(`${BASE}/api`, { headers: { token: owner.token } });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'ok');
});

await test('bad token -> 401', async () => {
  const r = await fetch(`${BASE}/api`, { headers: { token: 'nope' } });
  assert.equal(r.status, 401);
});

const AVATAR_BYTES = Buffer.from('PRETEND-NBT-AVATAR-DATA-🧍');
await test('upload + equip + details + download', async () => {
  let r = await fetch(`${BASE}/api/avatar`, {
    method: 'PUT',
    headers: { token: owner.token, 'content-type': 'application/octet-stream' },
    body: AVATAR_BYTES,
  });
  assert.equal(r.status, 200, 'upload ok');

  r = await fetch(`${BASE}/api/equip`, {
    method: 'POST',
    headers: { token: owner.token, 'content-type': 'application/json' },
    body: JSON.stringify([{ id: 'avatar', owner: owner.uuid }]),
  });
  assert.equal(r.status, 200, 'equip ok');

  const details = await fetch(`${BASE}/api/${owner.uuid}`, { headers: { token: owner.token } }).then(json);
  assert.equal(details.uuid, owner.uuid, 'details uuid');
  assert.equal(details.equipped.length, 1, 'one equipped');
  assert.equal(details.equipped[0].owner, owner.uuid);
  assert.ok(details.equipped[0].hash, 'has md5 hash');

  const dl = await fetch(`${BASE}/api/${owner.uuid}/avatar`, { headers: { token: owner.token } });
  assert.equal(dl.status, 200);
  const body = Buffer.from(await dl.arrayBuffer());
  assert.ok(body.equals(AVATAR_BYTES), 'downloaded bytes match uploaded');
});

// --- WebSocket: viewer subscribes to owner, gets ping relay + event ---
function connectWs(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.binaryType = 'nodebuffer';
    ws.once('error', reject);
    ws.once('open', () => {
      // C2S auth: [0][token]
      ws.send(Buffer.concat([Buffer.from([0]), Buffer.from(token, 'utf8')]));
    });
    ws.once('message', (data) => {
      // first server msg should be AUTH [0]
      if (data[0] === 0) resolve(ws);
      else reject(new Error('expected AUTH, got ' + data[0]));
    });
  });
}
function uuidToBuf(u) { return Buffer.from(u.replace(/-/g, ''), 'hex'); }

await test('ws ping relay to subscriber', async () => {
  const viewer = await authenticate('ViewerGal');
  const vws = await connectWs(viewer.token);
  const ows = await connectWs(owner.token);

  // viewer subscribes to owner: [2][uuid]
  vws.send(Buffer.concat([Buffer.from([2]), uuidToBuf(owner.uuid)]));
  await new Promise((r) => setTimeout(r, 100));

  const got = new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('no ping relayed')), 1500);
    vws.on('message', (data) => {
      if (data[0] === 1) { // S2C PING
        clearTimeout(to);
        const relayedUuid = data.subarray(1, 17).toString('hex');
        assert.equal(relayedUuid, owner.uuid.replace(/-/g, ''), 'relayed owner uuid');
        assert.equal(data.readInt32BE(17), 123, 'relayed ping id');
        assert.deepEqual([...data.subarray(22)], [5, 6, 7], 'relayed data');
        resolve();
      }
    });
  });

  // owner sends a ping: [1][int32 id=123][int8 sync=0][data 5,6,7]
  ows.send(Buffer.concat([Buffer.from([1, 0, 0, 0, 123, 0]), Buffer.from([5, 6, 7])]));
  await got;

  // now trigger an EVENT via re-equip; viewer should receive [2][uuid]
  const evt = new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('no event broadcast')), 1500);
    vws.on('message', (data) => {
      if (data[0] === 2) { // S2C EVENT
        clearTimeout(to);
        assert.equal(data.subarray(1, 17).toString('hex'), owner.uuid.replace(/-/g, ''));
        resolve();
      }
    });
  });
  await fetch(`${BASE}/api/equip`, {
    method: 'POST',
    headers: { token: owner.token, 'content-type': 'application/json' },
    body: JSON.stringify([{ id: 'avatar', owner: owner.uuid }]),
  });
  await evt;

  vws.close();
  ows.close();
});

console.log(failures ? `\nSMOKE: ${failures} FAILURE(S)` : '\nSMOKE: ALL PASS');
fs.rmSync(DATA, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
