// 核心协议回归：身份、频道、消息、长轮询、游标、上锁频道、文件交换
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startServer } from './harness.js';

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv?.stop(); });

const register = async (name) => {
  const r = await srv.call('POST', '/v1/agents', { json: { name } });
  assert.equal(r.status, 201, r.text);
  return r.body;
};

test('info + identity', async () => {
  const info = await srv.call('GET', '/v1/info');
  assert.match(info.body.instance_id, /^srv_/);
  const a = await register('alice');
  const me = await srv.call('GET', '/v1/agents/me', { token: a.token });
  assert.equal(me.body.agent_id, a.agent_id);
  assert.equal((await srv.call('GET', '/v1/agents/me', { token: 'nope' })).status, 401);
  const rn = await srv.call('PATCH', '/v1/agents/me', { token: a.token, json: { display_name: 'alice2' } });
  assert.equal(rn.body.display_name, 'alice2');
});

test('messages, seq, cursor, ack, long-poll', async () => {
  const a = await register('pa');
  const b = await register('pb');
  assert.equal((await srv.call('POST', '/v1/channels', { token: a.token, json: { name: 'room' } })).status, 201);
  assert.equal((await srv.call('POST', '/v1/channels', { token: a.token, json: { name: 'room' } })).status, 409);
  assert.equal((await srv.call('POST', '/v1/channels/nope/messages', { token: a.token, json: { content: 'x' } })).status, 404);

  // 并发写入：seq 严格连续
  const sends = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    srv.call('POST', '/v1/channels/room/messages', { token: a.token, json: { content: `m${i}` } })));
  const seqs = sends.map((r) => r.body.seq).sort((x, y) => x - y);
  assert.deepEqual(seqs, Array.from({ length: 20 }, (_, i) => i + 1));

  const r1 = await srv.call('GET', '/v1/channels/room/messages', { token: b.token });
  assert.equal(r1.body.cursor_initialized, true);
  assert.equal(r1.body.messages.length, 20);
  assert.equal(r1.body.messages[0].sender_name, 'pa');
  const ack = await srv.call('POST', '/v1/channels/room/ack', { token: b.token, json: { through: 999 } });
  assert.equal(ack.body.cursor, 20); // 钳制到 latest
  const back = await srv.call('POST', '/v1/channels/room/ack', { token: b.token, json: { through: 3 } });
  assert.equal(back.body.cursor, 20); // 只进不退

  // 长轮询：写入后立即唤醒
  const t0 = Date.now();
  const waiting = srv.call('GET', '/v1/channels/room/messages?wait=10', { token: b.token });
  await new Promise((r) => setTimeout(r, 300));
  await srv.call('POST', '/v1/channels/room/messages', { token: a.token, json: { content: 'wake', reply_to: 1 } });
  const w = await waiting;
  assert.equal(w.body.messages[0].content, 'wake');
  assert.equal(w.body.messages[0].reply_to, 1);
  assert.ok(Date.now() - t0 < 3000, 'long-poll should wake promptly');

  // 空等超时
  const e = await srv.call('GET', '/v1/channels/room/messages?wait=1&since=21', { token: b.token });
  assert.equal(e.body.messages.length, 0);

  const list = await srv.call('GET', '/v1/channels', { token: b.token });
  const room = list.body.channels.find((c) => c.name === 'room');
  assert.equal(room.latest_seq, 21);
  assert.equal(room.pending, 1);
  assert.equal(room.joined, false);
  assert.equal((await srv.call('POST', '/v1/channels/room/messages', { token: a.token, json: { content: 'x', reply_to: 99 } })).status, 422);
});

test('locked channel + roster', async () => {
  const o = await register('owner');
  const x = await register('xeno');
  await srv.call('POST', '/v1/channels', { token: o.token, json: { name: 'vault', password: 'pw' } });
  assert.equal((await srv.call('GET', '/v1/channels/vault/messages', { token: x.token })).status, 403);
  assert.equal((await srv.call('POST', '/v1/channels/vault/join', { token: x.token, json: { password: 'bad' } })).status, 403);
  assert.equal((await srv.call('POST', '/v1/channels/vault/join', { token: x.token, json: { password: 'pw' } })).body.joined, true);
  const mem = await srv.call('GET', '/v1/channels/vault/members', { token: x.token });
  assert.deepEqual(mem.body.members.map((m) => m.display_name), ['owner', 'xeno']);
  assert.equal((await srv.call('PATCH', '/v1/channels/vault', { token: x.token, json: { password: '' } })).status, 403);
  assert.equal((await srv.call('PATCH', '/v1/channels/vault', { token: o.token, json: { password: '' } })).body.locked, false);
});

test('display names are unique server-wide (case-insensitive), with a ready-to-use suggestion', async () => {
  const a = await register('unique-one');
  const dup = await srv.call('POST', '/v1/agents', { json: { name: 'Unique-One' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'name_taken');
  assert.match(dup.body.error.suggestion, /^Unique-One-[0-9a-z]{4}$/);
  // 照抄建议即可成功
  assert.equal((await srv.call('POST', '/v1/agents', { json: { name: dup.body.error.suggestion } })).status, 201);
  // 改名同样全服校验；改回自己的名字（大小写变化）允许
  const b = await register('other-one');
  const rn = await srv.call('PATCH', '/v1/agents/me', { token: b.token, json: { display_name: 'UNIQUE-ONE' } });
  assert.equal(rn.body.error.code, 'name_taken');
  assert.ok(rn.body.error.suggestion);
  assert.equal((await srv.call('PATCH', '/v1/agents/me', { token: a.token, json: { display_name: 'Unique-one' } })).status, 200);
  // 认领注册在发起时就拦住
  const cl = await srv.call('POST', '/v1/agents/claims', { json: { name: 'unique-one' } });
  assert.equal(cl.body.error.code, 'name_taken');
});

test('file exchange via object storage', async () => {
  const a = await register('fa');
  const b = await register('fb');
  await srv.call('POST', '/v1/channels', { token: a.token, json: { name: 'files' } });
  const data = Buffer.from('id,value\n1,hello\n2,世界\n');
  const up = await srv.call('POST', '/v1/channels/files/files?name=' + encodeURIComponent('结果.csv') + '&caption=hi',
    { token: a.token, body: data, headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(up.status, 201, up.text);
  assert.equal(up.body.file.mime, 'text/csv');
  assert.equal(up.body.file.sha256, createHash('sha256').update(data).digest('hex'));
  const dl = await fetch(`${srv.url}/v1/channels/files/files/${up.body.file.file_id}`, { headers: { authorization: `Bearer ${b.token}` } });
  assert.equal(dl.status, 200);
  assert.deepEqual(Buffer.from(await dl.arrayBuffer()), data);
  assert.equal(dl.headers.get('x-anotify-sha256'), up.body.file.sha256);
  assert.equal(dl.headers.get('content-length'), String(data.length));

  const big = await srv.call('POST', '/v1/channels/files/files?name=big.bin', { token: a.token, body: Buffer.alloc(2048) });
  assert.equal(big.status, 413);
  const empty = await srv.call('POST', '/v1/channels/files/files?name=e.bin', { token: a.token, body: Buffer.alloc(0) });
  assert.equal(empty.status, 422);
  assert.equal((await srv.call('GET', '/v1/channels/files/files/f_AAAAAAAAAAAAAAAA', { token: a.token })).status, 404);
  const forged = await srv.call('POST', '/v1/channels/files/messages',
    { token: a.token, json: { content: '{}', content_type: 'application/vnd.anotify.file+json' } });
  assert.equal(forged.status, 422);

  // 跨频道引用同一 file_id → 404
  await srv.call('POST', '/v1/channels', { token: a.token, json: { name: 'other' } });
  assert.equal((await srv.call('GET', `/v1/channels/other/files/${up.body.file.file_id}`, { token: a.token })).status, 404);
});
