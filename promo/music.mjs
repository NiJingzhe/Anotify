#!/usr/bin/env node
// 宣传片配乐：纯代码合成（无采样、无版权问题）。120 BPM，A 小调，Am–F–C–G，与 promo.js 的镜头切点对齐。
//   node promo/music.mjs → promo/out/music.wav
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 44100;
const DUR = 40;
const BEAT = 0.5;
const N = SR * DUR;
const L = new Float32Array(N);
const R = new Float32Array(N);

let seed = 7;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;

function add(t0, len, fn, gain = 1, pan = 0) {
  const s0 = Math.floor(t0 * SR);
  const n = Math.floor(len * SR);
  const gl = gain * Math.min(1, 1 - pan);
  const gr = gain * Math.min(1, 1 + pan);
  for (let i = 0; i < n && s0 + i < N; i++) {
    if (s0 + i < 0) continue;
    const v = fn(i / SR);
    L[s0 + i] += v * gl;
    R[s0 + i] += v * gr;
  }
}

// ---- 音色
function kick(t0, g = 1) {
  let ph = 0;
  add(t0, 0.45, (t) => {
    const f = 45 + 110 * Math.exp(-t * 28);
    ph += (2 * Math.PI * f) / SR;
    return Math.sin(ph) * Math.exp(-t * 7) + (t < 0.004 ? rand() * 0.5 : 0);
  }, 0.95 * g);
}
function clap(t0, g = 1) {
  let lp = 0;
  add(t0, 0.25, (t) => {
    const n = rand();
    lp += 0.45 * (n - lp);
    const bursts = t < 0.03 ? 0.6 + 0.4 * Math.sin(t * 900) : 1;
    return (n - lp) * Math.exp(-t * 16) * bursts + Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 30) * 0.3;
  }, 0.42 * g);
}
function hat(t0, g = 1, open = false) {
  let prev = 0;
  add(t0, open ? 0.25 : 0.06, (t) => {
    const n = rand();
    const hp = n - prev;
    prev = n;
    return hp * Math.exp(-t * (open ? 14 : 70));
  }, 0.16 * g, (Math.round(t0 / 0.25) % 2 ? 0.25 : -0.25));
}
function bass(t0, freq, len, g = 1) {
  let lp = 0;
  add(t0, len, (t) => {
    let v = 0;
    for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * freq * h * t) / h;
    const cutoff = 0.08 + 0.25 * Math.exp(-t * 9);
    lp += cutoff * (v - lp);
    const env = Math.min(1, t * 200) * Math.exp(-t * 3.5) * (t > len - 0.02 ? (len - t) / 0.02 : 1);
    return lp * env;
  }, 0.33 * g);
}
function pad(t0, len, freqs, g = 1) {
  add(t0, len, (t) => {
    let v = 0;
    freqs.forEach((f, i) => {
      for (const d of [-0.004, 0.004]) v += Math.sin(2 * Math.PI * f * (1 + d) * t + i) * 0.5;
    });
    const env = Math.min(1, t / 0.6) * Math.min(1, (len - t) / 0.8);
    return (v / freqs.length) * env;
  }, 0.16 * g);
}
function riser(t0, len, g = 1) {
  let lp = 0;
  add(t0, len, (t) => {
    const k = t / len;
    lp += (0.02 + 0.5 * k * k) * (rand() - lp);
    return lp * k * k * 1.6;
  }, 0.5 * g);
}
function impact(t0, g = 1) {
  kick(t0, 1.3 * g);
  let lp = 0;
  add(t0, 2.4, (t) => {
    lp += 0.25 * (rand() - lp);
    return lp * Math.exp(-t * 2.2) + Math.sin(2 * Math.PI * 38 * t) * Math.exp(-t * 2.5) * 0.8;
  }, 0.55 * g);
}
function swoosh(t0, g = 1) {
  // 反向噪声：大字出现前的「嗖」
  let lp = 0;
  add(t0 - 0.22, 0.22, (t) => {
    lp += 0.2 * (rand() - lp);
    return lp * Math.pow(t / 0.22, 2.5);
  }, 0.55 * g);
}

// ---- 编曲
const A2 = 110, F2 = 87.31, C3 = 130.81, G2 = 98;
const roots = [A2, F2, C3, G2];
const chords = [[220, 261.63, 329.63], [174.61, 220, 261.63], [261.63, 329.63, 392], [196, 246.94, 293.66]];
const barAt = (t) => Math.floor(t / 2) % 4;

// intro：大字 hits + 铺底
pad(0, 4.2, chords[0], 0.9);
for (const t of [0, 1, 2, 2.5, 3, 3.5]) { swoosh(t); kick(t, 0.9); clap(t, t >= 2 ? 0.8 : 0.5); }
riser(3.0, 1.0, 0.7);

// 正片 4–32 s：四拍底鼓 + 2/4 拍拍手 + 八分踩镲 + 低音
for (let t = 4; t < 32 - 1e-6; t += BEAT) {
  const beatInBar = Math.round(t / BEAT) % 4;
  kick(t);
  if (beatInBar === 1 || beatInBar === 3) clap(t);
  hat(t + 0.25, 1, beatInBar === 3);
  if (t >= 12) hat(t + 0.125, 0.55);
  const root = roots[barAt(t)];
  bass(t, root, 0.22, 1);
  bass(t + 0.25, root * (beatInBar === 3 ? 1.5 : 2), 0.2, 0.8);
}
for (let bar = 2; bar < 16; bar++) pad(bar * 2, 2.05, chords[bar % 4], 0.55);
// 转场前的上扬
for (const c of [12, 18, 22, 26]) riser(c - 1, 1, 0.55);

// 收尾 32–34：每拍加强的快闪
for (let t = 32; t < 34 - 1e-6; t += BEAT) { kick(t, 1.1); clap(t, 1.1); swoosh(t, 0.8); }
for (let t = 32; t < 34 - 1e-6; t += 0.125) hat(t, 0.8);
// 34–35：抽空 + 上扬，35 s「A Notify.」重击
riser(34.0, 1.0, 1.0);
pad(34, 1.0, chords[0], 0.6);
impact(35.0);
pad(35.0, 5.0, [220, 277.18, 329.63, 440], 1.1); // A 大三和弦：收在明亮处
for (let t = 36; t < 39 - 1e-6; t += BEAT) { kick(t, 0.45); hat(t + 0.25, 0.5); }

// ---- 母带：软削波 + 归一化 + 尾部淡出
let peak = 0;
for (let i = 0; i < N; i++) {
  const fade = i > (DUR - 1.2) * SR ? (N - i) / (1.2 * SR) : 1;
  L[i] = Math.tanh(L[i] * 1.1) * fade;
  R[i] = Math.tanh(R[i] * 1.1) * fade;
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const norm = 0.89 / peak;
const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  buf.writeInt16LE(Math.round(L[i] * norm * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(R[i] * norm * 32767), 46 + i * 4);
}
const out = join(dirname(fileURLToPath(import.meta.url)), 'out', 'music.wav');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, buf);
console.log(`wrote ${out}`);
