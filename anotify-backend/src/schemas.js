// 共享基础件：错误类型、参数校验、哈希（设计见 DESIGN.md §6）
import { createHash } from 'node:crypto';

/** 可映射为 HTTP 响应的业务错误，server.js 的 onError 统一转 JSON */
export class HttpError extends Error {
  /** extra：附加到错误 JSON 的字段（如 name_taken 的 suggestion） */
  constructor(status, code, message, extra = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
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

// ---- 决策轨迹（DESIGN §15）：决策即消息，只能由 POST /decisions 产生 ----

export const DECISION_CONTENT_TYPE = 'application/vnd.anotify.decision+json';

const BECAUSE_TYPES = new Set(['user', 'rule', 'fact', 'prior', 'assumption']);
const OPTION_IDS = ['A', 'B', 'C', 'D', 'E', 'F'];
const MAX_DECISION_FIELD_BYTES = 4 * 1024;

function reqText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(422, 'invalid_param', `${label} must be a non-empty string`);
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_DECISION_FIELD_BYTES) {
    throw new HttpError(422, 'invalid_param', `${label} exceeds ${MAX_DECISION_FIELD_BYTES} bytes`);
  }
  return value;
}

function optText(value, label) {
  return value === undefined || value === null || value === '' ? undefined : reqText(value, label);
}

function seqList(value, label) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 32) {
    throw new HttpError(422, 'invalid_param', `${label} must be an array of at most 32 seq numbers`);
  }
  return value.map((v) => assertInt(v, { min: 1, label: `${label}[]` }));
}

/**
 * 校验并规范化决策记录（DESIGN §15.3），返回 { payload, refs, reply_to }：
 *   payload —— 写入 content 的对象（字段顺序固定）
 *   refs    —— 需要在频道内存在的 seq 列表（prior.ref / done_so_far）
 *   reply_to —— resolution 必填（须指向 handoff，由调用方检查目标 kind）
 */
export function validateDecisionBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(422, 'invalid_param', 'body must be a JSON object');
  }
  const kind = body.kind;
  let reply_to;
  if (body.reply_to !== undefined && body.reply_to !== null) {
    reply_to = assertInt(body.reply_to, { min: 1, label: 'reply_to' });
  }
  const refs = [];

  if (kind === 'decision') {
    const because = body.because;
    if (!Array.isArray(because) || because.length < 1 || because.length > 8) {
      throw new HttpError(422, 'invalid_param', 'because must be an array of 1-8 reasons');
    }
    const cleaned = because.map((b, i) => {
      if (!b || typeof b !== 'object' || !BECAUSE_TYPES.has(b.type)) {
        throw new HttpError(422, 'invalid_param', `because[${i}].type must be one of: ${[...BECAUSE_TYPES].join(', ')}`);
      }
      const item = { type: b.type };
      if (b.type === 'prior') {
        item.ref = assertInt(b.ref, { min: 1, label: `because[${i}].ref` });
        refs.push(item.ref);
      } else if (b.ref !== undefined) {
        throw new HttpError(422, 'invalid_param', `because[${i}].ref is only allowed for type "prior"`);
      }
      item.text = reqText(b.text, `because[${i}].text`);
      return item;
    });
    const payload = { v: 1, kind, decision: reqText(body.decision, 'decision'), because: cleaned };
    const why = optText(body.why_notify, 'why_notify');
    if (why) payload.why_notify = why;
    return { payload, refs, reply_to };
  }

  if (kind === 'handoff') {
    const options = body.options;
    if (!Array.isArray(options) || options.length < 2 || options.length > 6) {
      throw new HttpError(422, 'invalid_param', 'options must be an array of 2-6 options');
    }
    let recommended = 0;
    const cleaned = options.map((o, i) => {
      if (!o || typeof o !== 'object' || o.id !== OPTION_IDS[i]) {
        throw new HttpError(422, 'invalid_param', `options[${i}].id must be "${OPTION_IDS[i]}" (ids run A-F in order)`);
      }
      const item = { id: o.id, label: reqText(o.label, `options[${i}].label`), outcome: reqText(o.outcome, `options[${i}].outcome`) };
      if (o.recommended === true) { item.recommended = true; recommended++; }
      return item;
    });
    if (recommended > 1) throw new HttpError(422, 'invalid_param', 'at most one option may be recommended');
    const payload = { v: 1, kind, question: reqText(body.question, 'question'), why_you: reqText(body.why_you, 'why_you') };
    const done = seqList(body.done_so_far, 'done_so_far');
    if (done?.length) { payload.done_so_far = done; refs.push(...done); }
    payload.options = cleaned;
    const blocked = optText(body.blocked, 'blocked');
    if (blocked) payload.blocked = blocked;
    const def = optText(body.default_action, 'default_action');
    if (def) payload.default_action = def;
    return { payload, refs, reply_to };
  }

  if (kind === 'resolution') {
    if (reply_to === undefined) throw new HttpError(422, 'invalid_param', 'resolution requires reply_to (the handoff seq)');
    const decided_by = body.decided_by ?? 'human';
    if (decided_by !== 'human' && decided_by !== 'agent') {
      throw new HttpError(422, 'invalid_param', 'decided_by must be "human" or "agent"');
    }
    const payload = { v: 1, kind };
    if (body.chosen !== undefined && body.chosen !== null) {
      if (!OPTION_IDS.includes(body.chosen)) throw new HttpError(422, 'invalid_param', 'chosen must be an option id A-F');
      payload.chosen = body.chosen;
    }
    payload.note = reqText(body.note, 'note');
    payload.decided_by = decided_by;
    return { payload, refs, reply_to };
  }

  throw new HttpError(422, 'invalid_param', 'kind must be one of: decision, handoff, resolution');
}
