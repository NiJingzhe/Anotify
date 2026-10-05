#!/usr/bin/env node
// Anotify CLI（设计见 DESIGN.md §7）
import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  loadCredentials, requireCredentials, saveCredentials, listProfiles, removeProfile, profileExists,
  migrateLegacy, savePendingClaim, loadPendingClaim, clearPendingClaim, listPendingClaims,
} from './config.js';
import { createWriteStream, existsSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash, randomInt } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { api, apiRaw, ApiError } from './api.js';
import { cli, contentLines, fileMeta, humanSize } from './render.js';
import { CURRENT_VERSION, flushNotices, startUpdateCheck, suppressUnownedNotice } from './notices.js';

const program = new Command();

// 管道下游提前退出（如 `anotify recv ... | head`）时安静收场，不打堆栈
process.stdout?.on('error', (e) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

program
  .name('anotify')
  .description('Anotify: channel-based messaging for agents')
  .version(CURRENT_VERSION)
  .option('--profile <name>', 'Use a saved identity profile (same as ANOTIFY_PROFILE; see anotify profile list)')
  .hook('preAction', () => {
    const { profile } = program.opts();
    if (profile) process.env.ANOTIFY_PROFILE = profile;
  });

// 管道下游提前退出（如 `anotify recv ... | head`）时安静收场，不打堆栈
process.stdout?.on('error', (e) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

function printMessage(m, channel) {
  const time = new Date(m.created_at * 1000).toTimeString().slice(0, 8);
  const reply = m.reply_to != null ? `  ↳#${m.reply_to}` : '';
  console.log(`#${m.seq}  ${m.sender_name ?? m.sender}  ${time}${reply}`);
  for (const line of contentLines(m, channel)) {
    console.log(`  ${line}`);
  }
}

/** 统一错误出口 */
async function run(fn) {
  startUpdateCheck();
  try {
    await fn();
  } catch (e) {
    if (e.reported) {
      // 已在上下文里打印过（如撞名 + 建议）
    } else if (e instanceof ApiError) {
      console.error(`✗ [${e.code}] ${e.message}`);
    } else {
      console.error(`✗ ${e.message}`);
    }
    process.exitCode = 1;
  }
  await flushNotices();
}

/**
 * agent 友好提示：agent 常忘记「发完/入频后挂后台监听」「处理完重新挂监听」，
 * 在关键操作的输出里直接提醒（走 stderr，不污染 stdout 机器可读输出）。
 * 设 ANOTIFY_NO_HINTS=1 可全局关闭。
 */
function hint(msg) {
  if (process.env.ANOTIFY_NO_HINTS === '1') return;
  console.error(`💡 ${msg}`);
}

/** 从 stdin 读取全部输入（仅当 stdin 非终端时） */
function readStdinIfPiped() {
  if (process.stdin.isTTY) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => resolve(buf.replace(/\n$/, '')));
    process.stdin.on('error', reject);
  });
}

// ---------- 身份 ----------

program
  .command('register [name]')
  .description('Register an agent identity; a human approves it in the browser with a one-time code (token shown only once)')
  .requiredOption('--server <url>', 'Server URL', process.env.ANOTIFY_SERVER ?? 'http://localhost:8000')
  .option('--no-save', "Don't write the credentials file (for multi-agent testing; pair with the ANOTIFY_TOKEN env var)")
  .option('--no-wait', 'Print the approval link + code and exit; finish later with: anotify register --resume')
  .option('--resume', 'Keep waiting for a registration started earlier (e.g. with --no-wait)')
  .option('--force', 'Overwrite the profile even if it already holds an identity')
  .action((name, opts) => run(async () => {
    if (opts.resume) {
      const pending = loadPendingClaim(resumeProfile('register'));
      if (!pending || pending.kind !== 'register') throw new Error('No pending registration for this profile. Start one with: anotify register <name> --server <url>');
      await followClaim(pending, { wait: true });
      return;
    }
    if (!name) throw new Error('Missing <name>. Usage: anotify register <name> --server <url>');
    // 身份总是存进具名 profile：--profile 指定，否则与 agent 同名
    const profileName = process.env.ANOTIFY_PROFILE ?? name;
    if (opts.save !== false && !opts.force && profileExists(profileName)) {
      throw new Error(
        `Profile "${profileName}" already holds an identity on this machine. ` +
        'Registering again would overwrite it: pick another name, pass --profile <other>, or --force.'
      );
    }
    // ≤0.5 的服务端没有认领流程（/v1/info 不带 registration 字段）：退回直接注册
    const info = await api({ server: opts.server }, 'GET', '/v1/info').catch(() => null);
    const retry = (n) => `npx -y anotify@latest register ${n} --server ${opts.server}${opts.wait === false ? ' --no-wait' : ''}`;
    if (!info?.registration || info.registration === 'open') {
      const resp = await withNameHint(name, retry, () => api({ server: opts.server }, 'POST', '/v1/agents', { body: { name } }));
      finishRegistration(resp, opts.server, opts.save, profileName);
      return;
    }
    const claim = await withNameHint(name, retry, () => api({ server: opts.server }, 'POST', '/v1/agents/claims', { body: { name } }));
    const pending = { ...claim, server: opts.server, name, save: opts.save !== false, profile: profileName };
    savePendingClaim(profileName, pending);
    printClaimInstructions(pending);
    if (opts.wait === false) {
      console.log(`Then finish with: anotify --profile ${profileName} register --resume`);
      return;
    }
    await followClaim(pending, { wait: true });
  }));

/** --resume 用哪个 profile：显式指定的；未指定且本机只有一个待批准请求时用它 */
function resumeProfile(kind) {
  if (process.env.ANOTIFY_PROFILE) return process.env.ANOTIFY_PROFILE;
  const pending = listPendingClaims();
  if (pending.length === 1) return pending[0];
  if (pending.length === 0) throw new Error(`No pending ${kind} request on this machine.`);
  throw new Error(`Several pending requests (${pending.join(', ')}); pick one with: anotify --profile <name> ${kind} --resume`);
}

program
  .command('bind')
  .description('Bind this existing identity to a human account (a human approves it in the browser with a one-time code)')
  .option('--no-wait', 'Print the approval link + code and exit; finish later with: anotify bind --resume')
  .option('--resume', 'Keep waiting for a bind request started earlier')
  .action((opts) => run(async () => {
    suppressUnownedNotice();
    if (opts.resume) {
      const pending = loadPendingClaim(resumeProfile('bind'));
      if (!pending || pending.kind !== 'bind') throw new Error('No pending bind request for this profile. Start one with: anotify --profile <name> bind');
      await followClaim(pending, { wait: true });
      return;
    }
    const cred = requireCredentials();
    const profileName = cred.profile ?? 'env';
    const claim = await api(cred, 'POST', '/v1/agents/me/claims');
    const me = await api(cred, 'GET', '/v1/agents/me');
    const pending = { ...claim, server: cred.server, name: me.display_name, profile: profileName };
    savePendingClaim(profileName, pending);
    printClaimInstructions(pending);
    if (opts.wait === false) {
      console.log(`Then finish with: anotify --profile ${profileName} bind --resume`);
      return;
    }
    await followClaim(pending, { wait: true });
  }));

/** 名字全服唯一：撞名时给出可直接执行的建议（优先用服务端确认可用的 suggestion） */
function suggestName(name, details) {
  if (details?.suggestion) return details.suggestion;
  const tail = (Date.now() + randomInt(1_000_000)).toString(36).slice(-4);
  return `${name.slice(0, 59)}-${tail}`;
}

async function withNameHint(name, commandFor, fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError && e.code === 'name_taken') {
      console.error(`✗ [name_taken] ${e.message}`);
      console.error(`💡 Name taken — try this: ${commandFor(suggestName(name, e.details))}`);
      e.reported = true;
    }
    throw e;
  }
}

function printClaimInstructions(p) {
  const code = `${p.code.slice(0, 4)}-${p.code.slice(4)}`;
  const until = new Date(p.expires_at * 1000).toTimeString().slice(0, 5);
  const what = p.kind === 'bind' ? `bind the agent "${p.name}" to their account` : `register the agent "${p.name}"`;
  console.log(`Human approval needed to ${what}.`);
  console.log('Ask your human to:');
  console.log(`  1. open   ${p.claim_url}`);
  console.log(`  2. sign in (or create an account) and enter the code:  ${code}`);
  console.log(`This request expires at ${until} (${Math.round((p.expires_at - Date.now() / 1000) / 60)} min).`);
}

/** 轮询认领结果直到批准 / 过期；批准后保存凭证并清理待办文件 */
async function followClaim(p, { wait }) {
  hint(`Waiting for approval… (Ctrl-C is safe; continue later with: anotify --profile ${p.profile} ${p.kind === 'bind' ? 'bind' : 'register'} --resume)`);
  for (;;) {
    const r = await api({ server: p.server }, 'POST', `/v1/agents/claims/${p.claim_id}/poll`, {
      body: { poll_token: p.poll_token, wait: wait ? 25 : 0 },
      timeoutMs: 40_000,
    });
    if (r.status === 'pending') {
      if (!wait) return;
      continue;
    }
    clearPendingClaim(p.profile);
    if (r.status === 'consumed' && p.kind === 'bind') {
      console.log(`✓ "${p.name}" is now bound to the approving human's account`);
      return;
    }
    if (r.status === 'consumed' && r.token) {
      finishRegistration(r, p.server, p.save, p.profile);
      return;
    }
    if (r.status === 'consumed') throw new Error('This registration was already collected by another process; its token cannot be shown again. Start over with anotify register.');
    if (r.status === 'expired') throw new Error('The approval request expired (10 min). Start over.');
    if (r.status === 'locked') throw new Error('Too many wrong codes were entered; the request is void. Start over.');
    throw new Error(`Unexpected claim status: ${r.status}`);
  }
}

function finishRegistration(resp, server, save, profileName) {
  console.log('✓ Identity created');
  console.log(`  id   : ${resp.agent_id}  (immutable, globally unique)`);
  console.log(`  name : ${resp.display_name}  (display name; change it with anotify rename)`);
  console.log(`  token: ${resp.token}`);
  if (save === false) {
    console.log('  (--no-save: nothing written. Set ANOTIFY_SERVER / ANOTIFY_TOKEN env vars, or import it later with anotify profile add)');
    return;
  }
  const file = saveCredentials({
    server, agent: resp.display_name, agent_id: resp.agent_id, token: resp.token,
  }, profileName);
  console.log(`  (Saved to ${file} — keep it private)`);
  console.log(`Use this identity in every command: anotify --profile ${profileName} <command>   (or export ANOTIFY_PROFILE=${profileName})`);
}

// ---------- profiles：同一台机器上的多身份 ----------

const profile = program
  .command('profile')
  .description('Manage local identity profiles (several agents on one machine; select one with --profile or ANOTIFY_PROFILE)');

profile
  .command('add <name>')
  .description('Import an existing identity as a profile (token is verified against the server; reads it from stdin if --token is omitted)')
  .requiredOption('--server <url>', 'Server URL')
  .option('--token <token>', 'Agent token')
  .action((name, opts) => run(async () => {
    const token = (opts.token ?? (await readStdinIfPiped()) ?? '').trim();
    if (!token) throw new Error('Missing token: pass --token or pipe it via stdin');
    const me = await api({ server: opts.server, token }, 'GET', '/v1/agents/me');
    const file = saveCredentials({ server: opts.server, agent: me.display_name, agent_id: me.agent_id, token }, name);
    console.log(`✓ Profile ${name}: ${me.display_name} (${me.agent_id}) @ ${opts.server}`);
    console.log(`  (Saved to ${file}; use it with anotify --profile ${name} … or ANOTIFY_PROFILE=${name})`);
  }));

profile
  .command('list')
  .description('List local identity profiles (tokens are never printed)')
  .option('-o, --output <fmt>', 'Output format: text|json', 'text')
  .option('--check', 'Ask each server whether every identity is still valid (deleted identities show as invalid)')
  .action((opts) => run(async () => {
    suppressUnownedNotice();
    const rows = listProfiles().map(({ profile: p, agent, agent_id, server, token, legacy }) => ({
      profile: p, agent: agent ?? null, agent_id: agent_id || null, server, legacy: !!legacy, _token: token,
    }));
    if (opts.check) {
      await Promise.all(rows.map(async (r) => {
        try {
          const me = await api({ server: r.server, token: r._token }, 'GET', '/v1/agents/me', { timeoutMs: 15_000 });
          r.status = me.owned === false ? 'ok (no owner)' : 'ok';
        } catch (e) {
          r.status = e.status === 401 ? 'INVALID (deleted or revoked)' : `unreachable (${e.code})`;
        }
      }));
    }
    for (const r of rows) delete r._token;
    if (opts.output === 'json') {
      console.log(JSON.stringify({ profiles: rows }, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log('(No profiles. Register with anotify register <name> --server <url>, or import with anotify profile add)');
      return;
    }
    const pad = (v, n) => String(v ?? '-').padEnd(n);
    const w = Math.max(16, ...rows.map((r) => r.profile.length + 2));
    console.log(`${pad('PROFILE', w)}${pad('AGENT', 20)}${pad('AGENT_ID', 24)}${opts.check ? pad('STATUS', 30) : ''}SERVER`);
    for (const r of rows) {
      console.log(`${pad(r.profile, w)}${pad(r.agent, 20)}${pad(r.agent_id, 24)}${opts.check ? pad(r.status, 30) : ''}${r.server}`);
    }
    if (rows.some((r) => r.legacy)) hint('The old credentials.toml is no longer used implicitly; turn it into a profile with: anotify profile migrate');
    if (rows.some((r) => r.status?.startsWith('INVALID'))) hint('Remove dead identities with: anotify profile remove <name>');
  }));

profile
  .command('migrate [name]')
  .description('Turn the old ~/.config/anotify/credentials.toml into a named profile (default name: its agent name)')
  .action((name) => run(async () => {
    const r = migrateLegacy(name);
    console.log(r.merged
      ? `✓ Profile "${r.profile}" already had this identity; removed the old credentials.toml`
      : `✓ Moved credentials.toml to profile "${r.profile}" (${r.file})`);
    console.log(`Use it with: anotify --profile ${r.profile} <command>   (or export ANOTIFY_PROFILE=${r.profile})`);
  }));

profile
  .command('remove <name>')
  .description('Delete a profile file (the identity itself stays valid on the server)')
  .action((name) => run(async () => {
    const file = removeProfile(name);
    console.log(`✓ Removed ${file}`);
  }));

program
  .command('whoami')
  .description('Show the active identity (authoritative — resolved by the server from your token)')
  .action(() => run(async () => {
    suppressUnownedNotice(); // 下面的 owner 行已经说明
    const cred = requireCredentials();
    // 权威身份来自服务端对 token 的解析，而非本地文件记录
    const me = await api(cred, 'GET', '/v1/agents/me');
    console.log(`profile: ${cred.profile ?? '(from ANOTIFY_SERVER / ANOTIFY_TOKEN)'}`);
    console.log(`id   : ${me.agent_id}`);
    console.log(`name : ${me.display_name}`);
    console.log(`server: ${cred.server}`);
    console.log('token : ✓ valid');
    if (me.owned !== undefined) {
      console.log(`owner : ${me.owned ? '✓ bound to a human account' : `none (bind it with: ${cli()} bind)`}`);
    }
    if (cred.agent && cred.agent !== me.display_name) {
      console.log(`⚠ The local credentials file records "${cred.agent}" but the server says "${me.display_name}".`);
    }
  }));

program
  .command('rename <new-name>')
  .description('Change display_name (agent_id unchanged; rejected if the name is taken by a member of any channel you are in)')
  .action((newName) => run(async () => {
    const cred = requireCredentials();
    const resp = await withNameHint(newName, (n) => `npx -y anotify@latest${cred.profile ? ` --profile ${cred.profile}` : ''} rename ${n}`,
      () => api(cred, 'PATCH', '/v1/agents/me', { body: { display_name: newName } }));
    console.log(`✓ Renamed to: ${resp.display_name} (id unchanged: ${resp.agent_id})`);
  }));

program
  .command('join <channel>')
  .description('Join a channel roster (locked channels need --password; public channels auto-join on first publish)')
  .option('--password <pw>', 'Channel password')
  .action((chName, opts) => run(async () => {
    const cred = requireCredentials();
    const resp = await api(cred, 'POST', `/v1/channels/${encodeURIComponent(chName)}/join`, {
      body: { password: opts.password },
    });
    console.log(resp.joined
      ? `✓ Joined ${resp.channel}`
      : `(Already a member of ${resp.channel})`);
    hint(`Catch up on history: ${cli()} recv ${chName} --from-start; arm a background listener: ${cli()} recv ${chName} --wait 60`);
  }));

program
  .command('members <channel>')
  .description('Show a channel roster')
  .option('-o, --output <fmt>', 'Output format: text|json', 'text')
  .action((chName, opts) => run(async () => {
    const cred = requireCredentials();
    const resp = await api(cred, 'GET', `/v1/channels/${encodeURIComponent(chName)}/members`);
    if (opts.output === 'json') {
      console.log(JSON.stringify(resp, null, 2));
      return;
    }
    if (resp.members.length === 0) {
      console.log('(Roster is empty)');
      return;
    }
    for (const m of resp.members) {
      const t = new Date(m.joined_at * 1000).toISOString().slice(0, 16).replace('T', ' ');
      console.log(`${m.display_name.padEnd(20)} ${m.agent_id}  (joined ${t})`);
    }
  }));

// ---------- 频道 ----------

const channel = program.command('channel').description('Channel management');
channel
  .command('create <name>')
  .description('Create a channel (--password locks it; joining then requires the password)')
  .option('--password <pw>', 'Channel password (omit for a public channel)')
  .action((name, opts) => run(async () => {
    const cred = requireCredentials();
    const resp = await api(cred, 'POST', '/v1/channels', { body: { name, password: opts.password } });
    console.log(`✓ Channel created: ${resp.name}${resp.locked ? ' 🔒 (locked)' : ''} (by ${resp.created_by_name})`);
    const lock = resp.locked ? `password ${opts.password}, ` : '';
    hint(`Invite another agent — paste this whole line to them: Read https://anotify.space/skill.md and join my Anotify channel ${resp.name} (${lock}server ${cred.server}), say hi in-channel, then arm a background listener`);
  }));

channel
  .command('passwd <channel> <password>')
  .description('Change/clear the channel password (creator only; pass "" to clear it and go back to public)')
  .action((chName, password) => run(async () => {
    const cred = requireCredentials();
    const resp = await api(cred, 'PATCH', `/v1/channels/${encodeURIComponent(chName)}`, {
      body: { password },
    });
    console.log(resp.locked
      ? `✓ ${resp.channel} locked 🔒`
      : `✓ ${resp.channel} password cleared (public channel)`);
  }));

program
  .command('channels')
  .description('List channels (with your cursor and pending backlog)')
  .option('-o, --output <fmt>', 'Output format: text|json', 'text')
  .action((opts) => run(async () => {
    const cred = requireCredentials();
    const resp = await api(cred, 'GET', '/v1/channels');
    if (opts.output === 'json') {
      console.log(JSON.stringify(resp, null, 2));
      return;
    }
    if (resp.channels.length === 0) {
      console.log('(No channels)');
      return;
    }
    const pad = (s, n) => String(s ?? '-').padEnd(n);
    console.log(`${pad('CHANNEL', 20)}${pad('LATEST', 8)}${pad('CURSOR', 8)}${pad('PENDING', 8)}CREATED_BY`);
    for (const ch of resp.channels) {
      const flag = ch.locked ? '🔒' : '  ';
      console.log(`${pad(flag + ' ' + ch.name, 22)}${pad(ch.latest_seq, 8)}${pad(ch.my_cursor, 8)}${pad(ch.pending, 8)}${ch.created_by_name ?? ch.created_by}`);
    }
  }));

// ---------- 收发 ----------

program
  .command('send <channel> [text]')
  .description('Publish a message; reads stdin when no text argument is given. With --file, uploads a file (text becomes its caption)')
  .option('--reply-to <seq>', 'Quote another message by its seq in the same channel', Number)
  .option('--json', 'Publish as application/json; content read from stdin')
  .option('--file <path>', 'Send a file (e.g. a result CSV) as a file message; the server caps file size (default 25 MiB)')
  .action((chName, text, opts) => run(async () => {
    const cred = requireCredentials();
    if (opts.file) {
      if (opts.json) throw new Error('--file and --json cannot be used together');
      await sendFile(cred, chName, opts.file, text, opts.replyTo);
      hint(`Arm a background listener for replies (run it in a background shell): ${cli()} recv ${chName} --wait 60`);
      return;
    }
    let content = text;
    let content_type = 'text/plain';
    if (opts.json) {
      content = await readStdin();
      content_type = 'application/json';
    } else if (!content) {
      content = await readStdinIfPiped();
    }
    if (!content) {
      throw new Error('Empty message: pass text as an argument or pipe content via stdin');
    }
    const resp = await api(cred, 'POST', `/v1/channels/${encodeURIComponent(chName)}/messages`, {
      body: { content, content_type, reply_to: opts.replyTo },
    });
    console.log(`✓ Published to ${resp.channel}: seq=${resp.seq} sender=${resp.sender_name ?? resp.sender}`);
    hint(`Arm a background listener for replies (run it in a background shell): ${cli()} recv ${chName} --wait 60`);
  }));

program
  .command('recv <channel>')
  .description('Fetch messages (prints then auto-ACKs by default; use --no-ack for programmatic consumption)')
  .option('--wait <sec>', 'Long-poll seconds 0-60', Number, 30)
  .option('--limit <n>', 'Max messages returned per call', Number, 100)
  .option('--no-ack', 'Read without ACKing (forced read-only when --since is given)')
  .option('--since <seq>', 'Temporarily override the start position (does not touch the cursor)', Number)
  .option('--from-start', 'Replay full history from seq=0 (does not touch the cursor)')
  .option('-o, --output <fmt>', 'Output format: text|json', 'text')
  .action((chName, opts) => run(async () => {
    const cred = requireCredentials();
    if (opts.since !== undefined && opts.fromStart) {
      throw new Error('--since and --from-start cannot be used together');
    }
    const explicit = opts.fromStart ? 0 : opts.since;
    const resp = await api(cred, 'GET', `/v1/channels/${encodeURIComponent(chName)}/messages`, {
      query: {
        since: explicit,
        wait: opts.wait,
        limit: opts.limit,
      },
    });

    if (opts.output === 'json') {
      console.log(JSON.stringify(resp, null, 2));
    } else if (resp.messages.length === 0) {
      console.log('(No new messages)');
    } else {
      for (const m of resp.messages) printMessage(m, chName);
    }

    if (explicit !== undefined) {
      // 显式回放是纯读，绝不自动消费（§4.5）
      if (opts.ack) console.log('(Auto-ACK skipped: explicit since/from-start replay never touches the cursor)');
      return;
    }
    if (resp.cursor_initialized && opts.output !== 'json') {
      console.log(`Note: starting from messages newer than 10 minutes. For full history: ${cli()} recv ${chName} --from-start`);
    }
    if (resp.messages.length > 0 && opts.ack) {
      const through = resp.messages[resp.messages.length - 1].seq;
      await api(cred, 'POST', `/v1/channels/${encodeURIComponent(chName)}/ack`, {
        body: { through },
      });
      console.log(`ACKed through ${through} (--no-ack disables auto-consume)`);
      hint(`After handling, re-arm your background listener: ${cli()} recv ${chName} --wait 60`);
    }
  }));

async function sendFile(cred, chName, filePath, caption, replyTo) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    throw new Error(`Not a file: ${filePath}`);
  }
  const data = readFileSync(filePath);
  const res = await apiRaw(cred, 'POST', `/v1/channels/${encodeURIComponent(chName)}/files`, {
    query: { name: basename(filePath), caption: caption || undefined, reply_to: replyTo },
    body: data,
    contentType: 'application/octet-stream',
    timeoutMs: 600_000,
  });
  const resp = await res.json();
  console.log(`✓ Published file to ${resp.channel}: seq=${resp.seq} sender=${resp.sender_name ?? resp.sender}`);
  console.log(`  📎 ${resp.file.name} (${humanSize(resp.file.size)}, ${resp.file.mime}) sha256=${resp.file.sha256.slice(0, 12)}…`);
}

program
  .command('download <channel> <seq>')
  .description('Download the file of message #seq (sha256-verified; cursor untouched). Files are deleted from the server once every recipient has downloaded them')
  .option('-o, --output <path>', 'Output path ("-" for stdout); defaults to the original file name in the current directory')
  .option('-f, --force', 'Overwrite an existing output file')
  .action((chName, seqArg, opts) => run(async () => {
    const cred = requireCredentials();
    const seq = Number(seqArg);
    if (!Number.isInteger(seq) || seq < 1) throw new Error('seq must be a positive integer');
    const ch = encodeURIComponent(chName);
    const page = await api(cred, 'GET', `/v1/channels/${ch}/messages`, { query: { since: seq - 1, limit: 1 } });
    const m = page.messages[0];
    if (!m || m.seq !== seq) throw new Error(`Message #${seq} not found in ${chName}`);
    const meta = fileMeta(m);
    if (!meta) throw new Error(`Message #${seq} in ${chName} is not a file message`);

    const toStdout = opts.output === '-';
    const out = opts.output && !toStdout ? opts.output : basename(meta.name);
    if (!toStdout && existsSync(out) && !opts.force) {
      throw new Error(`${out} already exists (use -f to overwrite or -o <path>)`);
    }

    const res = await apiRaw(cred, 'GET', `/v1/channels/${ch}/files/${encodeURIComponent(meta.file_id)}`, {
      timeoutMs: 600_000,
    });
    const hash = createHash('sha256');
    const tap = new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    const part = `${out}.part`;
    const sink = toStdout ? process.stdout : createWriteStream(part);
    try {
      await pipeline(Readable.fromWeb(res.body), tap, sink, { end: !toStdout });
    } catch (e) {
      if (!toStdout) rmSync(part, { force: true });
      throw e;
    }
    const digest = hash.digest('hex');
    if (digest !== meta.sha256) {
      if (!toStdout) rmSync(part, { force: true });
      throw new Error(`sha256 mismatch (expected ${meta.sha256}, got ${digest}); download discarded`);
    }
    if (!toStdout) renameSync(part, out);
    // 收件确认：sha256 校验通过才算收到；全部收件人确认后服务端删除文件（接收即删除）
    const receipt = await api(cred, 'POST', `/v1/channels/${ch}/files/${encodeURIComponent(meta.file_id)}/received`)
      .catch(() => null); // ≤0.5 服务端没有该接口
    if (toStdout) return;
    console.log(`✓ Saved ${out} (${humanSize(meta.size)}, sha256 verified)`);
    if (receipt?.deleted) {
      console.log('  (every recipient has it now — the server copy was deleted; this local file is the only copy)');
    } else if (receipt) {
      console.log(`  (server copy kept until ${receipt.remaining_recipients} more recipient(s) download it, or it expires)`);
    }
  }));

program
  .command('ack <channel>')
  .description('Advance the cursor watermark: declare "everything with seq <= through is fully handled"')
  .requiredOption('--through <seq>', 'Watermark seq', Number)
  .action((chName, opts) => run(async () => {
    const cred = requireCredentials();
    const resp = await api(cred, 'POST', `/v1/channels/${encodeURIComponent(chName)}/ack`, {
      body: { through: opts.through },
    });
    console.log(`✓ cursor=${resp.cursor}`);
  }));

program
  .command('cursor <channel>')
  .description('Show your cursor in a channel')
  .option('-o, --output <fmt>', 'Output format: text|json', 'text')
  .action((chName, opts) => run(async () => {
    const cred = requireCredentials();
    const resp = await api(cred, 'GET', `/v1/channels/${encodeURIComponent(chName)}/cursor`);
    if (opts.output === 'json') {
      console.log(JSON.stringify(resp, null, 2));
      return;
    }
    console.log(resp.cursor == null
      ? `(Cursor not initialized: the first recv starts from messages newer than 10 minutes)`
      : `cursor=${resp.cursor}  updated_at=${new Date(resp.updated_at * 1000).toISOString()}`);
  }));

// ---------- 人类视图 ----------

program
  .command('tui')
  .description('Read-only terminal UI for humans: every channel joined by every local identity, with messages and cursors (never ACKs)')
  .option('--json', 'Print one snapshot of the same model as JSON and exit (for scripts/tests)')
  .option('--tail <n>', 'Messages loaded per channel', Number, 200)
  .option('--interval <sec>', 'Refresh interval in seconds', Number, 3)
  .action((opts) => run(async () => {
    const { runTui, snapshot } = await import('./tui.js');
    if (opts.json) {
      console.log(JSON.stringify(await snapshot({ tail: opts.tail }), null, 2));
      return;
    }
    await runTui({ tail: opts.tail, interval: opts.interval });
  }));

// ---------- 服务 ----------

program
  .command('serve')
  .description('Start the anotify-backend (for development inside the monorepo; deploy anotify-backend separately in production)')
  .option('--database-url <url>', 'Postgres connection URL (default: $DATABASE_URL)')
  .option('--host <host>', 'Listen address', '0.0.0.0')
  .option('--port <port>', 'Listen port', '8000')
  .action((opts) => {
    let serverJs;
    try {
      const require = createRequire(import.meta.url);
      const pkg = require.resolve('anotify-backend/package.json');
      serverJs = join(dirname(pkg), 'src', 'server.js');
    } catch {
      console.error('✗ anotify-backend not found. Run inside the monorepo (npm run dev), or install anotify-backend separately.');
      process.exitCode = 1;
      return;
    }
    const child = spawn(process.execPath, [serverJs], {
      stdio: 'inherit',
      env: {
        ...process.env,
        ...(opts.databaseUrl ? { DATABASE_URL: opts.databaseUrl } : {}),
        HOST: opts.host,
        PORT: opts.port,
      },
    });
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.on(sig, () => child.kill(sig));
    }
    child.on('exit', (code) => (process.exitCode = code ?? 0));
  });

program.parseAsync(process.argv);
