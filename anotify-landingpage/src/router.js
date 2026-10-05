// 极简 hash 路由：#/path?query —— 静态托管无需任何服务端改写规则
import { useEffect, useState } from 'react';

function parse() {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  return { path: path || '/', query: Object.fromEntries(new URLSearchParams(qs)) };
}

export function useRoute() {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function navigate(path, { replace = false } = {}) {
  const url = '#' + path;
  if (replace) window.location.replace(url);
  else window.location.hash = path;
}

/** 登录后要回到的页面：跨「注册 → 邮件验证（新标签页）」也能保留，所以存 localStorage */
const NEXT_KEY = 'anotify.next';
export function rememberNext(path) {
  if (path) localStorage.setItem(NEXT_KEY, JSON.stringify({ path, at: Date.now() }));
}
export function takeNext(fallback = '/console') {
  try {
    const v = JSON.parse(localStorage.getItem(NEXT_KEY) ?? 'null');
    localStorage.removeItem(NEXT_KEY);
    if (v && Date.now() - v.at < 24 * 3600 * 1000 && v.path.startsWith('/')) return v.path;
  } catch {}
  return fallback;
}
