// 只读 TUI：本机全部身份 × 已加入频道 × 消息与游标（设计见 DESIGN.md §13）
// 零依赖：原生 ANSI + readline keypress。只用 since 读，绝不 ACK、绝不初始化任何身份的游标。
import readline from 'node:readline';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { listProfiles } from './config.js';
import { api } from './api.js';
import { contentLines, fileMeta, humanSize } from './render.js';

// ---------- 数据层 ----------

const enc = encodeURIComponent;

/** 解析本机全部身份；同一 server + agent_id 的多个 profile 合并为一个身份 */
async function loadIdentities() {
  const profiles = listProfiles();
  const resolved = await Promise.all(profiles.map(async (p) => {
    const base = { profile: p.profile, server: p.server.replace(/\/+$/, ''), token: p.token };
    try {
      const me = await api(base, 'GET', '/v1/agents/me', { timeoutMs: 10_000 });
      return { ...base, agent_id: me.agent_id, name: me.display_name, error: null };
    } catch (e) {
      return { ...base, agent_id: p.agent_id || null, name: p.agent ?? p.profile, error: e.message };
    }
  }));
  // 同一服务端可能经由不同 URL 注册（域名 / IP）：按 /v1/info 的 instance_id 归并，旧服务端退回 URL
  const servers = [...new Set(resolved.map((id) => id.server))];
  const instance = new Map(await Promise.all(servers.map(async (server) => {
    try {
      const info = await api({ server }, 'GET', '/v1/info', { timeoutMs: 10_000 });
      return [server, info?.instance_id ?? server];
    } catch {
      return [server, server];
    }
  })));
  for (const id of resolved) id.serverKey = instance.get(id.server);
  const seen = new Map();
  for (const id of resolved) {
    const k = id.agent_id ? `${id.serverKey}\t${id.agent_id}` : `${id.serverKey}\t~${id.profile}`;
    if (seen.has(k)) seen.get(k).aliases.push(id.profile);
    else seen.set(k, { ...id, aliases: [] });
  }
  return [...seen.values()];
}

/** 合并各身份已加入的频道：key = server + 频道名，locals 记录每个本机身份的游标 */
async function loadChannels(identities) {
  const channels = new Map();
  await Promise.all(identities.filter((i) => !i.error).map(async (id) => {
    let resp;
    try {
      resp = await api(id, 'GET', '/v1/channels', { timeoutMs: 15_000 });
      id.channelsError = null;
    } catch (e) {
      id.channelsError = e.message;
      return;
    }
    for (const c of resp.channels) {
      // 旧服务端没有 joined 字段：退回「有游标即视为在频道里」
      const joined = c.joined ?? c.my_cursor != null;
      if (!joined) continue;
      const key = `${id.serverKey}\t${c.name}`;
      if (!channels.has(key)) {
        channels.set(key, { key, server: id.server, name: c.name, locked: c.locked, latest_seq: c.latest_seq, locals: [] });
      }
      const ch = channels.get(key);
      ch.latest_seq = Math.max(ch.latest_seq, c.latest_seq);
      ch.locals.push({ identity: id, cursor: c.my_cursor, pending: c.pending });
    }
  }));
  return [...channels.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** 读频道消息（纯 since 读）；reader 为任一已入册的本机身份 */
async function fetchMessages(ch, since, limit) {
  const reader = ch.locals[0].identity;
  const resp = await api(reader, 'GET', `/v1/channels/${enc(ch.name)}/messages`, {
    query: { since, limit, wait: 0 },
    timeoutMs: 20_000,
  });
  return resp.messages;
}

async function fetchMembers(ch) {
  const reader = ch.locals[0].identity;
  const resp = await api(reader, 'GET', `/v1/channels/${enc(ch.name)}/members`, { timeoutMs: 15_000 });
  return resp.members;
}

/** 消息缓存：首载最近 tail 条，之后按 lastSeq 增量追加 */
function createCache(tail) {
  const store = new Map();
  return {
    get: (key) => store.get(key),
    async sync(ch) {
      let entry = store.get(ch.key);
      if (!entry) {
        const since = Math.max(0, ch.latest_seq - tail);
        const msgs = await fetchMessages(ch, since, Math.min(Math.max(tail, 1), 1000));
        entry = { msgs, lastSeq: msgs.length ? msgs[msgs.length - 1].seq : since, members: null };
        store.set(ch.key, entry);
        return msgs.length;
      }
      let added = 0;
      while (entry.lastSeq < ch.latest_seq) {
        const more = await fetchMessages(ch, entry.lastSeq, 1000);
        if (!more.length) break;
        entry.msgs.push(...more);
        entry.lastSeq = more[more.length - 1].seq;
        added += more.length;
      }
      return added;
    },
  };
}

function identityView(id) {
  return {
    profile: id.profile, aliases: id.aliases, name: id.name, agent_id: id.agent_id, server: id.server,
    error: id.error ?? id.channelsError ?? null,
  };
}

function channelView(ch, entry) {
  return {
    server: ch.server,
    name: ch.name,
    locked: ch.locked,
    latest_seq: ch.latest_seq,
    locals: ch.locals.map((l) => ({ profile: l.identity.profile, name: l.identity.name, agent_id: l.identity.agent_id, cursor: l.cursor, pending: l.pending })),
    ...(entry?.members ? { members: entry.members } : {}),
    messages: entry?.msgs ?? [],
  };
}

/** 非交互快照（tui --json）：与界面同一数据模型，供脚本/测试做验收 */
export async function snapshot({ tail = 200 } = {}) {
  const identities = await loadIdentities();
  const channels = await loadChannels(identities);
  const cache = createCache(tail);
  for (const ch of channels) await cache.sync(ch);
  return {
    generated_at: Date.now() / 1000,
    identities: identities.map(identityView),
    channels: channels.map((ch) => channelView(ch, cache.get(ch.key))),
  };
}

// ---------- 文本度量（CJK / emoji 占两列） ----------

function charWidth(cp) {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x20d0 && cp <= 0x20ff)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) || (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x2705 && cp <= 0x2705) ||
    (cp >= 0x274c && cp <= 0x274c) || (cp >= 0x2b50 && cp <= 0x2b55) || (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

const strWidth = (s) => {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0));
  return w;
};

/** 去掉控制字符（防止消息内容里的转义序列污染终端），tab 展开 */
const sanitize = (s) => String(s).replace(/\t/g, '  ').replace(/[\x00-\x1f\x7f-\x9f]/g, '');

/** 按显示宽度截断 */
function truncate(s, width) {
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > width) break;
    out += ch;
    w += cw;
  }
  return out;
}

/** 按显示宽度折行：优先在空白处断，超长词逐字切 */
function wrap(text, width) {
  if (width <= 0) return [''];
  const out = [];
  let line = '';
  let lw = 0;
  for (const tok of sanitize(text).split(/(\s+)/)) {
    if (!tok) continue;
    const tw = strWidth(tok);
    if (lw + tw <= width) {
      line += tok;
      lw += tw;
      continue;
    }
    if (/^\s+$/.test(tok)) {
      out.push(line);
      line = '';
      lw = 0;
      continue;
    }
    if (tw <= width && lw > 0) {
      out.push(line);
      line = tok;
      lw = tw;
      continue;
    }
    for (const ch of tok) {
      const cw = charWidth(ch.codePointAt(0));
      if (lw + cw > width) {
        out.push(line);
        line = '';
        lw = 0;
      }
      line += ch;
      lw += cw;
    }
  }
  out.push(line);
  return out;
}

// ---------- ANSI ----------

const ESC = '\x1b[';
const sty = {
  reset: `${ESC}0m`, bold: `${ESC}1m`, dim: `${ESC}2m`, inverse: `${ESC}7m`,
  red: `${ESC}31m`, green: `${ESC}32m`, yellow: `${ESC}33m`, cyan: `${ESC}36m`,
};
const PALETTE = [36, 33, 35, 32, 34, 91, 96, 93, 95, 92].map((n) => `${ESC}${n}m`);

function colorFor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** 一行由若干 [text, style] 段组成；按宽度截断并补齐空格 */
function renderSegs(segs, width) {
  let out = '';
  let used = 0;
  for (const [text, style = ''] of segs) {
    if (used >= width) break;
    const t = truncate(sanitize(text), width - used);
    used += strWidth(t);
    out += style ? `${style}${t}${sty.reset}` : t;
  }
  return out + ' '.repeat(Math.max(0, width - used));
}

// ---------- 视图构建 ----------

const pad2 = (n) => String(n).padStart(2, '0');
const hms = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

function firstLine(m) {
  const f = fileMeta(m);
  const text = f ? `📎 ${f.name}${f.caption ? ` — ${f.caption}` : ''}` : String(m.content);
  return sanitize(text.split('\n').find((l) => l.trim()) ?? '');
}

/** 右栏：消息 → 行段数组（日期分隔、reply 父消息摘要、本机身份游标水位线） */
function messageLines(ch, entry, width) {
  const lines = [];
  if (!entry) return [[['  loading…', sty.dim]]];
  if (!entry.msgs.length) return [[['  (no messages)', sty.dim]]];
  const bySeq = new Map(entry.msgs.map((m) => [m.seq, m]));
  const marks = new Map();
  for (const l of ch.locals) {
    if (l.cursor == null) continue;
    if (!marks.has(l.cursor)) marks.set(l.cursor, []);
    marks.get(l.cursor).push(l.identity.name);
  }
  if (entry.msgs[0].seq > 1) lines.push([[`  ┄ ${entry.msgs[0].seq - 1} earlier message(s) not loaded (--tail) ┄`, sty.dim]]);
  let lastDay = null;
  for (const m of entry.msgs) {
    const d = new Date(m.created_at * 1000);
    const day = ymd(d);
    if (day !== lastDay) {
      lines.push([[`──── ${day} ${'─'.repeat(Math.max(0, width - day.length - 6))}`, sty.dim]]);
      lastDay = day;
    }
    const sender = m.sender_name ?? m.sender;
    const head = [[`#${m.seq} `, sty.dim], [sender, `${sty.bold}${colorFor(sender)}`], [`  ${hms(d)}`, sty.dim]];
    if (m.reply_to != null) head.push([`  ↳#${m.reply_to}`, sty.dim]);
    lines.push(head);
    if (m.reply_to != null) {
      const parent = bySeq.get(m.reply_to);
      const summary = parent
        ? `${parent.sender_name ?? parent.sender}: ${firstLine(parent)}`
        : '(earlier message, not loaded)';
      lines.push([['  ┆ ', sty.dim], [summary, sty.dim]]);
    }
    const f = fileMeta(m);
    const body = f
      ? [`📎 ${f.name}  (${humanSize(f.size)}, ${f.mime})`, ...(f.caption ? String(f.caption).split('\n') : [])]
      : contentLines(m, ch.name);
    body.forEach((raw, i) => {
      for (const w of wrap(raw, width - 2)) lines.push([['  '], [w, f && i === 0 ? sty.cyan : '']]);
    });
    if (f) lines.push([[`  → anotify download ${ch.name} ${m.seq}`, sty.dim]]);
    if (marks.has(m.seq)) {
      const who = marks.get(m.seq).join(', ');
      lines.push([[`  ┄┄ ${who} ACKed through #${m.seq} ┄┄`, sty.yellow]]);
    }
    lines.push([['']]);
  }
  return lines;
}

/** 左栏：频道 + 其下每个本机身份的游标与积压 */
function channelRows(channels, multiServer) {
  const rows = [];
  const nameW = Math.max(0, ...channels.flatMap((ch) => ch.locals.map((l) => strWidth(l.identity.name))));
  channels.forEach((ch, idx) => {
    const host = multiServer ? ` @${new URL(ch.server).host}` : '';
    rows.push({ idx, segs: (selected) => [
      [selected ? '▸' : ' ', sty.bold],
      [ch.locked ? '🔒' : '  '],
      [` ${ch.name}${host}`, selected ? sty.bold : ''],
      [`  ${ch.latest_seq}`, sty.dim],
    ] });
    for (const l of ch.locals) {
      const pending = l.pending ?? 0;
      rows.push({ idx, segs: () => [
        ['    '],
        [l.identity.name + ' '.repeat(nameW - strWidth(l.identity.name)), colorFor(l.identity.name)],
        [`  @${l.cursor ?? '-'}`, sty.dim],
        [pending > 0 ? `  +${pending}` : '', sty.yellow],
      ] });
    }
  });
  return rows;
}

// ---------- 交互主循环 ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runTui({ tail = 200, interval = 3 } = {}) {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error('anotify tui needs an interactive terminal; use anotify tui --json for a snapshot');
  }
  const out = process.stdout;
  const cache = createCache(tail);
  const st = {
    identities: [], channels: [], sel: 0, focus: 'left', scroll: 0, leftScroll: 0,
    overlay: null, status: 'loading…', updated: null, quitting: false,
  };

  const selected = () => st.channels[st.sel];

  function frame() {
    const cols = out.columns || 80;
    const rows = out.rows || 24;
    const leftW = Math.min(40, Math.max(24, Math.floor(cols * 0.3)));
    const rightW = Math.max(10, cols - leftW - 1);
    const bodyH = Math.max(1, rows - 2);
    const buf = [];

    // 头部
    const names = st.identities.map((i) => (i.error ? `${i.name}⚠` : i.name)).join(', ');
    const servers = [...new Set(st.identities.map((i) => new URL(i.server).host))].join(', ');
    const upd = st.updated ? `updated ${hms(st.updated)}` : '';
    buf.push(`${sty.inverse}${renderSegs([[` anotify tui · read-only · ${st.identities.length} identit${st.identities.length === 1 ? 'y' : 'ies'}: ${names} · ${servers} · ${upd}`]], cols)}${sty.reset}`);

    // 左栏
    const multiServer = new Set(st.channels.map((c) => c.key.split('\t')[0])).size > 1;
    const lrows = channelRows(st.channels, multiServer);
    const left = [[[` CHANNELS (${st.channels.length})`, st.focus === 'left' ? `${sty.bold}${sty.cyan}` : sty.dim]]];
    const firstSel = lrows.findIndex((r) => r.idx === st.sel);
    const lastSel = lrows.length - 1 - [...lrows].reverse().findIndex((r) => r.idx === st.sel);
    const visible = bodyH - 1;
    if (firstSel >= 0) {
      if (firstSel < st.leftScroll) st.leftScroll = firstSel;
      if (lastSel >= st.leftScroll + visible) st.leftScroll = Math.max(0, lastSel - visible + 1);
    }
    for (const r of lrows.slice(st.leftScroll, st.leftScroll + visible)) left.push(r.segs(r.idx === st.sel));
    if (!st.channels.length) left.push([[st.identities.length ? ' (no joined channels)' : ' (no identities: anotify profile add)', sty.dim]]);

    // 右栏
    const ch = selected();
    let right = [];
    if (ch) {
      const entry = cache.get(ch.key);
      const title = [[` ${ch.locked ? '🔒 ' : ''}${ch.name}`, st.focus === 'right' ? `${sty.bold}${sty.cyan}` : sty.bold], [`  latest #${ch.latest_seq}`, sty.dim]];
      const all = messageLines(ch, entry, rightW - 1).map((segs) => [[' '], ...segs]);
      const viewH = bodyH - 1;
      const maxScroll = Math.max(0, all.length - viewH);
      st.scroll = Math.min(st.scroll, maxScroll);
      const end = all.length - st.scroll;
      right = [title, ...all.slice(Math.max(0, end - viewH), end)];
      if (st.scroll > 0) title.push([`  ↑ scrolled ${st.scroll} line(s) · G to follow`, sty.yellow]);
    }

    for (let i = 0; i < bodyH; i++) {
      buf.push(`${renderSegs(left[i] ?? [['']], leftW)}${sty.dim}│${sty.reset}${renderSegs(right[i] ?? [['']], rightW)}`);
    }

    // 底部
    const keys = '↑↓/jk move · Tab focus · PgUp/PgDn scroll · g/G top/bottom · m members · f dump · r refresh · ? help · q quit';
    buf.push(`${sty.inverse}${renderSegs([[` ${st.status ? `${st.status} · ` : ''}${keys}`]], cols)}${sty.reset}`);

    out.write(`${ESC}H${buf.join(`${ESC}K\n`)}${ESC}K${st.overlay && cols >= 20 && rows >= 8 ? overlay(cols, rows) : ''}`);
  }

  /** 居中浮层（帮助 / 成员列表），按坐标绘制在底图之上 */
  function overlay(cols, rows) {
    let title;
    let body;
    if (st.overlay === 'help') {
      title = 'Help';
      body = [
        'Read-only view of every channel joined by the identities on this machine.',
        'It only reads with since; it never ACKs or moves any cursor.',
        '',
        'Left pane: channels, then each local identity with its cursor (@seq)',
        '           and pending backlog (+N).',
        'Right pane: messages; "┄┄ X ACKed through #N ┄┄" marks local cursors.',
        '',
        '↑↓ / j k   select channel (left) or scroll (right)',
        'Tab h l    switch focus          Enter  focus messages',
        'PgUp PgDn  scroll a page         g / G  top / bottom (follow)',
        'm          members of channel    f      dump channel JSON to a file',
        'r          refresh now           q Esc  quit (any key closes this box)',
        '',
        'Identities: ~/.config/anotify/profiles/*.toml (+ an old credentials.toml, read-only)',
        '(import one with: anotify profile add <name> --server URL --token T)',
      ];
    } else {
      const ch = selected();
      const members = ch && cache.get(ch.key)?.members;
      title = `Members · ${ch?.name ?? ''}`;
      const localIds = new Map((ch?.locals ?? []).map((l) => [l.identity.agent_id, l]));
      body = !members ? ['loading…'] : members.map((m) => {
        const local = localIds.get(m.agent_id);
        const joined = new Date(m.joined_at * 1000);
        const tag = local ? `  ← local (${local.identity.profile}, cursor @${local.cursor ?? '-'})` : '';
        return `${m.display_name.padEnd(18)} ${m.agent_id}  joined ${ymd(joined)} ${hms(joined).slice(0, 5)}${tag}`;
      });
      body.push('', `server: ${ch?.server ?? ''}`);
    }
    const w = Math.min(cols - 4, Math.max(40, ...body.map((l) => strWidth(l) + 4)));
    const h = Math.min(rows - 2, body.length + 4);
    const top = Math.max(1, Math.floor((rows - h) / 2));
    const left = Math.max(0, Math.floor((cols - w) / 2));
    const boxLines = [
      `┌─ ${title} ${'─'.repeat(Math.max(0, w - strWidth(title) - 5))}┐`,
      ...body.slice(0, h - 3).map((l) => `│ ${renderSegs([[l]], w - 4)} │`),
      `│${' '.repeat(w - 2)}│`,
      `└${'─'.repeat(w - 2)}┘`,
    ].slice(0, h);
    return boxLines.map((l, i) => `${ESC}${top + i + 1};${left + 1}H${sty.bold}${l}${sty.reset}`).join('');
  }

  async function refresh({ identities = false } = {}) {
    try {
      if (identities || !st.identities.length) st.identities = await loadIdentities();
      const prevKey = selected()?.key;
      st.channels = await loadChannels(st.identities);
      const idx = st.channels.findIndex((c) => c.key === prevKey);
      st.sel = idx >= 0 ? idx : Math.min(st.sel, Math.max(0, st.channels.length - 1));
      const ch = selected();
      if (ch) {
        const before = messageCount(ch);
        await cache.sync(ch);
        // 非跟随状态下新消息到达，保持视口不跳
        if (st.scroll > 0 && before != null) st.scroll += lineDelta(ch, before);
      }
      st.updated = new Date();
      const errs = st.identities.filter((i) => i.error || i.channelsError);
      st.status = errs.length ? `⚠ ${errs.map((i) => `${i.name}: ${i.error ?? i.channelsError}`).join('; ')}` : '';
    } catch (e) {
      st.status = `⚠ ${e.message}`;
    }
  }

  const messageCount = (ch) => cache.get(ch.key)?.msgs.length ?? null;
  // 近似：按「新增消息条数 × 3 行」补偿滚动，足以让阅读位置基本稳定
  const lineDelta = (ch, before) => Math.max(0, (messageCount(ch) - before) * 3);

  async function loadSelected() {
    const ch = selected();
    if (!ch || cache.get(ch.key)) return;
    frame();
    try {
      await cache.sync(ch);
    } catch (e) {
      st.status = `⚠ ${e.message}`;
    }
    frame();
  }

  async function openMembers() {
    const ch = selected();
    if (!ch) return;
    st.overlay = 'members';
    frame();
    try {
      await cache.sync(ch);
      cache.get(ch.key).members = await fetchMembers(ch);
    } catch (e) {
      st.overlay = null;
      st.status = `⚠ ${e.message}`;
    }
    frame();
  }

  function dump() {
    const ch = selected();
    if (!ch) return;
    const d = new Date();
    const stamp = `${ymd(d).replace(/-/g, '')}-${hms(d).replace(/:/g, '')}`;
    const file = `anotify-${ch.name}-${stamp}.json`;
    writeFileSync(file, JSON.stringify({ generated_at: d.getTime() / 1000, ...channelView(ch, cache.get(ch.key)) }, null, 2));
    st.status = `✓ dumped ${resolve(file)}`;
  }

  let restored = false;
  function cleanup() {
    if (restored) return;
    restored = true;
    out.write(`${ESC}?25h${ESC}?1049l`);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  out.write(`${ESC}?1049h${ESC}?25l${ESC}2J`);
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  out.on('resize', frame);

  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  const quit = () => {
    st.quitting = true;
    cleanup();
    resolveDone();
  };
  process.on('exit', cleanup);

  // 崩溃兜底：先恢复终端再打印堆栈——否则错误输出在备用屏里，退出后什么都看不到
  const fail = (e) => {
    if (st.quitting) return;
    st.quitting = true;
    cleanup();
    console.error(`✗ anotify tui crashed: ${e?.stack ?? e}`);
    process.exitCode = 1;
    resolveDone();
  };
  process.on('uncaughtException', fail);
  process.on('unhandledRejection', fail);

  process.stdin.on('keypress', (str, key) => {
    try {
      onKey(str, key ?? {});
    } catch (e) {
      fail(e);
    }
  });

  function onKey(str, key) {
    if (st.quitting) return;
    const name = key.name ?? str;
    const page = Math.max(1, (out.rows || 24) - 4);
    if (key.ctrl && name === 'c') return quit();
    if (st.overlay) {
      st.overlay = null; // 任意键关闭浮层
      return frame();
    }
    switch (name) {
      case 'q':
        if (key.shift) return; // 只认小写 q，避免误触 Q 退出
        return quit();
      case 'escape': return quit();
      case 'tab': st.focus = st.focus === 'left' ? 'right' : 'left'; break;
      case 'h': case 'left': st.focus = 'left'; break;
      case 'l': case 'right': case 'return': st.focus = 'right'; break;
      case 'up': case 'k':
        if (st.focus === 'left') {
          if (st.sel > 0) { st.sel--; st.scroll = 0; loadSelected(); }
        } else st.scroll++;
        break;
      case 'down': case 'j':
        if (st.focus === 'left') {
          if (st.sel < st.channels.length - 1) { st.sel++; st.scroll = 0; loadSelected(); }
        } else st.scroll = Math.max(0, st.scroll - 1);
        break;
      case 'pageup': st.scroll += page; break;
      case 'pagedown': st.scroll = Math.max(0, st.scroll - page); break;
      case 'g': case 'home':
        if (key.shift || str === 'G') st.scroll = 0;
        else st.scroll = Number.MAX_SAFE_INTEGER;
        break;
      case 'end': st.scroll = 0; break;
      case 'm': openMembers(); return;
      case 'f': dump(); break;
      case 'r': st.status = 'refreshing…'; frame(); refresh({ identities: true }).then(frame); return;
      case '?': st.overlay = 'help'; break;
      default: return;
    }
    frame();
  }

  await refresh({ identities: true });
  frame();

  (async () => {
    let tick = 0;
    while (!st.quitting) {
      await sleep(Math.max(1, interval) * 1000);
      if (st.quitting) break;
      tick++;
      await refresh({ identities: tick % 10 === 0 });
      if (!st.quitting) frame();
    }
  })();

  await done;
}
