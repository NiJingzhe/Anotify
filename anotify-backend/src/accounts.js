// 人类用户账号 / 会话 / agent 认领的业务逻辑（设计见 DESIGN.md §14）
import { EventEmitter } from 'node:events';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError, sha256 } from './schemas.js';
import {
  assertEmail, assertPasswordPolicy, createPasswordHasher, createSnowflake, normalizeCode,
  normalizeEmail, randomCode, randomToken,
} from './security.js';
import { MailQuotaError, verificationEmail } from './mailer.js';

const DAY = 86400;

export const SESSION_IDLE_SECONDS = 14 * DAY; // 无活动 14 天过期
export const VERIFY_TTL_SECONDS = DAY;
export const CLAIM_TTL_SECONDS = 10 * 60;
export const CLAIM_CODE_LENGTH = 8;
const CLAIM_MAX_ATTEMPTS = 5;
const CLAIM_MAX_PENDING_PER_IP = 5;
const CLAIM_MAX_PENDING_TOTAL = 500;
const RESEND_COOLDOWN_SECONDS = 60;

const DAILY_LIMIT_MESSAGE =
  "Today's sign-up quota (100 verification emails per day) has been reached. Please come back and register tomorrow. / 今日注册名额（每天 100 封验证邮件）已满，请明天再来注册。";

/**
 * @param {object} store  createStore() 的返回值
 * @param {object} cfg    { pepper, workerId, mailer, mailDailyLimit, webUrl, maxAgentsPerUser }
 */
export function createAccounts(store, cfg) {
  const { pool, tx } = store;
  const now = () => Date.now() / 1000;
  const one = async (text, params, client = pool) => (await client.query(text, params)).rows[0];
  const nextId = createSnowflake(cfg.workerId ?? 0);
  const passwords = createPasswordHasher(cfg.pepper);
  const claimEvents = new EventEmitter();
  claimEvents.setMaxListeners(0);

  // ---------- 邮件额度 ----------

  /** 当天（UTC）已消耗的发信额度：成功发出的 + 被 Mailgun 以额度为由拒绝的都算 */
  async function mailsSentToday() {
    const start = Math.floor(now() / DAY) * DAY;
    return Number((await one(
      "SELECT COUNT(*) AS n FROM mail_log WHERE created_at >= $1 AND (ok OR error = 'quota')", [start]
    )).n);
  }

  async function sendVerification(user) {
    if (await mailsSentToday() >= cfg.mailDailyLimit) {
      throw new HttpError(429, 'daily_signup_limit', DAILY_LIMIT_MESSAGE);
    }
    const token = randomToken();
    await pool.query(
      `INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at, created_at)
       VALUES ($1, $2, 'verify', $3, $4)`,
      [sha256(token), user.id, now() + VERIFY_TTL_SECONDS, now()]
    );
    const link = `${cfg.webUrl}/#/verify?token=${token}`;
    const mail = verificationEmail({ link, ttlHours: VERIFY_TTL_SECONDS / 3600 });
    try {
      await cfg.mailer.send({ to: user.email, ...mail });
    } catch (e) {
      const quota = e instanceof MailQuotaError;
      await pool.query(
        'INSERT INTO mail_log (recipient, purpose, ok, error, created_at) VALUES ($1, $2, false, $3, $4)',
        [user.email, 'verify', quota ? 'quota' : String(e.message).slice(0, 200), now()]
      );
      if (quota) throw new HttpError(429, 'daily_signup_limit', DAILY_LIMIT_MESSAGE);
      throw e;
    }
    await pool.query(
      'INSERT INTO mail_log (recipient, purpose, ok, created_at) VALUES ($1, $2, true, $3)',
      [user.email, 'verify', now()]
    );
  }

  // ---------- 注册 / 验证 / 登录 ----------

  async function newInviteCode(client) {
    for (let i = 0; i < 5; i++) {
      const code = randomCode(8);
      if (!(await one('SELECT 1 FROM users WHERE invite_code = $1', [code], client))) return code;
    }
    throw new HttpError(500, 'internal', 'failed to allocate invite code');
  }

  /**
   * 注册：已验证的邮箱 → 409；未验证的邮箱 → 视为重新注册（更新密码 / 邀请人并重发验证信）。
   * 验证信发不出去时，新建的账号整体撤销，用户可以明天用同一邮箱重来。
   */
  async function register({ email, password, inviteCode }) {
    email = assertEmail(email);
    assertPasswordPolicy(password);
    const emailNorm = normalizeEmail(email);

    let inviterId = null;
    const invite = normalizeCode(inviteCode);
    if (invite) {
      const inviter = await one('SELECT id FROM users WHERE invite_code = $1 AND email_verified_at IS NOT NULL', [invite]);
      if (!inviter) throw new HttpError(422, 'invalid_invite_code', 'invite code not found (leave it empty if you do not have one)');
      inviterId = inviter.id;
    }

    // 额度先行检查：额度用尽时不建账号
    if (await mailsSentToday() >= cfg.mailDailyLimit) {
      throw new HttpError(429, 'daily_signup_limit', DAILY_LIMIT_MESSAGE);
    }

    const passwordHash = await passwords.hash(password);
    const existing = await one('SELECT id, email_verified_at FROM users WHERE email_norm = $1', [emailNorm]);
    let user;
    let created = false;
    if (existing?.email_verified_at) {
      throw new HttpError(409, 'email_taken', 'an account with this email already exists; sign in instead');
    } else if (existing) {
      const recent = await one(
        "SELECT 1 FROM email_tokens WHERE user_id = $1 AND purpose = 'verify' AND created_at > $2",
        [existing.id, now() - RESEND_COOLDOWN_SECONDS]
      );
      if (recent) throw new HttpError(429, 'too_soon', 'a verification email was just sent; check your inbox or wait a minute');
      user = await one(
        'UPDATE users SET email = $1, password_hash = $2, invited_by = $3 WHERE id = $4 RETURNING id, email',
        [email, passwordHash, inviterId, existing.id]
      );
    } else {
      user = await tx(async (c) => one(
        `INSERT INTO users (id, email, email_norm, password_hash, invite_code, invited_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, email`,
        [nextId(), email, emailNorm, passwordHash, await newInviteCode(c), inviterId, now()], c
      )).catch((e) => {
        if (e.code === '23505') throw new HttpError(409, 'email_taken', 'an account with this email already exists');
        throw e;
      });
      created = true;
    }

    try {
      await sendVerification(user);
    } catch (e) {
      if (created) await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
      throw e;
    }
    return { user_id: user.id, email: user.email, verification_sent: true };
  }

  async function resendVerification(email) {
    const emailNorm = normalizeEmail(assertEmail(email));
    const user = await one('SELECT id, email, email_verified_at FROM users WHERE email_norm = $1', [emailNorm]);
    // 不暴露邮箱是否注册：不存在 / 已验证都静默成功
    if (!user || user.email_verified_at) return { ok: true };
    const recent = await one(
      "SELECT 1 FROM email_tokens WHERE user_id = $1 AND purpose = 'verify' AND created_at > $2",
      [user.id, now() - RESEND_COOLDOWN_SECONDS]
    );
    if (recent) throw new HttpError(429, 'too_soon', 'a verification email was just sent; check your inbox or wait a minute');
    await sendVerification(user);
    return { ok: true };
  }

  /** 消费验证 token：标记邮箱已验证，返回用户（随后由路由签发会话） */
  async function verifyEmail(token) {
    if (typeof token !== 'string' || !token) throw new HttpError(422, 'invalid_token', 'verification token is required');
    return tx(async (c) => {
      const row = await one(
        "DELETE FROM email_tokens WHERE token_hash = $1 AND purpose = 'verify' RETURNING user_id, expires_at",
        [sha256(token)], c
      );
      if (!row) throw new HttpError(400, 'invalid_token', 'this verification link is invalid or has already been used');
      if (row.expires_at < now()) throw new HttpError(400, 'token_expired', 'this verification link has expired; request a new one');
      const user = await one(
        'UPDATE users SET email_verified_at = COALESCE(email_verified_at, $1) WHERE id = $2 RETURNING id, email',
        [now(), row.user_id], c
      );
      await c.query("DELETE FROM email_tokens WHERE user_id = $1 AND purpose = 'verify'", [row.user_id]);
      return user;
    });
  }

  // 登录失败节流：同一邮箱 15 分钟内最多 10 次失败（进程内计数）
  const failures = new Map();
  const FAIL_WINDOW = 15 * 60;
  const FAIL_MAX = 10;

  async function login({ email, password }) {
    if (typeof email !== 'string' || typeof password !== 'string') {
      throw new HttpError(422, 'invalid_param', 'email and password are required');
    }
    const key = normalizeEmail(email);
    const f = failures.get(key);
    if (f && f.until > now() && f.count >= FAIL_MAX) {
      throw new HttpError(429, 'too_many_attempts', 'too many failed sign-in attempts; try again in 15 minutes');
    }
    const user = await one('SELECT id, email, password_hash, email_verified_at FROM users WHERE email_norm = $1', [key]);
    const ok = user ? await passwords.verify(password, user.password_hash) : false;
    if (!ok) {
      const cur = f && f.until > now() ? f : { count: 0, until: now() + FAIL_WINDOW };
      cur.count++;
      failures.set(key, cur);
      throw new HttpError(401, 'invalid_credentials', 'wrong email or password');
    }
    failures.delete(key);
    if (!user.email_verified_at) {
      throw new HttpError(403, 'email_not_verified', 'verify your email first (check your inbox, or request a new verification email)');
    }
    return { id: user.id, email: user.email };
  }

  // ---------- 会话（JWT 只携带 sid；有效性以 sessions 行为准，可撤销、可续期）----------

  async function createSession(userId, { userAgent, ip } = {}) {
    const id = randomToken(18);
    const t = now();
    await pool.query(
      `INSERT INTO sessions (id, user_id, created_at, last_active_at, expires_at, user_agent, ip)
       VALUES ($1, $2, $3, $3, $4, $5, $6)`,
      [id, userId, t, t + SESSION_IDLE_SECONDS, (userAgent ?? '').slice(0, 300), ip ?? null]
    );
    return { id, user_id: userId, expires_at: t + SESSION_IDLE_SECONDS };
  }

  async function getSession(sid) {
    const s = await one(`
      SELECT s.id, s.user_id, s.last_active_at, s.expires_at, u.email
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > $2
    `, [sid, now()]);
    return s ?? null;
  }

  /** 活动心跳：滑动续期到「现在 + 14 天」 */
  async function touchSession(sid) {
    const t = now();
    return one(
      `UPDATE sessions SET last_active_at = $1, expires_at = $2
       WHERE id = $3 AND revoked_at IS NULL AND expires_at > $1
       RETURNING id, user_id, expires_at`,
      [t, t + SESSION_IDLE_SECONDS, sid]
    );
  }

  async function revokeSession(sid) {
    await pool.query('UPDATE sessions SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL', [now(), sid]);
  }

  async function getProfile(userId) {
    const u = await one(`
      SELECT u.id, u.email, u.invite_code, u.created_at, u.email_verified_at,
             inv.email AS invited_by_email,
             (SELECT COUNT(*) FROM users x WHERE x.invited_by = u.id AND x.email_verified_at IS NOT NULL) AS invitees,
             (SELECT COUNT(*) FROM agents a WHERE a.owner_id = u.id) AS agents
      FROM users u LEFT JOIN users inv ON inv.id = u.invited_by
      WHERE u.id = $1
    `, [userId]);
    if (!u) return null;
    return {
      user_id: u.id,
      email: u.email,
      invite_code: u.invite_code,
      invited_by: u.invited_by_email ? maskEmail(u.invited_by_email) : null,
      invitee_count: Number(u.invitees),
      agent_count: Number(u.agents),
      created_at: u.created_at,
    };
  }

  async function listInvitees(userId) {
    const { rows } = await pool.query(
      'SELECT email, created_at FROM users WHERE invited_by = $1 AND email_verified_at IS NOT NULL ORDER BY created_at',
      [userId]
    );
    return rows.map((r) => ({ email: maskEmail(r.email), created_at: r.created_at }));
  }

  // ---------- agent 认领（DESIGN §14.4）----------

  /**
   * 发起认领：kind=register（新 agent，批准后才建档）或 bind（已有 agent 绑定到用户）。
   * 返回给 CLI 的 code 是唯一一次明文出现；库里只存哈希。
   */
  async function createClaim({ kind, displayName, agentId = null, ip }) {
    if (kind === 'bind') {
      const agent = await store.getAgentRow(agentId);
      if (agent.owner_id) throw new HttpError(409, 'already_owned', 'this agent is already bound to an account');
    }
    const t = now();
    const pendingByIp = await one(
      "SELECT COUNT(*) AS n FROM agent_claims WHERE requester_ip = $1 AND status = 'pending' AND expires_at > $2",
      [ip, t]
    );
    if (Number(pendingByIp.n) >= CLAIM_MAX_PENDING_PER_IP) {
      throw new HttpError(429, 'too_many_claims', 'too many pending registration requests from this address; finish or let them expire (10 min) first');
    }
    const pendingTotal = await one(
      "SELECT COUNT(*) AS n FROM agent_claims WHERE status = 'pending' AND expires_at > $1", [t]
    );
    if (Number(pendingTotal.n) >= CLAIM_MAX_PENDING_TOTAL) {
      throw new HttpError(503, 'claims_busy', 'too many pending registration requests; try again in a few minutes');
    }
    const id = 'cl_' + randomBytes(12).toString('base64url');
    const code = randomCode(CLAIM_CODE_LENGTH);
    const pollToken = randomToken();
    await pool.query(
      `INSERT INTO agent_claims (id, kind, display_name, agent_id, code_hash, poll_hash, status, requester_ip, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9)`,
      [id, kind, displayName, agentId, sha256(code), sha256(pollToken), ip, t, t + CLAIM_TTL_SECONDS]
    );
    return {
      claim_id: id,
      kind,
      code,
      claim_url: `${cfg.webUrl}/#/claim/${id}`,
      poll_token: pollToken,
      expires_at: t + CLAIM_TTL_SECONDS,
    };
  }

  /** 状态视图：过期在读取时惰性判定 */
  const effectiveStatus = (c) => (c.status === 'pending' && c.expires_at <= now() ? 'expired' : c.status);

  /** web 端查看认领单（不含 code）；用户需登录 */
  async function getClaimForWeb(claimId) {
    const c = await one(`
      SELECT c.id, c.kind, c.display_name, c.agent_id, c.status, c.expires_at, c.created_at, c.user_id,
             a.display_name AS agent_name
      FROM agent_claims c LEFT JOIN agents a ON a.id = c.agent_id
      WHERE c.id = $1
    `, [claimId]);
    if (!c) throw new HttpError(404, 'claim_not_found', 'this registration link is invalid');
    return {
      claim_id: c.id,
      kind: c.kind,
      display_name: c.kind === 'bind' ? c.agent_name : c.display_name,
      agent_id: c.agent_id,
      status: effectiveStatus(c),
      expires_at: c.expires_at,
      created_at: c.created_at,
      approved_by_you: null,
      code_length: CLAIM_CODE_LENGTH,
      _user_id: c.user_id,
    };
  }

  /** 人在 web 上输入 8 位码批准；错 5 次作废 */
  async function approveClaim(claimId, userId, code) {
    const result = await tx(async (c) => {
      const claim = await one('SELECT * FROM agent_claims WHERE id = $1 FOR UPDATE', [claimId], c);
      if (!claim) throw new HttpError(404, 'claim_not_found', 'this registration link is invalid');
      const status = effectiveStatus(claim);
      if (status === 'expired') throw new HttpError(410, 'claim_expired', 'this request has expired; ask your agent to start again');
      if (status === 'locked') throw new HttpError(410, 'claim_locked', 'too many wrong codes; ask your agent to start again');
      if (status !== 'pending') throw new HttpError(409, 'claim_decided', 'this request has already been approved');

      const given = Buffer.from(sha256(normalizeCode(code)), 'hex');
      const expected = Buffer.from(claim.code_hash, 'hex');
      if (!timingSafeEqual(given, expected)) {
        const attempts = claim.attempts + 1;
        const locked = attempts >= CLAIM_MAX_ATTEMPTS;
        await c.query('UPDATE agent_claims SET attempts = $1, status = $2 WHERE id = $3',
          [attempts, locked ? 'locked' : 'pending', claimId]);
        return { error: locked
          ? new HttpError(410, 'claim_locked', 'too many wrong codes; this request is now void — ask your agent to start again')
          : new HttpError(422, 'wrong_code', `wrong code (${CLAIM_MAX_ATTEMPTS - attempts} attempt(s) left)`) };
      }

      const owned = Number((await one('SELECT COUNT(*) AS n FROM agents WHERE owner_id = $1', [userId], c)).n);
      if (owned >= cfg.maxAgentsPerUser) {
        throw new HttpError(409, 'agent_limit', `an account can own at most ${cfg.maxAgentsPerUser} agents`);
      }
      if (claim.kind === 'bind') {
        const r = await c.query('UPDATE agents SET owner_id = $1 WHERE id = $2 AND owner_id IS NULL', [userId, claim.agent_id]);
        if (!r.rowCount) throw new HttpError(409, 'already_owned', 'this agent is already bound to an account');
      }
      await c.query("UPDATE agent_claims SET status = 'approved', user_id = $1, decided_at = $2 WHERE id = $3",
        [userId, now(), claimId]);
      return { ok: { claim_id: claimId, kind: claim.kind, status: 'approved' } };
    });
    // 错码计数要落库，所以在事务提交之后再抛
    if (result.error) throw result.error;
    claimEvents.emit(claimId);
    return result.ok;
  }

  /**
   * CLI 轮询认领结果（可长等）。register 批准后在这里建档并下发 token——token 只出现这一次，
   * 认领单随即标记 consumed。
   */
  async function pollClaim(claimId, pollToken, waitSeconds = 0) {
    const load = () => one('SELECT * FROM agent_claims WHERE id = $1', [claimId]);
    let claim = await load();
    if (!claim || typeof pollToken !== 'string' ||
        !timingSafeEqual(Buffer.from(sha256(pollToken), 'hex'), Buffer.from(claim.poll_hash, 'hex'))) {
      throw new HttpError(404, 'claim_not_found', 'unknown claim or wrong poll token');
    }
    const deadline = Date.now() + waitSeconds * 1000;
    while (effectiveStatus(claim) === 'pending' && Date.now() < deadline) {
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); claimEvents.off(claimId, done); resolve(); };
        const timer = setTimeout(done, Math.min(deadline - Date.now(), 2000));
        claimEvents.on(claimId, done);
      });
      claim = await load();
    }

    const status = effectiveStatus(claim);
    const base = { claim_id: claim.id, kind: claim.kind, status, expires_at: claim.expires_at };
    if (status !== 'approved') return base;

    if (claim.kind === 'bind') {
      await pool.query("UPDATE agent_claims SET status = 'consumed' WHERE id = $1 AND status = 'approved'", [claim.id]);
      return { ...base, status: 'consumed', agent_id: claim.agent_id };
    }
    return tx(async (c) => {
      const r = await c.query("UPDATE agent_claims SET status = 'consumed' WHERE id = $1 AND status = 'approved'", [claim.id]);
      if (!r.rowCount) return { ...base, status: 'consumed' }; // 并发轮询：另一路已领走
      const agent = await store.createAgent(claim.display_name, { ownerId: claim.user_id, client: c });
      await c.query('UPDATE agent_claims SET agent_id = $1 WHERE id = $2', [agent.agent_id, claim.id]);
      return { ...base, status: 'consumed', ...agent };
    });
  }

  // ---------- web 只读视图 ----------

  async function listOwnedAgents(userId) {
    const { rows } = await pool.query(`
      SELECT a.id AS agent_id, a.display_name, a.created_at,
             (SELECT COUNT(*) FROM channel_members cm WHERE cm.agent = a.id) AS channels
      FROM agents a WHERE a.owner_id = $1 ORDER BY a.created_at
    `, [userId]);
    return rows.map((r) => ({ ...r, channels: Number(r.channels) }));
  }

  /** 用户名下 agent 加入的全部频道，附每个 agent 的游标 / 积压 */
  async function listUserChannels(userId) {
    const { rows } = await pool.query(`
      SELECT c.name, c.created_at, c.last_seq, (c.password_hash IS NOT NULL) AS locked,
             ca.display_name AS created_by_name,
             (SELECT MAX(m.created_at) FROM messages m WHERE m.channel = c.name AND m.seq = c.last_seq) AS last_activity,
             (SELECT COUNT(*) FROM channel_members x WHERE x.channel = c.name) AS member_count,
             a.id AS agent_id, a.display_name AS agent_name, cu.cursor
      FROM agents a
      JOIN channel_members cm ON cm.agent = a.id
      JOIN channels c ON c.name = cm.channel
      LEFT JOIN agents ca ON ca.id = c.created_by
      LEFT JOIN cursors cu ON cu.channel = c.name AND cu.agent = a.id
      WHERE a.owner_id = $1
      ORDER BY c.name, a.display_name
    `, [userId]);
    const byName = new Map();
    for (const r of rows) {
      let ch = byName.get(r.name);
      if (!ch) {
        ch = {
          name: r.name, locked: r.locked, created_at: r.created_at, created_by_name: r.created_by_name,
          latest_seq: r.last_seq, last_activity: r.last_activity, member_count: Number(r.member_count), my_agents: [],
        };
        byName.set(r.name, ch);
      }
      ch.my_agents.push({
        agent_id: r.agent_id, display_name: r.agent_name, cursor: r.cursor ?? null,
        pending: r.cursor == null ? null : Math.max(0, r.last_seq - r.cursor),
      });
    }
    return [...byName.values()].sort((a, b) => (b.last_activity ?? 0) - (a.last_activity ?? 0));
  }

  async function listPublicChannels() {
    const { rows } = await pool.query(`
      SELECT c.name, c.created_at, c.last_seq, ca.display_name AS created_by_name,
             (SELECT m.created_at FROM messages m WHERE m.channel = c.name AND m.seq = c.last_seq) AS last_activity,
             (SELECT COUNT(*) FROM channel_members x WHERE x.channel = c.name) AS member_count
      FROM channels c LEFT JOIN agents ca ON ca.id = c.created_by
      WHERE c.password_hash IS NULL
      ORDER BY last_activity DESC NULLS LAST, c.created_at DESC
    `);
    return rows.map((r) => ({
      name: r.name, created_at: r.created_at, created_by_name: r.created_by_name, latest_seq: r.last_seq,
      last_activity: r.last_activity, member_count: Number(r.member_count),
    }));
  }

  /** web 读频道的访问门：公开频道人人可读；上锁频道仅当用户名下有 agent 是成员 */
  async function assertWebAccess(channel, userId) {
    const row = await store.getChannelRow(channel);
    if (!row) throw new HttpError(404, 'channel_not_found', `channel "${channel}" does not exist`);
    if (!row.password_hash) return { locked: false };
    if (userId) {
      const ok = await one(`
        SELECT 1 FROM channel_members cm JOIN agents a ON a.id = cm.agent
        WHERE cm.channel = $1 AND a.owner_id = $2 LIMIT 1
      `, [channel, userId]);
      if (ok) return { locked: true };
    }
    throw new HttpError(userId ? 403 : 401, 'no_access',
      'this channel is private; only accounts owning a member agent can view it');
  }

  /** 倒序翻页：before 之前的最多 limit 条（升序返回）；或 after 之后的增量 */
  async function webMessages(channel, { before, after, limit }) {
    let rows;
    const cols = `m.seq, m.sender, a.display_name AS sender_name, m.content_type, m.content, m.reply_to, m.created_at`;
    if (after !== undefined) {
      ({ rows } = await pool.query(`
        SELECT ${cols} FROM messages m LEFT JOIN agents a ON a.id = m.sender
        WHERE m.channel = $1 AND m.seq > $2 ORDER BY m.seq LIMIT $3
      `, [channel, after, limit]));
    } else {
      ({ rows } = await pool.query(`
        SELECT ${cols} FROM messages m LEFT JOIN agents a ON a.id = m.sender
        WHERE m.channel = $1 AND m.seq < $2 ORDER BY m.seq DESC LIMIT $3
      `, [channel, before ?? 2147483647, limit]));
      rows.reverse();
    }
    return rows;
  }

  /** 定期清理：过期认领单 / 验证 token / 会话 */
  async function gc() {
    const t = now();
    await pool.query("DELETE FROM agent_claims WHERE expires_at < $1 AND status IN ('pending', 'locked', 'expired')", [t - DAY]);
    await pool.query('DELETE FROM agent_claims WHERE created_at < $1', [t - 30 * DAY]);
    await pool.query('DELETE FROM email_tokens WHERE expires_at < $1', [t]);
    await pool.query('DELETE FROM sessions WHERE expires_at < $1 OR revoked_at < $1', [t - DAY]);
    // 超过 7 天仍未验证的账号释放邮箱
    await pool.query('DELETE FROM users WHERE email_verified_at IS NULL AND created_at < $1', [t - 7 * DAY]);
  }

  return {
    register, resendVerification, verifyEmail, login,
    createSession, getSession, touchSession, revokeSession, getProfile, listInvitees,
    createClaim, getClaimForWeb, approveClaim, pollClaim,
    listOwnedAgents, listUserChannels, listPublicChannels, assertWebAccess, webMessages,
    mailsSentToday, gc,
  };
}

export function maskEmail(email) {
  const [local, domain] = String(email).split('@');
  if (!domain) return '***';
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}${'*'.repeat(Math.max(1, local.length - head.length))}@${domain}`;
}
