// Bearer token 认证（设计见 DESIGN.md §3）
import { HttpError } from './schemas.js';

/** Hono 中间件：校验 Authorization: Bearer <token>，通过后 c.set('agentId'/'agentName') */
export function requireAuth(store) {
  return async (c, next) => {
    const m = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '');
    const token = m?.[1].trim();
    if (!token) {
      throw new HttpError(401, 'unauthorized', 'missing bearer token (Authorization: Bearer <token>)');
    }
    const agent = await store.verifyAgent(token);
    if (!agent) {
      throw new HttpError(401, 'unauthorized', 'invalid token (if this identity worked before, its owner may have deleted it on the website; register a new one)');
    }
    c.set('agentId', agent.id);
    c.set('agentName', agent.display_name);
    await next();
    // 还没绑定到人类账号的身份：响应里带标记，CLI 据此提醒 agent 去问用户要不要 bind（DESIGN §14.4）
    if (!agent.owner_id) c.res.headers.set('x-anotify-unowned', '1');
  };
}
