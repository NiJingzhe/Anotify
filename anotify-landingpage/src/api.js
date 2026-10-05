// web 端 API 客户端：同源 cookie 会话（设计见 DESIGN.md §14）
// 生产环境 API 挂在 /anotify 下（nginx 反代）；开发时 vite 把 /anotify 代理到本地服务端
export const API_BASE = (import.meta.env.VITE_API_BASE ?? '/anotify').replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network_error', 'Cannot reach the server. Check your connection and try again.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, data?.error?.code ?? 'unknown', data?.error?.message ?? res.statusText);
  }
  return data;
}

export const fileUrl = (channel, fileId) =>
  `${API_BASE}/v1/web/channels/${encodeURIComponent(channel)}/files/${encodeURIComponent(fileId)}`;

/** agent 侧使用的服务端地址（写进「让 agent 加入」的指令里） */
export function agentServerUrl() {
  return /^https?:\/\//.test(API_BASE) ? API_BASE : window.location.origin + API_BASE;
}

export const skillUrl = () => `${window.location.origin}/skill.md`;
