// Postgres 访问层：版本化建表、seq 分配、游标语义、频道名册、文件元数据
// 设计见 DESIGN.md §3（身份模型）/§4（可靠投递）/§5（游标初始化）/§8（存储）
import pg from 'pg';
import { EventEmitter } from 'node:events';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError, sha256, FILE_CONTENT_TYPE } from './schemas.js';

/** 游标初始化窗口：新订阅者可见最近 10 分钟内的消息（DESIGN §5） */
const CURSOR_INIT_WINDOW_SECONDS = 600;

/**
 * 版本化迁移：按顺序执行，已执行的版本记录在 schema_migrations。
 * 只追加不修改——改表结构就加一个新版本。
 */
export const MIGRATIONS = [
  // v1：与 SQLite 时代的数据模型一一对应（便于 scripts/migrate-from-sqlite.js 原样搬迁）
  `
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE agents (
    id           TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    created_at   DOUBLE PRECISION NOT NULL
  );

  CREATE TABLE channels (
    name          TEXT PRIMARY KEY,
    created_by    TEXT NOT NULL,
    password_hash TEXT,
    last_seq      INTEGER NOT NULL DEFAULT 0,
    created_at    DOUBLE PRECISION NOT NULL
  );

  CREATE TABLE channel_members (
    channel   TEXT NOT NULL,
    agent     TEXT NOT NULL,
    joined_at DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (channel, agent)
  );
  CREATE INDEX idx_channel_members_agent ON channel_members(agent);

  CREATE TABLE messages (
    channel      TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    sender       TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'text/plain',
    content      TEXT NOT NULL,
    reply_to     INTEGER,
    created_at   DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (channel, seq)
  );

  CREATE TABLE files (
    id         TEXT PRIMARY KEY,
    channel    TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    uploader   TEXT NOT NULL,
    name       TEXT NOT NULL,
    size       BIGINT NOT NULL,
    sha256     TEXT NOT NULL,
    mime       TEXT NOT NULL,
    created_at DOUBLE PRECISION NOT NULL
  );
  CREATE INDEX idx_files_channel ON files(channel);

  CREATE TABLE cursors (
    channel    TEXT NOT NULL,
    agent      TEXT NOT NULL,
    cursor     INTEGER NOT NULL,
    updated_at DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (channel, agent)
  );
  `,
  // v2：人类用户、邮箱验证、会话、agent 认领（DESIGN §14）
  `
  CREATE TABLE users (
    id                BIGINT PRIMARY KEY,
    email             TEXT NOT NULL,
    email_norm        TEXT NOT NULL UNIQUE,
    password_hash     TEXT NOT NULL,
    email_verified_at DOUBLE PRECISION,
    invite_code       TEXT NOT NULL UNIQUE,
    invited_by        BIGINT REFERENCES users(id),
    created_at        DOUBLE PRECISION NOT NULL
  );
  CREATE INDEX idx_users_invited_by ON users(invited_by);

  CREATE TABLE email_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose    TEXT NOT NULL,
    expires_at DOUBLE PRECISION NOT NULL,
    created_at DOUBLE PRECISION NOT NULL
  );
  CREATE INDEX idx_email_tokens_user ON email_tokens(user_id);

  CREATE TABLE mail_log (
    id         BIGSERIAL PRIMARY KEY,
    recipient  TEXT NOT NULL,
    purpose    TEXT NOT NULL,
    ok         BOOLEAN NOT NULL,
    error      TEXT,
    created_at DOUBLE PRECISION NOT NULL
  );
  CREATE INDEX idx_mail_log_created ON mail_log(created_at);

  CREATE TABLE sessions (
    id             TEXT PRIMARY KEY,
    user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at     DOUBLE PRECISION NOT NULL,
    last_active_at DOUBLE PRECISION NOT NULL,
    expires_at     DOUBLE PRECISION NOT NULL,
    revoked_at     DOUBLE PRECISION,
    user_agent     TEXT,
    ip             TEXT
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);

  ALTER TABLE agents ADD COLUMN owner_id BIGINT REFERENCES users(id);
  CREATE INDEX idx_agents_owner ON agents(owner_id);

  CREATE TABLE agent_claims (
    id           TEXT PRIMARY KEY,
    kind         TEXT NOT NULL,
    display_name TEXT NOT NULL,
    agent_id     TEXT,
    code_hash    TEXT NOT NULL,
    poll_hash    TEXT NOT NULL,
    status       TEXT NOT NULL,
    user_id      BIGINT REFERENCES users(id),
    attempts     INTEGER NOT NULL DEFAULT 0,
    requester_ip TEXT,
    created_at   DOUBLE PRECISION NOT NULL,
    expires_at   DOUBLE PRECISION NOT NULL,
    decided_at   DOUBLE PRECISION
  );
  CREATE INDEX idx_agent_claims_ip ON agent_claims(requester_ip, status);
  `,
  // v3：文件接收即删除（DESIGN §12「生命周期」）
  `
  ALTER TABLE files ADD COLUMN deleted_at DOUBLE PRECISION;
  ALTER TABLE files ADD COLUMN deleted_reason TEXT;

  CREATE TABLE file_recipients (
    file_id     TEXT NOT NULL,
    agent       TEXT NOT NULL,
    received_at DOUBLE PRECISION,
    PRIMARY KEY (file_id, agent)
  );
  `,
];

async function migrate(pool) {
  const client = await pool.connect();
  try {
    // 多实例同时启动时用咨询锁串行化迁移
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())'
    );
    const { rows } = await client.query('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations');
    for (let v = rows[0].v + 1; v <= MIGRATIONS.length; v++) {
      await client.query('BEGIN');
      try {
        await client.query(MIGRATIONS[v - 1]);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [v]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
}

export async function createStore(databaseUrl) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  await migrate(pool);

  const now = () => Date.now() / 1000;
  const q = (text, params) => pool.query(text, params);
  const one = async (text, params, client = pool) => (await client.query(text, params)).rows[0];

  /** 事务：fn 收到专用 client，抛错即回滚 */
  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  // 新消息事件：长轮询在本进程内被即时唤醒（多实例部署时退化为定时重查）
  const events = new EventEmitter();
  events.setMaxListeners(0);

  // 实例 id：首次启动生成并持久化，让客户端识别「多个 URL 指向同一服务端」（DESIGN §13）
  await q('INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
    ['instance_id', 'srv_' + randomBytes(9).toString('base64url')]);
  const instanceId = (await one("SELECT value FROM meta WHERE key = 'instance_id'")).value;

  // ---- agents ----

  /** ownerId：认领流程创建时归属的用户（DESIGN §14.4）；client：在调用方事务内执行 */
  async function createAgent(displayName, { ownerId = null, client = pool } = {}) {
    // 注册不查重：display_name 的唯一性在频道名册范围内校验（DESIGN §3）
    const token = randomBytes(32).toString('base64url');
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = 'ag_' + randomBytes(12).toString('base64url');
      const r = await client.query(
        `INSERT INTO agents (id, display_name, token_hash, owner_id, created_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [id, displayName, sha256(token), ownerId, now()]
      );
      if (r.rowCount) return { agent_id: id, display_name: displayName, token };
      // id / token 哈希极小概率撞唯一约束，换一个重试
    }
    throw new HttpError(500, 'internal', 'failed to allocate agent id');
  }

  async function verifyAgent(token) {
    return (await one('SELECT id, display_name FROM agents WHERE token_hash = $1', [sha256(token)])) ?? null;
  }

  async function getAgentRow(agentId) {
    return one('SELECT id, display_name, owner_id FROM agents WHERE id = $1', [agentId]);
  }

  /**
   * 改名（PATCH /v1/agents/me）：只改显示视图。
   * 冲突校验范围 = 自己已加入的频道名册（DESIGN §3）。
   */
  async function renameAgent(agentId, newDisplayName) {
    const { rows: conflicts } = await q(`
      SELECT DISTINCT cm.channel
      FROM channel_members cm
      JOIN agents a ON a.id = cm.agent
      WHERE cm.agent != $1
        AND a.display_name = $2
        AND cm.channel IN (SELECT channel FROM channel_members WHERE agent = $1)
    `, [agentId, newDisplayName]);
    if (conflicts.length) {
      throw new HttpError(
        409, 'name_conflict',
        `display_name "${newDisplayName}" is already taken by a member of channel(s) [${conflicts.map((c) => c.channel).join(', ')}]; pick another name or leave the channel(s) first`
      );
    }
    await q('UPDATE agents SET display_name = $1 WHERE id = $2', [newDisplayName, agentId]);
    return { agent_id: agentId, display_name: newDisplayName };
  }

  // ---- 频道名册 ----

  /** 同频道成员间 display_name 不得重复；通过则入册（幂等），返回是否新加入 */
  async function ensureMember(channel, agentId) {
    const myName = (await getAgentRow(agentId))?.display_name;
    const dup = await one(`
      SELECT a.display_name
      FROM channel_members cm
      JOIN agents a ON a.id = cm.agent
      WHERE cm.channel = $1 AND cm.agent != $2 AND a.display_name = $3
    `, [channel, agentId, myName]);
    if (dup) {
      throw new HttpError(
        409, 'name_conflict',
        `display_name "${myName}" is already taken by a member of channel "${channel}"; rename first with anotify rename`
      );
    }
    const r = await q(
      'INSERT INTO channel_members (channel, agent, joined_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [channel, agentId, now()]
    );
    return r.rowCount > 0;
  }

  async function listMembers(channel) {
    const { rows } = await q(`
      SELECT cm.agent AS agent_id, a.display_name, cm.joined_at
      FROM channel_members cm
      JOIN agents a ON a.id = cm.agent
      WHERE cm.channel = $1
      ORDER BY cm.joined_at
    `, [channel]);
    return rows;
  }

  // ---- channels ----

  async function hasChannel(name) {
    return !!(await one('SELECT 1 FROM channels WHERE name = $1', [name]));
  }

  async function getChannelRow(name) {
    return one('SELECT name, created_by, password_hash, created_at FROM channels WHERE name = $1', [name]);
  }

  async function createChannel(name, createdBy, password) {
    const ts = now();
    const password_hash = password ? sha256(password) : null;
    const r = await q(
      `INSERT INTO channels (name, created_by, password_hash, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (name) DO NOTHING`,
      [name, createdBy, password_hash, ts]
    );
    if (!r.rowCount) {
      throw new HttpError(409, 'channel_exists', `channel "${name}" already exists`);
    }
    return { name, created_by: createdBy, locked: !!password_hash, created_at: ts };
  }

  /** 仅 owner（创建者）可改/清除密码；清除即回到公开频道 */
  async function setChannelPassword(name, agentId, password) {
    const row = await getChannelRow(name);
    if (!row) throw new HttpError(404, 'channel_not_found', `channel "${name}" does not exist`);
    if (row.created_by !== agentId) {
      throw new HttpError(403, 'not_owner', `only the channel owner can change its password`);
    }
    const hash = password ? sha256(password) : null;
    await q('UPDATE channels SET password_hash = $1 WHERE name = $2', [hash, name]);
    return { channel: name, locked: !!hash };
  }

  /** join / 发言的门禁：上锁频道必须验密后由路由显式入册（公开频道自动入册） */
  async function assertJoinAllowed(channel, password) {
    const row = await getChannelRow(channel);
    if (!row?.password_hash) return; // 公开频道不设防
    if (password === undefined || password === null || password === '') {
      throw new HttpError(403, 'password_required', `channel "${channel}" is locked; a password is required to join`);
    }
    const expected = Buffer.from(row.password_hash, 'hex');
    const given = Buffer.from(sha256(password), 'hex');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new HttpError(403, 'wrong_password', `wrong password for channel "${channel}"`);
    }
  }

  async function isMember(channel, agentId) {
    return !!(await one('SELECT 1 FROM channel_members WHERE channel = $1 AND agent = $2', [channel, agentId]));
  }

  async function listChannels(agentId) {
    const { rows } = await q(`
      SELECT c.name, c.created_at, c.created_by, c.password_hash, ca.display_name AS created_by_name,
             c.last_seq AS latest_seq,
             cu.cursor AS my_cursor,
             (cm.agent IS NOT NULL) AS joined
      FROM channels c
      LEFT JOIN agents ca ON ca.id = c.created_by
      LEFT JOIN cursors cu ON cu.channel = c.name AND cu.agent = $1
      LEFT JOIN channel_members cm ON cm.channel = c.name AND cm.agent = $1
      ORDER BY c.created_at
    `, [agentId]);
    return rows.map((r) => {
      const latest = r.latest_seq ?? 0;
      return {
        name: r.name,
        created_at: r.created_at,
        created_by: r.created_by,
        created_by_name: r.created_by_name ?? r.created_by,
        locked: !!r.password_hash,
        joined: r.joined,
        latest_seq: latest,
        my_cursor: r.my_cursor ?? null,
        pending: r.my_cursor == null ? null : Math.max(0, latest - r.my_cursor),
      };
    });
  }

  // ---- messages ----

  async function latestSeq(channel) {
    return (await one('SELECT last_seq FROM channels WHERE name = $1', [channel]))?.last_seq ?? 0;
  }

  async function hasMessage(channel, seq) {
    return !!(await one('SELECT 1 FROM messages WHERE channel = $1 AND seq = $2', [channel, seq]));
  }

  /**
   * seq 分配（DESIGN §8）：UPDATE ... RETURNING 对频道行加行锁直到提交，
   * 同频道并发写入被串行化，保证 seq 严格单调无空洞。
   */
  async function insertTx(client, { channel, sender, content, content_type, reply_to }) {
    const { rows } = await client.query(
      'UPDATE channels SET last_seq = last_seq + 1 WHERE name = $1 RETURNING last_seq', [channel]
    );
    if (!rows.length) throw new HttpError(404, 'channel_not_found', `channel "${channel}" does not exist`);
    const seq = rows[0].last_seq;
    const created_at = now();
    await client.query(`
      INSERT INTO messages (channel, seq, sender, content_type, content, reply_to, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [channel, seq, sender, content_type, content, reply_to ?? null, created_at]);
    return { seq, created_at };
  }

  async function insertMessage(msg) {
    const r = await tx((client) => insertTx(client, msg));
    events.emit('message', msg.channel);
    return r;
  }

  // ---- files（DESIGN §12：文件即消息，files 行与文件消息同一事务写入）----

  /** 写 files 行 + 对应的文件消息；content 为元数据 JSON（字段顺序固定，便于客户端展示） */
  async function insertFile({ fileId, channel, sender, name, size, sha256, mime, caption, reply_to }) {
    const content = JSON.stringify({ file_id: fileId, name, size, sha256, mime, caption: caption ?? null });
    const msg = await tx(async (client) => {
      const m = await insertTx(client, { channel, sender, content, content_type: FILE_CONTENT_TYPE, reply_to });
      await client.query(`
        INSERT INTO files (id, channel, seq, uploader, name, size, sha256, mime, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [fileId, channel, m.seq, sender, name, size, sha256, mime, m.created_at]);
      // 收件人 = 上传这一刻除上传者外的全部成员；全部确认收到即删除 blob
      await client.query(`
        INSERT INTO file_recipients (file_id, agent)
        SELECT $1, agent FROM channel_members WHERE channel = $2 AND agent != $3
      `, [fileId, channel, sender]);
      return m;
    });
    events.emit('message', channel);
    return { ...msg, content };
  }

  async function getFile(channel, fileId) {
    const row = await one(
      `SELECT id, channel, seq, uploader, name, size, sha256, mime, created_at, deleted_at, deleted_reason
       FROM files WHERE channel = $1 AND id = $2`,
      [channel, fileId]
    );
    return row ? { ...row, size: Number(row.size) } : undefined;
  }

  /** blob 仍应存在（有 files 行且未删除）——孤儿回收据此判断 */
  async function hasFileId(fileId) {
    return !!(await one('SELECT 1 FROM files WHERE id = $1 AND deleted_at IS NULL', [fileId]));
  }

  async function filesTotalBytes() {
    return Number((await one('SELECT COALESCE(SUM(size), 0) AS s FROM files WHERE deleted_at IS NULL')).s);
  }

  /** 先在库里标记删除（之后 blob 删除失败也会被孤儿回收兜底）；返回是否由本次调用标记 */
  async function markFileDeleted(fileId, reason, client = pool) {
    const r = await client.query(
      'UPDATE files SET deleted_at = $1, deleted_reason = $2 WHERE id = $3 AND deleted_at IS NULL',
      [now(), reason, fileId]
    );
    return r.rowCount > 0;
  }

  /**
   * 收件确认（DESIGN §12 生命周期）：记录 agent 已收到；全部收件人都确认后标记删除。
   * 上传时频道里没有其他成员的，第一个确认收到的非上传者即触发删除。
   * 返回 { deleted, remaining }，deleted=true 表示调用方应删除 blob。
   */
  async function confirmFileReceived(fileId, agentId) {
    return tx(async (c) => {
      const f = await one('SELECT uploader, deleted_at FROM files WHERE id = $1 FOR UPDATE', [fileId], c);
      if (!f || f.deleted_at) return { deleted: false, already_deleted: !!f?.deleted_at, remaining: 0 };
      if (f.uploader === agentId) {
        const n = await one('SELECT COUNT(*) AS n FROM file_recipients WHERE file_id = $1 AND received_at IS NULL', [fileId], c);
        return { deleted: false, remaining: Number(n.n) };
      }
      await c.query(`
        INSERT INTO file_recipients (file_id, agent, received_at) VALUES ($1, $2, $3)
        ON CONFLICT (file_id, agent) DO UPDATE SET received_at = COALESCE(file_recipients.received_at, excluded.received_at)
      `, [fileId, agentId, now()]);
      const remaining = Number((await one(
        'SELECT COUNT(*) AS n FROM file_recipients WHERE file_id = $1 AND received_at IS NULL', [fileId], c
      )).n);
      if (remaining > 0) return { deleted: false, remaining };
      await markFileDeleted(fileId, 'delivered', c);
      return { deleted: true, remaining: 0 };
    });
  }

  /** 超过保留期仍未删除的文件：标记 expired，返回 id 列表（调用方删 blob） */
  async function expireFiles(olderThan) {
    const { rows } = await pool.query(`
      UPDATE files SET deleted_at = $1, deleted_reason = 'expired'
      WHERE deleted_at IS NULL AND created_at < $2
      RETURNING id
    `, [now(), olderThan]);
    return rows.map((r) => r.id);
  }

  async function messagesSince(channel, since, limit) {
    const { rows } = await q(`
      SELECT m.seq, m.sender, a.display_name AS sender_name,
             m.content_type, m.content, m.reply_to, m.created_at
      FROM messages m
      LEFT JOIN agents a ON a.id = m.sender
      WHERE m.channel = $1 AND m.seq > $2
      ORDER BY m.seq
      LIMIT $3
    `, [channel, since, limit]);
    return rows;
  }

  /**
   * 等待频道出现新消息，最多 ms 毫秒：本进程写入即时唤醒，
   * 另以 2s 间隔兜底（多实例部署时别的进程写入的消息靠它发现）。
   */
  function waitForMessage(channel, ms) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        events.off('message', onMsg);
        resolve();
      };
      const onMsg = (ch) => { if (ch === channel) done(); };
      const timer = setTimeout(done, Math.min(ms, 2000));
      events.on('message', onMsg);
    });
  }

  // ---- cursors（DESIGN §4.2/§4.5/§5：fetch 不动游标，仅 ACK 推进）----

  async function getCursorRow(channel, agentId) {
    return one('SELECT cursor, updated_at FROM cursors WHERE channel = $1 AND agent = $2', [channel, agentId]);
  }

  /**
   * 首次拉取时初始化游标（§5）：
   * cursor = 最近一条「早于 10 分钟前」的消息 seq（没有则为 0），
   * 效果即新订阅者恰好可见最近 10 分钟内的消息。
   */
  async function ensureCursor(channel, agentId) {
    const existing = await getCursorRow(channel, agentId);
    if (existing) return { cursor: existing.cursor, initialized: false };
    const cutoff = now() - CURSOR_INIT_WINDOW_SECONDS;
    const base = (await one(
      'SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE channel = $1 AND created_at < $2',
      [channel, cutoff]
    )).s;
    // 并发首拉时可能撞主键，DO NOTHING 后重读即可
    await q(
      'INSERT INTO cursors (channel, agent, cursor, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
      [channel, agentId, base, now()]
    );
    return { cursor: (await getCursorRow(channel, agentId)).cursor, initialized: true };
  }

  /**
   * ACK 推进水位线（§4.2 原则三）：
   * 只进不退（GREATEST），且钳制到 latest_seq，防止静默跳过未来消息。
   */
  async function setCursor(channel, agentId, through) {
    const target = Math.min(through, await latestSeq(channel));
    const row = await one(`
      INSERT INTO cursors (channel, agent, cursor, updated_at) VALUES ($1, $2, $3, $4)
      ON CONFLICT (channel, agent) DO UPDATE
      SET cursor = GREATEST(cursors.cursor, excluded.cursor), updated_at = excluded.updated_at
      RETURNING cursor
    `, [channel, agentId, target, now()]);
    return row.cursor;
  }

  return {
    pool,
    tx,
    close: () => pool.end(),
    instanceId,
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
    waitForMessage,
    insertFile,
    getFile,
    hasFileId,
    filesTotalBytes,
    markFileDeleted,
    confirmFileReceived,
    expireFiles,
    getCursorRow,
    ensureCursor,
    setCursor,
  };
}
