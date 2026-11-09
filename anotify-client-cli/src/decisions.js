// 决策轨迹（DESIGN §15）：记录决策 / 交接给人类 / 记录人类答复。
// 人类对 Anotify 始终只读：handoff 只「留痕 + 打印给人类看的文本」，agent 须把文本贴到用户自己的界面里，
// 得到答复后再用 resolve 记录。
import { api } from './api.js';

export const DECISION_CONTENT_TYPE = 'application/vnd.anotify.decision+json';
const BECAUSE_TYPES = ['user', 'rule', 'fact', 'prior', 'assumption'];
const OPTION_IDS = ['A', 'B', 'C', 'D', 'E', 'F'];

/** 消息 → 决策记录对象；非决策消息或坏 JSON 返回 null */
export function decisionRecord(m) {
  if (m?.content_type !== DECISION_CONTENT_TYPE) return null;
  try {
    const r = JSON.parse(m.content);
    return r && typeof r === 'object' && r.v === 1 ? r : null;
  } catch {
    return null;
  }
}

/** `--because fact:text` / `prior:#12 text` / `prior:12:text` → {type,text[,ref]} */
export function parseBecause(raw) {
  const s = String(raw);
  const i = s.indexOf(':');
  const type = i > 0 ? s.slice(0, i).trim() : '';
  if (!BECAUSE_TYPES.includes(type)) {
    throw new Error(`--because must look like <type>:<text> with type one of ${BECAUSE_TYPES.join('|')} (got "${s}")`);
  }
  const rest = s.slice(i + 1).trim();
  if (type === 'prior') {
    const m = rest.match(/^#?(\d+)\s*[: ]\s*(.+)$/s);
    if (!m) throw new Error(`--because prior needs a seq and text: prior:#12 why it matters (got "${s}")`);
    return { type, ref: Number(m[1]), text: m[2].trim() };
  }
  if (!rest) throw new Error(`--because "${s}" has no text`);
  return { type, text: rest };
}

/** `--option "label=>outcome"`（重复）→ [{id,label,outcome[,recommended]}]，id 按 A–F 顺序分配 */
export function buildOptions(rawOptions, recommend) {
  if (!Array.isArray(rawOptions) || rawOptions.length < 2 || rawOptions.length > OPTION_IDS.length) {
    throw new Error(`handoff needs 2-${OPTION_IDS.length} --option "<label>=><known outcome>" entries`);
  }
  const rec = recommend ? String(recommend).toUpperCase() : undefined;
  if (rec && !OPTION_IDS.slice(0, rawOptions.length).includes(rec)) {
    throw new Error(`--recommend must be one of ${OPTION_IDS.slice(0, rawOptions.length).join(', ')}`);
  }
  return rawOptions.map((raw, i) => {
    const k = String(raw).indexOf('=>');
    if (k <= 0 || !String(raw).slice(k + 2).trim()) {
      throw new Error(`--option must be "<label>=><known outcome>" (got "${raw}")`);
    }
    const o = { id: OPTION_IDS[i], label: String(raw).slice(0, k).trim(), outcome: String(raw).slice(k + 2).trim() };
    if (rec === o.id) o.recommended = true;
    return o;
  });
}

/** `--done 12` 或 `--done "12:简述"` → { seq, summary? }（summary 只用于给人类看的文本，不入库） */
export function parseDone(raw) {
  const m = String(raw).match(/^#?(\d+)(?:\s*[: ]\s*(.+))?$/s);
  if (!m) throw new Error(`--done must be a seq, optionally followed by a short summary: 12 or "12:chose X" (got "${raw}")`);
  return { seq: Number(m[1]), summary: m[2]?.trim() };
}

/** recv / TUI 用的摘要行 */
export function decisionLines(rec, m) {
  if (rec.kind === 'decision') {
    const lines = [`◆ decision: ${rec.decision}`];
    for (const b of rec.because ?? []) lines.push(`  because [${b.type}${b.ref ? ` #${b.ref}` : ''}] ${b.text}`);
    if (rec.why_notify) lines.push(`  why notify: ${rec.why_notify}`);
    return lines;
  }
  if (rec.kind === 'handoff') {
    const lines = [`◇ handoff: ${rec.question}`, `  why you: ${rec.why_you}`];
    if (rec.done_so_far?.length) lines.push(`  done so far: ${rec.done_so_far.map((n) => `#${n}`).join(' ')}`);
    for (const o of rec.options ?? []) lines.push(`  ${o.id}${o.recommended ? ' (recommended)' : ''} ${o.label} → ${o.outcome}`);
    if (rec.blocked) lines.push(`  blocked: ${rec.blocked}`);
    if (rec.default_action) lines.push(`  default: ${rec.default_action}`);
    return lines;
  }
  if (rec.kind === 'resolution') {
    return [`✓ resolution of #${m?.reply_to ?? '?'}: ${rec.chosen ? `chose ${rec.chosen} — ` : ''}${rec.note} (decided by ${rec.decided_by})`];
  }
  return [JSON.stringify(rec)];
}

/** 给人类看的交接文本：agent 须原样贴到用户自己的 coding agent 界面里 */
export function humanHandoffText({ channel, seq, rec, done }) {
  const out = [`**I need a decision from you** (recorded as #${seq} in channel "${channel}")`, ''];
  if (done?.length) {
    out.push('**Already decided:**', ...done.map((d) => `- #${d.seq}${d.summary ? ` ${d.summary}` : ''}`), '');
  }
  out.push(`**Question:** ${rec.question}`, '', `**Why this is your call:** ${rec.why_you}`, '', '**Options (known outcomes):**');
  for (const o of rec.options) out.push(`- **${o.id}** ${o.label}${o.recommended ? ' — *my recommendation*' : ''}: ${o.outcome}`);
  if (rec.blocked || rec.default_action) {
    out.push('');
    if (rec.blocked) out.push(`**If you don't decide:** ${rec.blocked}`);
    if (rec.default_action) out.push(`**Default if no answer:** ${rec.default_action}`);
  }
  return out.join('\n');
}

export function registerDecisionCommands(program, { requireCredentials, run, hint, cli }) {
  const collect = (v, prev) => { prev.push(v); return prev; };
  const post = (cred, ch, body) => api(cred, 'POST', `/v1/channels/${encodeURIComponent(ch)}/decisions`, { body });

  program
    .command('decide <channel> <decision>')
    .description('Record a decision you made, with the reasons (trace for humans; see skill references/decisions.md)')
    .option('--because <type:text>', `Reason, repeatable (1-8): ${BECAUSE_TYPES.join('|')}:<text>; prior needs a seq: prior:#12 <text>`, collect, [])
    .option('--why-notify <text>', 'Why a human should care about this decision')
    .option('--reply-to <seq>', 'Thread onto another message', Number)
    .action((chName, decision, opts) => run(async () => {
      const cred = requireCredentials();
      const because = opts.because.map(parseBecause);
      if (!because.length) throw new Error('At least one --because <type:text> is required');
      const r = await post(cred, chName, { kind: 'decision', decision, because, why_notify: opts.whyNotify, reply_to: opts.replyTo });
      console.log(`✓ Recorded decision in ${r.channel}: seq=${r.seq}  (refer to it later as prior:#${r.seq})`);
    }));

  program
    .command('handoff <channel>')
    .description('Hand a decision to the human: records the trace and PRINTS the text you must show the user in your own chat')
    .requiredOption('--question <text>', 'What the human must decide')
    .requiredOption('--why-you <text>', 'Why it has to be the human (authority, irreversible, value judgment, missing info)')
    .option('--option <label=>outcome>', 'Option with its known outcome, repeatable (2-6)', collect, [])
    .option('--recommend <A-F>', 'Which option you recommend')
    .option('--done <seq[:summary]>', 'A decision already made (repeatable); the summary is only shown to the human', collect, [])
    .option('--blocked <text>', 'What stays blocked until the human decides')
    .option('--default-action <text>', 'What you will do if there is no answer')
    .action((chName, opts) => run(async () => {
      const cred = requireCredentials();
      const options = buildOptions(opts.option, opts.recommend);
      const done = opts.done.map(parseDone);
      const body = {
        kind: 'handoff', question: opts.question, why_you: opts.whyYou,
        done_so_far: done.length ? done.map((d) => d.seq) : undefined,
        options, blocked: opts.blocked, default_action: opts.defaultAction,
      };
      const r = await post(cred, chName, body);
      const rec = JSON.parse(r.content);
      console.log(`✓ Recorded handoff in ${r.channel}: seq=${r.seq}`);
      console.log('\n----- show this to the user, in your own chat (they cannot answer inside Anotify) -----');
      console.log(humanHandoffText({ channel: r.channel, seq: r.seq, rec, done }));
      console.log('----- end -----');
      hint(`Wait for the user's answer, then record it: ${cli()} resolve ${chName} ${r.seq} --chosen <A-F> --note "<what the user said>"`);
    }));

  program
    .command('resolve <channel> <handoff-seq>')
    .description("Record the human's answer to a handoff (closes the trace)")
    .requiredOption('--note <text>', 'What the human said / why (quote or paraphrase)')
    .option('--chosen <A-F>', 'Which option the human picked')
    .option('--decided-by <who>', 'human (default) or agent (e.g. the default action ran after a timeout)', 'human')
    .action((chName, seq, opts) => run(async () => {
      const cred = requireCredentials();
      const r = await post(cred, chName, {
        kind: 'resolution', reply_to: Number(seq), chosen: opts.chosen ? String(opts.chosen).toUpperCase() : undefined,
        note: opts.note, decided_by: opts.decidedBy,
      });
      console.log(`✓ Recorded resolution of #${seq} in ${r.channel}: seq=${r.seq}`);
    }));
}
