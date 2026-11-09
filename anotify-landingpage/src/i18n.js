// 极简 i18n：en / zh，无第三方依赖。
//  - 语言：localStorage('anotify.lang') > 浏览器语言（zh* → zh，其余 en）
//  - t(key, vars)：{name} 插值；vars.n === 1 且存在 `key.one` 时取单数形式；中文缺键回退英文
//  - rich(key, vars)：值里允许 <b> <em> <code> <a href="…">，变量在解析标签之后才替换（变量里的 < 不会被当成标签）
//  - tr / richText 是模块级函数（读取当前语言），供 util 等非组件代码使用；组件里用 useI18n() 订阅语言变化
import { createContext, createElement, Fragment, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import en from './locales/en.js';
import zh from './locales/zh.js';

const DICTS = { en, zh };
export const LANGS = ['en', 'zh'];
const KEY = 'anotify.lang';

export function detectLang() {
  try {
    const saved = localStorage.getItem(KEY);
    if (LANGS.includes(saved)) return saved;
  } catch { /* 隐私模式等：忽略 */ }
  const nav = (typeof navigator !== 'undefined' && (navigator.languages?.[0] || navigator.language)) || 'en';
  return /^zh/i.test(nav) ? 'zh' : 'en';
}

let current = detectLang();
export const getLang = () => current;
export const getLocale = () => (current === 'zh' ? 'zh-CN' : 'en');

function pick(dict, key, n) {
  if (n === 1 && `${key}.one` in dict) return dict[`${key}.one`];
  return dict[key];
}

function template(key, vars) {
  const n = typeof vars?.n === 'number' ? vars.n : undefined;
  return pick(DICTS[current], key, n) ?? pick(en, key, n) ?? key;
}

const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));

export function tr(key, vars) {
  return fill(template(key, vars), vars);
}

export const hasKey = (key) => key in DICTS[current] || key in en;

const TAG_SOURCE = '<(b|em|code)>(.*?)<\\/\\1>|<a href="([^"]*)">(.*?)<\\/a>';

function parse(str, vars) {
  const out = [];
  let last = 0;
  let i = 0;
  let m;
  const text = (s) => fill(s, vars);
  // 每次调用用自己的正则：带 g 标志的正则 lastIndex 是实例状态，parse 递归时共用同一个会被内层重置，
  // 外层 while 就会死循环、数组无限增长（页面一打开内存暴涨）
  const re = new RegExp(TAG_SOURCE, 'gs');
  while ((m = re.exec(str))) {
    if (m.index > last) out.push(text(str.slice(last, m.index)));
    last = re.lastIndex;
    if (m[1]) out.push(createElement(m[1], { key: i++ }, parse(m[2], vars)));
    else out.push(createElement('a', { key: i++, href: m[3] }, parse(m[4], vars)));
  }
  if (last < str.length) out.push(text(str.slice(last)));
  return out;
}

/** 带少量行内标记的文案 → React 节点 */
export function richText(key, vars) {
  return createElement(Fragment, null, ...parse(template(key, vars), vars));
}

/** API 错误：已知错误码用译文，其余显示服务端原文 */
export function errMsg(err) {
  if (!err) return '';
  const k = `err.${err.code}`;
  return hasKey(k) ? tr(k) : err.message;
}

const Ctx = createContext(null);

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(current);
  const setLang = useCallback((l) => {
    if (!LANGS.includes(l)) return;
    current = l;
    try { localStorage.setItem(KEY, l); } catch { /* 忽略 */ }
    setLangState(l);
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  }, [lang]);
  const value = useMemo(() => ({ lang, setLang }), [lang, setLang]);
  return createElement(Ctx.Provider, { value }, children);
}

/** 组件内使用：订阅语言变化，返回 t / rich / errMsg / lang / setLang / locale */
export function useI18n() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useI18n must be used inside <I18nProvider>');
  return { lang: c.lang, setLang: c.setLang, locale: getLocale(), t: tr, rich: richText, errMsg };
}
