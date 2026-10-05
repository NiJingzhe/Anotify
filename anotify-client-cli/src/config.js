// CLI 凭证管理：具名 profile，无默认身份（设计见 DESIGN.md §7 / §13）
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.config', 'anotify');
const CRED_FILE = join(CONFIG_DIR, 'credentials.toml');
const PROFILES_DIR = join(CONFIG_DIR, 'profiles');
const PENDING_DIR = join(CONFIG_DIR, 'pending');

/** profile 名与 agent 名同一规则 */
const PROFILE_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * v0.7 起没有「默认身份」：每条用到身份的命令都必须显式指定 profile（--profile / ANOTIFY_PROFILE），
 * 或显式给出 ANOTIFY_SERVER + ANOTIFY_TOKEN。旧版的 credentials.toml 只读保留，用 `anotify profile migrate` 转成具名 profile。
 */
export const LEGACY_FILE = CRED_FILE;

function profileFile(profile) {
  if (typeof profile !== 'string' || !PROFILE_RE.test(profile)) {
    throw new Error(`Invalid profile name "${profile}" (1-64 chars of [A-Za-z0-9_-])`);
  }
  return join(PROFILES_DIR, `${profile}.toml`);
}

export function profileExists(profile) {
  return existsSync(profileFile(profile));
}

export function readProfile(profile) {
  return parseToml(readFileSync(profileFile(profile), 'utf8'));
}

export function readLegacy() {
  return existsSync(CRED_FILE) ? parseToml(readFileSync(CRED_FILE, 'utf8')) : null;
}

/** 没选身份时的可操作提示：列出本机 profile，并提示迁移旧 credentials.toml */
export function noProfileMessage() {
  const names = listProfiles().filter((p) => !p.legacy).map((p) => p.profile);
  const lines = ['No identity selected: pass --profile <name> (or set ANOTIFY_PROFILE=<name>).'];
  lines.push(names.length
    ? `  Identities on this machine: ${names.join(', ')}`
    : '  No identities on this machine yet. Create one with: anotify register <name> --server <url>');
  const legacy = readLegacy();
  if (legacy?.token) {
    lines.push(`  Found the old ~/.config/anotify/credentials.toml ("${legacy.agent ?? 'unknown'}"). Turn it into a profile with: anotify profile migrate`);
  }
  return lines.join('\n');
}

/**
 * 读取当前选中的身份。只认显式指定：
 *   ANOTIFY_PROFILE（--profile 会设置它）→ profiles/<name>.toml，ANOTIFY_SERVER / ANOTIFY_TOKEN 若同时给出则覆盖对应字段；
 *   未指定 profile 时，只有 ANOTIFY_SERVER + ANOTIFY_TOKEN 都给出才可用。
 * 返回 { server, agent, agent_id, token, profile }。
 */
export function loadCredentials() {
  const profile = process.env.ANOTIFY_PROFILE;
  const envServer = process.env.ANOTIFY_SERVER;
  const envToken = process.env.ANOTIFY_TOKEN;
  if (!profile) {
    if (envServer && envToken) return { server: envServer, token: envToken, profile: null };
    throw new Error(noProfileMessage());
  }
  if (!profileExists(profile)) {
    const names = listProfiles().filter((p) => !p.legacy).map((p) => p.profile);
    throw new Error(`Profile "${profile}" not found.${names.length ? ` Identities on this machine: ${names.join(', ')}` : ''}`);
  }
  const base = readProfile(profile);
  return {
    server: envServer ?? base.server,
    agent: base.agent,
    agent_id: base.agent_id,
    token: envToken ?? base.token,
    profile,
  };
}

/** 要求凭证齐备，否则给出可操作的错误提示 */
export function requireCredentials() {
  const cred = loadCredentials();
  if (!cred.server || !cred.token) {
    throw new Error(`Profile "${cred.profile}" is incomplete (missing server or token); re-import it with anotify profile add`);
  }
  return cred;
}

/** 保存凭证到具名 profile（0600 权限），返回文件路径 */
export function saveCredentials({ server, agent, agent_id, token }, profile) {
  const file = profileFile(profile);
  mkdirSync(dirname(file), { recursive: true });
  const toml = [
    `server = ${tomlString(server)}`,
    `agent = ${tomlString(agent)}`,
    `agent_id = ${tomlString(agent_id ?? '')}`,
    `token = ${tomlString(token)}`,
    '',
  ].join('\n');
  writeFileSync(file, toml, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

/**
 * 本机全部身份：profiles/*.toml；旧版 credentials.toml 若还在，作为 legacy 条目列出（只读，供 tui 查看与提示迁移）；
 * 外加环境变量给出的身份（profile "env"）。缺 server/token 的条目跳过。
 */
export function listProfiles() {
  const out = [];
  if (existsSync(PROFILES_DIR)) {
    for (const f of readdirSync(PROFILES_DIR).sort()) {
      const m = /^(.+)\.toml$/.exec(f);
      if (!m || !PROFILE_RE.test(m[1])) continue;
      const file = join(PROFILES_DIR, f);
      out.push({ profile: m[1], file, ...parseToml(readFileSync(file, 'utf8')) });
    }
  }
  const legacy = readLegacy();
  if (legacy) out.push({ profile: '(legacy credentials.toml)', file: CRED_FILE, legacy: true, ...legacy });
  if (process.env.ANOTIFY_TOKEN && process.env.ANOTIFY_SERVER) {
    out.push({ profile: 'env', file: null, server: process.env.ANOTIFY_SERVER, token: process.env.ANOTIFY_TOKEN });
  }
  return out.filter((p) => p.server && p.token);
}

/**
 * 把旧版 credentials.toml 转成具名 profile（默认用其中记录的 agent 名）。
 * 目标 profile 已存在：同一 token → 只删旧文件；不同 token → 拒绝，要求换个名字。
 */
export function migrateLegacy(name) {
  const legacy = readLegacy();
  if (!legacy?.token) throw new Error('Nothing to migrate: ~/.config/anotify/credentials.toml not found');
  const target = name ?? legacy.agent;
  if (!target || !PROFILE_RE.test(target)) {
    throw new Error('Cannot derive a profile name from credentials.toml; pass one: anotify profile migrate <name>');
  }
  if (profileExists(target)) {
    if (readProfile(target).token !== legacy.token) {
      throw new Error(`Profile "${target}" already exists with a different identity; pick another name: anotify profile migrate <name>`);
    }
    rmSync(CRED_FILE);
    return { profile: target, file: profileFile(target), merged: true };
  }
  const file = saveCredentials(legacy, target);
  if (readProfile(target).token !== legacy.token) throw new Error(`Failed to write ${file}; credentials.toml left untouched`);
  rmSync(CRED_FILE);
  return { profile: target, file, merged: false };
}

export function removeProfile(profile) {
  const file = profileFile(profile);
  if (!existsSync(file)) throw new Error(`Profile "${profile}" not found`);
  rmSync(file);
  return file;
}

// ---- 待批准的认领（register / bind 的 --resume 用）----

function pendingFile(profile) {
  if (!PROFILE_RE.test(profile ?? '')) throw new Error(`Invalid profile name "${profile}"`);
  return join(PENDING_DIR, `${profile}.json`);
}

/** 所有等待批准中的认领（register --resume 未指定 profile 时，唯一的那个即可直接续上） */
export function listPendingClaims() {
  if (!existsSync(PENDING_DIR)) return [];
  return readdirSync(PENDING_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
}

export function savePendingClaim(profile, claim) {
  const file = pendingFile(profile);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(claim, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function loadPendingClaim(profile) {
  const file = pendingFile(profile);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function clearPendingClaim(profile) {
  rmSync(pendingFile(profile), { force: true });
}

function tomlString(s) {
  return JSON.stringify(String(s)); // JSON 字符串转义与 TOML 基本字符串兼容
}

/** 极简扁平 TOML 解析：仅支持 `key = "value"` 行与 # 注释 */
function parseToml(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*"(.*)"\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
