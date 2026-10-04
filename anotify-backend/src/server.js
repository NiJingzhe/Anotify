// Anotify 服务端：路由与入口（设计见 DESIGN.md §6）
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { createStore } from './db.js';
import { requireAuth } from './auth.js';
import { HttpError, parseJson, parseOptionalJson, assertName, assertInt, validateMessageBody } from './schemas.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dbPath = process.env.ANOTIFY_DB ?? './anotify.db';
const port = Number(process.env.PORT ?? 8000);
const host = process.env.HOST ?? '0.0.0.0';

const store = createStore(dbPath);
const app = new Hono();

app.use(logger());
app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status);
  }
  console.error(err);
  return c.json({ error: { code: 'internal', message: 'internal server error' } }, 500);
});
app.notFound((c) =>
  c.json({ error: { code: 'not_found', message: 'route not found' } }, 404)
);

app.get('/healthz', (c) => c.json({ ok: true }));

const v1 = new Hono();

// ---------- 公开路由 ----------

// POST /v1/agents —— 注册身份（§6.1）：agent_id 服务端生成且不可变
v1.post('/agents', async (c) => {
  const body = await parseJson(c);
  const displayName = assertName(body?.name, 'name');
  const result = store.createAgent(displayName);
  return c.json({
    agent_id: result.agent_id,
    display_name: result.display_name,
    token: result.token,
  }, 201);
});

// ---------- 以下路由需要认证 ----------

const authed = new Hono();
authed.use('*', requireAuth(store));

// GET /v1/agents/me —— 当前认证身份（§6.1.1）
authed.get('/agents/me', (c) => {
  return c.json({ agent_id: c.get('agentId'), display_name: c.get('agentName') });
});

// PATCH /v1/agents/me —— 改名（§6.1.1）：只改显示视图，历史引用不受影响
authed.patch('/agents/me', async (c) => {
  const body = await parseJson(c);
  const displayName = assertName(body?.display_name, 'display_name');
  const result = store.renameAgent(c.get('agentId'), displayName);
  return c.json(result);
});

// POST /v1/channels —— 创建频道（§6.2），可选密码上锁；创建者自动入册
authed.post('/channels', async (c) => {
  const body = await parseJson(c);
  const name = assertName(body?.name, 'name');
  const password = typeof body?.password === 'string' && body.password.length > 0 ? body.password : undefined;
  const agentId = c.get('agentId');
  const ch = store.createChannel(name, agentId, password);
  store.ensureMember(name, agentId);
  return c.json({
    name: ch.name,
    locked: ch.locked,
    created_at: ch.created_at,
    created_by: ch.created_by,
    created_by_name: c.get('agentName'),
  }, 201);
});

// PATCH /v1/channels/:ch —— owner 修改/清除密码（§6.2）
authed.patch('/channels/:ch', async (c) => {
  const ch = requireChannel(c);
  const body = await parseJson(c);
  if (typeof body?.password !== 'string') {
    throw new HttpError(422, 'invalid_param', 'password must be a string（空字符串表示清除密码）');
  }
  const result = store.setChannelPassword(ch, c.get('agentId'), body.password || null);
  return c.json(result);
});

// POST /v1/channels/:ch/join —— 入册（上锁频道需密码）
authed.post('/channels/:ch/join', async (c) => {
  const ch = requireChannel(c);
  const body = await parseOptionalJson(c);
  store.assertJoinAllowed(ch, body?.password);
  const agentId = c.get('agentId');
  const joined = store.ensureMember(ch, agentId);
  return c.json({ channel: ch, agent_id: agentId, joined });
});

// GET /v1/channels/:ch/members —— 频道名册（上锁频道仅成员可见）
authed.get('/channels/:ch/members', (c) => {
  const ch = requireChannel(c);
  requireAccess(c, ch);
  return c.json({ channel: ch, members: store.listMembers(ch) });
});

// GET /v1/channels —— 频道列表 + 自己视角的游标/积压（§6.7）
authed.get('/channels', (c) => {
  return c.json({ channels: store.listChannels(c.get('agentId')) });
});

// 频道必须已显式创建，否则 404，不隐式创建（§6.3）
function requireChannel(c) {
  const ch = c.req.param('ch');
  if (!store.hasChannel(ch)) {
    throw new HttpError(404, 'channel_not_found', `channel "${ch}" does not exist`);
  }
  return ch;
}

// 上锁频道的访问门：非成员一律 403（公开频道不设防，行为不变）
function requireAccess(c, ch) {
  const row = store.getChannelRow(ch);
  if (row?.password_hash && !store.isMember(ch, c.get('agentId'))) {
    throw new HttpError(
      403, 'join_required',
      `频道 "${ch}" 已上锁：先 anotify join ${ch} --password <密码> 再访问`
    );
  }
}

// POST /v1/channels/:ch/messages —— 发布消息（§6.3）：公开频道自动入册，上锁频道须先 join
authed.post('/channels/:ch/messages', async (c) => {
  const ch = requireChannel(c);
  requireAccess(c, ch);
  const agentId = c.get('agentId');
  const body = validateMessageBody(await parseJson(c));
  if (body.reply_to !== undefined && !store.hasMessage(ch, body.reply_to)) {
    throw new HttpError(
      422, 'reply_target_missing',
      `reply_to seq ${body.reply_to} not found in channel "${ch}"`
    );
  }
  store.ensureMember(ch, agentId); // 名册重名校验在此发生（§3）
  const msg = store.insertMessage({ channel: ch, sender: agentId, ...body });
  return c.json({
    channel: ch,
    seq: msg.seq,
    sender: agentId,
    sender_name: c.get('agentName'),
    content: body.content,
    content_type: body.content_type,
    reply_to: body.reply_to ?? null,
    created_at: msg.created_at,
  }, 201);
});

// GET /v1/channels/:ch/messages —— 拉取消息，支持长轮询（§6.4）
authed.get('/channels/:ch/messages', async (c) => {
  const ch = requireChannel(c);
  requireAccess(c, ch);
  const agentId = c.get('agentId');
  const q = c.req.query();

  // since 显式传入 = 临时覆盖，仅本次生效、不动游标（§4.5）；
  // 不传 = 用服务端游标，首次拉取按 §5 初始化（最近 10 分钟）。
  let base;
  let initialized = false;
  if (q.since !== undefined) {
    base = assertInt(q.since, { min: 0, label: 'since' });
  } else {
    ({ cursor: base, initialized } = store.ensureCursor(ch, agentId));
  }

  const wait = assertInt(q.wait ?? 0, { min: 0, max: 60, label: 'wait' });
  const limit = assertInt(q.limit ?? 100, { min: 1, max: 1000, label: 'limit' });

  let messages = store.messagesSince(ch, base, limit);
  const deadline = Date.now() + wait * 1000;
  while (messages.length === 0 && Date.now() < deadline) {
    await sleep(300);
    messages = store.messagesSince(ch, base, limit);
  }

  return c.json({
    channel: ch,
    messages,
    cursor: base,
    cursor_initialized: initialized,
    latest_seq: store.latestSeq(ch),
  });
});

// POST /v1/channels/:ch/ack —— 推进游标水位线（§6.5）
authed.post('/channels/:ch/ack', async (c) => {
  const ch = requireChannel(c);
  const body = await parseJson(c);
  const through = assertInt(body?.through, { min: 0, label: 'through' });
  const cursor = store.setCursor(ch, c.get('agentId'), through);
  return c.json({ channel: ch, cursor });
});

// GET /v1/channels/:ch/cursor —— 查看游标（§6.6）
authed.get('/channels/:ch/cursor', (c) => {
  const ch = requireChannel(c);
  requireAccess(c, ch);
  const agentId = c.get('agentId');
  const row = store.getCursorRow(ch, agentId);
  return c.json({
    channel: ch,
    agent: agentId,
    cursor: row ? row.cursor : null,
    updated_at: row ? row.updated_at : null,
  });
});

v1.route('/', authed);
app.route('/v1', v1);

// ---------- 启动 ----------

const server = serve({ fetch: app.fetch, port, host }, (info) => {
  console.log(`anotify-backend listening on http://${info.address}:${info.port}`);
  console.log(`  db: ${dbPath}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
