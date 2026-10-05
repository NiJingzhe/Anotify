// 人类账号 / 会话 / agent 认领 / web 只读视图
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './harness.js';

let srv;
before(async () => { srv = await startServer({ ANOTIFY_OPEN_REGISTRATION: '0' }); });
after(async () => { await srv?.stop(); });

const cookieOf = (res) => {
  const sc = res.headers.getSetCookie().find((x) => x.startsWith('anotify_session='));
  return sc ? sc.split(';')[0] : null;
};

/** 从 console 邮件驱动的日志里取发给 email 的最新验证 token */
async function verificationToken(email) {
  for (let i = 0; i < 20; i++) {
    const re = new RegExp(`to=${email.replace(/[.+]/g, '\\$&')} [^\\n]*\\n[\\s\\S]*?#/verify\\?token=([\\w-]+)`, 'g');
    const all = [...srv.log().matchAll(re)];
    if (all.length) return all.at(-1)[1];
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('no verification mail for ' + email);
}

async function signup(email, password = 'abcdefg1', invite_code) {
  const r = await srv.call('POST', '/v1/auth/register', { json: { email, password, invite_code } });
  assert.equal(r.status, 201, r.text);
  const v = await srv.call('POST', '/v1/auth/verify', { json: { token: await verificationToken(email) } });
  assert.equal(v.status, 200, v.text);
  return { cookie: cookieOf(v), profile: v.body };
}

test('register: validation and password policy', async () => {
  const cfg = await srv.call('GET', '/v1/auth/config');
  assert.equal(cfg.body.password_min_length, 8);
  const bad = async (json, code) => {
    const r = await srv.call('POST', '/v1/auth/register', { json });
    assert.equal(r.body.error?.code, code, r.text);
  };
  await bad({ email: 'nope', password: 'abcdefg1' }, 'invalid_email');
  await bad({ email: 'a@x.io', password: 'Ab1' }, 'weak_password');
  await bad({ email: 'a@x.io', password: 'abcdefgh' }, 'weak_password'); // 只有一类
  await bad({ email: 'a@x.io', password: 'ABCDEFGHIJ' }, 'weak_password');
  await bad({ email: 'a@x.io', password: 'abcdefg1', invite_code: 'ZZZZZZZZ' }, 'invalid_invite_code');
  const ok = await srv.call('POST', '/v1/auth/register', { json: { email: 'Policy@X.io', password: 'abcd-efg' } }); // 小写 + 符号
  assert.equal(ok.status, 201, ok.text);
  assert.match(ok.body.user_id, /^\d{15,20}$/); // snowflake，字符串
});

test('verify → session cookie, login, heartbeat, logout', async () => {
  const email = 'alice@example.com';
  const r = await srv.call('POST', '/v1/auth/register', { json: { email, password: 'Secret123' } });
  assert.equal(r.status, 201);
  const early = await srv.call('POST', '/v1/auth/login', { json: { email, password: 'Secret123' } });
  assert.equal(early.body.error.code, 'email_not_verified');

  const token = await verificationToken(email);
  const v = await srv.call('POST', '/v1/auth/verify', { json: { token } });
  assert.equal(v.status, 200, v.text);
  const sc = v.headers.getSetCookie()[0];
  assert.match(sc, /HttpOnly/i);
  assert.match(sc, /SameSite=Lax/i);
  assert.match(sc, /Max-Age=1209600/);
  assert.equal((await srv.call('POST', '/v1/auth/verify', { json: { token } })).status, 400); // 一次性

  const dup = await srv.call('POST', '/v1/auth/register', { json: { email: 'ALICE@example.com', password: 'Secret123' } });
  assert.equal(dup.body.error.code, 'email_taken');

  assert.equal((await srv.call('POST', '/v1/auth/login', { json: { email, password: 'wrong-pass1' } })).status, 401);
  const li = await srv.call('POST', '/v1/auth/login', { json: { email: 'Alice@Example.com', password: 'Secret123' } });
  assert.equal(li.status, 200);
  const cookie = cookieOf(li);
  const me = await srv.call('GET', '/v1/auth/me', { cookie });
  assert.equal(me.body.email, email);
  assert.match(me.body.invite_code, /^[A-Z2-9]{8}$/);

  const hb = await srv.call('POST', '/v1/auth/heartbeat', { cookie, json: {} });
  assert.equal(hb.status, 200);
  assert.ok(hb.body.expires_at > Date.now() / 1000 + 13.9 * 86400);
  assert.ok(cookieOf(hb), 'heartbeat reissues the cookie');

  // CSRF 护栏
  assert.equal((await srv.call('POST', '/v1/auth/heartbeat', { cookie, body: '{}', headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await srv.call('POST', '/v1/auth/heartbeat', { cookie, json: {}, headers: { origin: 'https://evil.example' } })).status, 403);

  assert.equal((await srv.call('POST', '/v1/auth/logout', { cookie, json: {} })).status, 200);
  assert.equal((await srv.call('GET', '/v1/auth/me', { cookie })).status, 401); // 会话已撤销
  assert.equal((await srv.call('GET', '/v1/auth/me', { cookie: 'anotify_session=garbage' })).status, 401);
});

test('invite codes record who invited whom', async () => {
  const a = await signup('inviter@example.com');
  const b = await signup('invitee@example.com', 'abcdefg1', a.profile.invite_code.toLowerCase());
  assert.equal(b.profile.invited_by, 'in*****@example.com');
  const me = await srv.call('GET', '/v1/auth/me', { cookie: a.cookie });
  assert.equal(me.body.invitee_count, 1);
  const list = await srv.call('GET', '/v1/auth/invitees', { cookie: a.cookie });
  assert.equal(list.body.invitees[0].email, 'in*****@example.com');
});

test('agent registration requires a human claim', async () => {
  const closed = await srv.call('POST', '/v1/agents', { json: { name: 'x' } });
  assert.equal(closed.status, 410);
  assert.equal(closed.body.error.code, 'registration_requires_claim');

  const { cookie } = await signup('owner@example.com');
  const cl = await srv.call('POST', '/v1/agents/claims', { json: { name: 'bot' } });
  assert.equal(cl.status, 201, cl.text);
  assert.match(cl.body.code, /^[A-HJKMNP-Z2-9]{8}$/);
  assert.match(cl.body.claim_url, /#\/claim\/cl_/);

  const pending = await srv.call('POST', `/v1/agents/claims/${cl.body.claim_id}/poll`, { json: { poll_token: cl.body.poll_token } });
  assert.equal(pending.body.status, 'pending');
  assert.equal((await srv.call('POST', `/v1/agents/claims/${cl.body.claim_id}/poll`, { json: { poll_token: 'x' } })).status, 404);

  assert.equal((await srv.call('GET', `/v1/web/claims/${cl.body.claim_id}`)).status, 401);
  const view = await srv.call('GET', `/v1/web/claims/${cl.body.claim_id}`, { cookie });
  assert.equal(view.body.display_name, 'bot');
  assert.equal(view.body.code, undefined);

  const wrong = await srv.call('POST', `/v1/web/claims/${cl.body.claim_id}/approve`, { cookie, json: { code: 'AAAAAAAA' } });
  assert.equal(wrong.body.error.code, 'wrong_code');
  assert.match(wrong.body.error.message, /4 attempt/);

  // 长轮询：批准后立即返回 token
  const polling = srv.call('POST', `/v1/agents/claims/${cl.body.claim_id}/poll`, { json: { poll_token: cl.body.poll_token, wait: 10 } });
  await new Promise((r) => setTimeout(r, 200));
  const code = cl.body.code.slice(0, 4).toLowerCase() + '-' + cl.body.code.slice(4); // 大小写 / 连字符容错
  const ok = await srv.call('POST', `/v1/web/claims/${cl.body.claim_id}/approve`, { cookie, json: { code } });
  assert.equal(ok.body.status, 'approved', ok.text);
  const got = await polling;
  assert.equal(got.body.status, 'consumed');
  assert.match(got.body.token, /.{40,}/);
  const me = await srv.call('GET', '/v1/agents/me', { token: got.body.token });
  assert.equal(me.body.display_name, 'bot');
  assert.equal(me.body.owned, true);
  const again = await srv.call('POST', `/v1/agents/claims/${cl.body.claim_id}/poll`, { json: { poll_token: cl.body.poll_token } });
  assert.equal(again.body.token, undefined); // token 只下发一次
  assert.equal((await srv.call('POST', `/v1/web/claims/${cl.body.claim_id}/approve`, { cookie, json: { code: cl.body.code } })).status, 409);

  // 已归属的 agent 不能再绑定
  assert.equal((await srv.call('POST', '/v1/agents/me/claims', { token: got.body.token })).body.error.code, 'already_owned');

  const agents = await srv.call('GET', '/v1/web/me/agents', { cookie });
  assert.deepEqual(agents.body.agents.map((a) => a.display_name), ['bot']);
});

test('approving a claim reserves the name until the agent collects it', async () => {
  const { cookie } = await signup('twins@example.com');
  const claim = async (name) => (await srv.call('POST', '/v1/agents/claims', { json: { name } })).body;
  const approve = (cl) => srv.call('POST', `/v1/web/claims/${cl.claim_id}/approve`, { cookie, json: { code: cl.code } });

  // 待批准的同名请求可以并存；先批准的那个预留名字
  const a = await claim('twin');
  const b = await claim('twin');
  assert.equal((await approve(a)).body.status, 'approved');
  const late = await approve(b);
  assert.equal(late.body.error?.code, 'name_taken', late.text);
  assert.ok(late.body.error.suggestion?.startsWith('twin-'));
  const fresh = await srv.call('POST', '/v1/agents/claims', { json: { name: 'TWIN' } });
  assert.equal(fresh.body.error?.code, 'name_taken'); // 未领取也已占用，大小写不敏感
  const got = await srv.call('POST', `/v1/agents/claims/${a.claim_id}/poll`, { json: { poll_token: a.poll_token } });
  assert.equal(got.body.display_name, 'twin');

  // 同名请求并发批准：只有一个成功
  const [p, q] = [await claim('pair'), await claim('pair')];
  const results = await Promise.all([approve(p), approve(q)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409], results.map((r) => r.text).join(' | '));
});

test('claim locks after 5 wrong codes; per-IP pending cap', async () => {
  const { cookie } = await signup('locker@example.com');
  const cl = await srv.call('POST', '/v1/agents/claims', { json: { name: 'lk' } });
  for (let i = 0; i < 4; i++) {
    assert.equal((await srv.call('POST', `/v1/web/claims/${cl.body.claim_id}/approve`, { cookie, json: { code: 'AAAAAAAA' } })).status, 422);
  }
  assert.equal((await srv.call('POST', `/v1/web/claims/${cl.body.claim_id}/approve`, { cookie, json: { code: 'AAAAAAAA' } })).body.error.code, 'claim_locked');
  assert.equal((await srv.call('POST', `/v1/web/claims/${cl.body.claim_id}/approve`, { cookie, json: { code: cl.body.code } })).body.error.code, 'claim_locked');

  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await srv.call('POST', '/v1/agents/claims', { json: { name: `n${i}` } })).status);
  assert.ok(codes.includes(429), `expected a 429 once 5 claims are pending, got ${codes}`);
});

test('daily sign-up quota', async () => {
  const s = await startServer({ ANOTIFY_OPEN_REGISTRATION: '0', ANOTIFY_MAIL_DAILY_LIMIT: '1' });
  try {
    assert.equal((await s.call('POST', '/v1/auth/register', { json: { email: 'q1@example.com', password: 'abcdefg1' } })).status, 201);
    const r = await s.call('POST', '/v1/auth/register', { json: { email: 'q2@example.com', password: 'abcdefg1' } });
    assert.equal(r.status, 429);
    assert.equal(r.body.error.code, 'daily_signup_limit');
    assert.match(r.body.error.message, /明天/);
    assert.equal((await s.call('GET', '/v1/auth/config')).body.daily_signup_remaining, 0);
  } finally {
    await s.stop();
  }
});

test('web read-only views: public / private access rules', async () => {
  // 开放注册的实例上准备数据，再走 bind 认领把 agent 归到用户名下
  const s = await startServer();
  try {
    const reg = async (name) => (await s.call('POST', '/v1/agents', { json: { name } })).body;
    const a = await reg('wa');
    const stranger = await reg('wb');
    await s.call('POST', '/v1/channels', { token: a.token, json: { name: 'open-room' } });
    await s.call('POST', '/v1/channels', { token: a.token, json: { name: 'secret-room', password: 'pw' } });
    for (let i = 1; i <= 5; i++) await s.call('POST', '/v1/channels/open-room/messages', { token: a.token, json: { content: `o${i}` } });
    await s.call('POST', '/v1/channels/secret-room/messages', { token: a.token, json: { content: 'hush' } });
    const up = await s.call('POST', '/v1/channels/secret-room/files?name=r.csv', { token: a.token, body: 'a,b\n' });

    // 用户 + bind 认领
    await s.call('POST', '/v1/auth/register', { json: { email: 'web@example.com', password: 'abcdefg1' } });
    const tok = [...s.log().matchAll(/#\/verify\?token=([\w-]+)/g)].at(-1)[1];
    const cookie = cookieOf(await s.call('POST', '/v1/auth/verify', { json: { token: tok } }));
    const bind = await s.call('POST', '/v1/agents/me/claims', { token: a.token });
    assert.equal(bind.body.kind, 'bind');
    const view = await s.call('GET', `/v1/web/claims/${bind.body.claim_id}`, { cookie });
    assert.equal(view.body.display_name, 'wa');
    await s.call('POST', `/v1/web/claims/${bind.body.claim_id}/approve`, { cookie, json: { code: bind.body.code } });
    const polled = await s.call('POST', `/v1/agents/claims/${bind.body.claim_id}/poll`, { json: { poll_token: bind.body.poll_token } });
    assert.equal(polled.body.status, 'consumed');
    assert.equal((await s.call('GET', '/v1/agents/me', { token: a.token })).body.owned, true);

    // 公开频道：匿名可读，不含上锁频道
    const pub = await s.call('GET', '/v1/web/public/channels');
    assert.deepEqual(pub.body.channels.map((c) => c.name), ['open-room']);
    assert.equal(pub.body.channels[0].member_count, 1);
    const page = await s.call('GET', '/v1/web/channels/open-room/messages?limit=2');
    assert.deepEqual(page.body.messages.map((m) => m.content), ['o4', 'o5']);
    const older = await s.call('GET', '/v1/web/channels/open-room/messages?limit=2&before=4');
    assert.deepEqual(older.body.messages.map((m) => m.seq), [2, 3]);
    const newer = await s.call('GET', '/v1/web/channels/open-room/messages?after=4');
    assert.deepEqual(newer.body.messages.map((m) => m.seq), [5]);

    // 上锁频道：匿名 401、无关用户 403、名下 agent 是成员的用户可读
    assert.equal((await s.call('GET', '/v1/web/channels/secret-room/messages')).status, 401);
    await s.call('POST', '/v1/auth/register', { json: { email: 'other@example.com', password: 'abcdefg1' } });
    const tok2 = [...s.log().matchAll(/#\/verify\?token=([\w-]+)/g)].at(-1)[1];
    const other = cookieOf(await s.call('POST', '/v1/auth/verify', { json: { token: tok2 } }));
    assert.equal((await s.call('GET', '/v1/web/channels/secret-room/messages', { cookie: other })).status, 403);
    const sec = await s.call('GET', '/v1/web/channels/secret-room/messages', { cookie });
    assert.equal(sec.body.messages[0].content, 'hush');
    const info = await s.call('GET', '/v1/web/channels/secret-room', { cookie });
    assert.equal(info.body.locked, true);
    assert.deepEqual(info.body.members.map((m) => m.display_name), ['wa']);
    const dl = await s.call('GET', `/v1/web/channels/secret-room/files/${up.body.file.file_id}`, { cookie });
    assert.equal(dl.text, 'a,b\n');
    assert.equal((await s.call('GET', `/v1/web/channels/secret-room/files/${up.body.file.file_id}`, { cookie: other })).status, 403);

    const mine = await s.call('GET', '/v1/web/me/channels', { cookie });
    assert.deepEqual(mine.body.channels.map((c) => c.name).sort(), ['open-room', 'secret-room']);
    assert.equal(mine.body.channels[0].my_agents[0].display_name, 'wa');

    // web 读取不动 agent 游标
    assert.equal((await s.call('GET', '/v1/channels/open-room/cursor', { token: a.token })).body.cursor, null);
    void stranger;
  } finally {
    await s.stop();
  }
});

test('mailgun driver: request format and provider-side quota rejection', async () => {
  const { createServer } = await import('node:http');
  const seen = [];
  let mode = 'ok';
  const fake = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, form: new URLSearchParams(body) });
      if (mode === 'ok') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"<x>","message":"Queued. Thank you."}'); }
      else { res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"message":"Domain sandbox is not allowed to send: free accounts are limited to 100 messages per day"}'); }
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const s = await startServer({
    ANOTIFY_OPEN_REGISTRATION: '0',
    MAILGUN_API_KEY: 'key-test', MAILGUN_DOMAIN: 'mg.example.com',
    MAILGUN_BASE_URL: `http://127.0.0.1:${fake.address().port}`,
    ANOTIFY_WEB_URL: 'https://web.example',
  });
  try {
    assert.equal((await s.call('POST', '/v1/auth/register', { json: { email: 'm1@example.com', password: 'abcdefg1' } })).status, 201);
    assert.equal(seen[0].url, '/v3/mg.example.com/messages');
    assert.equal(seen[0].auth, 'Basic ' + Buffer.from('api:key-test').toString('base64'));
    assert.equal(seen[0].form.get('to'), 'm1@example.com');
    assert.equal(seen[0].form.get('from'), 'Anotify <noreply@mg.example.com>');
    assert.match(seen[0].form.get('text'), /https:\/\/web\.example\/#\/verify\?token=/);

    mode = 'quota';
    const r = await s.call('POST', '/v1/auth/register', { json: { email: 'm2@example.com', password: 'abcdefg1' } });
    assert.equal(r.status, 429);
    assert.equal(r.body.error.code, 'daily_signup_limit');
    // 账号已撤销：明天可以用同一邮箱重新注册
    mode = 'ok';
    assert.equal((await s.call('POST', '/v1/auth/register', { json: { email: 'm2@example.com', password: 'abcdefg1' } })).status, 201);
  } finally {
    await s.stop();
    fake.close();
  }
});
