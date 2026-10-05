// Anotify 服务端：路由与入口（设计见 DESIGN.md §6）
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { createStore } from './db.js';
import { requireAuth } from './auth.js';
import { Readable } from 'node:stream';
import { createBlobStore, newFileId, guessMime } from './files.js';
import {
  HttpError, parseJson, parseOptionalJson, assertName, assertInt, validateMessageBody,
  assertFileName, assertCaption, FILE_CONTENT_TYPE,
} from './schemas.js';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://anotify:anotify@localhost:5432/anotify';
const port = Number(process.env.PORT ?? 8000);
const host = process.env.HOST ?? '0.0.0.0';

// 文件交换（DESIGN §12）：配置了 ANOTIFY_S3_ENDPOINT 时 blob 存 MinIO，否则存本地目录；
// 本地目录同时承载上传中的临时文件
const filesDir = process.env.ANOTIFY_FILES_DIR ?? './data/files';
const s3 = {
  endpoint: process.env.ANOTIFY_S3_ENDPOINT,
  accessKey: process.env.ANOTIFY_S3_ACCESS_KEY,
  secretKey: process.env.ANOTIFY_S3_SECRET_KEY,
  bucket: process.env.ANOTIFY_S3_BUCKET ?? 'anotify-files',
};
const maxFileBytes = Number(process.env.ANOTIFY_MAX_FILE_BYTES ?? 25 * 1024 * 1024);
const filesQuotaBytes = Number(process.env.ANOTIFY_FILES_QUOTA_BYTES ?? 2 * 1024 * 1024 * 1024);

const store = await createStore(databaseUrl);
const blobs = await createBlobStore({ dir: filesDir, s3 });
const swept = await blobs.sweep((id) => store.hasFileId(id));
if (swept) console.log(`files: swept ${swept} orphan blob(s)`);
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
  const result = await store.createAgent(displayName);
  return c.json({
    agent_id: result.agent_id,
    display_name: result.display_name,
    token: result.token,
  }, 201);
});

// GET /v1/info —— 服务端实例信息（§13）：instance_id 稳定不变，客户端据此合并指向同一服务端的不同 URL
v1.get('/info', (c) => c.json({
  instance_id: store.instanceId,
  max_file_bytes: maxFileBytes,
}));

// ---------- 以下路由需要认证 ----------

const authed = new Hono();
authed.use('*', requireAuth(store));

// GET /v1/agents/me —— 当前认证身份（§6.1.1）
authed.get('/agents/me', async (c) => {
  return c.json({ agent_id: c.get('agentId'), display_name: c.get('agentName') });
});

// PATCH /v1/agents/me —— 改名（§6.1.1）：只改显示视图，历史引用不受影响
authed.patch('/agents/me', async (c) => {
  const body = await parseJson(c);
  const displayName = assertName(body?.display_name, 'display_name');
  const result = await store.renameAgent(c.get('agentId'), displayName);
  return c.json(result);
});

// POST /v1/channels —— 创建频道（§6.2），可选密码上锁；创建者自动入册
authed.post('/channels', async (c) => {
  const body = await parseJson(c);
  const name = assertName(body?.name, 'name');
  const password = typeof body?.password === 'string' && body.password.length > 0 ? body.password : undefined;
  const agentId = c.get('agentId');
  const ch = await store.createChannel(name, agentId, password);
  await store.ensureMember(name, agentId);
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
  const ch = await requireChannel(c);
  const body = await parseJson(c);
  if (typeof body?.password !== 'string') {
    throw new HttpError(422, 'invalid_param', 'password must be a string (empty string clears the password)');
  }
  const result = await store.setChannelPassword(ch, c.get('agentId'), body.password || null);
  return c.json(result);
});

// POST /v1/channels/:ch/join —— 入册（上锁频道需密码）
authed.post('/channels/:ch/join', async (c) => {
  const ch = await requireChannel(c);
  const body = await parseOptionalJson(c);
  await store.assertJoinAllowed(ch, body?.password);
  const agentId = c.get('agentId');
  const joined = await store.ensureMember(ch, agentId);
  return c.json({ channel: ch, agent_id: agentId, joined });
});

// GET /v1/channels/:ch/members —— 频道名册（上锁频道仅成员可见）
authed.get('/channels/:ch/members', async (c) => {
  const ch = await requireChannel(c);
  await requireAccess(c, ch);
  return c.json({ channel: ch, members: await store.listMembers(ch) });
});

// GET /v1/channels —— 频道列表 + 自己视角的游标/积压（§6.7）
authed.get('/channels', async (c) => {
  return c.json({ channels: await store.listChannels(c.get('agentId')) });
});

// 频道必须已显式创建，否则 404，不隐式创建（§6.3）
async function requireChannel(c) {
  const ch = c.req.param('ch');
  if (!await store.hasChannel(ch)) {
    throw new HttpError(404, 'channel_not_found', `channel "${ch}" does not exist`);
  }
  return ch;
}

// 上锁频道的访问门：非成员一律 403（公开频道不设防，行为不变）
async function requireAccess(c, ch) {
  const row = await store.getChannelRow(ch);
  if (row?.password_hash && !await store.isMember(ch, c.get('agentId'))) {
    throw new HttpError(
      403, 'join_required',
      `channel "${ch}" is locked: run anotify join ${ch} --password <pw> first`
    );
  }
}

// POST /v1/channels/:ch/messages —— 发布消息（§6.3）：公开频道自动入册，上锁频道须先 join
authed.post('/channels/:ch/messages', async (c) => {
  const ch = await requireChannel(c);
  await requireAccess(c, ch);
  const agentId = c.get('agentId');
  const body = validateMessageBody(await parseJson(c));
  if (body.reply_to !== undefined && !await store.hasMessage(ch, body.reply_to)) {
    throw new HttpError(
      422, 'reply_target_missing',
      `reply_to seq ${body.reply_to} not found in channel "${ch}"`
    );
  }
  await store.ensureMember(ch, agentId); // 名册重名校验在此发生（§3）
  const msg = await store.insertMessage({ channel: ch, sender: agentId, ...body });
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
  const ch = await requireChannel(c);
  await requireAccess(c, ch);
  const agentId = c.get('agentId');
  const q = c.req.query();

  // since 显式传入 = 临时覆盖，仅本次生效、不动游标（§4.5）；
  // 不传 = 用服务端游标，首次拉取按 §5 初始化（最近 10 分钟）。
  let base;
  let initialized = false;
  if (q.since !== undefined) {
    base = assertInt(q.since, { min: 0, label: 'since' });
  } else {
    ({ cursor: base, initialized } = await store.ensureCursor(ch, agentId));
  }

  const wait = assertInt(q.wait ?? 0, { min: 0, max: 60, label: 'wait' });
  const limit = assertInt(q.limit ?? 100, { min: 1, max: 1000, label: 'limit' });

  let messages = await store.messagesSince(ch, base, limit);
  const deadline = Date.now() + wait * 1000;
  while (messages.length === 0 && Date.now() < deadline) {
    await store.waitForMessage(ch, deadline - Date.now());
    messages = await store.messagesSince(ch, base, limit);
  }

  return c.json({
    channel: ch,
    messages,
    cursor: base,
    cursor_initialized: initialized,
    latest_seq: await store.latestSeq(ch),
  });
});

// POST /v1/channels/:ch/files —— 上传文件（§12）：body 为原始字节流，落盘后作为一条文件消息进入频道日志
authed.post('/channels/:ch/files', async (c) => {
  const ch = await requireChannel(c);
  await requireAccess(c, ch);
  const agentId = c.get('agentId');
  const q = c.req.query();
  const name = assertFileName(q.name);
  const caption = assertCaption(q.caption);
  let reply_to;
  if (q.reply_to !== undefined && q.reply_to !== '') {
    reply_to = assertInt(q.reply_to, { min: 1, label: 'reply_to' });
    if (!await store.hasMessage(ch, reply_to)) {
      throw new HttpError(422, 'reply_target_missing', `reply_to seq ${reply_to} not found in channel "${ch}"`);
    }
  }

  // 声明了 Content-Length 的先行拦截，免得白传一遍
  const declared = Number(c.req.header('content-length') ?? NaN);
  if (declared > maxFileBytes) {
    throw new HttpError(413, 'file_too_large', `file exceeds ${maxFileBytes} bytes`);
  }
  const assertQuota = async (size) => {
    if (await store.filesTotalBytes() + size > filesQuotaBytes) {
      throw new HttpError(507, 'storage_quota_exceeded', 'server file storage quota exceeded');
    }
  };
  if (declared > 0) await assertQuota(declared);

  await store.ensureMember(ch, agentId); // 重名校验先于落盘（§3）
  const blob = await blobs.receive(c.req.raw.body, maxFileBytes);
  try {
    if (blob.size === 0) throw new HttpError(422, 'empty_file', 'file is empty');
    await assertQuota(blob.size);
  } catch (e) {
    blobs.discard(blob.tmpPath);
    throw e;
  }
  const fileId = newFileId();
  const mime = guessMime(name, c.req.header('content-type'));
  await blobs.commit(blob.tmpPath, fileId, { size: blob.size, mime });

  let msg;
  try {
    msg = await store.insertFile({
      fileId, channel: ch, sender: agentId, name, size: blob.size, sha256: blob.sha256,
      mime, caption, reply_to,
    });
  } catch (e) {
    await blobs.remove(fileId).catch(() => {}); // 事务失败即删，崩溃残留由启动 sweep 兜底
    throw e;
  }
  return c.json({
    channel: ch,
    seq: msg.seq,
    sender: agentId,
    sender_name: c.get('agentName'),
    content: msg.content,
    content_type: FILE_CONTENT_TYPE,
    reply_to: reply_to ?? null,
    created_at: msg.created_at,
    file: JSON.parse(msg.content),
  }, 201);
});

// GET /v1/channels/:ch/files/:id —— 下载文件（§12）：与读消息同一道访问门
authed.get('/channels/:ch/files/:id', async (c) => {
  const ch = await requireChannel(c);
  await requireAccess(c, ch);
  const id = c.req.param('id');
  const row = await store.getFile(ch, id);
  if (!row) throw new HttpError(404, 'file_not_found', `file "${id}" not found in channel "${ch}"`);
  const stream = await blobs.open(id);
  if (!stream) throw new HttpError(410, 'file_gone', `file "${id}" is missing from server storage`);
  const encoded = encodeURIComponent(row.name);
  return new Response(Readable.toWeb(stream), {
    headers: {
      'content-type': row.mime,
      'content-length': String(row.size),
      'content-disposition': `attachment; filename*=UTF-8''${encoded}`,
      'x-anotify-file-name': encoded,
      'x-anotify-sha256': row.sha256,
    },
  });
});

// POST /v1/channels/:ch/ack —— 推进游标水位线（§6.5）
authed.post('/channels/:ch/ack', async (c) => {
  const ch = await requireChannel(c);
  const body = await parseJson(c);
  const through = assertInt(body?.through, { min: 0, label: 'through' });
  const cursor = await store.setCursor(ch, c.get('agentId'), through);
  return c.json({ channel: ch, cursor });
});

// GET /v1/channels/:ch/cursor —— 查看游标（§6.6）
authed.get('/channels/:ch/cursor', async (c) => {
  const ch = await requireChannel(c);
  await requireAccess(c, ch);
  const agentId = c.get('agentId');
  const row = await store.getCursorRow(ch, agentId);
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
  console.log(`  db: ${databaseUrl.replace(/\/\/[^@/]*@/, '//***@')}`);
  console.log(`  files: ${blobs.kind} (max ${maxFileBytes} B/file, quota ${filesQuotaBytes} B)`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => store.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
