// PostHog 埋点（留存 / 活跃 / 用户行为动线）。
// key 是公开的项目令牌，可安全进入前端构建；未配置 key 时全部 API 静默 no-op。
// 隐私：mask_all_text —— 消息类产品，DOM 文本（消息内容）一律不入分析库；
// 自定义事件只携带行为语义（频道名、是否含密码等非敏感字段）。
import posthog from 'posthog-js';

const KEY = 'phc_CXUeX8FfKHvoD8sv5AJ7DTJ96XBiDT6vXuuQqAHtf9ZJ';
const HOST = 'https://us.i.posthog.com';

let inited = false;
let lastPath = null;
let enteredAt = 0; // 当前路径的进入时刻（可见状态），配合 $pageleave 得出每屏停留时长

const url = (path) => `${location.origin}/#${path}`;

function capturePageleave() {
  if (!inited || lastPath == null || !enteredAt) return;
  posthog.capture('$pageleave', {
    $current_url: url(lastPath),
    path: lastPath,
    seconds_on_path: Math.round((Date.now() - enteredAt) / 1000),
  });
  enteredAt = 0;
}

export function initAnalytics() {
  if (inited) return;
  inited = true;
  posthog.init(KEY, {
    api_host: HOST,
    autocapture: true,
    capture_pageview: false, // hash 路由：pageview/pageleave 由下面手动成对发送
    mask_all_text: true,     // 消息内容不入库
    persistence: 'localStorage+cookie',
  });
  // 切走标签页 / 关页：把最后一段停留补发出去（session 时长的尾巴精度）
  window.addEventListener('pagehide', capturePageleave);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') capturePageleave();
    else if (lastPath != null) enteredAt = Date.now(); // 回来续表
  });
}

/** hash 路由的手动 pageview：先补发上一屏的 pageleave，再发新 pageview（连续同路径去重） */
export function capturePageview(path) {
  if (!inited) return;
  if (path !== lastPath) capturePageleave();
  lastPath = path;
  enteredAt = Date.now();
  posthog.capture('$pageview', { $current_url: url(path), path });
}

export function identifyUser(userId, props = {}) {
  if (!inited || userId == null) return;
  posthog.identify(String(userId), props);
}

/** 登出 / 未登录态：清掉本地身份（避免下一个登录者的事件串号） */
export function resetAnalytics() {
  if (!inited) return;
  lastPath = null;
  enteredAt = 0;
  posthog.reset();
}

export function track(name, props = {}) {
  if (!inited) return;
  posthog.capture(name, props);
}
