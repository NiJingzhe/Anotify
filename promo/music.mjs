#!/usr/bin/env node
// 宣传片配乐：纯代码合成的空灵 synthwave（无采样、无版权问题）。
// 100 BPM，A 小调，Am–F–C–G 走在低音与琶音上（不铺和弦）；sidechain 脉冲贝斯、gated reverb 军鼓、闪烁琶音，主旋律用与开头 chime 同款的铃声音色，带延迟与长混响。
// 段落与 promo.js 的镜头切点对齐。  node promo/music.mjs → promo/out/music.wav
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 44100;
const DUR = 64.8;
const BEAT = 0.6;
const BAR = BEAT * 4;
const S16 = BEAT / 4;
const N = Math.round(SR * DUR);

// 三条总线：干声、混响发送、主旋律（先过延迟再进干声与混响）
const bus = () => ({ L: new Float32Array(N), R: new Float32Array(N) });
const dry = bus();
const verb = bus();
const lead = bus();

let seed = 11;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** 写入总线：fn(t) 返回单声道样本；send 为混响发送量 */
function add(target, t0, len, fn, { gain = 1, pan = 0, send = 0 } = {}) {
  const s0 = Math.floor(t0 * SR);
  const n = Math.floor(len * SR);
  const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
  const gr = gain * Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
  for (let i = 0; i < n; i++) {
    const j = s0 + i;
    if (j < 0 || j >= N) continue;
    const v = fn(i / SR);
    target.L[j] += v * gl;
    target.R[j] += v * gr;
    if (send) {
      verb.L[j] += v * gl * send;
      verb.R[j] += v * gr * send;
    }
  }
}

// ---------------------------------------------------------------- 底鼓与 sidechain

const kickTimes = [];
function kick(t0, g = 1) {
  kickTimes.push(t0);
  let ph = 0;
  add(dry, t0, 0.5, (t) => {
    const f = 42 + 95 * Math.exp(-t * 30);
    ph += (2 * Math.PI * f) / SR;
    return Math.sin(ph) * Math.exp(-t * 6.5) + (t < 0.003 ? rand() * 0.3 : 0);
  }, { gain: 0.9 * g });
}
/** sidechain 增益：底鼓后短暂压低（贝斯 / pad 的「呼吸」） */
function duck(t) {
  let g = 1;
  for (const k of kickTimes) {
    const d = t - k;
    if (d >= 0 && d < 0.4) g = Math.min(g, 1 - 0.65 * Math.exp(-d * 9));
  }
  return g;
}

// ---------------------------------------------------------------- 音色

function snare(t0, g = 1) {
  // 80 年代 gated reverb 军鼓：噪声 + 体鸣，送大量混响，0.32 s 处硬门限
  let lp = 0;
  add(dry, t0, 0.34, (t) => {
    const n = rand();
    lp += 0.55 * (n - lp);
    const gate = t < 0.3 ? 1 : (0.34 - t) / 0.04;
    return ((n - lp * 0.5) * Math.exp(-t * 7) + Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t * 25) * 0.6) * gate;
  }, { gain: 0.32 * g, send: 0.9 });
}

function hat(t0, g = 1) {
  let prev = 0;
  add(dry, t0, 0.05, (t) => {
    const n = rand();
    const hp = n - prev;
    prev = n;
    return hp * Math.exp(-t * 80);
  }, { gain: 0.08 * g, pan: Math.round(t0 / 0.25) % 2 ? 0.3 : -0.3, send: 0.15 });
}

/** supersaw pad：5 个失谐锯齿 + 一阶低通，慢起音，跟随 sidechain */
function pad(t0, len, notes, g = 1, attack = 0.7) {
  const voices = [];
  for (const m of notes) for (const d of [-0.12, -0.06, 0, 0.06, 0.12]) voices.push({ f: midi(m + d), ph: Math.random() });
  for (const [side, pan] of [[0, -0.5], [1, 0.5]]) {
    let lp = 0;
    const vs = voices.filter((_, i) => i % 2 === side);
    add(dry, t0, len, (t) => {
      let v = 0;
      for (const o of vs) {
        o.ph += o.f / SR;
        v += (o.ph % 1) * 2 - 1;
      }
      v /= vs.length;
      lp += 0.06 * (v - lp);
      const env = Math.min(1, t / attack) * Math.min(1, (len - t) / 0.9);
      return lp * env * duck(t0 + t);
    }, { gain: 0.36 * g, pan, send: 0.7 });
  }
}

/** 脉冲贝斯：锯齿 + 滤波包络，八分音符，被 sidechain 压 */
function bassNote(t0, m, len = 0.24, g = 1) {
  let ph = 0;
  let lp = 0;
  const f = midi(m);
  add(dry, t0, len, (t) => {
    ph += f / SR;
    const saw = (ph % 1) * 2 - 1;
    lp += (0.04 + 0.22 * Math.exp(-t * 14)) * (saw - lp);
    const env = Math.min(1, t * 300) * (t > len - 0.015 ? (len - t) / 0.015 : 1);
    return lp * env * duck(t0 + t);
  }, { gain: 0.42 * g });
}

/** 琶音铃声：方波 + 正弦，短衰减，左右交替，送混响 */
function arpNote(t0, m, g = 1, pan = 0) {
  const f = midi(m);
  add(dry, t0, 0.5, (t) => {
    const env = Math.exp(-t * 7);
    return (Math.sin(2 * Math.PI * f * t) * 0.7 + Math.sign(Math.sin(2 * Math.PI * f * t)) * 0.12) * env * Math.min(1, t * 400);
  }, { gain: 0.11 * g, pan, send: 0.8 });
}

/** 主旋律：与开头 chime 同一种铃声音色（正弦 + 起音处轻微 FM 亮度），自然余韵，写入 lead 总线（之后加延迟与混响） */
function leadNote(t0, m, beats, g = 1) {
  const f = midi(m);
  const len = Math.max(beats * BEAT, 0.3) + 1.8; // 让余韵自然散开
  add(lead, t0, len, (t) => {
    const env = Math.min(1, t * 400) * Math.exp(-t * 2.0);
    const fm = Math.sin(2 * Math.PI * f * 2 * t) * 0.9 * Math.exp(-t * 7);
    return Math.sin(2 * Math.PI * f * t + fm) * 0.85 * env + Math.sin(2 * Math.PI * f * 3 * t) * 0.06 * Math.exp(-t * 5);
  }, { gain: 0.24 * g });
}

function riser(t0, len, g = 1) {
  let lp = 0;
  add(dry, t0, len, (t) => {
    const k = t / len;
    lp += (0.01 + 0.4 * k * k) * (rand() - lp);
    return lp * k * k;
  }, { gain: 0.55 * g, send: 0.6 });
}

function impact(t0) {
  kick(t0, 1.3);
  let lp = 0;
  add(dry, t0, 3.5, (t) => {
    lp += 0.2 * (rand() - lp);
    return lp * Math.exp(-t * 1.8) * 0.8 + Math.sin(2 * Math.PI * 36 * t) * Math.exp(-t * 2.2);
  }, { gain: 0.5, send: 1.0 });
}

function chime(t0, g = 1) {
  // 大字出现时的空灵「叮」：高八度五度叠加，长混响
  for (const [m, p] of [[81, -0.4], [88, 0.4]]) {
    add(dry, t0, 1.6, (t) => Math.sin(2 * Math.PI * midi(m) * t) * Math.exp(-t * 3.2), { gain: 0.09 * g, pan: p, send: 1.0 });
  }
}

// ---------------------------------------------------------------- 编曲

// 和弦（MIDI）：Am F C G，每和弦 1 小节 = 2.4 s
const CHORDS = [[57, 60, 64, 69], [53, 57, 60, 65], [48, 55, 60, 64], [55, 59, 62, 67]];
const ROOTS = [45, 41, 36, 43];
const chordAt = (t) => Math.floor(t / BAR + 1e-6) % 4;

// 主旋律动机（拍为单位：[起拍, 音, 时值]），每 4 小节一轮
const MOTIF = [
  [0, 76, 1], [1, 74, 0.5], [1.5, 72, 0.5], [2, 69, 2],
  [4, 72, 1], [5, 69, 0.5], [5.5, 72, 0.5], [6, 77, 2],
  [8, 76, 1.5], [9.5, 79, 0.5], [10, 76, 1], [11, 74, 1],
  [12, 74, 1], [13, 71, 1], [14, 74, 0.5], [14.5, 76, 1.5],
];

// 段落（与 promo.js 的 SECTIONS 一致）
const USAGE = 4.8;   // 复制 → 粘贴 → 完成
const SCENES = 19.2; // 场景①–④
const OUTRO = 55.2;  // 快闪 + slogan
const HIT = 58.8;    // 「A Notify.」落点

// intro 0–4.8 s：pad 渐起 + 大字 chime + 琶音
for (const t of [0, 1.2, 2.4, 3.0, 3.6, 4.2]) { chime(t, t < 2.4 ? 0.8 : 1); kick(t, 0.5); }
for (let i = 0; i < 32; i++) arpNote(i * S16, CHORDS[0][i % 4] + 12, 0.6 + 0.4 * (i / 32), i % 2 ? 0.4 : -0.4);
riser(3.6, 1.2, 0.6);

// 正片 4.8–55.2 s：用法段只有底鼓与踩镲（轻），9.6 s 起军鼓加入
for (let t = USAGE; t < OUTRO - 1e-6; t += BEAT) {
  const b = Math.round(t / BEAT) % 4;
  kick(t, t < 9.6 ? 0.8 : 1);
  if (t >= 9.6 && (b === 1 || b === 3)) snare(t);
  hat(t + BEAT / 2, b === 3 ? 1.4 : 1);
  const root = ROOTS[chordAt(t)];
  bassNote(t, root, 0.28, t < 9.6 ? 0.7 : 1);
  bassNote(t + BEAT / 2, root + (b === 3 ? 12 : 0), 0.26, t < 9.6 ? 0.6 : 0.85);
}
// 16 分琶音从 9.6 s 起
for (let t = 9.6; t < OUTRO - 1e-6; t += S16) {
  const c = CHORDS[chordAt(t)];
  const i = Math.round(t / S16);
  arpNote(t, c[[0, 1, 2, 3, 2, 1][i % 6]] + 12, 0.75, i % 2 ? 0.45 : -0.45);
}
// 「Copy. Paste. Done.」三拍：叮 + 重音
for (const t of [16.8, 17.4, 18.0]) { chime(t, 0.9); kick(t, 0.6); }
// 主旋律：场景段起，每 4 小节一轮，最后一轮高八度
for (const [start, sparkle] of [[SCENES, false], [SCENES + 4 * BAR, false], [SCENES + 8 * BAR, false], [SCENES + 12 * BAR, true]]) {
  for (const [b, m, d] of MOTIF) {
    const t0 = start + b * BEAT;
    if (t0 >= OUTRO) continue;
    leadNote(t0, m + 12, d);
    if (sparkle) leadNote(t0, m + 24, d, 0.3);
  }
}
for (const c of [SCENES, 30.0, 37.2, 44.4]) riser(c - 1.2, 1.2, 0.45);

// 55.2–57.6 s：快闪段，军鼓八分滚奏推高
for (let t = OUTRO; t < OUTRO + BAR - 1e-6; t += BEAT) { kick(t, 1.05); bassNote(t, 45); bassNote(t + BEAT / 2, 57, 0.26, 0.8); }
for (let t = OUTRO; t < OUTRO + BAR - 1e-6; t += BEAT / 2) snare(t, 0.55 + 0.45 * ((t - OUTRO) / BAR));
// 57.6–58.8 s：抽空，只剩 pad 与上扬
riser(OUTRO + BAR, HIT - OUTRO - BAR, 0.9);
// 58.8 s：「A Notify.」重击 + A 大三和弦长铺底 + 旋律尾音在混响里散开
impact(HIT);
leadNote(HIT, 81, 6, 1.0);
leadNote(HIT, 88, 6, 0.7);
leadNote(HIT + 1.2, 76, 4, 0.5);
for (let t = HIT + 2 * BEAT; t < DUR - 1.5; t += BEAT) { kick(t, 0.35); hat(t + BEAT / 2, 0.6); }
for (let i = 0; i < 16; i++) arpNote(HIT + 1.2 + i * S16, [69, 73, 76, 81][i % 4] + 12, 0.6 * (1 - i / 18), i % 2 ? 0.5 : -0.5);

// ---------------------------------------------------------------- 效果：主旋律延迟、Schroeder 混响

// 附点八分（0.375 s）乒乓延迟
{
  const d = Math.round(0.375 * SR);
  for (let i = d; i < N; i++) {
    lead.L[i] += lead.R[i - d] * 0.38;
    lead.R[i] += lead.L[i - d] * 0.38;
  }
  for (let i = 0; i < N; i++) {
    dry.L[i] += lead.L[i];
    dry.R[i] += lead.R[i];
    verb.L[i] += lead.L[i] * 0.85;
    verb.R[i] += lead.R[i] * 0.85;
  }
}

function schroeder(input, combDelays, fb) {
  const out = new Float32Array(N);
  for (const ms of combDelays) {
    const d = Math.round((ms / 1000) * SR);
    const buf = new Float32Array(N);
    let lp = 0;
    for (let i = 0; i < N; i++) {
      const prev = i >= d ? buf[i - d] : 0;
      lp += 0.35 * (prev - lp); // 阻尼：越晚越暗
      buf[i] = input[i] + lp * fb;
      out[i] += prev;
    }
  }
  for (const [ms, g] of [[5.0, 0.7], [1.7, 0.7]]) {
    const d = Math.round((ms / 1000) * SR);
    const x = Float32Array.from(out);
    for (let i = 0; i < N; i++) out[i] = -g * x[i] + (i >= d ? x[i - d] + g * out[i - d] : 0);
  }
  for (let i = 0; i < N; i++) out[i] /= combDelays.length;
  return out;
}
const wetL = schroeder(verb.L, [29.7, 37.1, 41.1, 43.7], 0.86);
const wetR = schroeder(verb.R, [30.5, 36.3, 40.7, 44.9], 0.86);

// ---------------------------------------------------------------- 母带

const L = new Float32Array(N);
const R = new Float32Array(N);
let peak = 0;
for (let i = 0; i < N; i++) {
  const fade = i > (DUR - 2.0) * SR ? (N - i) / (2.0 * SR) : 1;
  L[i] = Math.tanh((dry.L[i] + wetL[i] * 0.55) * 1.05) * fade;
  R[i] = Math.tanh((dry.R[i] + wetR[i] * 0.55) * 1.05) * fade;
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
