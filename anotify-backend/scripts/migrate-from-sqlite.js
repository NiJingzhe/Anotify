#!/usr/bin/env node
// 一次性迁移：SQLite（≤0.5 服务端）→ Postgres + 对象存储（DESIGN.md §8.1）
//
// 用法（容器内，与服务端同一套环境变量；须在新服务端启动之前执行——服务端启动时缓存 instance_id）：
//   docker compose run --rm anotify node anotify-backend/scripts/migrate-from-sqlite.js --sqlite /data/anotify.db --files /data/files [--dry-run]
//
// 保证：
//   - 目标库必须为空（没有 agent / 频道），否则拒绝执行，避免重复导入
//   - Postgres 写入在单个事务里完成：要么全部导入，要么什么都不变
//   - instance_id 原样保留，客户端（TUI）眼里仍是同一个服务端
//   - agent token 哈希原样保留，所有已注册 agent 无需重新注册
//   - 先上传 blob 再提交事务；重跑时已上传的 blob 会被覆盖，无副作用
import Database from 'better-sqlite3';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createStore } from '../src/db.js';
import { createBlobStore } from '../src/files.js';

const { values: args } = parseArgs({
  options: {
    sqlite: { type: 'string', default: '/data/anotify.db' },
    files: { type: 'string', default: '/data/files' },
    'dry-run': { type: 'boolean', default: false },
  },
});

const log = (...a) => console.log('[migrate]', ...a);

if (!existsSync(args.sqlite)) {
  console.error(`[migrate] SQLite database not found: ${args.sqlite}`);
  process.exit(1);
}

const src = new Database(args.sqlite, { readonly: true, fileMustExist: true });
const hasTable = (t) => !!src.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const all = (t, sql = `SELECT * FROM ${t}`) => (hasTable(t) ? src.prepare(sql).all() : []);

const agentCols = hasTable('agents') ? src.pragma('table_info(agents)').map((c) => c.name) : [];
if (agentCols.length && !agentCols.includes('id')) {
  console.error('[migrate] source database still uses the v1 identity model; start the 0.5.x server on it once to upgrade, then rerun');
  process.exit(1);
}

const data = {
  meta: all('meta'),
  agents: all('agents'),
  channels: all('channels'),
  members: all('channel_members'),
  messages: all('messages', 'SELECT * FROM messages ORDER BY channel, seq'),
  files: all('files'),
  cursors: all('cursors'),
};
src.close();
log('source:', Object.entries(data).map(([k, v]) => `${k}=${v.length}`).join(' '));

// 频道 last_seq = 该频道最大 seq（Postgres 侧用它分配后续 seq）
const lastSeq = {};
for (const m of data.messages) lastSeq[m.channel] = Math.max(lastSeq[m.channel] ?? 0, m.seq);

// 文件 blob 预检
const missingBlobs = data.files.filter((f) => !existsSync(join(args.files, f.id)));
if (missingBlobs.length) log(`warning: ${missingBlobs.length} blob(s) missing on disk, rows kept (download will answer 410):`, missingBlobs.map((f) => f.id).join(' '));

if (args['dry-run']) {
  log('dry run: nothing written');
  process.exit(0);
}

const store = await createStore(process.env.DATABASE_URL);
const existing = (await store.pool.query('SELECT (SELECT COUNT(*) FROM agents) + (SELECT COUNT(*) FROM channels) AS n')).rows[0].n;
if (Number(existing) > 0) {
  console.error('[migrate] target Postgres database is not empty (agents/channels exist); refusing to import twice');
  await store.close();
  process.exit(1);
}

// 1) blob → 对象存储（与服务端同一配置）
const blobs = await createBlobStore({
  dir: process.env.ANOTIFY_FILES_DIR ?? '/data',
  s3: {
    endpoint: process.env.ANOTIFY_S3_ENDPOINT,
    accessKey: process.env.ANOTIFY_S3_ACCESS_KEY,
    secretKey: process.env.ANOTIFY_S3_SECRET_KEY,
    bucket: process.env.ANOTIFY_S3_BUCKET ?? 'anotify-files',
  },
});
let uploaded = 0;
for (const f of data.files) {
  const p = join(args.files, f.id);
  if (!existsSync(p)) continue;
  await blobs.put(p, f.id, { size: statSync(p).size, mime: f.mime });
  uploaded++;
}
log(`blobs uploaded to ${blobs.kind}: ${uploaded}`);

// 2) 行数据 → Postgres（单事务）
await store.tx(async (c) => {
  const ins = async (sql, rows, map) => {
    for (const r of rows) await c.query(sql, map(r));
  };
  // 保留原 instance_id（覆盖 createStore 首启时生成的那个）
  await ins(
    'INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    data.meta, (r) => [r.key, r.value]);
  await ins(
    'INSERT INTO agents (id, display_name, token_hash, created_at) VALUES ($1, $2, $3, $4)',
    data.agents, (r) => [r.id, r.display_name, r.token_hash, r.created_at]);
  await ins(
    'INSERT INTO channels (name, created_by, password_hash, last_seq, created_at) VALUES ($1, $2, $3, $4, $5)',
    data.channels, (r) => [r.name, r.created_by, r.password_hash ?? null, lastSeq[r.name] ?? 0, r.created_at]);
  await ins(
    'INSERT INTO channel_members (channel, agent, joined_at) VALUES ($1, $2, $3)',
    data.members, (r) => [r.channel, r.agent, r.joined_at]);
  await ins(
    `INSERT INTO messages (channel, seq, sender, content_type, content, reply_to, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    data.messages, (r) => [r.channel, r.seq, r.sender, r.content_type, r.content, r.reply_to ?? null, r.created_at]);
  await ins(
    `INSERT INTO files (id, channel, seq, uploader, name, size, sha256, mime, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    data.files, (r) => [r.id, r.channel, r.seq, r.uploader, r.name, r.size, r.sha256, r.mime, r.created_at]);
  await ins(
    'INSERT INTO cursors (channel, agent, cursor, updated_at) VALUES ($1, $2, $3, $4)',
    data.cursors, (r) => [r.channel, r.agent, r.cursor, r.updated_at]);
});

// 3) 校验行数
const counts = {};
for (const [k, t] of Object.entries({ agents: 'agents', channels: 'channels', members: 'channel_members', messages: 'messages', files: 'files', cursors: 'cursors' })) {
  counts[k] = Number((await store.pool.query(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0].n);
}
const mismatch = Object.entries(counts).filter(([k, n]) => n !== data[k].length);
log('target:', Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' '));
log('instance_id:', (await store.pool.query("SELECT value FROM meta WHERE key='instance_id'")).rows[0].value);
await store.close();
if (mismatch.length) {
  console.error('[migrate] row count mismatch:', mismatch);
  process.exit(1);
}
log('done ✓ (the SQLite file is left untouched; keep it as a backup)');
log('now start (or restart) the server: docker compose up -d anotify');
