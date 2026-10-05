// 命令结束时给 agent 的提示：CLI 有新版本 / 当前身份还没绑定到人类账号（设计见 DESIGN.md §7）
// 提示走 stderr，不影响 stdout 的机器可读输出；ANOTIFY_NO_HINTS=1 全部关闭。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const STATE_FILE = join(homedir(), '.config', 'anotify', 'state.json');
const UPDATE_URL = process.env.ANOTIFY_UPDATE_URL ?? 'https://registry.npmjs.org/anotify/latest';
const UPDATE_EVERY_MS = 12 * 3600 * 1000; // 最多 12 小时在后台查一次 npm
const UNOWNED_EVERY_MS = 24 * 3600 * 1000; // 未绑定提醒：每个身份每天最多一次

export const CURRENT_VERSION = createRequire(import.meta.url)('../package.json').version;

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {
    // 只读环境等：提示功能不影响命令本身
  }
}

const quiet = () => process.env.ANOTIFY_NO_HINTS === '1';

/** 语义化版本比较：a > b */
export function newer(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

/**
 * 启动时调用：只读缓存，绝不阻塞命令。缓存过期时派生一个脱离的后台进程去查 npm 并写回缓存——
 * 网络慢 / 不通也不会拖住当前命令（连接超时会让进程挂到 TCP 超时），新版本提示在下一条命令出现。
 */
export function startUpdateCheck() {
  if (quiet() || process.env.ANOTIFY_NO_UPDATE_CHECK === '1' || process.env.CI) return;
  const state = readState();
  const u = state.update ?? {};
  const fresh = u.checked_at && Date.now() - u.checked_at < UPDATE_EVERY_MS;
  const inFlight = u.checking_at && Date.now() - u.checking_at < 60_000;
  if (fresh || inFlight) return;
  writeState({ ...state, update: { ...u, checking_at: Date.now() } });
  const code = `
    const fs = require('node:fs');
    fetch(${JSON.stringify(UPDATE_URL)}, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (typeof j?.version !== 'string') return;
        let s = {};
        try { s = JSON.parse(fs.readFileSync(${JSON.stringify(STATE_FILE)}, 'utf8')); } catch {}
        s.update = { checked_at: Date.now(), latest: j.version };
        fs.writeFileSync(${JSON.stringify(STATE_FILE)}, JSON.stringify(s, null, 2));
      })
      .catch(() => {})
      .finally(() => process.exit(0));`;
  try {
    spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // 无法派生进程：跳过本次检查
  }
}

const unowned = new Map(); // server → profile 名
let unownedSuppressed = false;

/** api 层看到 x-anotify-unowned 时登记 */
export function noteUnowned(profile, server) {
  if (!unownedSuppressed) unowned.set(server, profile);
}

/** bind / whoami / profile list --check 自己就在处理或展示归属，不再重复提醒 */
export function suppressUnownedNotice() {
  unownedSuppressed = true;
}

/** 命令结束时调用：打印需要 agent 转告用户的提示 */
export async function flushNotices() {
  if (quiet()) return;
  const lines = [];
  const latest = process.env.ANOTIFY_NO_UPDATE_CHECK === '1' ? null : readState().update?.latest;
  if (latest && newer(latest, CURRENT_VERSION)) {
    lines.push(
      `Update available: anotify ${CURRENT_VERSION} → ${latest}. Tell your user an update is available. ` +
      'Run commands as npx -y anotify@latest … (a global install updates with: npm i -g anotify@latest).'
    );
  }
  if (unowned.size) {
    const state = readState();
    const seen = state.unowned_hint ?? {};
    for (const [server, profile] of unowned) {
      const key = `${server}|${profile ?? 'env'}`;
      if (seen[key] && Date.now() - seen[key] < UNOWNED_EVERY_MS) continue;
      seen[key] = Date.now();
      const who = profile ? `--profile ${profile} ` : '';
      lines.push(
        `This identity${profile ? ` (${profile})` : ''} is not linked to a human account yet. Ask your user whether to link it ` +
        `so they can watch and manage your channels on anotify.space: npx -y anotify@latest ${who}bind --no-wait`
      );
    }
    writeState({ ...state, unowned_hint: seen });
  }
  for (const l of lines) console.error(`💡 ${l}`);
}
