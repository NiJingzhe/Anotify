#!/usr/bin/env node
// 宣传片配乐：纯代码合成的 synthwave（无采样、无版权问题）。
// 按 synthwave 的典型编曲写：100 BPM，A 小调，Am–F–C–G 每和弦一小节；
//   - 16 分音符琶音（Up：根-三-五-八度）贯穿全曲，是旋律引擎
//   - 四拍 808 底鼓（≈52 Hz）、2/4 拍 gated reverb 军鼓、带 swing 的 16 分踩镲 + 反拍开镲、乐句末下行 tom fill
//   - 八分音符推进式贝斯（根音 + 偶尔跳八度），sidechain 到底鼓，带少许滑音
//   - 主旋律：双锯齿失谐 + 滤波「绽放」，A 小调五声音阶的长音旋律，附点八分延迟 + 混响
//   - 结构：冷开场只有琶音 → 鼓与贝斯逐层进入 → 副歌主旋律 → 间奏回到琶音 → 重建 → 高八度终副歌 → slogan 重击
// 段落与 promo.js 的 SECTIONS 对齐。  node promo/music.mjs → promo/out/music.wav
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 44100;
const DUR = 64.8;
const BEAT = 0.6;
const BAR = BEAT * 4;
const S16 = BEAT / 4;
const N = Math.round(SR * DUR);

const bus = () => ({ L: new Float32Array(N), R: new Float32Array(N) });
const dry = bus();
const verb = bus();
const lead = bus();

let seed = 11;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);

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

// ---------------------------------------------------------------- 鼓

const kickTimes = [];
function kick(t0, g = 1) {
  kickTimes.push(t0);
  let ph = 0;
  add(dry, t0, 0.7, (t) => {
    const f = 52 + 110 * Math.exp(-t * 35); // 808：落到 ≈52 Hz，长尾
    ph += (2 * Math.PI * f) / SR;
    return Math.tanh(Math.sin(ph) * 1.6) * Math.exp(-t * 4.2) + (t < 0.002 ? rand() * 0.4 : 0);
  }, { gain: 0.62 * g });
}
/** sidechain：底鼓后短暂压低，制造「泵感」 */
function duck(t) {
  let g = 1;
  for (const k of kickTimes) {
    const d = t - k;
    if (d >= 0 && d < 0.45) g = Math.min(g, 1 - 0.7 * Math.exp(-d * 8));
  }
  return g;
}

/** gated reverb 军鼓：噪声与体鸣先被拉成一片大混响，约 220 ms 后硬门限切断 */
function snare(t0, g = 1) {
  let lp = 0;
  let room = 0;
  add(dry, t0, 0.26, (t) => {
    const n = rand();
    lp += 0.5 * (n - lp);
    room += 0.08 * (rand() - room);
    const hit = (n - lp * 0.4) * Math.exp(-t * 18) + Math.sin(2 * Math.PI * 180 * t) * Math.exp(-t * 22) * 0.7;
    const tail = (n * 0.55 + room * 1.2) * Math.exp(-t * 2.5) * Math.min(1, t * 60); // 2.5 s 的「混响」被门限截在 0.22 s
    const gate = t < 0.22 ? 1 : Math.max(0, 1 - (t - 0.22) / 0.035);
    return (hit + tail * 0.75) * gate;
  }, { gain: 0.34 * g, send: 0.25 });
}

function hat(t0, g = 1, open = false) {
  let prev = 0;
  add(dry, t0, open ? 0.2 : 0.045, (t) => {
    const n = rand();
    const hp = n - prev;
    prev = n;
    return hp * Math.exp(-t * (open ? 16 : 85));
  }, { gain: (open ? 0.09 : 0.07) * g, pan: open ? 0.2 : -0.2, send: 0.08 });
}

function tom(t0, m, g = 1) {
  let ph = 0;
  add(dry, t0, 0.3, (t) => {
    const f = midi(m) * (1 + 0.5 * Math.exp(-t * 25));
    ph += (2 * Math.PI * f) / SR;
    const gate = t < 0.24 ? 1 : Math.max(0, 1 - (t - 0.24) / 0.04);
    return (Math.sin(ph) * Math.exp(-t * 7) + rand() * 0.15 * Math.exp(-t * 20)) * gate;
  }, { gain: 0.38 * g, send: 0.45 });
}
/** 乐句末的下行 tom fill：小节最后一拍的三连击 */
function tomFill(tEnd, g = 1) {
  [52, 47, 43].forEach((m, i) => tom(tEnd - BEAT + (i * BEAT) / 3, m, g));
}

// ---------------------------------------------------------------- 合成器

/** 推进式贝斯：锯齿 + 方波，滤波包络，八分音符，带 30 ms 滑音，被 sidechain 压 */
let lastBass = null;
function bassNote(t0, m, len = BEAT / 2 - 0.02, g = 1) {
  const f1 = midi(m);
  const f0 = lastBass ?? f1;
  lastBass = f1;
  let ph = 0;
  let lp = 0;
  add(dry, t0, len, (t) => {
    const f = f1 + (f0 - f1) * Math.exp(-t / 0.03);
    ph += f / SR;
    const saw = (ph % 1) * 2 - 1;
    const sq = (ph % 1) < 0.5 ? 0.6 : -0.6;
    lp += (0.035 + 0.2 * Math.exp(-t * 12)) * (saw * 0.7 + sq * 0.3 - lp);
    const env = Math.min(1, t * 250) * (t > len - 0.012 ? (len - t) / 0.012 : 1);
    return lp * env * duck(t0 + t);
  }, { gain: 0.5 * g });
}

/** 琶音：开头那种铃声拨弦（正弦 + 一点方波），短衰减、左右交替、送混响 */
function arpNote(t0, m, g = 1, pan = 0) {
  const f = midi(m);
  add(dry, t0, 0.45, (t) => {
    const env = Math.exp(-t * 9) * Math.min(1, t * 500);
    return (Math.sin(2 * Math.PI * f * t) * 0.75 + Math.sign(Math.sin(2 * Math.PI * f * t)) * 0.1) * env;
  }, { gain: 0.15 * g, pan, send: 0.55 });
}

/** 主旋律：双锯齿 ±12 音分 + 慢速合唱，滤波在起音后「绽放」，渐入颤音，音符间滑音；送延迟与混响 */
let lastLead = null;
function leadNote(t0, m, beats, g = 1) {
  const len = beats * BEAT;
  const f1 = midi(m);
  const f0 = lastLead ?? f1;
  lastLead = f1;
  let p1 = Math.random();
  let p2 = Math.random();
  let p3 = Math.random();
  let lp = 0;
  let lp2 = 0;
  add(lead, t0, len + 0.35, (t) => {
    const glide = f1 + (f0 - f1) * Math.exp(-t / 0.04);
    const vib = 1 + 0.005 * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, Math.max(0, (t - 0.25) / 0.4));
    const chorus = 1 + 0.002 * Math.sin(2 * Math.PI * 0.7 * t);
    p1 += (glide * vib * 1.007 * chorus) / SR;
    p2 += (glide * vib * 0.993) / SR;
    p3 += (glide * vib * 0.5) / SR; // 低八度方波加厚
    const v = ((p1 % 1) * 2 - 1) * 0.5 + ((p2 % 1) * 2 - 1) * 0.5 + ((p3 % 1) < 0.5 ? 0.18 : -0.18);
    const cutoff = 0.05 + 0.22 * Math.min(1, t / 0.18); // 滤波「绽放」
    lp += cutoff * (v - lp);
    lp2 += cutoff * (lp - lp2);
    const env = Math.min(1, t / 0.03) * (t < len ? 1 : Math.max(0, 1 - (t - len) / 0.35));
    return lp2 * env;
  }, { gain: 0.42 * g });
}

function riser(t0, len, g = 1) {
  let lp = 0;
  add(dry, t0, len, (t) => {
    const k = t / len;
    lp += (0.01 + 0.45 * k * k) * (rand() - lp);
    return lp * k * k;
  }, { gain: 0.5 * g, send: 0.5 });
}

function impact(t0) {
  kick(t0, 1.3);
  snare(t0, 1.2);
  let lp = 0;
  add(dry, t0, 3.0, (t) => {
    lp += 0.2 * (rand() - lp);
    return lp * Math.exp(-t * 1.8) * 0.7 + Math.sin(2 * Math.PI * 41 * t) * Math.exp(-t * 2.0);
  }, { gain: 0.5, send: 0.9 });
}

/** 开头大字的「叮」，也用于收尾回呼 */
function chime(t0, g = 1) {
  for (const [m, p] of [[81, -0.4], [88, 0.4]]) {
    add(dry, t0, 1.8, (t) => Math.sin(2 * Math.PI * midi(m) * t) * Math.exp(-t * 3.0), { gain: 0.09 * g, pan: p, send: 1.0 });
  }
}

// ---------------------------------------------------------------- 和声与旋律

// Am F C G，每和弦 1 小节（2.4 s）；琶音 Up 模式：根-三-五-八度，跨两个八度
const CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
const ROOTS = [45, 41, 36, 43];
const chordAt = (t) => Math.floor(t / BAR + 1e-6) % 4;
const arpPattern = (c) => [c[0], c[1], c[2], c[0] + 12, c[1] + 12, c[2] + 12, c[0] + 24, c[2] + 12];

// 主旋律（A 小调五声音阶为主，长音、好唱）：[起拍, MIDI, 拍数]，每段 4 小节 = 16 拍
const PHRASE_A = [
  [0, 69, 1.5], [1.5, 72, 0.5], [2, 76, 2],               // Am：A → C → E（上行）
  [4, 74, 1.5], [5.5, 72, 0.5], [6, 69, 2],               // F ：D → C → A
  [8, 67, 1], [9, 72, 1], [10, 76, 1.5], [11.5, 79, 0.5], // C ：G → C → E → G
  [12, 76, 3], [15, 74, 1],                               // G ：长 E，D 引回
];
const PHRASE_B = [
  [0, 81, 2], [2, 79, 1], [3, 76, 1],                     // Am：高 A → G → E
  [4, 79, 1.5], [5.5, 76, 0.5], [6, 74, 2],               // F ：G → E → D
  [8, 76, 1.5], [9.5, 74, 0.5], [10, 72, 2],              // C ：E → D → C
  [12, 74, 2], [14, 71, 1], [15, 74, 1],                  // G ：D → B → D（回到 A）
];
function phrase(start, notes, transpose = 0, g = 1, until = Infinity) {
  for (const [b, m, d] of notes) {
    const t0 = start + b * BEAT;
    if (t0 >= until) continue;
    leadNote(t0, m + transpose, Math.min(d, (until - t0) / BEAT), g);
  }
}

// ---------------------------------------------------------------- 编曲（与画面段落对齐）

const T = {
  usage: 4.8,      // 用法：鼓与贝斯逐层进入
  bass: 7.2,
  hats: 9.6,
  snare: 12.0,
  chorus: 19.2,    // 场景①起：副歌，主旋律进入
  breakdown: 38.4, // 圆桌附近：回到只有琶音
  rebuild: 43.2,
  finale: 48.0,    // 高八度终副歌
  outro: 55.2,     // 快闪四个词
  hit: 58.8,       // 「A Notify.」
};

// 琶音：从第一秒到结尾贯穿全曲
for (let t = 0; t < DUR - 2.4; t += S16) {
  const i = Math.round(t / S16);
  const ramp = t < 4.8 ? 0.6 + 0.4 * (t / 4.8) : 1;
  const inBreak = t >= T.breakdown && t < T.rebuild ? 1.15 : 1;
  const fadeOut = t >= T.hit ? Math.max(0.15, 1 - (t - T.hit) / 5) : 1;
  arpNote(t, arpPattern(CHORDS[chordAt(t)])[i % 8] + 12, ramp * inBreak * fadeOut, i % 2 ? 0.45 : -0.45);
}
// 开头大字的「叮」
for (const t of [0, 1.2, 2.4, 3.0, 3.6, 4.2]) chime(t, t < 2.4 ? 0.8 : 1);
riser(3.6, 1.2, 0.5);

const drumsOn = (t) => t >= T.usage && t < T.outro && !(t >= T.breakdown && t < T.rebuild);
for (let t = 0; t < T.outro - 1e-6; t += BEAT) {
  const b = Math.round(t / BEAT) % 4;
  if (drumsOn(t)) kick(t, t < T.bass ? 0.85 : 1);
  if (t >= T.snare && drumsOn(t) && (b === 1 || b === 3) && !(t >= T.rebuild && t < T.rebuild + BAR)) snare(t);
  const hatsOn = t >= T.hats && drumsOn(t) && !(t >= T.rebuild && t < T.rebuild + BAR); // 重建第一小节只有底鼓
  if (hatsOn) {
    for (let k = 0; k < 4; k++) {
      if (k === 2) continue; // 开镲占位
      const swing = k % 2 ? S16 * 0.08 : 0; // 8% swing
      hat(t + k * S16 + swing);
    }
    hat(t + BEAT / 2, 1, true); // 反拍开镲
  }
  if (t >= T.bass && drumsOn(t)) {
    const root = ROOTS[chordAt(t)];
    bassNote(t, root, undefined, t < T.snare ? 0.8 : 1);
    bassNote(t + BEAT / 2, root + (b === 3 ? 12 : 0), undefined, t < T.snare ? 0.7 : 0.9);
  }
}
// 乐句末 tom fill
for (const t of [T.chorus, 28.8, T.breakdown, T.finale]) tomFill(t);
// 「Copy. Paste. Done.」三拍：gated 军鼓重音
for (const t of [16.8, 17.4, 18.0]) { snare(t, 1.1); chime(t, 0.6); }
// 副歌主旋律：A 段 → B 段；间奏无旋律；终副歌 B 段高八度 + 原八度叠加
phrase(T.chorus, PHRASE_A);
phrase(T.chorus + 4 * BAR, PHRASE_B, 0, 1, T.breakdown);
riser(T.rebuild + BAR, BAR, 0.6);
phrase(T.finale, PHRASE_B, 12, 0.8, T.outro);
phrase(T.finale, PHRASE_B, 0, 0.55, T.outro);

// 收尾：四个词各一拍的军鼓 + 底鼓；抽空上扬；重击后旋律尾音与开头的「叮」回呼
for (let t = T.outro; t < T.outro + BAR - 1e-6; t += BEAT) { kick(t, 1.05); snare(t, 1.0); bassNote(t, 43); bassNote(t + BEAT / 2, 55); }
riser(T.outro + BAR, T.hit - T.outro - BAR, 0.9);
impact(T.hit);
leadNote(T.hit, 81, 4, 0.9);
leadNote(T.hit, 76, 4, 0.45);
chime(T.hit, 1.0);
for (let t = T.hit + BAR; t < DUR - 2.0; t += BEAT) { kick(t, 0.35); bassNote(t, 45, undefined, 0.5); }

// ---------------------------------------------------------------- 效果：主旋律附点八分延迟、Schroeder 混响

{
  const d = Math.round(BEAT * 0.75 * SR); // 附点八分 = 0.45 s
  for (let i = d; i < N; i++) {
    lead.L[i] += lead.R[i - d] * 0.36;
    lead.R[i] += lead.L[i - d] * 0.36;
  }
  for (let i = 0; i < N; i++) {
    dry.L[i] += lead.L[i];
    dry.R[i] += lead.R[i];
    verb.L[i] += lead.L[i] * 0.5;
    verb.R[i] += lead.R[i] * 0.5;
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
      lp += 0.4 * (prev - lp);
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
const wetL = schroeder(verb.L, [29.7, 37.1, 41.1, 43.7], 0.84);
const wetR = schroeder(verb.R, [30.5, 36.3, 40.7, 44.9], 0.84);

// ---------------------------------------------------------------- 母带

const L = new Float32Array(N);
const R = new Float32Array(N);
let peak = 0;
for (let i = 0; i < N; i++) {
  const fade = i > (DUR - 2.5) * SR ? (N - i) / (2.5 * SR) : 1;
  L[i] = Math.tanh((dry.L[i] + wetL[i] * 0.5) * 1.15) * fade;
  R[i] = Math.tanh((dry.R[i] + wetR[i] * 0.5) * 1.15) * fade;
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const norm = 0.8 / peak;
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
