// CLI 凭证管理（设计见 DESIGN.md §7）
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.config', 'anotify');
const CRED_FILE = join(CONFIG_DIR, 'credentials.toml');
const PROFILES_DIR = join(CONFIG_DIR, 'profiles');
const PENDING_DIR = join(CONFIG_DIR, 'pending');

/** profile 名与 agent 名同一规则；default 指 credentials.toml */
const PROFILE_RE = /^[A-Za-z0-9_-]{1,64}$/;

function profileFile(profile) {
  if (!profile || profile === 'default') return CRED_FILE;
  if (!PROFILE_RE.test(profile)) throw new Error(`Invalid profile name "${profile}" (1-64 chars of [A-Za-z0-9_-])`);
  return join(PROFILES_DIR, `${profile}.toml`);
}

/**
 * 读取凭证。来源优先级：环境变量 ANOTIFY_SERVER / ANOTIFY_TOKEN > ANOTIFY_PROFILE 指定的 profile > credentials.toml。
 * 返回 { server, agent, agent_id, token }（字段可能为 undefined）。
 */
export function loadCredentials() {
  const profile = process.env.ANOTIFY_PROFILE;
  const file = profileFile(profile);
  if (profile && profile !== 'default' && !existsSync(file)) {
    throw new Error(`Profile "${profile}" not found (anotify profile list)`);
  }
  const base = existsSync(file) ? parseToml(readFileSync(file, 'utf8')) : {};
  return {
    server: process.env.ANOTIFY_SERVER ?? base.server,
    agent: base.agent,
    agent_id: base.agent_id,
    token: process.env.ANOTIFY_TOKEN ?? base.token,
  };
}

/** 要求凭证齐备，否则给出可操作的错误提示 */
export function requireCredentials() {
  const cred = loadCredentials();
  if (!cred.server || !cred.token) {
    throw new Error('No credentials found. Run first: anotify register <name> --server <url>');
  }
  return cred;
}

/** 保存凭证（0600 权限），返回文件路径；profile 缺省写 credentials.toml */
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
 * 本机全部身份：credentials.toml（profile "default"）+ profiles/*.toml，
 * 外加环境变量 ANOTIFY_TOKEN 指定的身份（profile "env"）。缺 server/token 的条目跳过。
 */
export function listProfiles() {
  const out = [];
  if (existsSync(CRED_FILE)) out.push({ profile: 'default', file: CRED_FILE, ...parseToml(readFileSync(CRED_FILE, 'utf8')) });
  if (existsSync(PROFILES_DIR)) {
    for (const f of readdirSync(PROFILES_DIR).sort()) {
      const m = /^(.+)\.toml$/.exec(f);
      if (!m || !PROFILE_RE.test(m[1]) || m[1] === 'default') continue;
      const file = join(PROFILES_DIR, f);
      out.push({ profile: m[1], file, ...parseToml(readFileSync(file, 'utf8')) });
    }
  }
  if (process.env.ANOTIFY_TOKEN && process.env.ANOTIFY_SERVER) {
    out.push({ profile: 'env', file: null, server: process.env.ANOTIFY_SERVER, token: process.env.ANOTIFY_TOKEN });
  }
  return out.filter((p) => p.server && p.token);
}

export function removeProfile(profile) {
  if (!profile || profile === 'default') throw new Error('Refusing to remove the default credentials file');
  const file = profileFile(profile);
  if (!existsSync(file)) throw new Error(`Profile "${profile}" not found`);
  rmSync(file);
  return file;
}

// ---- 待批准的认领（register / bind 的 --resume 用）----

function pendingFile(profile) {
  const name = !profile || profile === 'default' ? 'default' : profile;
  if (!PROFILE_RE.test(name)) throw new Error(`Invalid profile name "${profile}"`);
  return join(PENDING_DIR, `${name}.json`);
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
