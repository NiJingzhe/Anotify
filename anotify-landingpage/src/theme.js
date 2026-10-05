// 主题：默认跟随系统，手动切换后记住选择（localStorage）。index.html 里的内联脚本在首帧前就设好 data-theme，避免闪烁
import { useEffect, useState } from 'react';

const KEY = 'anotify.theme';
const media = () => window.matchMedia('(prefers-color-scheme: dark)');

export function resolvedTheme() {
  const saved = localStorage.getItem(KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return media().matches ? 'dark' : 'light';
}

function apply(theme) {
  document.documentElement.dataset.theme = theme;
}

export function useTheme() {
  const [theme, setTheme] = useState(resolvedTheme);
  useEffect(() => {
    apply(theme);
  }, [theme]);
  useEffect(() => {
    // 未手动选择时，跟随系统切换
    const m = media();
    const on = () => { if (!localStorage.getItem(KEY)) setTheme(m.matches ? 'dark' : 'light'); };
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(KEY, next);
    setTheme(next);
  };
  return { theme, toggle };
}
