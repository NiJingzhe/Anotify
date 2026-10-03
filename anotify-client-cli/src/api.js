// Anotify HTTP 客户端（原生 fetch，供 CLI 使用；设计见 DESIGN.md §6）
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * 发起 API 请求并解析 JSON。
 * @param {object} cred  { server, token }
 * @param {string} method HTTP 方法
 * @param {string} path   以 /v1 开头的路径
 */
export async function api(cred, method, path, { query, body, timeoutMs = 70_000 } = {}) {
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
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const reason = e?.cause?.code ?? e?.message ?? e;
    throw new ApiError(0, 'network_error', `无法连接 ${cred.server}（${reason}）`);
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data?.error ?? {};
    throw new ApiError(res.status, err.code ?? 'unknown', err.message ?? res.statusText);
  }
  return data;
}
