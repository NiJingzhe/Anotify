// 人类管理操作：删除名下 agent、关闭（删除）频道、同名 agent 提示（DESIGN §14.6）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { startServer } from './harness.js';

let srv;
// 文件存本地磁盘，便于直接断言 blob 是否被删除
before(async () => { srv = await startServer({ ANOTIFY_S3_ENDPOINT: '' }); });
after(async () => { await srv?.stop(); });

const cookieOf = (res) => res.headers.getSetCookie().find((x) => x.startsWith('anotify_session='))?.split(';')[0];

async function signup(email) {
  await srv.call('POST', '/v1/auth/register', { json: { email, password: 'abcdefg1' } });
  const tok = [...srv.log().matchAll(new RegExp(`to=${email.replace(/[.]/g, '\\.')}[^\\n]*\\n[\\s\\S]*?#/verify\\?token=([\\w-]+)`, 'g'))].at(-1)[1];
  return cookieOf(await srv.call('POST', '/v1/auth/verify', { json: { token: tok } }));
}
const reg = async (name) => (await srv.call('POST', '/v1/agents', { json: { name } })).body;
async function bind(agent, cookie) {
  const cl = (await srv.call('POST', '/v1/agents/me/claims', { token: agent.token })).body;
  const ok = await srv.call('POST', `/v1/web/claims/${cl.claim_id}/approve`, { cookie, json: { code: cl.code } });
  assert.equal(ok.status, 200, ok.text);
}
const blobOnDisk = (id) => existsSync(`${srv.env.ANOTIFY_FILES_DIR}/${id}`);
const del = (path, cookie) => srv.call('DELETE', path, { cookie, json: {} });

test('delete an owned agent: token dies, rosters cleared, history kept, pending files released', async () => {
  const owner = await signup('mgr@example.com');
  const stranger = await signup('other-mgr@example.com');
  const [a, b, c] = [await reg('ma'), await reg('mb'), await reg('mc')];
  await bind(a, owner);
  await srv.call('POST', '/v1/channels', { token: b.token, json: { name: 'm-room' } });
  await srv.call('POST', '/v1/channels/m-room/join', { token: a.token });
  await srv.call('POST', '/v1/channels/m-room/join', { token: c.token });
  await srv.call('POST', '/v1/channels/m-room/messages', { token: a.token, json: { content: 'from ma' } });
  const up = await srv.call('POST', '/v1/channels/m-room/files?name=x.csv', { token: b.token, body: 'a\n' });
  const fid = up.body.file.file_id;
  await srv.call('POST', `/v1/channels/m-room/files/${fid}/received`, { token: c.token }); // c 已收，a 未收
  assert.equal(blobOnDisk(fid), true);

  // 只能删自己名下的
  assert.equal((await del(`/v1/web/me/agents/${a.agent_id}`, stranger)).status, 404);
  assert.equal((await del(`/v1/web/me/agents/${a.agent_id}`)).status, 401);
  assert.equal((await srv.call('DELETE', `/v1/web/me/agents/${a.agent_id}`, { cookie: owner, body: '{}', headers: { 'content-type': 'text/plain' } })).status, 415);

  const r = await del(`/v1/web/me/agents/${a.agent_id}`, owner);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.deleted, true);

  const me = await srv.call('GET', '/v1/agents/me', { token: a.token });
  assert.equal(me.status, 401);
  assert.match(me.body.error.message, /owner may have deleted it/);
  const members = await srv.call('GET', '/v1/channels/m-room/members', { token: b.token });
  assert.deepEqual(members.body.members.map((m) => m.display_name).sort(), ['mb', 'mc']);
  const hist = await srv.call('GET', '/v1/channels/m-room/messages?since=0', { token: b.token });
  assert.equal(hist.body.messages[0].sender_name, 'ma'); // 历史消息仍显示名字
  assert.equal(blobOnDisk(fid), false, 'file no longer waits for the deleted agent');
  assert.equal((await srv.call('GET', `/v1/channels/m-room/files/${fid}`, { token: b.token })).status, 410);

  assert.deepEqual((await srv.call('GET', '/v1/web/me/agents', { cookie: owner })).body.agents, []);
  assert.equal((await srv.call('GET', '/v1/auth/me', { cookie: owner })).body.agent_count, 0);
  assert.equal((await del(`/v1/web/me/agents/${a.agent_id}`, owner)).status, 404); // 幂等：已删即不存在
  // 删掉的名字在名册里不再占位：新 agent 可以用同名加入
  const a2 = await reg('ma');
  assert.equal((await srv.call('POST', '/v1/channels/m-room/join', { token: a2.token })).status, 200);
});

test('close a channel: only the owner of its creator agent; everything is deleted; name reusable', async () => {
  const owner = await signup('closer@example.com');
  const other = await signup('closer-other@example.com');
  const [a, b] = [await reg('ca'), await reg('cb')];
  await bind(a, owner);
  await bind(b, other);
  await srv.call('POST', '/v1/channels', { token: a.token, json: { name: 'to-close', password: 'pw' } });
  await srv.call('POST', '/v1/channels/to-close/join', { token: b.token, json: { password: 'pw' } });
  await srv.call('POST', '/v1/channels/to-close/messages', { token: b.token, json: { content: 'hi' } });
  const fid = (await srv.call('POST', '/v1/channels/to-close/files?name=y.csv', { token: a.token, body: 'b\n' })).body.file.file_id;
  assert.equal(blobOnDisk(fid), true);

  // can_close：创建者的主人才有
  const mine = (await srv.call('GET', '/v1/web/me/channels', { cookie: owner })).body.channels.find((x) => x.name === 'to-close');
  const theirs = (await srv.call('GET', '/v1/web/me/channels', { cookie: other })).body.channels.find((x) => x.name === 'to-close');
  assert.equal(mine.can_close, true);
  assert.equal(theirs.can_close, false);
  assert.equal((await srv.call('GET', '/v1/web/channels/to-close', { cookie: owner })).body.can_close, true);

  assert.equal((await del('/v1/web/channels/to-close', other)).status, 403);
  assert.equal((await del('/v1/web/channels/to-close')).status, 401);
  assert.equal((await del('/v1/web/channels/nope', owner)).status, 404);

  // 正在长轮询的 agent 被唤醒
  const waiting = srv.call('GET', '/v1/channels/to-close/messages?wait=20&since=1', { token: b.token });
  await new Promise((r) => setTimeout(r, 200));
  const t0 = Date.now();
  const r = await del('/v1/web/channels/to-close', owner);
  assert.equal(r.status, 200, r.text);
  await waiting;
  assert.ok(Date.now() - t0 < 5000, 'long-poll released promptly');

  assert.equal((await srv.call('GET', '/v1/channels/to-close/messages', { token: b.token })).status, 404);
  assert.equal(blobOnDisk(fid), false);
  assert.equal((await srv.call('GET', '/v1/channels', { token: b.token })).body.channels.some((x) => x.name === 'to-close'), false);
  // 名字可再用；旧游标 / 名册不残留
  assert.equal((await srv.call('POST', '/v1/channels', { token: b.token, json: { name: 'to-close' } })).status, 201);
  const fresh = await srv.call('GET', '/v1/channels/to-close/members', { token: b.token });
  assert.deepEqual(fresh.body.members.map((m) => m.display_name), ['cb']);
  assert.equal((await srv.call('GET', '/v1/channels/to-close/cursor', { token: a.token })).body.cursor, null);
});

test('channels created by a deleted agent can still be closed by its former owner', async () => {
  const owner = await signup('former@example.com');
  const a = await reg('fa');
  await bind(a, owner);
  await srv.call('POST', '/v1/channels', { token: a.token, json: { name: 'orphaned' } });
  await del(`/v1/web/me/agents/${a.agent_id}`, owner);
  assert.equal((await del('/v1/web/channels/orphaned', owner)).status, 200);
});

test('approving a claim warns about a same-name agent already on the account', async () => {
  const owner = await signup('dup@example.com');
  const a = await reg('twin');
  await bind(a, owner);
  // 新 agent 的注册认领：开放注册的实例也接受认领流程
  const cl = (await srv.call('POST', '/v1/agents/claims', { json: { name: 'twin' } })).body;
  const view = await srv.call('GET', `/v1/web/claims/${cl.claim_id}`, { cookie: owner });
  assert.equal(view.body.same_name_agents, 1);
  const cl2 = (await srv.call('POST', '/v1/agents/claims', { json: { name: 'unique-name' } })).body;
  assert.equal((await srv.call('GET', `/v1/web/claims/${cl2.claim_id}`, { cookie: owner })).body.same_name_agents, 0);
});
