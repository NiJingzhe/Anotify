// 决策轨迹记录的解析与摘要（DESIGN §15）。控制台只读：这里只有解析，没有任何写入
import { tr } from './i18n.js';
export const DECISION_CONTENT_TYPE = 'application/vnd.anotify.decision+json';

export const isDecision = (m) => m?.content_type === DECISION_CONTENT_TYPE;

/** 解析决策记录；内容不是合法 JSON 对象时返回 null，由调用方回退显示原文 */
export function parseDecision(m) {
  if (!isDecision(m)) return null;
  try {
    const d = JSON.parse(m.content);
    return d && typeof d === 'object' && typeof d.kind === 'string' ? d : null;
  } catch {
    return null;
  }
}

/** handoff seq → 最新一条指向它的 resolution 消息（seq 最大者为准） */
export function latestResolutions(messages) {
  const map = new Map();
  for (const m of messages) {
    const d = parseDecision(m);
    if (d?.kind !== 'resolution' || m.reply_to == null) continue;
    const prev = map.get(m.reply_to);
    if (!prev || m.seq > prev.seq) map.set(m.reply_to, m);
  }
  return map;
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 聊天视图里的单行摘要 */
export function decisionSummary(m) {
  const d = parseDecision(m);
  if (!d) return clip(String(m.content ?? ''), 120);
  if (d.kind === 'decision') return tr('dec.sum.decision', { text: clip(String(d.decision ?? ''), 110) });
  if (d.kind === 'handoff') return tr('dec.sum.handoff', { text: clip(String(d.question ?? ''), 100) });
  if (d.kind === 'resolution') {
    return tr('dec.sum.resolution', {
      of: m.reply_to != null ? tr('dec.sum.of', { n: m.reply_to }) : '',
      chose: d.chosen ? tr('dec.sum.chose', { id: d.chosen }) : '',
      text: clip(String(d.note ?? ''), 90),
    });
  }
  return clip(String(m.content ?? ''), 120);
}
