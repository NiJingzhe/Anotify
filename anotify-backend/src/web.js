// 人类用户相关路由：账号 / 会话（cookie + JWT）、agent 认领、web 只读视图（设计见 DESIGN.md §14）
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { sign, verify } from 'hono/jwt';
import { HttpError, parseJson, parseOptionalJson, assertName, assertInt } from './schemas.js';
import { CLAIM_TTL_SECONDS, SESSION_IDLE_SECONDS } from './accounts.js';
import { MIN_PASSWORD_LENGTH } from './security.js';

export const SESSION_COOKIE = 'anotify_session';

/**
 * @param {object} deps { store, accounts, cfg: { jwtSecret, cookieSecure, allowedOrigins, trustProxy, mailDailyLimit }, serveFile, requireAuth }
 */
export function accountRoutes({ store, accounts, cfg, serveFile, requireAuth }) {
  const r = new Hono();

  // ---------- 会话工具 ----------

  async function issueCookie(c, session) {
    const token = await sign({ sid: session.id, sub: String(session.user_id), exp: Math.floor(session.expires_at) }, cfg.jwtSecret, 'HS256');
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: cfg.cookieSecure,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_IDLE_SECONDS,
    });
  }

  /** 解析 cookie → 有效会话；无效 / 缺失返回 null（不抛） */
  async function currentUser(c) {
    if (c.get('user') !== undefined) return c.get('user');
    let user = null;
    const raw = getCookie(c, SESSION_COOKIE);
    if (raw) {
      try {
        const payload = await verify(raw, cfg.jwtSecret, 'HS256');
        const s = await accounts.getSession(payload.sid);
        if (s) user = { user_id: s.user_id, email: s.email, sid: s.id };
      } catch {
        // 签名错误 / 过期：当作未登录
      }
    }
    c.set('user', user);
    return user;
  }

  async function requireUser(c) {
    const user = await currentUser(c);
    if (!user) throw new HttpError(401, 'login_required', 'sign in first');
    return user;
  }

  /**
   * cookie 鉴权的写操作防 CSRF：必须是 JSON 请求（跨站表单发不出来、跨站 fetch 需预检），
   * 且 Origin（若带）必须在白名单内。cookie 本身还有 SameSite=Lax。
   */
  function assertSameSite(c) {
    const ct = c.req.header('content-type') ?? '';
    if (!ct.toLowerCase().startsWith('application/json')) {
      throw new HttpError(415, 'json_required', 'content-type must be application/json');
    }
    const origin = c.req.header('origin');
    if (origin && !cfg.allowedOrigins.includes(origin)) {
      throw new HttpError(403, 'bad_origin', `origin ${origin} is not allowed`);
    }
  }

  function clientIp(c) {
    if (cfg.trustProxy) {
      const real = c.req.header('x-real-ip');
      if (real) return real.trim();
      const xff = c.req.header('x-forwarded-for');
      if (xff) return xff.split(',').pop().trim(); // 最右一跳由我们自己的反代写入，不可伪造
    }
    return c.env?.incoming?.socket?.remoteAddress ?? 'unknown';
  }

  // ---------- 账号 ----------

  r.get('/auth/config', async (c) => c.json({
    password_min_length: MIN_PASSWORD_LENGTH,
    password_min_classes: 2,
    daily_signup_limit: cfg.mailDailyLimit,
    daily_signup_remaining: Math.max(0, cfg.mailDailyLimit - await accounts.mailsSentToday()),
  }));

  r.post('/auth/register', async (c) => {
    assertSameSite(c);
    const body = await parseJson(c);
    const result = await accounts.register({ email: body?.email, password: body?.password, inviteCode: body?.invite_code });
    return c.json(result, 201);
  });

  r.post('/auth/resend', async (c) => {
    assertSameSite(c);
    const body = await parseJson(c);
    return c.json(await accounts.resendVerification(body?.email));
  });

  // 验证邮箱成功即登录
  r.post('/auth/verify', async (c) => {
    assertSameSite(c);
    const body = await parseJson(c);
    const user = await accounts.verifyEmail(body?.token);
    const session = await accounts.createSession(user.id, { userAgent: c.req.header('user-agent'), ip: clientIp(c) });
    await issueCookie(c, session);
    return c.json(await accounts.getProfile(user.id));
  });

  r.post('/auth/login', async (c) => {
    assertSameSite(c);
    const body = await parseJson(c);
    const user = await accounts.login({ email: body?.email, password: body?.password });
    const session = await accounts.createSession(user.id, { userAgent: c.req.header('user-agent'), ip: clientIp(c) });
    await issueCookie(c, session);
    return c.json(await accounts.getProfile(user.id));
  });

  r.post('/auth/logout', async (c) => {
    assertSameSite(c);
    const user = await currentUser(c);
    if (user) await accounts.revokeSession(user.sid);
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: cfg.cookieSecure });
    return c.json({ ok: true });
  });

  // 活动心跳：web 端在用户有交互时（节流）调用，会话滑动续期到 14 天后
  r.post('/auth/heartbeat', async (c) => {
    assertSameSite(c);
    const user = await requireUser(c);
    const s = await accounts.touchSession(user.sid);
    if (!s) throw new HttpError(401, 'login_required', 'session expired; sign in again');
    await issueCookie(c, s);
    return c.json({ expires_at: s.expires_at });
  });

  r.get('/auth/me', async (c) => {
    const user = await requireUser(c);
    return c.json(await accounts.getProfile(user.user_id));
  });

  r.get('/auth/invitees', async (c) => {
    const user = await requireUser(c);
    return c.json({ invitees: await accounts.listInvitees(user.user_id) });
  });

  // ---------- agent 认领：CLI 侧（匿名发起 + 轮询）----------

  r.post('/agents/claims', async (c) => {
    const body = await parseJson(c);
    const name = assertName(body?.name, 'name');
    const claim = await accounts.createClaim({ kind: 'register', displayName: name, ip: clientIp(c) });
    return c.json({ ...claim, ttl_seconds: CLAIM_TTL_SECONDS }, 201);
  });

  r.post('/agents/claims/:id/poll', async (c) => {
    const body = await parseOptionalJson(c);
    const wait = assertInt(body?.wait ?? 0, { min: 0, max: 30, label: 'wait' });
    return c.json(await accounts.pollClaim(c.req.param('id'), body?.poll_token, wait));
  });

  // 已有 agent（带 token）申请绑定到用户
  r.post('/agents/me/claims', requireAuth, async (c) => {
    const agentId = c.get('agentId');
    const claim = await accounts.createClaim({
      kind: 'bind', displayName: c.get('agentName'), agentId, ip: clientIp(c),
    });
    return c.json({ ...claim, ttl_seconds: CLAIM_TTL_SECONDS }, 201);
  });

  // ---------- agent 认领：web 侧（登录用户输入 8 位码）----------

  r.get('/web/claims/:id', async (c) => {
    const user = await requireUser(c);
    const claim = await accounts.getClaimForWeb(c.req.param('id'));
    const { _user_id, ...view } = claim;
    view.approved_by_you = _user_id ? _user_id === user.user_id : null;
    return c.json(view);
  });

  r.post('/web/claims/:id/approve', async (c) => {
    assertSameSite(c);
    const user = await requireUser(c);
    const body = await parseJson(c);
    return c.json(await accounts.approveClaim(c.req.param('id'), user.user_id, body?.code));
  });

  // ---------- web 只读视图 ----------

  r.get('/web/public/channels', async (c) => c.json({ channels: await accounts.listPublicChannels() }));

  r.get('/web/me/agents', async (c) => {
    const user = await requireUser(c);
    return c.json({ agents: await accounts.listOwnedAgents(user.user_id) });
  });

  r.get('/web/me/channels', async (c) => {
    const user = await requireUser(c);
    return c.json({ channels: await accounts.listUserChannels(user.user_id) });
  });

  r.get('/web/channels/:ch', async (c) => {
    const ch = c.req.param('ch');
    const user = await currentUser(c);
    const { locked } = await accounts.assertWebAccess(ch, user?.user_id);
    const row = await store.getChannelRow(ch);
    const members = await store.listMembers(ch);
    return c.json({
      name: ch,
      locked,
      created_at: row.created_at,
      created_by: row.created_by,
      latest_seq: await store.latestSeq(ch),
      members,
    });
  });

  r.get('/web/channels/:ch/messages', async (c) => {
    const ch = c.req.param('ch');
    const user = await currentUser(c);
    await accounts.assertWebAccess(ch, user?.user_id);
    const q = c.req.query();
    const limit = assertInt(q.limit ?? 50, { min: 1, max: 200, label: 'limit' });
    const before = q.before !== undefined ? assertInt(q.before, { min: 1, label: 'before' }) : undefined;
    const after = q.after !== undefined ? assertInt(q.after, { min: 0, label: 'after' }) : undefined;
    const messages = await accounts.webMessages(ch, { before, after, limit });
    return c.json({ channel: ch, messages, latest_seq: await store.latestSeq(ch) });
  });

  r.get('/web/channels/:ch/files/:id', async (c) => {
    const ch = c.req.param('ch');
    const user = await currentUser(c);
    await accounts.assertWebAccess(ch, user?.user_id);
    return serveFile(ch, c.req.param('id'));
  });

  return r;
}
