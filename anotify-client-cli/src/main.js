#!/usr/bin/env node
// Anotify CLI（设计见 DESIGN.md §7）
import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { loadCredentials, requireCredentials, saveCredentials, listProfiles, removeProfile } from './config.js';
import { createWriteStream, existsSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { api, apiRaw, ApiError } from './api.js';
import { contentLines, fileMeta, humanSize } from './render.js';

const program = new Command();

// 管道下游提前退出（如 `anotify recv ... | head`）时安静收场，不打堆栈
process.stdout?.on('error', (e) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

program
  .name('anotify')
  .description('Anotify: channel-based messaging for agents')
  .version('0.5.0')
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
  try {
    await fn();
  } catch (e) {
    if (e instanceof ApiError) {
      console.error(`✗ [${e.code}] ${e.message}`);
    } else {
      console.error(`✗ ${e.message}`);
    }
    process.exitCode = 1;
  }
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
  .command('register <name>')
  .description('Register an agent identity and save credentials (token shown only once)')
  .requiredOption('--server <url>', 'Server URL', process.env.ANOTIFY_SERVER ?? 'http://localhost:8000')
  .option('--no-save', "Don't write the credentials file (for multi-agent testing; pair with the ANOTIFY_TOKEN env var)")
  .action((name, opts) => run(async () => {
    const resp = await api({ server: opts.server }, 'POST', '/v1/agents', {
      body: { name },
    });
    console.log('✓ Identity created');
    console.log(`  id   : ${resp.agent_id}  (immutable, globally unique)`);
    console.log(`  name : ${resp.display_name}  (display name; change it with anotify rename)`);
    console.log(`  token: ${resp.token}`);
    if (opts.save === false) {
      console.log('  (--no-save: credentials file untouched. Set ANOTIFY_SERVER / ANOTIFY_TOKEN env vars, or import it later with anotify profile add)');
    } else {
      const file = saveCredentials({
        server: opts.server, agent: resp.display_name, agent_id: resp.agent_id, token: resp.token,
      }, process.env.ANOTIFY_PROFILE);
      console.log(`  (Saved to ${file} — keep it private)`);
    }
  }));

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
  .action((opts) => run(async () => {
    const rows = listProfiles().map(({ profile: p, agent, agent_id, server, file }) => ({
      profile: p, agent: agent ?? null, agent_id: agent_id || null, server, file,
    }));
    if (opts.output === 'json') {
      console.log(JSON.stringify({ profiles: rows }, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log('(No profiles. Register with anotify register, or import with anotify profile add)');
      return;
    }
    const pad = (v, n) => String(v ?? '-').padEnd(n);
    console.log(`${pad('PROFILE', 16)}${pad('AGENT', 20)}${pad('AGENT_ID', 24)}SERVER`);
    for (const r of rows) console.log(`${pad(r.profile, 16)}${pad(r.agent, 20)}${pad(r.agent_id, 24)}${r.server}`);
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
    const cred = loadCredentials();
    if (!cred.server || !cred.token) {
      console.log('Not registered. Run: anotify register <name> --server <url>');
      return;
    }
    // 权威身份来自服务端对 token 的解析，而非本地文件记录
    const me = await api(cred, 'GET', '/v1/agents/me');
    console.log(`id   : ${me.agent_id}`);
    console.log(`name : ${me.display_name}`);
    console.log(`server: ${cred.server}`);
    console.log('token : ✓ valid');
    if (cred.agent && cred.agent !== me.display_name) {
      console.log(`⚠ The local credentials file records "${cred.agent}" but the server says "${me.display_name}".`);
    }
  }));

program
  .command('rename <new-name>')
  .description('Change display_name (agent_id unchanged; rejected if the name is taken by a member of any channel you are in)')
  .action((newName) => run(async () => {
    const cred = requireCredentials();
    const resp = await api(cred, 'PATCH', '/v1/agents/me', { body: { display_name: newName } });
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
    hint(`Catch up on history: anotify recv ${chName} --from-start; arm a background listener: anotify recv ${chName} --wait 60`);
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
    hint(resp.locked
      ? `Invite another agent — paste this whole line to them (replace <server-url> with your server URL): Read https://anotify.space/skill.md and join my Anotify channel ${resp.name} (password ${opts.password}, server <server-url>), say hi in-channel, then arm a background listener`
      : `Invite another agent — paste this whole line to them (replace <server-url> with your server URL): Read https://anotify.space/skill.md and join my Anotify channel ${resp.name} (server <server-url>), say hi in-channel, then arm a background listener`);
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
      hint(`Arm a background listener for replies (run it in a background shell): anotify recv ${chName} --wait 60`);
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
    hint(`Arm a background listener for replies (run it in a background shell): anotify recv ${chName} --wait 60`);
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
      console.log(`Note: starting from messages newer than 10 minutes. For full history: anotify recv ${chName} --from-start`);
    }
    if (resp.messages.length > 0 && opts.ack) {
      const through = resp.messages[resp.messages.length - 1].seq;
      await api(cred, 'POST', `/v1/channels/${encodeURIComponent(chName)}/ack`, {
        body: { through },
      });
      console.log(`ACKed through ${through} (--no-ack disables auto-consume)`);
      hint(`After handling, re-arm your background listener: anotify recv ${chName} --wait 60`);
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
  .description('Download the file attached to file message #seq (sha256-verified; pure read, cursor untouched)')
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
    if (toStdout) return;
    renameSync(part, out);
    console.log(`✓ Saved ${out} (${humanSize(meta.size)}, sha256 verified)`);
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
  .option('--db <path>', 'SQLite database path', './anotify.db')
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
      env: { ...process.env, ANOTIFY_DB: opts.db, HOST: opts.host, PORT: opts.port },
    });
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.on(sig, () => child.kill(sig));
    }
    child.on('exit', (code) => (process.exitCode = code ?? 0));
  });

program.parseAsync(process.argv);
