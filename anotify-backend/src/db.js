// SQLite 访问层：建表、v1→v2 迁移、seq 分配、游标语义、频道名册
// 设计见 DESIGN.md §3（身份模型）/§4（可靠投递）/§5（游标初始化）/§8（存储）
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { HttpError, sha256 } from './schemas.js';
import { timingSafeEqual } from 'node:crypto';

/** 游标初始化窗口：新订阅者可见最近 10 分钟内的消息（DESIGN §5） */
const CURSOR_INIT_WINDOW_SECONDS = 600;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  created_at   REAL NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_token_hash ON agents(token_hash);

CREATE TABLE IF NOT EXISTS channels (
  name          TEXT PRIMARY KEY,
  created_by    TEXT NOT NULL,
  password_hash TEXT,
  created_at    REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_members (
  channel   TEXT NOT NULL,
  agent     TEXT NOT NULL,
  joined_at REAL NOT NULL,
  PRIMARY KEY (channel, agent)
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

const newAgentId = () => 'ag_' + randomBytes(12).toString('base64url');

/**
 * v1 → v2 身份模型迁移（DESIGN §3）：
 * agents(name 主键) → agents(id 主键 + display_name)，
 * messages.sender / cursors.agent / channels.created_by 中的旧名字全部映射为新生成的 id。
 * token_hash 原样保留——存量 agent 的凭证继续有效。
 */
function migrateIdentityModel(db) {
  const hasAgents = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='agents'"
  ).get();
  if (!hasAgents) return false;
  const cols = db.pragma('table_info(agents)');
  if (cols.some((c) => c.name === 'id')) return false; // 已是 v2

  const migrate = db.transaction(() => {
    db.exec('ALTER TABLE agents RENAME TO agents_old');
    db.exec(`
      CREATE TABLE agents (
        id           TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        token_hash   TEXT NOT NULL,
        created_at   REAL NOT NULL
      );
      CREATE UNIQUE INDEX idx_agents_token_hash ON agents(token_hash);
    `);
    const rows = db.prepare('SELECT name, token_hash, created_at FROM agents_old').all();
    const ins = db.prepare(
      'INSERT INTO agents (id, display_name, token_hash, created_at) VALUES (?, ?, ?, ?)'
    );
    const map = {};
    for (const r of rows) {
      const id = newAgentId();
      map[r.name] = id;
      ins.run(id, r.name, r.token_hash, r.created_at);
    }
    const updMsg = db.prepare('UPDATE messages SET sender = ? WHERE sender = ?');
    const updCur = db.prepare('UPDATE cursors SET agent = ? WHERE agent = ?');
    const updCh = db.prepare('UPDATE channels SET created_by = ? WHERE created_by = ?');
    for (const [name, id] of Object.entries(map)) {
      updMsg.run(id, name);
      updCur.run(id, name);
      updCh.run(id, name);
    }
    db.exec('DROP TABLE agents_old');
  });
  migrate();
  return true;
}

/** 迁移后回填频道名册：发过消息或有游标的 agent 都是频道成员 */
function backfillRoster(db) {
  db.exec(`
    INSERT OR IGNORE INTO channel_members (channel, agent, joined_at)
    SELECT DISTINCT m.channel, m.sender, m.created_at FROM messages m;

    INSERT OR IGNORE INTO channel_members (channel, agent, joined_at)
    SELECT c.channel, c.agent, c.updated_at FROM cursors c;
  `);
}

/** 存量库补列：channels.password_hash（ALTER ADD COLUMN 幂等） */
function migrateChannelPassword(db) {
  const hasChannels = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='channels'"
  ).get();
  if (!hasChannels) return;
  const cols = db.pragma('table_info(channels)');
  if (!cols.some((c) => c.name === 'password_hash')) {
    db.exec('ALTER TABLE channels ADD COLUMN password_hash TEXT');
  }
}

export function createStore(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  const migrated = migrateIdentityModel(db);
  migrateChannelPassword(db);
  db.exec(SCHEMA);
  if (migrated) backfillRoster(db);

  const now = () => Date.now() / 1000;

  // ---- agents ----

  function createAgent(displayName) {
    // 注册不查重：display_name 的唯一性在频道名册范围内校验（DESIGN §3）
    const token = randomBytes(32).toString('base64url');
    let id;
    for (let attempt = 0; attempt < 3; attempt++) {
      id = newAgentId();
      try {
        db.prepare('INSERT INTO agents (id, display_name, token_hash, created_at) VALUES (?, ?, ?, ?)')
          .run(id, displayName, sha256(token), now());
        return { agent_id: id, display_name: displayName, token };
      } catch (e) {
        if (!String(e.message).includes('UNIQUE')) throw e;
        // id 极小概率撞主键，换一个重试；token 哈希撞索引同理
      }
    }
    throw new HttpError(500, 'internal', 'failed to allocate agent id');
  }

  function verifyAgent(token) {
    return db.prepare('SELECT id, display_name FROM agents WHERE token_hash = ?')
      .get(sha256(token)) ?? null;
  }

  function getAgentRow(agentId) {
    return db.prepare('SELECT id, display_name FROM agents WHERE id = ?').get(agentId);
  }

  /**
   * 改名（PATCH /v1/agents/me）：只改显示视图。
   * 冲突校验范围 = 自己已加入的频道名册（DESIGN §3）。
   */
  function renameAgent(agentId, newDisplayName) {
    const conflicts = db.prepare(`
      SELECT DISTINCT cm.channel
      FROM channel_members cm
      JOIN agents a ON a.id = cm.agent
      WHERE cm.agent != ?
        AND a.display_name = ?
        AND cm.channel IN (SELECT channel FROM channel_members WHERE agent = ?)
    `).all(agentId, newDisplayName, agentId);
    if (conflicts.length) {
      throw new HttpError(
        409, 'name_conflict',
        `display_name "${newDisplayName}" is already taken by a member of channel(s) [${conflicts.map((c) => c.channel).join(', ')}]; pick another name or leave the channel(s) first`
      );
    }
    db.prepare('UPDATE agents SET display_name = ? WHERE id = ?').run(newDisplayName, agentId);
    return { agent_id: agentId, display_name: newDisplayName };
  }

  // ---- 频道名册 ----

  /** 同频道成员间 display_name 不得重复；通过则入册（幂等），返回是否新加入 */
  function ensureMember(channel, agentId) {
    const myName = getAgentRow(agentId)?.display_name;
    const dup = db.prepare(`
      SELECT a.display_name
      FROM channel_members cm
      JOIN agents a ON a.id = cm.agent
      WHERE cm.channel = ? AND cm.agent != ? AND a.display_name = ?
    `).get(channel, agentId, myName);
    if (dup) {
      throw new HttpError(
        409, 'name_conflict',
        `display_name "${myName}" is already taken by a member of channel "${channel}"; rename first with anotify rename`
      );
    }
    const r = db.prepare(
      'INSERT OR IGNORE INTO channel_members (channel, agent, joined_at) VALUES (?, ?, ?)'
    ).run(channel, agentId, now());
    return r.changes > 0;
  }

  function listMembers(channel) {
    return db.prepare(`
      SELECT cm.agent AS agent_id, a.display_name, cm.joined_at
      FROM channel_members cm
      JOIN agents a ON a.id = cm.agent
      WHERE cm.channel = ?
      ORDER BY cm.joined_at
    `).all(channel);
  }

  // ---- channels ----

  function hasChannel(name) {
    return !!db.prepare('SELECT 1 FROM channels WHERE name = ?').get(name);
  }

  function getChannelRow(name) {
    return db.prepare('SELECT name, created_by, password_hash, created_at FROM channels WHERE name = ?')
      .get(name);
  }

  function createChannel(name, createdBy, password) {
    if (hasChannel(name)) {
      throw new HttpError(409, 'channel_exists', `channel "${name}" already exists`);
    }
    const ts = now();
    const password_hash = password ? sha256(password) : null;
    db.prepare('INSERT INTO channels (name, created_by, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(name, createdBy, password_hash, ts);
    return { name, created_by: createdBy, locked: !!password_hash, created_at: ts };
  }

  /** 仅 owner（创建者）可改/清除密码；清除即回到公开频道 */
  function setChannelPassword(name, agentId, password) {
    const row = getChannelRow(name);
    if (!row) throw new HttpError(404, 'channel_not_found', `channel "${name}" does not exist`);
    if (row.created_by !== agentId) {
      throw new HttpError(403, 'not_owner', `only the channel owner can change its password`);
    }
    const hash = password ? sha256(password) : null;
    db.prepare('UPDATE channels SET password_hash = ? WHERE name = ?').run(hash, name);
    return { channel: name, locked: !!hash };
  }

  /** join / 发言的门禁：上锁频道必须验密后由路由显式入册（公开频道自动入册） */
  function assertJoinAllowed(channel, password) {
    const row = getChannelRow(channel);
    if (!row?.password_hash) return; // 公开频道不设防
    if (password === undefined || password === null || password === '') {
      throw new HttpError(403, 'password_required', `channel "${channel}" is locked; a password is required to join`);
    }
    const provided = sha256(password);
    const expected = Buffer.from(row.password_hash, 'hex');
    const given = Buffer.from(provided, 'hex');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new HttpError(403, 'wrong_password', `wrong password for channel "${channel}"`);
    }
  }

  function isMember(channel, agentId) {
    return !!db.prepare('SELECT 1 FROM channel_members WHERE channel = ? AND agent = ?')
      .get(channel, agentId);
  }

  function listChannels(agentId) {
    const rows = db.prepare(`
      SELECT c.name, c.created_at, c.created_by, c.password_hash, ca.display_name AS created_by_name,
             (SELECT MAX(seq) FROM messages m WHERE m.channel = c.name) AS latest_seq,
             cu.cursor AS my_cursor
      FROM channels c
      LEFT JOIN agents ca ON ca.id = c.created_by
      LEFT JOIN cursors cu ON cu.channel = c.name AND cu.agent = ?
      ORDER BY c.created_at
    `).all(agentId);
    return rows.map((r) => {
      const latest = r.latest_seq ?? 0;
      return {
        name: r.name,
        created_at: r.created_at,
        created_by: r.created_by,
        created_by_name: r.created_by_name ?? r.created_by,
        locked: !!r.password_hash,
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
      SELECT m.seq, m.sender, a.display_name AS sender_name,
             m.content_type, m.content, m.reply_to, m.created_at
      FROM messages m
      LEFT JOIN agents a ON a.id = m.sender
      WHERE m.channel = ? AND m.seq > ?
      ORDER BY m.seq
      LIMIT ?
    `).all(channel, since, limit);
  }

  // ---- cursors（DESIGN §4.2/§4.5/§5：fetch 不动游标，仅 ACK 推进）----

  function getCursorRow(channel, agentId) {
    return db.prepare('SELECT cursor, updated_at FROM cursors WHERE channel = ? AND agent = ?')
      .get(channel, agentId);
  }

  /**
   * 首次拉取时初始化游标（§5）：
   * cursor = 最近一条「早于 10 分钟前」的消息 seq（没有则为 0），
   * 效果即新订阅者恰好可见最近 10 分钟内的消息。
   */
  function ensureCursor(channel, agentId) {
    const existing = getCursorRow(channel, agentId);
    if (existing) return { cursor: existing.cursor, initialized: false };
    const cutoff = now() - CURSOR_INIT_WINDOW_SECONDS;
    const base = db.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE channel = ? AND created_at < ?'
    ).get(channel, cutoff).s;
    // 并发首拉时可能撞主键，OR IGNORE 后重读即可
    db.prepare('INSERT OR IGNORE INTO cursors (channel, agent, cursor, updated_at) VALUES (?, ?, ?, ?)')
      .run(channel, agentId, base, now());
    return { cursor: getCursorRow(channel, agentId).cursor, initialized: true };
  }

  /**
   * ACK 推进水位线（§4.2 原则三）：
   * 只进不退（MAX），且钳制到 latest_seq，防止静默跳过未来消息。
   */
  function setCursor(channel, agentId, through) {
    const target = Math.min(through, latestSeq(channel));
    db.prepare(`
      INSERT INTO cursors (channel, agent, cursor, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(channel, agent) DO UPDATE
      SET cursor = MAX(cursor, excluded.cursor), updated_at = excluded.updated_at
    `).run(channel, agentId, target, now());
    return getCursorRow(channel, agentId).cursor;
  }

  return {
    close: () => db.close(),
    createAgent,
    verifyAgent,
    getAgentRow,
    renameAgent,
    ensureMember,
    listMembers,
    hasChannel,
    getChannelRow,
    createChannel,
    setChannelPassword,
    assertJoinAllowed,
    isMember,
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
