// Round-trip / layout checks for the binary protocol.
import assert from 'node:assert';
import {
  C2S, S2C, bufToUuid, uuidToBuf, decodeC2S,
  encodeAuth, encodePing, encodeEvent,
} from './protocol.js';

const UUID = '12345678-9abc-def0-1234-56789abcdef0';

// uuid <-> buffer
assert.equal(bufToUuid(uuidToBuf(UUID)), UUID, 'uuid round-trip');
assert.equal(uuidToBuf(UUID).length, 16, 'uuid is 16 bytes');

// decode TOKEN: [0][token...]
{
  const buf = Buffer.concat([Buffer.from([C2S.TOKEN]), Buffer.from('mytoken', 'utf8')]);
  const m = decodeC2S(buf);
  assert.equal(m.type, C2S.TOKEN);
  assert.equal(m.token, 'mytoken');
}

// decode PING: [1][int32 id][int8 sync][data]  (as the Java client writes it)
{
  const data = Buffer.from([9, 8, 7]);
  const buf = Buffer.concat([Buffer.from([C2S.PING, 0, 0, 0, 42, 1]), data]);
  const m = decodeC2S(buf);
  assert.equal(m.type, C2S.PING);
  assert.equal(m.id, 42);
  assert.equal(m.sync, 1);
  assert.deepEqual([...m.data], [9, 8, 7]);
}

// decode SUB: [2][uuid 16]
{
  const buf = Buffer.concat([Buffer.from([C2S.SUB]), uuidToBuf(UUID)]);
  const m = decodeC2S(buf);
  assert.equal(m.type, C2S.SUB);
  assert.equal(m.uuid, UUID);
}

// encode AUTH
assert.deepEqual([...encodeAuth()], [S2C.AUTH]);

// encode PING relay: [1][uuid 16][int32 id][int8 sync][data]
{
  const data = Buffer.from([1, 2, 3, 4]);
  const out = encodePing(UUID, 77, 0, data);
  assert.equal(out[0], S2C.PING);
  assert.equal(bufToUuid(out.subarray(1, 17)), UUID);
  assert.equal(out.readInt32BE(17), 77);
  assert.equal(out[21], 0);
  assert.deepEqual([...out.subarray(22)], [1, 2, 3, 4]);
}

// encode EVENT: [2][uuid 16]
{
  const out = encodeEvent(UUID);
  assert.equal(out[0], S2C.EVENT);
  assert.equal(out.length, 17);
  assert.equal(bufToUuid(out.subarray(1)), UUID);
}

console.log('protocol self-test: PASS');
