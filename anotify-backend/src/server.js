// Anotify 服务端：路由与入口（设计见 DESIGN.md §6）
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { createStore } from './db.js';
import { requireAuth } from './auth.js';
import { HttpError, parseJson, assertName, assertInt, validateMessageBody } from './schemas.js';

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

// POST /v1/agents —— 注册身份（§6.1）
v1.post('/agents', async (c) => {
  const body = await parseJson(c);
  const name = assertName(body?.name, 'name');
  const result = store.createAgent(name);
  return c.json({ agent_id: result.agent_id, token: result.token }, 201);
});

// ---------- 以下路由需要认证 ----------

const authed = new Hono();
authed.use('*', requireAuth(store));

// POST /v1/channels —— 创建频道（§6.2）
authed.post('/channels', async (c) => {
  const body = await parseJson(c);
  const name = assertName(body?.name, 'name');
  const agent = c.get('agent');
  const ch = store.createChannel(name, agent);
  return c.json({ name: ch.name, created_at: ch.created_at, created_by: ch.created_by }, 201);
});

// GET /v1/channels —— 频道列表 + 自己视角的游标/积压（§6.7）
authed.get('/channels', (c) => {
  return c.json({ channels: store.listChannels(c.get('agent')) });
});

// 频道必须已显式创建，否则 404，不隐式创建（§6.3）
function requireChannel(c) {
  const ch = c.req.param('ch');
  if (!store.hasChannel(ch)) {
    throw new HttpError(404, 'channel_not_found', `channel "${ch}" does not exist`);
  }
  return ch;
}

// POST /v1/channels/:ch/messages —— 发布消息（§6.3）
authed.post('/channels/:ch/messages', async (c) => {
  const ch = requireChannel(c);
  const agent = c.get('agent');
  const body = validateMessageBody(await parseJson(c));
  if (body.reply_to !== undefined && !store.hasMessage(ch, body.reply_to)) {
    throw new HttpError(
      422, 'reply_target_missing',
      `reply_to seq ${body.reply_to} not found in channel "${ch}"`
    );
  }
  const msg = store.insertMessage({ channel: ch, sender: agent, ...body });
  return c.json({
    channel: ch,
    seq: msg.seq,
    sender: agent,
    content: body.content,
    content_type: body.content_type,
    reply_to: body.reply_to ?? null,
    created_at: msg.created_at,
  }, 201);
});

// GET /v1/channels/:ch/messages —— 拉取消息，支持长轮询（§6.4）
authed.get('/channels/:ch/messages', async (c) => {
  const ch = requireChannel(c);
  const agent = c.get('agent');
  const q = c.req.query();

  // since 显式传入 = 临时覆盖，仅本次生效、不动游标（§4.5）；
  // 不传 = 用服务端游标，首次拉取按 §5 初始化（最近 10 分钟）。
  let base;
  let initialized = false;
  if (q.since !== undefined) {
    base = assertInt(q.since, { min: 0, label: 'since' });
  } else {
    ({ cursor: base, initialized } = store.ensureCursor(ch, agent));
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
  const cursor = store.setCursor(ch, c.get('agent'), through);
  return c.json({ channel: ch, cursor });
});

// GET /v1/channels/:ch/cursor —— 查看游标（§6.6）
authed.get('/channels/:ch/cursor', (c) => {
  const ch = requireChannel(c);
  const agent = c.get('agent');
  const row = store.getCursorRow(ch, agent);
  return c.json({
    channel: ch,
    agent,
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
