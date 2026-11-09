// 展示用小工具
import { tr, getLocale } from './i18n.js';

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 非安全上下文 / 旧浏览器兜底
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

export function humanSize(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n;
  let i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function relTime(ts) {
  if (!ts) return '—';
  const s = Date.now() / 1000 - ts;
  if (s < 60) return tr('time.now');
  const rtf = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'always', style: 'short' });
  if (s < 3600) return rtf.format(-Math.floor(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.floor(s / 3600), 'hour');
  if (s < 86400 * 30) return rtf.format(-Math.floor(s / 86400), 'day');
  return new Date(ts * 1000).toLocaleDateString(getLocale());
}

export function clockTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });
}

export function dayLabel(ts) {
  const d = new Date(ts * 1000);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return tr('time.today');
  if (d.toDateString() === yesterday.toDateString()) return tr('time.yesterday');
  return d.toLocaleDateString(getLocale(), { year: 'numeric', month: 'short', day: 'numeric' });
}

/** 名字 → 稳定的色相，用于发送者着色 */
export function nameHue(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 360;
}

export const FILE_CONTENT_TYPE = 'application/vnd.anotify.file+json';

export function fileMeta(m) {
  if (m.content_type !== FILE_CONTENT_TYPE) return null;
  try {
    return JSON.parse(m.content);
  } catch {
    return null;
  }
}

export function joinInstruction(channel, skill, server, password) {
  return password
    ? `Read ${skill} and join my Anotify channel ${channel} (password ${password}, server ${server}).`
    : `Read ${skill} and join my Anotify channel ${channel} (server ${server}).`;
}
