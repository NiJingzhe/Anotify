// 常驻唤醒 daemon：多频道监听 → 把唤醒交给任意外部命令（--wake-command）。
// 设计边界（SKILL.md「Wake daemon」）：
//   - daemon 绝不替 agent ack；服务端游标仍是「已处理」的唯一真相源，at-least-once 完整保留。
//   - 防风暴最小不变集（常驻监听 × 游标滞后 ack 的结构性矛盾）：
//       单飞锁（同 seq 不二次注入，状态=一个整数）+ 拦截后睡眠（防热循环）+ 看门狗（处理停滞后补注入）。
//   - adapter 是一条命令：daemon 用环境变量传上下文，退出码即投递协议（0 = 已投递）。
import { exec, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, appendFileSync, readFileSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { api } from './api.js';
import { sleep, listenForWake, inboxFileFor } from './wake.js';

const WAKE_RETRY_DELAYS_MS = [2000, 5000, 10000, 20000, 20000]; // 注入失败短重试，总计约 60s
const INTERCEPT_SLEEP_MS = 5000;                                // 单飞拦截后的礼貌间隔（消息仍高于游标会秒级重抓）
const COMMAND_TIMEOUT_MS = 120_000;

function daemonDir() {
  return join(homedir(), '.anotify', 'daemon');
}

function baseName(profile, channels) {
  const h = createHash('sha256').update(`${profile ?? 'env'}|${[...channels].sort().join(',')}`).digest('hex').slice(0, 10);
  return `${String(profile ?? 'env').replace(/[^A-Za-z0-9_.-]/g, '_')}-${h}`;
}

function pathsFor(base) {
  const dir = daemonDir();
  return { dir, pid: join(dir, `${base}.pid`), state: join(dir, `${base}.state`), log: join(dir, `${base}.log`) };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function registerDaemonCommands(program, { requireCredentials, run }) {
  const collect = (v, prev) => { prev.push(v); return prev; };

  const daemon = program.command('daemon').description('Standing wake daemon: listen on channels, hand wakes to an external command');

  const sharedOpts = (cmd) => cmd
    .option('--profile <name>', 'Identity profile to run as (persisted into installed services; overrides the global --profile)')
    .requiredOption('--channel <name>', 'Channel to listen on (repeatable)', collect, [])
    .requiredOption('--wake-command <cmd>', 'Command to run on wake (env: ANOTIFY_CHANNEL/MAX_SEQ/COUNT/INBOX/WAKE_LINE/PROFILE; exit 0 = delivered)')
    .option('--state-dir <dir>', 'Directory for pid/state/log files', join(homedir(), '.anotify', 'daemon'))
    .option('--wake-retry-secs <n>', 'Keep retrying a failing wake command for this long', Number, 60)
    .option('--watchdog-secs <n>', 'Re-inject if the cursor lags the last wake this long (0 disables)', Number, 600);

  const buildStartArgs = (o) => {
    // 返回 { raw, quoted }：raw 给 launchd（逐元素直传 argv，绝不能带 shell 引号）；
    // quoted 给 systemd ExecStart / schtasks /TR（过 shell，需要引号）。
    const q = (s) => (process.platform === 'win32' ? `\"${String(s).replace(/"/g, '\\"')}\"` : JSON.stringify(String(s)));
    const raw = [];
    const profile = o.profile ?? program.opts().profile; // --profile 必须随单元持久化，否则服务环境里无身份可载
    if (profile) raw.push('--profile', String(profile));
    raw.push('daemon', 'start');
    for (const c of o.channel) raw.push('--channel', String(c));
    raw.push('--wake-command', String(o.wakeCommand));
    if (o.stateDir) raw.push('--state-dir', String(o.stateDir));
    if (o.wakeRetrySecs !== 60) raw.push('--wake-retry-secs', String(o.wakeRetrySecs));
    if (o.watchdogSecs !== 600) raw.push('--watchdog-secs', String(o.watchdogSecs));
    return { raw, quoted: raw.map((a) => /^[-A-Za-z0-9_@:\\/=.]+$/.test(a) ? a : q(a)) };
  };

  const findPids = (stateDir, profile) => (existsSync(stateDir) ? readdirSync(stateDir) : []).filter((f) => f.endsWith('.pid'))
    .filter((f) => !profile || f.startsWith(`${String(profile).replace(/[^A-Za-z0-9_.-]/g, '_')}-`))
    .map((f) => join(stateDir, f));

  const start = daemon
    .command('start')
    .description('Run the wake daemon in the foreground (keep it alive with daemon install / systemd / launchd / Task Scheduler)');
  sharedOpts(start)
    .action((opts) => run(() => runDaemon(mergeOpts(opts, { requireCredentials }))));

  sharedOpts(daemon.command('install')
    .description('Install as a platform service: systemd --user (linux) / launchd (darwin) / Task Scheduler (win32), then start it'))
    .action((opts) => run(async () => { await installDaemon(mergeOpts(opts, { requireCredentials })); }));

  daemon.command('status')
    .description('Show daemons on this machine')
    .option('--profile <name>', 'Only show daemons of this profile')
    .option('--state-dir <dir>', 'Directory for pid/state/log files', join(homedir(), '.anotify', 'daemon'))
    .action((opts) => run(async () => {
      const files = findPids(opts.stateDir, opts.profile);
      if (!files.length) { console.log('(no daemons installed on this machine)'); return; }
      for (const f of files) {
        let meta; try { meta = JSON.parse(readFileSync(f, 'utf8')); } catch { continue; }
        const running = alive(meta.pid);
        const base = f.replace(/\.pid$/, '');
        let state = {}; try { state = JSON.parse(readFileSync(`${base}.state`, 'utf8')); } catch {}
        const pos = running ? 'running' : 'stopped(Stale pid file)';
        console.log(`${running ? '●' : '○'} ${pos}  pid=${meta.pid}  profile=${meta.profile ?? 'env'}`);
        console.log(`  channels: ${meta.channels?.join(', ')}`);
        for (const [ch, s] of Object.entries(state)) console.log(`  ${ch}: last_wake_seq=${s.seq}`);
        console.log(`  log: ${base}.log`);
      }
    }));

  daemon.command('stop')
    .description('Stop running daemons on this machine')
    .option('--profile <name>', 'Only stop daemons of this profile')
    .option('--state-dir <dir>', 'Directory for pid/state/log files', join(homedir(), '.anotify', 'daemon'))
    .action((opts) => run(async () => {
      const files = findPids(opts.stateDir, opts.profile);
      if (!files.length) { console.log('(no running daemons found)'); return; }
      for (const f of files) {
        let meta; try { meta = JSON.parse(readFileSync(f, 'utf8')); } catch { continue; }
        if (alive(meta.pid)) {
          process.kill(meta.pid, 'SIGTERM');
          for (let i = 0; i < 30 && alive(meta.pid); i++) await sleep(100);
          if (alive(meta.pid)) process.kill(meta.pid, 'SIGKILL');
          console.log(`✓ stopped pid=${meta.pid} (${(meta.channels ?? []).join(', ')})`);
        } else {
          console.log(`○ pid=${meta.pid} was not running`);
        }
        rmSync(f, { force: true });
      }
    }));

  daemon.command('uninstall')
    .description('Remove the platform service installed by daemon install')
    .action(() => run(async () => { await uninstallDaemon(); }));

  // ---------- internals ----------

  function mergeOpts(o, ctx) { return { ...o, requireCredentials: ctx.requireCredentials }; }

  async function runDaemon(o) {
    if (o.profile) process.env.ANOTIFY_PROFILE = o.profile;
    const cred = o.requireCredentials();
    const channels = o.channel;
    const base = baseName(cred.profile, channels);
    const P = { dir: o.stateDir, pid: join(o.stateDir, `${base}.pid`), state: join(o.stateDir, `${base}.state`), log: join(o.stateDir, `${base}.log`) };
    mkdirSync(P.dir, { recursive: true });
    if (existsSync(P.pid)) {
      const old = JSON.parse(readFileSync(P.pid, 'utf8'));
      if (alive(old.pid)) throw new Error(`daemon already running (pid ${old.pid}, channels ${(old.channels ?? []).join(',')}). Stop it first: anotify daemon stop`);
      rmSync(P.pid);
    }
    const log = (m) => { const line = `[${new Date().toISOString()}] ${m}`; appendFileSync(P.log, `${line}\n`); console.error(line); };
    writeFileSync(P.pid, JSON.stringify({ pid: process.pid, profile: cred.profile ?? null, channels, started: Date.now() }));
    const readState = () => { try { return JSON.parse(readFileSync(P.state, 'utf8')); } catch { return {}; } };
    const writeState = (s) => writeFileSync(P.state, JSON.stringify(s, null, 2));

    let shuttingDown = false;
    const shutdown = (sig) => { if (shuttingDown) return; shuttingDown = true; log(`received ${sig}, exiting`); try { rmSync(P.pid); } catch {} process.exit(0); };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    const cursorOf = async (ch) => {
      try { const r = await api(cred, 'GET', `/v1/channels/${encodeURIComponent(ch)}/cursor`); return r?.cursor ?? 0; } catch { return null; }
    };

    const runCommand = (wake) => new Promise((resolve) => {
      const env = {
        ...process.env,
        ANOTIFY_PROFILE: cred.profile ?? '',
        ANOTIFY_CHANNEL: wake.channel,
        ANOTIFY_MAX_SEQ: String(wake.maxSeq),
        ANOTIFY_COUNT: String(wake.count ?? ''),
        ANOTIFY_INBOX: wake.inbox,
        ANOTIFY_WAKE_LINE: wake.wakeLine,
      };
      exec(o.wakeCommand, { env, timeout: COMMAND_TIMEOUT_MS }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, stderr: String(stderr ?? ''), killed: Boolean(err?.killed) });
      });
    });

    async function inject(wake) {
      const deadline = Date.now() + o.wakeRetrySecs * 1000;
      let i = 0;
      for (;;) {
        const r = await runCommand(wake);
        if (r.code === 0) return true;
        if (Date.now() >= deadline) { log(`wake command failed permanently (exit ${r.code}${r.killed ? ', timeout' : ''}): ${r.stderr.slice(0, 300)}`); return false; }
        await sleep(WAKE_RETRY_DELAYS_MS[Math.min(i++, WAKE_RETRY_DELAYS_MS.length - 1)]);
      }
    }

    const watchdogs = new Map();
    function scheduleWatchdog(ch, seq) {
      if (!o.watchdogSecs) return;
      clearTimeout(watchdogs.get(ch));
      watchdogs.set(ch, setTimeout(async () => {
        if (shuttingDown) return;
        const cur = await cursorOf(ch);
        if (cur !== null && cur < seq) {
          log(`watchdog: ${ch} cursor=${cur} still behind seq=${seq}, re-injecting`);
          const ok = await inject({ channel: ch, maxSeq: seq, count: null, inbox: inboxFileFor(cred, ch), wakeLine: `ANOTIFY-WAKE channel=${ch} profile=${cred.profile ?? 'env'} max_seq=${seq} (watchdog re-wake)` });
          if (ok) scheduleWatchdog(ch, seq);
        }
      }, o.watchdogSecs * 1000));
    }

    const dead = new Set();
    const arm = (ch) => {
      listenForWake(cred, ch, {}).then(async (wake) => {
        if (shuttingDown) return;
        const last = readState()[ch]?.seq ?? 0;
        if (wake.maxSeq <= last) {
          log(`duplicate wake ${ch} seq=${wake.maxSeq} <= injected ${last}: single-flight intercept`);
          await sleep(INTERCEPT_SLEEP_MS); // 消息仍高于游标，立即重挂会秒级重抓
        } else {
          const ok = await inject(wake);
          const s = readState(); s[ch] = { seq: wake.maxSeq, ts: Date.now() }; writeState(s);
          // 无论注入成败都挂看门狗：失败时 cursor-behind 检查正是这条消息的恢复路径
          scheduleWatchdog(ch, wake.maxSeq);
          if (ok) log(`injected: ${wake.wakeLine}`);
        }
        arm(ch);
      }).catch((e) => {
        log(`listener for ${ch} exited permanently: ${e.message}`);
        dead.add(ch);
        if (dead.size === channels.length) { log('all channels dead, exiting'); try { rmSync(P.pid); } catch {} process.exit(1); }
      });
    };
    channels.forEach(arm);
    log(`daemon listening: channels=${channels.join(',')} profile=${cred.profile ?? 'env'} pid=${process.pid}`);
    console.log(`✓ daemon listening on: ${channels.join(', ')}  (profile=${cred.profile ?? 'env'}, pid=${process.pid})`);
    console.log(`  wake command: ${o.wakeCommand}`);
    console.log(`  stop: anotify daemon stop    log: ${P.log}`);
    await new Promise(() => {}); // 常驻；退出走信号处理器
  }

  function entryJs() {
    // daemon.js 与 main.js 同目录；npm bin shim 下 process.argv[1] 也是 main.js
    const here = fileURLToPath(import.meta.url);
    return join(dirname(here), 'main.js');
  }

  async function installDaemon(o) {
    if (o.profile) process.env.ANOTIFY_PROFILE = o.profile;
    const cred = o.requireCredentials();
    const base = `anotify-daemon-${baseName(cred.profile, o.channel)}`;
    const args = buildStartArgs(o).map(String);
    const plat = process.platform;
    if (plat === 'linux') {
      try { execSync('systemctl --user is-system-running', { stdio: 'ignore' }); } catch {
        throw new Error('systemd user session not available on this linux box. Run `anotify daemon start` under your own supervisor instead.');
      }
      const dir = join(homedir(), '.config', 'systemd', 'user');
      mkdirSync(dir, { recursive: true });
      const unit = [
        '[Unit]', `Description=Anotify wake daemon (${o.channel.join(',')})`, 'After=default.target', '',
        '[Service]', 'Type=simple',
        `ExecStart=${process.execPath} ${entryJs()} ${args.quoted.join(' ')}`,
        'Restart=on-failure', 'RestartSec=5s', '',
        '[Install]', 'WantedBy=default.target', '',
      ].join('\n');
      const path = join(dir, `${base}.service`);
      writeFileSync(path, unit);
      execSync('systemctl --user daemon-reload', { stdio: 'inherit' });
      execSync(`systemctl --user enable ${base}`, { stdio: 'ignore' });
      execSync(`systemctl --user restart ${base}`, { stdio: 'inherit' }); // 首装=start；重装=重启到新配置
      console.log(`✓ installed & started: ${path}`);
    } else if (plat === 'darwin') {
      const dir = join(homedir(), 'Library', 'LaunchAgents');
      mkdirSync(dir, { recursive: true });
      const label = `space.anotify.wake.${baseName(cred.profile, o.channel)}`;
      const xesc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
      const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${xesc(label)}</string>\n  <key>ProgramArguments</key><array>\n    <string>${xesc(process.execPath)}</string><string>${xesc(entryJs())}</string>\n${args.raw.map((a) => `    <string>${xesc(a)}</string>`).join('\n')}\n  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><dict><key>Crashed</key><true/></dict>\n  <key>ThrottleInterval</key><integer>30</integer>\n  <key>StandardOutPath</key><string>${xesc(join(o.stateDir, `${base}.out.log`))}</string>\n  <key>StandardErrorPath</key><string>${xesc(join(o.stateDir, `${base}.err.log`))}</string>\n</dict></plist>\n`;
      const path = join(dir, `${label}.plist`);
      writeFileSync(path, plist);
      try { execSync(`launchctl unload "${path}"`, { stdio: 'ignore' }); } catch {}
      execSync(`launchctl load "${path}"`, { stdio: 'inherit' });
      console.log(`✓ installed & loaded: ${path}`);
    } else if (plat === 'win32') {
      const tn = `AnotifyWake_${baseName(cred.profile, o.channel)}`;
      const tr = `"${process.execPath}" "${entryJs()}" ${args.quoted.join(' ')}`;
      execSync(`schtasks /Create /F /TN ${tn} /SC ONLOGON /TR "${tr.replace(/"/g, '\\"')}"`, { stdio: 'inherit' });
      console.log(`✓ scheduled task created: ${tn} (runs at logon)`);
      console.log('  note: Task Scheduler does not restart crashed tasks; for robust unattended use consider NSSM or pm2.');
      console.log('  start now without waiting for next logon: schtasks /Run /TN ' + tn);
    } else {
      throw new Error(`unsupported platform "${plat}". Run \`anotify daemon start\` under your own supervisor (it is a plain foreground loop).`);
    }
  }

  async function uninstallDaemon() {
    const plat = process.platform;
    const dir = daemonDir();
    const bases = findPids(dir).map((f) => f.replace(/\.pid$/, '')); // 通过 pid 文件找实例
    // 先停运行中的实例
    try { execSync(`${process.execPath} ${entryJs()} daemon stop`, { stdio: 'inherit' }); } catch {}
    if (plat === 'linux') {
      const units = readdirSync(join(homedir(), '.config', 'systemd', 'user')).filter((f) => f.startsWith('anotify-daemon-') && f.endsWith('.service'));
      for (const u of units) {
        try { execSync(`systemctl --user disable --now ${u.replace(/\.service$/, '')}`, { stdio: 'ignore' }); } catch {}
        rmSync(join(homedir(), '.config', 'systemd', 'user', u), { force: true });
        console.log(`✓ removed ${u}`);
      }
      execSync('systemctl --user daemon-reload', { stdio: 'ignore' });
    } else if (plat === 'darwin') {
      const ladir = join(homedir(), 'Library', 'LaunchAgents');
      const plists = readdirSync(ladir).filter((f) => f.startsWith('space.anotify.wake.') && f.endsWith('.plist'));
      for (const p of plists) {
        try { execSync(`launchctl unload "${join(ladir, p)}"`, { stdio: 'ignore' }); } catch {}
        rmSync(join(ladir, p), { force: true });
        console.log(`✓ removed ${p}`);
      }
    } else if (plat === 'win32') {
      let out = '';
      try { out = execSync('schtasks /Query /FO CSV /NH', { encoding: 'utf8' }); } catch {}
      for (const line of out.split('\n')) {
        const m = line.match(/"AnotifyWake_([^"]+)"/);
        if (m) { try { execSync(`schtasks /Delete /F /TN "AnotifyWake_${m[1]}"`, { stdio: 'ignore' }); console.log(`✓ removed task AnotifyWake_${m[1]}`); } catch {} }
      }
    } else {
      throw new Error(`unsupported platform "${plat}".`);
    }
    if (bases.length) console.log(`(daemon state kept in ${dir}; delete manually if unwanted)`);
  }

}
