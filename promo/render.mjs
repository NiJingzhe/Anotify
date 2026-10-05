#!/usr/bin/env node
// 逐帧渲染宣传片：无头 Chrome 打开 index.html，逐帧调用 window.render(t) 并截图（CDP，Node 自带 WebSocket）
//
//   node promo/render.mjs --stills 2,6.5,8.2     # 抽几帧检查画面 → promo/out/stills/
//   node promo/render.mjs                        # 全片 30 fps → promo/out/frames/，再交给 build.sh 合成
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    fps: { type: 'string', default: '30' },
    from: { type: 'string', default: '0' },
    to: { type: 'string' },
    stills: { type: 'string' },
    chrome: { type: 'string', default: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    port: { type: 'string', default: '9334' },
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(args.chrome, [
  '--headless=new', `--remote-debugging-port=${args.port}`, '--hide-scrollbars',
  '--window-size=1920,1080', '--force-device-scale-factor=1', '--user-data-dir=/tmp/anotify-promo-chrome',
  '--enable-gpu', '--ignore-gpu-blocklist', '--allow-file-access-from-files', 'about:blank',
], { stdio: 'ignore' });
process.on('exit', () => chrome.kill());

let target;
for (let i = 0; i < 100 && !target; i++) {
  await sleep(150);
  try { target = (await (await fetch(`http://127.0.0.1:${args.port}/json`)).json()).find((t) => t.type === 'page'); } catch {}
}
if (!target) throw new Error('chrome did not start');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
  const i = ++id;
  pending.set(i, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
  ws.send(JSON.stringify({ id: i, method, params }));
});
const evaluate = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

await cdp('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await cdp('Page.enable');
await cdp('Page.navigate', { url: `${pathToFileURL(join(HERE, 'index.html')).href}?capture` });
await sleep(1500);
await evaluate('document.fonts.ready.then(() => document.fonts.size)');

async function frame(t, file) {
  // render 后等两帧，确保 WebGL 与布局都已提交
  await evaluate(`(render(${t}), new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))`);
  const shot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 92, clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 } });
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
}

if (args.stills) {
  const dir = join(HERE, 'out', 'stills');
  mkdirSync(dir, { recursive: true });
  for (const t of args.stills.split(',').map(Number)) {
    const file = join(dir, `t${t.toFixed(2)}.jpg`);
    await frame(t, file);
    console.log(file);
  }
} else {
  const fps = Number(args.fps);
  const duration = await evaluate('window.PROMO.DURATION');
  const from = Number(args.from);
  const to = Number(args.to ?? duration);
  const dir = join(HERE, 'out', 'frames');
  mkdirSync(dir, { recursive: true });
  const total = Math.round((to - from) * fps);
  const t0 = Date.now();
  for (let i = 0; i < total; i++) {
    const n = Math.round(from * fps) + i;
    await frame(n / fps, join(dir, `${String(n).padStart(5, '0')}.jpg`));
    if (i % 60 === 0) {
      const rate = (i + 1) / ((Date.now() - t0) / 1000);
      console.log(`frame ${n} / ${Math.round(to * fps)}  (${rate.toFixed(1)} fps, ~${Math.round((total - i) / rate)} s left)`);
    }
  }
  console.log(`done: ${total} frames in ${Math.round((Date.now() - t0) / 1000)} s → ${dir}`);
}
ws.close();
chrome.kill();
process.exit(0);
