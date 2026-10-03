// SQLite 访问层：建表、seq 分配、游标语义（设计见 DESIGN.md §4/§5/§8）
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { HttpError, sha256 } from './schemas.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  name       TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  name       TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  channel      TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  sender       TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text/plain',
  content      TEXT NOT NULL,
  reply_to     INTEGER,
  created_at   REAL NOT NULL,
  PRIMARY KEY (channel, seq)
);

CREATE TABLE IF NOT EXISTS cursors (
  channel    TEXT NOT NULL,
  agent      TEXT NOT NULL,
  cursor     INTEGER NOT NULL,
  updated_at REAL NOT NULL,
  PRIMARY KEY (channel, agent)
);
`;

/** 游标初始化窗口：新订阅者可见最近 10 分钟内的消息（DESIGN §5） */
const CURSOR_INIT_WINDOW_SECONDS = 600;

export function createStore(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);

  const now = () => Date.now() / 1000;

  // ---- agents ----

  const hasAgent = db.prepare('SELECT 1 FROM agents WHERE name = ?');

  function createAgent(name) {
    if (hasAgent.get(name)) {
      throw new HttpError(409, 'name_taken', `agent "${name}" already exists`);
    }
    const token = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO agents (name, token_hash, created_at) VALUES (?, ?, ?)')
      .run(name, sha256(token), now());
    return { agent_id: name, token };
  }

  function verifyAgent(token) {
    const row = db.prepare('SELECT name FROM agents WHERE token_hash = ?').get(sha256(token));
    return row?.name ?? null;
  }

  // ---- channels ----

  function hasChannel(name) {
    return !!db.prepare('SELECT 1 FROM channels WHERE name = ?').get(name);
  }

  function createChannel(name, createdBy) {
    if (hasChannel(name)) {
      throw new HttpError(409, 'channel_exists', `channel "${name}" already exists`);
    }
    const ts = now();
    db.prepare('INSERT INTO channels (name, created_by, created_at) VALUES (?, ?, ?)')
      .run(name, createdBy, ts);
    return { name, created_by: createdBy, created_at: ts };
  }

  function listChannels(agent) {
    const rows = db.prepare(`
      SELECT c.name, c.created_at, c.created_by,
             (SELECT MAX(seq) FROM messages m WHERE m.channel = c.name) AS latest_seq,
             cu.cursor AS my_cursor
      FROM channels c
      LEFT JOIN cursors cu ON cu.channel = c.name AND cu.agent = ?
      ORDER BY c.created_at
    `).all(agent);
    return rows.map((r) => {
      const latest = r.latest_seq ?? 0;
      return {
        name: r.name,
        created_at: r.created_at,
        created_by: r.created_by,
        latest_seq: latest,
        my_cursor: r.my_cursor ?? null,
        pending: r.my_cursor == null ? null : Math.max(0, latest - r.my_cursor),
      };
    });
  }

  // ---- messages ----

  function latestSeq(channel) {
    return db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE channel = ?')
      .get(channel).s;
  }

  function hasMessage(channel, seq) {
    return !!db.prepare('SELECT 1 FROM messages WHERE channel = ? AND seq = ?').get(channel, seq);
  }

  /** seq 分配在事务内完成，保证频道内严格单调无空洞（DESIGN §8） */
  const insertTx = db.transaction(({ channel, sender, content, content_type, reply_to }) => {
    const seq = latestSeq(channel) + 1;
    const created_at = now();
    db.prepare(`
      INSERT INTO messages (channel, seq, sender, content_type, content, reply_to, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(channel, seq, sender, content_type, content, reply_to ?? null, created_at);
    return { seq, created_at };
  });

  function insertMessage(msg) {
    return insertTx(msg);
  }

  function messagesSince(channel, since, limit) {
    return db.prepare(`
      SELECT seq, sender, content_type, content, reply_to, created_at
      FROM messages
      WHERE channel = ? AND seq > ?
      ORDER BY seq
      LIMIT ?
    `).all(channel, since, limit);
  }

  // ---- cursors（DESIGN §4.2/§4.5/§5：fetch 不动游标，仅 ACK 推进）----

  function getCursorRow(channel, agent) {
    return db.prepare('SELECT cursor, updated_at FROM cursors WHERE channel = ? AND agent = ?')
      .get(channel, agent);
  }

  /**
   * 首次拉取时初始化游标（§5）：
   * cursor = 最近一条「早于 10 分钟前」的消息 seq（没有则为 0），
   * 效果即新订阅者恰好可见最近 10 分钟内的消息。
   * 已存在则原样返回，initialized=false。
   */
  function ensureCursor(channel, agent) {
    const existing = getCursorRow(channel, agent);
    if (existing) return { cursor: existing.cursor, initialized: false };
    const cutoff = now() - CURSOR_INIT_WINDOW_SECONDS;
    const base = db.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE channel = ? AND created_at < ?'
    ).get(channel, cutoff).s;
    // 并发首拉时可能撞主键，OR IGNORE 后重读即可
    db.prepare('INSERT OR IGNORE INTO cursors (channel, agent, cursor, updated_at) VALUES (?, ?, ?, ?)')
      .run(channel, agent, base, now());
    return { cursor: getCursorRow(channel, agent).cursor, initialized: true };
  }

  /**
   * ACK 推进水位线（§4.2 原则三）：
   * - 只进不退（MAX）
   * - 钳制到 latest_seq，防止误 ACK 越过尚未存在的 seq 导致静默跳过未来消息
   */
  function setCursor(channel, agent, through) {
    const target = Math.min(through, latestSeq(channel));
    db.prepare(`
      INSERT INTO cursors (channel, agent, cursor, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(channel, agent) DO UPDATE
      SET cursor = MAX(cursor, excluded.cursor), updated_at = excluded.updated_at
    `).run(channel, agent, target, now());
    return getCursorRow(channel, agent).cursor;
  }

  return {
    close: () => db.close(),
    createAgent,
    verifyAgent,
    hasChannel,
    createChannel,
    listChannels,
    latestSeq,
    hasMessage,
    insertMessage,
    messagesSince,
    getCursorRow,
    ensureCursor,
    setCursor,
  };
}
