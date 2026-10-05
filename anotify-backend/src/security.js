// 账号体系的安全基础件：snowflake id、密码策略与哈希、随机码（设计见 DESIGN.md §14）
import { createHmac, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError } from './schemas.js';

const scrypt = promisify(scryptCb);

// ---- snowflake id ----
// 41 位毫秒时间戳（自 2026-01-01）| 10 位 worker | 12 位序列；以十进制字符串对外（超出 JS 安全整数）

const EPOCH = 1767225600000n; // 2026-01-01T00:00:00Z

export function createSnowflake(workerId = 0) {
  if (!Number.isInteger(workerId) || workerId < 0 || workerId > 1023) {
    throw new Error('snowflake worker id must be an integer in [0, 1023]');
  }
  let lastMs = -1n;
  let seq = 0n;
  return function next() {
    let ms = BigInt(Date.now());
    if (ms < lastMs) ms = lastMs; // 时钟回拨：沿用上一毫秒，靠序列号区分
    if (ms === lastMs) {
      seq = (seq + 1n) & 0xfffn;
      if (seq === 0n) {
        // 本毫秒序列用尽：自旋到下一毫秒
        while (BigInt(Date.now()) <= lastMs);
        ms = BigInt(Date.now());
      }
    } else {
      seq = 0n;
    }
    lastMs = ms;
    return (((ms - EPOCH) << 22n) | (BigInt(workerId) << 12n) | seq).toString();
  };
}

// ---- 密码 ----

export const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_BYTES = 256;

/** 密码策略：至少 8 位，大写 / 小写 / 数字 / 符号四类中至少占两类 */
export function assertPasswordPolicy(password) {
  if (typeof password !== 'string' || [...password].length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(422, 'weak_password', `password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    throw new HttpError(422, 'weak_password', `password must be at most ${MAX_PASSWORD_BYTES} bytes`);
  }
  const classes = [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 2) {
    throw new HttpError(422, 'weak_password', 'password must mix at least two of: uppercase, lowercase, digits, symbols');
  }
}

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

/**
 * 密码哈希：scrypt(HMAC-SHA256(pepper, password), salt)。
 * pepper 是只存在服务端配置里的密钥——仅拿到数据库无法离线爆破。
 * 存储格式：scrypt$N$r$p$<salt>$<hash>（base64url）
 */
export function createPasswordHasher(pepper) {
  const prehash = (password) => createHmac('sha256', pepper).update(password, 'utf8').digest();

  async function hash(password) {
    const salt = randomBytes(16);
    const { N, r, p, keylen } = SCRYPT;
    const dk = await scrypt(prehash(password), salt, keylen, { N, r, p });
    return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${dk.toString('base64url')}`;
  }

  async function verify(password, stored) {
    const parts = String(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, N, r, p, saltB64, hashB64] = parts;
    const expected = Buffer.from(hashB64, 'base64url');
    const dk = await scrypt(prehash(password), Buffer.from(saltB64, 'base64url'), expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    return timingSafeEqual(dk, expected);
  }

  return { hash, verify };
}

// ---- 随机码 ----

/** 人工抄写用字母表：去掉易混的 0/O、1/I/L */
export const HUMAN_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function randomCode(length, alphabet = HUMAN_ALPHABET) {
  let s = '';
  for (let i = 0; i < length; i++) s += alphabet[randomInt(alphabet.length)];
  return s;
}

/** 人工输入的码归一化：去空白 / 连字符、转大写 */
export function normalizeCode(value) {
  return String(value ?? '').replace(/[\s-]/g, '').toUpperCase();
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

// ---- 邮箱 ----

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function assertEmail(value) {
  if (typeof value !== 'string' || value.length > 254 || !EMAIL_RE.test(value.trim())) {
    throw new HttpError(422, 'invalid_email', 'a valid email address is required');
  }
  return value.trim();
}

export const normalizeEmail = (email) => email.trim().toLowerCase();
