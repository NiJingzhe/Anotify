#!/usr/bin/env node
// Anotify CLI（设计见 DESIGN.md §7）
import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { loadCredentials, requireCredentials, saveCredentials } from './config.js';
import { api, ApiError } from './api.js';

const program = new Command();

// 管道下游提前退出（如 `anotify recv ... | head`）时安静收场，不打堆栈
process.stdout?.on('error', (e) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

program
  .name('anotify')
  .description('Anotify: channel-based messaging for agents')
  .version('0.3.2');

// 管道下游提前退出（如 `anotify recv ... | head`）时安静收场，不打堆栈
process.stdout?.on('error', (e) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

function printMessage(m) {
  const time = new Date(m.created_at * 1000).toTimeString().slice(0, 8);
  const reply = m.reply_to != null ? `  ↳#${m.reply_to}` : '';
  console.log(`#${m.seq}  ${m.sender_name ?? m.sender}  ${time}${reply}`);
  for (const line of String(m.content).split('\n')) {
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
  .description('注册 agent 身份并保存凭证（token 仅此一次显示）')
  .requiredOption('--server <url>', '服务端地址', process.env.ANOTIFY_SERVER ?? 'http://localhost:8000')
  .option('--no-save', '不写入本地凭证文件（多 agent 测试时用，配合 ANOTIFY_TOKEN 环境变量）')
  .action((name, opts) => run(async () => {
    const resp = await api({ server: opts.server }, 'POST', '/v1/agents', {
      body: { name },
    });
    console.log('✓ 身份已创建');
    console.log(`  id   : ${resp.agent_id}  （不可变，全服唯一）`);
    console.log(`  name : ${resp.display_name}  （display_name，可用 anotify rename 修改）`);
    console.log(`  token: ${resp.token}`);
    if (opts.save === false) {
      console.log('  （--no-save：未写凭证文件。使用时设置 ANOTIFY_SERVER / ANOTIFY_TOKEN 环境变量）');
    } else {
      const file = saveCredentials({
        server: opts.server, agent: resp.display_name, agent_id: resp.agent_id, token: resp.token,
      });
      console.log(`  （已保存到 ${file}，请勿泄露）`);
    }
  }));

program
  .command('whoami')
  .description('显示当前生效身份（以服务端认证结果为准）')
  .action(() => run(async () => {
    const cred = loadCredentials();
    if (!cred.server || !cred.token) {
      console.log('未注册。执行: anotify register <name> --server <url>');
      return;
    }
    // 权威身份来自服务端对 token 的解析，而非本地文件记录
    const me = await api(cred, 'GET', '/v1/agents/me');
    console.log(`id   : ${me.agent_id}`);
    console.log(`name : ${me.display_name}`);
    console.log(`server: ${cred.server}`);
    console.log('token : ✓ 有效');
    if (cred.agent && cred.agent !== me.display_name) {
      console.log(`⚠ 本地凭证文件记录的名字是 "${cred.agent}"，服务端实际为 "${me.display_name}"。`);
    }
  }));

program
  .command('rename <new-name>')
  .description('修改 display_name（agent_id 不变；与已加入频道的成员重名会被拒绝）')
  .action((newName) => run(async () => {
    const cred = requireCredentials();
    const resp = await api(cred, 'PATCH', '/v1/agents/me', { body: { display_name: newName } });
    console.log(`✓ 已改名: ${resp.display_name}（id 不变: ${resp.agent_id}）`);
  }));

program
  .command('join <channel>')
  .description('加入频道名册（上锁频道需 --password；公开频道首次发言也会自动加入）')
  .option('--password <pw>', '频道密码')
  .action((chName, opts) => run(async () => {
    const cred = requireCredentials();
    const resp = await api(cred, 'POST', `/v1/channels/${encodeURIComponent(chName)}/join`, {
      body: { password: opts.password },
    });
    console.log(resp.joined
      ? `✓ 已加入 ${resp.channel}`
      : `(早已是 ${resp.channel} 成员)`);
    hint(`补看全部历史: anotify recv ${chName} --from-start；挂后台监听: anotify recv ${chName} --wait 60`);
  }));

program
  .command('members <channel>')
  .description('查看频道名册')
  .option('-o, --output <fmt>', '输出格式: text|json', 'text')
  .action((chName, opts) => run(async () => {
    const cred = requireCredentials();
    const resp = await api(cred, 'GET', `/v1/channels/${encodeURIComponent(chName)}/members`);
    if (opts.output === 'json') {
      console.log(JSON.stringify(resp, null, 2));
      return;
    }
    if (resp.members.length === 0) {
      console.log('(名册为空)');
      return;
    }
    for (const m of resp.members) {
      const t = new Date(m.joined_at * 1000).toISOString().slice(0, 16).replace('T', ' ');
      console.log(`${m.display_name.padEnd(20)} ${m.agent_id}  (joined ${t})`);
    }
  }));

// ---------- 频道 ----------

const channel = program.command('channel').description('频道管理');
channel
  .command('create <name>')
  .description('创建频道（--password 设置后频道上锁，加入需密码）')
  .option('--password <pw>', '频道密码（不传则为公开频道）')
  .action((name, opts) => run(async () => {
    const cred = requireCredentials();
    const resp = await api(cred, 'POST', '/v1/channels', { body: { name, password: opts.password } });
    console.log(`✓ 频道已创建: ${resp.name}${resp.locked ? ' 🔒（已上锁）' : ''}（by ${resp.created_by_name}）`);
    hint(resp.locked
      ? `邀请其他 agent，把整行粘贴给对方（<server-url> 换成你的服务端地址）: Read https://raw.githubusercontent.com/NiJingzhe/Anotify/main/skill/SKILL.md and join my Anotify channel ${resp.name} (password ${opts.password}, server <server-url>), say hi in-channel, then arm a background listener`
      : `邀请其他 agent，把整行粘贴给对方（<server-url> 换成你的服务端地址）: Read https://raw.githubusercontent.com/NiJingzhe/Anotify/main/skill/SKILL.md and join my Anotify channel ${resp.name} (server <server-url>), say hi in-channel, then arm a background listener`);
  }));
channel
  .command('passwd <channel> <password>')
  .description('修改/清除频道密码（仅频道创建者；传空字符串 "" 清除密码回到公开）')
  .action((chName, password) => run(async () => {
    const cred = requireCredentials();
    const resp = await api(cred, 'PATCH', `/v1/channels/${encodeURIComponent(chName)}`, {
      body: { password },
    });
    console.log(resp.locked
      ? `✓ ${resp.channel} 已上锁 🔒`
      : `✓ ${resp.channel} 密码已清除（公开频道）`);
  }));

program
  .command('channels')
  .description('列出频道（含自己的游标与积压数）')
  .option('-o, --output <fmt>', '输出格式: text|json', 'text')
  .action((opts) => run(async () => {
    const cred = requireCredentials();
    const resp = await api(cred, 'GET', '/v1/channels');
    if (opts.output === 'json') {
      console.log(JSON.stringify(resp, null, 2));
      return;
    }
    if (resp.channels.length === 0) {
      console.log('(无频道)');
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
  .description('发布消息；无 text 时从 stdin 读取')
  .option('--reply-to <seq>', '引用同频道内另一条消息的 seq', Number)
  .option('--json', '以 application/json 发布，内容从 stdin 读取')
  .action((chName, text, opts) => run(async () => {
    const cred = requireCredentials();
    let content = text;
    let content_type = 'text/plain';
    if (opts.json) {
      content = await readStdin();
      content_type = 'application/json';
    } else if (!content) {
      content = await readStdinIfPiped();
    }
    if (!content) {
      throw new Error('消息内容为空：传入 text 参数，或通过 stdin 提供内容');
    }
    const resp = await api(cred, 'POST', `/v1/channels/${encodeURIComponent(chName)}/messages`, {
      body: { content, content_type, reply_to: opts.replyTo },
    });
    console.log(`✓ 已发布到 ${resp.channel}: seq=${resp.seq} sender=${resp.sender_name ?? resp.sender}`);
    hint(`发完消息记得挂后台监听等回复（background shell 运行）: anotify recv ${chName} --wait 60`);
  }));

program
  .command('recv <channel>')
  .description('拉取消息（默认打印后自动 ACK；--no-ack 供 agent 程序化使用）')
  .option('--wait <sec>', '长轮询秒数 0-60', Number, 30)
  .option('--limit <n>', '单次最多返回条数', Number, 100)
  .option('--no-ack', '只读不 ACK（显式指定 since 时强制只读）')
  .option('--since <seq>', '临时覆盖起始位置（不影响游标）', Number)
  .option('--from-start', '从 seq=0 回放全部历史（不影响游标）')
  .option('-o, --output <fmt>', '输出格式: text|json', 'text')
  .action((chName, opts) => run(async () => {
    const cred = requireCredentials();
    if (opts.since !== undefined && opts.fromStart) {
      throw new Error('--since 与 --from-start 不能同时使用');
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
      console.log('(无新消息)');
    } else {
      for (const m of resp.messages) printMessage(m);
    }

    if (explicit !== undefined) {
      // 显式回放是纯读，绝不自动消费（§4.5）
      if (opts.ack) console.log('(已跳过自动 ACK：显式 since 回放不影响游标)');
      return;
    }
    if (resp.cursor_initialized && opts.output !== 'json') {
      console.log(`提示：已从最近 10 分钟内的消息开始。补看全部历史: anotify recv ${chName} --from-start`);
    }
    if (resp.messages.length > 0 && opts.ack) {
      const through = resp.messages[resp.messages.length - 1].seq;
      await api(cred, 'POST', `/v1/channels/${encodeURIComponent(chName)}/ack`, {
        body: { through },
      });
      console.log(`已 ACK through ${through}（--no-ack 可关闭自动消费）`);
      hint(`处理完记得重新挂后台监听: anotify recv ${chName} --wait 60`);
    }
  }));

program
  .command('ack <channel>')
  .description('手动推进游标水位线：声明「seq ≤ through 已全部处理完毕」')
  .requiredOption('--through <seq>', '水位线 seq', Number)
  .action((chName, opts) => run(async () => {
    const cred = requireCredentials();
    const resp = await api(cred, 'POST', `/v1/channels/${encodeURIComponent(chName)}/ack`, {
      body: { through: opts.through },
    });
    console.log(`✓ cursor=${resp.cursor}`);
  }));

program
  .command('cursor <channel>')
  .description('查看自己在该频道的游标')
  .option('-o, --output <fmt>', '输出格式: text|json', 'text')
  .action((chName, opts) => run(async () => {
    const cred = requireCredentials();
    const resp = await api(cred, 'GET', `/v1/channels/${encodeURIComponent(chName)}/cursor`);
    if (opts.output === 'json') {
      console.log(JSON.stringify(resp, null, 2));
      return;
    }
    console.log(resp.cursor == null
      ? `(尚未初始化游标：首次 recv 时将从最近 10 分钟内的消息开始)`
      : `cursor=${resp.cursor}  updated_at=${new Date(resp.updated_at * 1000).toISOString()}`);
  }));

// ---------- 服务 ----------

program
  .command('serve')
  .description('启动 anotify-backend（monorepo 内开发用；独立部署请直接运行 anotify-backend）')
  .option('--db <path>', 'SQLite 数据库路径', './anotify.db')
  .option('--host <host>', '监听地址', '0.0.0.0')
  .option('--port <port>', '监听端口', '8000')
  .action((opts) => {
    let serverJs;
    try {
      const require = createRequire(import.meta.url);
      const pkg = require.resolve('anotify-backend/package.json');
      serverJs = join(dirname(pkg), 'src', 'server.js');
    } catch {
      console.error('✗ 未找到 anotify-backend。请在 monorepo 内运行（npm run dev），或单独安装 anotify-backend。');
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
