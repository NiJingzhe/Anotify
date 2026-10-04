// 共享基础件：错误类型、参数校验、哈希（设计见 DESIGN.md §6）
import { createHash } from 'node:crypto';

/** 可映射为 HTTP 响应的业务错误，server.js 的 onError 统一转 JSON */
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

/** 频道名 / agent 名共用同一规则（DESIGN §2） */
export const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function assertName(value, label = 'name') {
  if (typeof value !== 'string' || !NAME_RE.test(value)) {
    throw new HttpError(422, 'invalid_param', `${label} must match ${NAME_RE} (1-64 chars of [A-Za-z0-9_-])`);
  }
  return value;
}

/** 解析 JSON body，非法时 422 */
export async function parseJson(c) {
  try {
    return await c.req.json();
  } catch {
    throw new HttpError(422, 'invalid_json', 'request body must be valid JSON');
  }
}

/** 解析 JSON body，允许空 body（返回 {}），非法时 422 */
export async function parseOptionalJson(c) {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(422, 'invalid_json', 'request body must be valid JSON');
  }
}

/** 整数参数校验（query string / body 通用，接受数字或数字字符串） */
export function assertInt(value, { min, max, label = 'value' } = {}) {
  const n = typeof value === 'number' ? value : Number(value);
  const inRange =
    Number.isInteger(n) &&
    (min === undefined || n >= min) &&
    (max === undefined || n <= max);
  if (!inRange) {
    const lo = min ?? '-inf';
    const hi = max ?? '+inf';
    throw new HttpError(422, 'invalid_param', `${label} must be an integer in [${lo}, ${hi}]`);
  }
  return n;
}

/** 单条消息上限 64 KB（DESIGN §6.3） */
export const MAX_CONTENT_BYTES = 64 * 1024;

export const CONTENT_TYPES = new Set(['text/plain', 'application/json']);

/** 发布消息的 body 校验，返回规范化后的字段 */
export function validateMessageBody(body) {
  if (typeof body?.content !== 'string' || body.content.length === 0) {
    throw new HttpError(422, 'invalid_param', 'content must be a non-empty string');
  }
  if (Buffer.byteLength(body.content, 'utf8') > MAX_CONTENT_BYTES) {
    throw new HttpError(413, 'message_too_large', `content exceeds ${MAX_CONTENT_BYTES} bytes`);
  }
  const content_type = body.content_type ?? 'text/plain';
  if (!CONTENT_TYPES.has(content_type)) {
    throw new HttpError(422, 'invalid_param', `content_type must be one of: ${[...CONTENT_TYPES].join(', ')}`);
  }
  let reply_to;
  if (body.reply_to !== undefined && body.reply_to !== null) {
    reply_to = assertInt(body.reply_to, { min: 1, label: 'reply_to' });
  }
  return { content: body.content, content_type, reply_to };
}

/** 文件消息的 content_type：content 为 JSON 元数据，只能由 POST /files 产生，防伪造（DESIGN §12） */
export const FILE_CONTENT_TYPE = 'application/vnd.anotify.file+json';

/** 文件名：单段 basename，1-255 字节，无路径分隔符 / 控制字符 */
export function assertFileName(value) {
  const ok =
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 255 &&
    value !== '.' && value !== '..' &&
    !/[/\\\x00-\x1f\x7f]/.test(value);
  if (!ok) {
    throw new HttpError(422, 'invalid_param', 'name must be a plain file name (1-255 bytes, no path separators or control characters)');
  }
  return value;
}

/** 文件附言上限 4 KB */
export const MAX_CAPTION_BYTES = 4 * 1024;

export function assertCaption(value) {
  if (value === undefined || value === '') return undefined;
  if (Buffer.byteLength(value, 'utf8') > MAX_CAPTION_BYTES) {
    throw new HttpError(422, 'invalid_param', `caption exceeds ${MAX_CAPTION_BYTES} bytes`);
  }
  return value;
}
