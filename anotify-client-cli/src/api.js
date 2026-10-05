// Anotify HTTP 客户端（原生 fetch，供 CLI 使用；设计见 DESIGN.md §6）
import { noteUnowned } from './notices.js';
export class ApiError extends Error {
  /** details：服务端错误 JSON 里的其他字段（如 name_taken 的 suggestion） */
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * 发起 API 请求并解析 JSON。
 * @param {object} cred  { server, token }
 * @param {string} method HTTP 方法
 * @param {string} path   以 /v1 开头的路径
 */
export async function api(cred, method, path, { query, body, timeoutMs = 70_000 } = {}) {
  const res = await apiRaw(cred, method, path, {
    query,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    contentType: body !== undefined ? 'application/json' : undefined,
    timeoutMs,
  });
  return res.json().catch(() => null);
}

/**
 * 底层请求：body 原样发送、返回未消费的 Response（文件上传/下载用）。
 * 非 2xx 时解析错误 JSON 并抛 ApiError。
 */
export async function apiRaw(cred, method, path, { query, body, contentType, timeoutMs = 70_000 } = {}) {
  const url = new URL(cred.server.replace(/\/+$/, '') + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...(cred.token ? { authorization: `Bearer ${cred.token}` } : {}),
        ...(contentType ? { 'content-type': contentType } : {}),
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const reason = e?.cause?.code ?? e?.message ?? e;
    throw new ApiError(0, 'network_error', `Cannot reach ${cred.server} (${reason})`);
  }

  // 服务端标记「此身份还没绑定到人类账号」：命令结束时提醒 agent 去问用户
  if (res.headers.get('x-anotify-unowned') === '1') noteUnowned(cred.profile ?? null, cred.server);

  if (!res.ok) {
    const data = await res.json().catch(() => null);
    const err = data?.error ?? {};
    // nginx 等反代层的 413 不是 JSON，给出可操作的提示
    const fallback = res.status === 413 ? 'request body too large for the server or its reverse proxy' : res.statusText;
    throw new ApiError(res.status, err.code ?? 'unknown', err.message ?? fallback, err);
  }
  return res;
}
