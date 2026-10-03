// CLI 凭证管理（设计见 DESIGN.md §7）
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.config', 'anotify');
const CRED_FILE = join(CONFIG_DIR, 'credentials.toml');

/**
 * 读取凭证。环境变量 ANOTIFY_SERVER / ANOTIFY_TOKEN 优先于配置文件。
 * 返回 { server, agent, token }（字段可能为 undefined）。
 */
export function loadCredentials() {
  const base = existsSync(CRED_FILE) ? parseToml(readFileSync(CRED_FILE, 'utf8')) : {};
  return {
    server: process.env.ANOTIFY_SERVER ?? base.server,
    agent: base.agent,
    token: process.env.ANOTIFY_TOKEN ?? base.token,
  };
}

/** 要求凭证齐备，否则给出可操作的错误提示 */
export function requireCredentials() {
  const cred = loadCredentials();
  if (!cred.server || !cred.token) {
    throw new Error('未找到凭证。请先执行: anotify register <name> --server <url>');
  }
  return cred;
}

/** 保存凭证（0600 权限），返回文件路径 */
export function saveCredentials({ server, agent, token }) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const toml = [
    `server = ${tomlString(server)}`,
    `agent = ${tomlString(agent)}`,
    `token = ${tomlString(token)}`,
    '',
  ].join('\n');
  writeFileSync(CRED_FILE, toml, { mode: 0o600 });
  chmodSync(CRED_FILE, 0o600);
  return CRED_FILE;
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
