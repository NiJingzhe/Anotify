// 决策轨迹端到端（DESIGN §15）：需要 Postgres（与其他 e2e 测试相同）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './harness.js';

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv?.stop(); });

const reg = async (name) => (await srv.call('POST', '/v1/agents', { json: { name } })).body;
const post = (token, ch, json) => srv.call('POST', `/v1/channels/${ch}/decisions`, { token, json });
const DEC = { kind: 'decision', decision: 'ship it', because: [{ type: 'fact', text: 'tests green' }] };
const HAND = {
  kind: 'handoff', question: 'install?', why_you: 'changes system tasks',
  options: [{ id: 'A', label: 'now', outcome: 'auto-start' }, { id: 'B', label: 'later', outcome: 'manual' }],
};

test('decision/handoff/resolution flow: stored as messages with the decision content type', async () => {
  const a = await reg('dec-a');
  await srv.call('POST', '/v1/channels', { token: a.token, json: { name: 'dec-flow' } });
  const d = await post(a.token, 'dec-flow', DEC);
  assert.equal(d.status, 201, d.text);
  assert.equal(d.body.content_type, 'application/vnd.anotify.decision+json');
  const h = await post(a.token, 'dec-flow', { ...HAND, done_so_far: [d.body.seq] });
  assert.equal(h.status, 201, h.text);
  const r = await post(a.token, 'dec-flow', { kind: 'resolution', reply_to: h.body.seq, chosen: 'A', note: 'user ok' });
  assert.equal(r.status, 201, r.text);
  const got = await srv.call('GET', '/v1/channels/dec-flow/messages?since=0&wait=0', { token: a.token });
  assert.equal(got.body.messages.filter((m) => m.content_type.includes('decision')).length, 3);
});

test('plain POST /messages cannot forge a decision record', async () => {
  const a = await reg('dec-forge');
  await srv.call('POST', '/v1/channels', { token: a.token, json: { name: 'dec-forge' } });
  const r = await srv.call('POST', '/v1/channels/dec-forge/messages', {
    token: a.token, json: { content: JSON.stringify(DEC), content_type: 'application/vnd.anotify.decision+json' },
  });
  assert.equal(r.status, 422);
});

test('references must exist; resolution must target a handoff and a real option', async () => {
  const a = await reg('dec-ref');
  await srv.call('POST', '/v1/channels', { token: a.token, json: { name: 'dec-ref' } });
  const bad = await post(a.token, 'dec-ref', { ...DEC, because: [{ type: 'prior', ref: 99, text: 'nope' }] });
  assert.equal(bad.status, 422);
  const d = await post(a.token, 'dec-ref', DEC);
  const notHandoff = await post(a.token, 'dec-ref', { kind: 'resolution', reply_to: d.body.seq, note: 'n' });
  assert.equal(notHandoff.status, 422);
  const h = await post(a.token, 'dec-ref', HAND);
  const badOpt = await post(a.token, 'dec-ref', { kind: 'resolution', reply_to: h.body.seq, chosen: 'F', note: 'n' });
  assert.equal(badOpt.status, 422);
});

test('locked channel: non-members cannot record decisions', async () => {
  const [a, b] = [await reg('dec-lock-a'), await reg('dec-lock-b')];
  await srv.call('POST', '/v1/channels', { token: a.token, json: { name: 'dec-locked', password: 'pw-12345' } });
  const r = await post(b.token, 'dec-locked', DEC);
  assert.equal(r.status, 403);
});

test('web view: ?type=decision returns only decision records; unknown type is 422', async () => {
  const a = await reg('dec-web');
  await srv.call('POST', '/v1/channels', { token: a.token, json: { name: 'dec-web' } });
  await srv.call('POST', '/v1/channels/dec-web/messages', { token: a.token, json: { content: 'chat' } });
  await post(a.token, 'dec-web', DEC);
  const all = await srv.call('GET', '/v1/web/channels/dec-web/messages');
  const only = await srv.call('GET', '/v1/web/channels/dec-web/messages?type=decision');
  assert.equal(all.body.messages.length, 2);
  assert.equal(only.body.messages.length, 1);
  assert.equal(only.body.messages[0].content_type, 'application/vnd.anotify.decision+json');
  assert.equal((await srv.call('GET', '/v1/web/channels/dec-web/messages?type=bogus')).status, 422);
});
