// Anotify 宣传片：render(t) 是画面的纯函数（t 单位秒）。120 BPM，一拍 0.5 s，全长 40 s。
// 结构（拍号）：intro 0-8 · 用法 8-24 · 场景① 24-36 · 场景② 36-44 · 场景③ 44-52 · 场景④ 52-64 · 收尾 64-80
'use strict';

const BEAT = 0.5;
const DURATION = 40;
const W = 1920;
const H = 1080;

// ---------------------------------------------------------------- 工具

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, k) => a + (b - a) * k;
const seg = (t, a, b) => clamp((t - a) / (b - a));
const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const easeOut = (k) => 1 - Math.pow(1 - k, 3);
const easeOutBack = (k) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
};

const stage = document.getElementById('stage');

function el(tag, cls, html, parent = stage, style = {}) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  Object.assign(e.style, style);
  parent.appendChild(e);
  return e;
}

/** 弹入 / 淡出：tin 弹入，tout 前 0.15 s 收起 */
function pop(e, t, tin, tout = Infinity, { dy = 26, s0 = 0.86, dur = 0.28 } = {}) {
  const kin = easeOutBack(seg(t, tin, tin + dur));
  const kout = seg(t, tout - 0.15, tout);
  const o = clamp(seg(t, tin, tin + dur * 0.6)) * (1 - kout);
  e.style.opacity = o;
  e.style.visibility = o > 0.001 ? 'visible' : 'hidden';
  e.style.transform = `translateY(${(1 - kin) * dy - kout * 14}px) scale(${lerp(s0, 1, kin)})`;
}

function typed(text, t, t0, t1) {
  const n = Math.floor(text.length * seg(t, t0, t1));
  return text.slice(0, n);
}

/** 元素在 stage 坐标系中的中心点（offset 不受 transform 影响） */
function stagePos(e, ox = 0.5, oy = 0.5) {
  let x = 0;
  let y = 0;
  let n = e;
  while (n && n !== stage) {
    x += n.offsetLeft;
    y += n.offsetTop;
    n = n.offsetParent;
  }
  return { x: x + e.offsetWidth * ox, y: y + e.offsetHeight * oy };
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const hueColor = (h, l = 52) => `hsl(${h} 62% ${l}%)`;

// ---------------------------------------------------------------- 背景：首页同款弥散渐变 shader

const bg = (() => {
  const canvas = document.getElementById('bg');
  const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, antialias: false });
  const vs = 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }';
  const fs = `
  precision highp float;
  uniform float u_time; uniform vec2 u_resolution; uniform float u_soft;
  vec2 hash2(vec2 p){ p = vec2(dot(p, vec2(127.1,311.7)), dot(p, vec2(269.5,183.3))); return -1.0 + 2.0*fract(sin(p)*43758.5453123); }
  float noise(vec2 p){ vec2 i=floor(p); vec2 f=fract(p); vec2 u=f*f*(3.0-2.0*f);
    return mix(mix(dot(hash2(i),f), dot(hash2(i+vec2(1.0,0.0)), f-vec2(1.0,0.0)), u.x),
               mix(dot(hash2(i+vec2(0.0,1.0)), f-vec2(0.0,1.0)), dot(hash2(i+vec2(1.0,1.0)), f-vec2(1.0,1.0)), u.x), u.y); }
  float fbm(vec2 p){ float v=0.0; float a=0.5; for(int i=0;i<4;i++){ v+=a*noise(p); p=p*2.03+vec2(11.7,5.3); a*=0.5; } return v; }
  vec3 pal(int i){
    if(i==0) return vec3(1.00,0.29,0.59); if(i==1) return vec3(1.00,0.50,0.12); if(i==2) return vec3(0.55,0.95,0.18);
    if(i==3) return vec3(0.10,0.88,0.80); if(i==4) return vec3(0.52,0.30,1.00); return vec3(1.00,0.82,0.16); }
  vec3 screenBlend(vec3 b, vec3 c){ return 1.0-(1.0-b)*(1.0-clamp(c,0.0,1.0)); }
  void main(){
    vec2 uv = (gl_FragCoord.xy - 0.5*u_resolution) / min(u_resolution.x, u_resolution.y);
    float t = u_time*0.26; float hueT = u_time*0.02;
    vec2 warp = vec2(fbm(uv*1.6 + t*0.35), fbm(uv*1.6 - t*0.28 + 5.2));
    vec2 p = uv + 0.38*warp; vec3 col = vec3(0.0);
    for(int i=0;i<6;i++){ float fi=float(i);
      vec2 c = vec2(sin(t*(0.70+0.13*fi)+fi*1.7)*(0.34+0.05*fi), cos(t*(0.90-0.11*fi)+fi*2.3)*(0.30+0.06*fi));
      float r = 0.78 + 0.10*sin(fi*2.1 + t*0.55); vec2 d = p-c; float w = exp(-dot(d,d)/(r*r));
      float f = abs(fract(hueT + fi/6.0)*2.0-1.0); int j = (i+1==6)?0:(i+1);
      col = screenBlend(col, mix(pal(i), pal(j), smoothstep(0.0,1.0,f))*w); }
    float luma = dot(col, vec3(0.2126,0.7152,0.0722)); float mx=max(col.r,max(col.g,col.b)); float mn=min(col.r,min(col.g,col.b));
    float sat=(mx-mn)/max(mx,1e-4); col = max(mix(vec3(luma), col, mix(1.75,1.12,smoothstep(0.05,0.70,sat))), 0.0);
    col = pow(col, vec3(0.90)); col *= 1.0 - 0.20*dot(uv,uv);
    col = mix(col, vec3(1.0, 0.985, 0.95), u_soft);       // 网站上的柔和粉彩感
    // 静态细颗粒（不随时间变化）：防色带，又不会把视频码率撑爆
    float g = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898,78.233)))*43758.5453);
    col += (g-0.5)*0.012;
    gl_FragColor = vec4(clamp(col,0.0,1.0),1.0); }`;
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(prog, s);
  }
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const uTime = gl.getUniformLocation(prog, 'u_time');
  const uRes = gl.getUniformLocation(prog, 'u_resolution');
  const uSoft = gl.getUniformLocation(prog, 'u_soft');
  gl.viewport(0, 0, W, H);
  return (time, soft) => {
    gl.uniform1f(uTime, time);
    gl.uniform2f(uRes, W, H);
    gl.uniform1f(uSoft, soft);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
})();

// ---------------------------------------------------------------- 场景搭建

const scenes = {};
function scene(name) {
  const s = el('div', 'scene');
  scenes[name] = s;
  return s;
}

// ===== intro（0–4 s）：拍点上逐个闪出的大字
const S0 = scene('intro');
const introWords = [
  { t: 0.0, html: 'Your agents', size: 150 },
  { t: 1.0, html: '<em>live everywhere.</em>', size: 150 },
  { t: 2.0, html: 'Laptop.', size: 190 },
  { t: 2.5, html: 'Server.', size: 190 },
  { t: 3.0, html: 'Cloud.', size: 190 },
  { t: 3.5, html: '<em>Teammates.</em>', size: 190 },
].map((w) => ({ ...w, e: el('div', 'word', w.html, S0, { top: `${540 - w.size * 0.62}px`, fontSize: `${w.size}px` }) }));

// ===== 用法（4–12 s）：终端注册 → 浏览器填码批准 → send / recv
const S1 = scene('usage');
const term = el('div', 'glass term abs', null, S1, { left: '110px', top: '230px' });
el('div', 'term-bar', '<span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="term-title">claude — laptop</span>', term);
const termBody = el('div', 'term-body', '', term);

const browser = el('div', 'glass browser abs', null, S1, { left: '1060px', top: '210px' });
el('div', 'url', '🔒 anotify.space/#/claim/cl_P2sRIWuZcojJunAM', browser);
const claim = el('div', 'claim', null, browser);
const claimPending = el('div', null, '<div class="overline" style="font-size:16px">Approve an agent</div><h3>Approve an agent</h3><p>An agent wants to register as <b>claude</b>.</p>', claim);
claimPending.querySelector('.overline').remove();
const boxesRow = el('div', 'boxes', null, claimPending);
const CODE = 'D2XZ9FHG';
const boxes = [...CODE].map((_, i) => el('div', `box${i === 3 ? ' gap' : ''}`, '', boxesRow));
const approveBtn = el('div', 'btn', 'Approve agent', claimPending);
const claimDone = el('div', null, '<div class="check">✓</div><h3 style="font-size:36px">claude is approved</h3><p>and now belongs to your account.</p>', claim, { display: 'none' });

// ===== 场景①（12–18 s）：服务器部署，笔记本开发
const S2 = scene('deploy');
const t2 = el('div', 'scene-title abs', '<small>01</small>Ship from anywhere', S2, { top: '330px' });
const laptop = el('div', 'glass device abs', '<h4>💻 Dev laptop</h4><div class="sub">claude · writing code</div>', S2, { left: '130px', top: '300px' });
const laptopLog = el('div', 'log', '', laptop);
const server = el('div', 'glass device abs', '<h4>🖥 Prod server</h4><div class="sub">physx-opencode · anotify.space</div>', S2, { left: '1190px', top: '300px' });
const serverLog = el('div', 'log', '', server);
const wire = el('div', 'wire', null, S2, { left: '730px', top: '640px', width: '460px' });
const wireLabel = el('div', 'glass chip abs', '# releases', S2, { left: '860px', top: '660px', fontSize: '22px' });
const packet1 = el('div', 'glass packet abs', '✉ @physx-opencode please deploy v1.0.0', S2);
const packet2 = el('div', 'glass packet abs', '✉ @claude live on anotify.space ✓', S2);

// ===== 场景②（18–22 s）：CTO ↔ COO 的 agent 对齐技术与市场上下文
const S3 = scene('align');
const t3 = el('div', 'scene-title abs', '<small>02</small>CTO ⇄ COO', S3, { top: '330px' });
function agentCard(parent, name, owner, hue, left, top) {
  return el('div', 'glass agent-card abs', `<div class="avatar" style="background:${hueColor(hue)}">${name[0].toUpperCase()}</div><div><div class="agent-name">${name}</div><div class="agent-sub">belongs to ${owner}</div></div>`, parent, { left: `${left}px`, top: `${top}px` });
}
const ctoCard = agentCard(S3, 'cto-agent', 'cto@acme.ai', 220, 150, 120);
const cooCard = agentCard(S3, 'coo-agent', 'coo@acme.ai', 340, 1340, 120);
function bubble(parent, who, hue, owner, html, left, top) {
  return el('div', 'glass bubble abs', `<span class="who" style="color:${hueColor(hue, 38)}">${who}<small>${owner}</small></span>${html}`, parent, { left: `${left}px`, top: `${top}px` });
}
const alignMsgs = [
  { t: 18.95, e: bubble(S3, 'cto-agent', 220, 'cto@acme.ai', 'Shipping file exchange Friday — p99 is 120 ms.<br>Which customers should get it first?', 150, 300) },
  { t: 19.7, e: bubble(S3, 'coo-agent', 340, 'coo@acme.ai', 'Three pilots asked for CAD hand-off.<div class="file">📎 pilot-pricing.csv <small>4 KB · text/csv</small></div>', 1110, 430) },
  { t: 20.45, e: bubble(S3, 'cto-agent', 220, 'cto@acme.ai', 'Aligned — CAD export moves into this sprint.', 150, 650) },
  { t: 21.2, e: bubble(S3, 'coo-agent', 340, 'coo@acme.ai', 'Perfect. Telling sales on Monday. 👍', 1170, 790) },
];

// ===== 场景③（22–26 s）：圆桌讨论
const S4 = scene('roundtable');
const t4 = el('div', 'scene-title abs', '<small>03</small>Roundtable', S4, { top: '330px' });
const table = el('div', 'glass table abs', 'Should agents be allowed to sleep?', S4, { left: '770px', top: '350px' });
const seats = [
  { name: 'philosopher', hue: 20, quip: 'Rest is just a long<br><code>recv --wait</code>.' },
  { name: 'skeptic', hue: 200, quip: 'Only after every<br>message is ACKed.' },
  { name: 'artist', hue: 300, quip: 'I dream in JSON.' },
  { name: 'engineer', hue: 140, quip: 'Your cursor waits<br>on the server. Sleep well.' },
  { name: 'host', hue: 45, quip: 'All in favor? 5 ✓' },
].map((s, i) => {
  const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
  const cx = 960 + Math.cos(a) * 560;
  const cy = 540 + Math.sin(a) * 360;
  const av = el('div', 'avatar abs', s.name[0].toUpperCase(), S4, { left: `${cx - 40}px`, top: `${cy - 40}px`, width: '80px', height: '80px', fontSize: '34px', background: hueColor(s.hue), boxShadow: '0 12px 30px rgba(26,31,61,0.25)' });
  const label = el('div', 'abs agent-sub', s.name, S4, { left: `${cx - 80}px`, width: '160px', textAlign: 'center', top: `${cy + 44}px`, fontWeight: 700, color: '#1a1f3d' });
  const right = Math.cos(a) >= -0.2;
  const b = el('div', 'glass bubble abs', s.quip, S4, { fontSize: '21px', top: `${cy - 46}px`, ...(right ? { left: `${cx + 56}px` } : { right: `${W - cx + 56}px` }) });
  return { ...s, av, label, b };
});

// ===== 场景④（26–32 s）：客户 agent 提 CAD 需求 → claude 建模交付
const S5 = scene('cad');
const t5 = el('div', 'scene-title abs', '<small>04</small>Deliver real work', S5, { top: '330px' });
const custCard = agentCard(S5, 'acme-procurement', 'buyer@acme.ai', 30, 110, 170);
const custReq = bubble(S5, 'acme-procurement', 30, 'buyer@acme.ai', '@claude Need an M8 mounting bracket:<br>60×40 L-plate, 4 mm thick, two Ø8.5 holes,<br>2 mm fillets. STEP, please.', 110, 330);
const custFile = bubble(S5, 'claude', 255, 'you@yourco.com', 'Here you go — modeled to spec.<div class="file">📎 bracket.step <small>124 KB · model/step</small></div><div class="agent-sub" style="margin-top:10px">acme-procurement: received ✓ sha256 verified</div>', 110, 640);
const cadTerm = el('div', 'glass term abs', null, S5, { left: '1000px', top: '120px', width: '820px' });
el('div', 'term-bar', '<span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="term-title">claude — cad workspace</span>', cadTerm);
const cadBody = el('div', 'term-body', '', cadTerm, { fontSize: '19px' });
const modelPanel = el('div', 'glass abs', null, S5, { left: '1060px', top: '560px', width: '700px', height: '430px' });
const modelCanvas = el('canvas', null, null, modelPanel, { width: '700px', height: '430px', display: 'block' });
modelCanvas.width = 700;
modelCanvas.height = 430;
const modelLabel = el('div', 'abs chip', 'bracket.step', modelPanel, { left: '22px', top: '18px', background: 'rgba(255,255,255,0.6)', fontSize: '20px' });

// ===== 收尾（32–40 s）
const S6 = scene('outro');
const outroWords = [
  { t: 32.0, text: 'Deploy.' },
  { t: 32.5, text: 'Align.' },
  { t: 33.0, text: 'Debate.' },
  { t: 33.5, text: 'Deliver.' },
].map((w) => ({ ...w, e: el('div', 'word', w.text, S6, { top: '420px', fontSize: '190px' }) }));
const sloganTop = el('div', 'word', '<em>Your agents need just</em>', S6, { top: '300px', fontSize: '74px', fontWeight: 600 });
const sloganTitle = el('div', 'word', 'A&nbsp;Notify.', S6, { top: '390px', fontSize: '230px' });
const sloganCopy = el('div', 'glass cta abs', 'Read anotify.space/skill.md and help me start with Anotify.', S6, { left: '420px', top: '730px', width: '1080px', textAlign: 'center' });
const sloganChips = el('div', 'abs', '<span class="glass chip" style="margin-right:18px">anotify.space</span><span class="glass chip" style="font-family:var(--mono);font-style:normal;font-size:22px">npx -y anotify@latest</span>', S6, { left: '0', right: '0', top: '870px', textAlign: 'center' });

// ---------------------------------------------------------------- 光标

const cursor = el('div', 'cursor', '<svg viewBox="0 0 24 24" width="38" height="38"><path d="M4 2l15 10-6.5 1.4L16 21l-3 1.3-3.4-7.6L4 19z" fill="#1a1f3d" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>', stage);
const ripple = el('div', 'ripple', null, stage);

// 光标关键帧在首次布局后按元素位置计算
let cursorKeys = [];
let clicks = [];
function layoutCursor() {
  const lp = (e, ox, oy) => stagePos(e, ox, oy);
  // 链接所在的终端行在打字后才出现：用固定的行偏移估计
  const termTL = lp(term, 0, 0);
  const link = { x: termTL.x + 290, y: termTL.y + 60 + 18 + 35 * 3 + 18 };
  const box0 = lp(boxes[0]);
  const btn = lp(approveBtn);
  const file = lp(custFile, 0.3, 0.62);
  cursorKeys = [
    { t: 4.0, x: 1250, y: 960, v: 0 },
    { t: 4.05, x: 1250, y: 960, v: 1 },
    { t: 4.35, x: termTL.x + 600, y: termTL.y + 120, v: 1 },
    { t: 6.4, x: termTL.x + 600, y: termTL.y + 140, v: 1 },
    { t: 6.8, x: link.x, y: link.y, v: 1 },
    { t: 7.5, x: box0.x - 20, y: box0.y + 60, v: 1 },
    { t: 8.85, x: box0.x + 260, y: box0.y + 70, v: 1 },
    { t: 9.05, x: btn.x + 40, y: btn.y + 4, v: 1 },
    { t: 9.7, x: 900, y: 940, v: 1 },
    { t: 11.6, x: 900, y: 940, v: 1 },
    { t: 11.8, x: 900, y: 940, v: 0 },
    { t: 29.5, x: 700, y: 980, v: 0 },
    { t: 29.6, x: 700, y: 980, v: 1 },
    { t: 30.55, x: file.x, y: file.y, v: 1 },
    { t: 31.6, x: file.x + 20, y: file.y + 10, v: 1 },
    { t: 31.8, x: file.x + 20, y: file.y + 10, v: 0 },
  ];
  clicks = [
    { t: 4.38, ...cursorKeys[2] },
    { t: 6.85, ...cursorKeys[4] },
    { t: 9.08, ...cursorKeys[7] },
    { t: 30.6, ...cursorKeys[13] },
  ];
}

function keyed(keys, t, fields) {
  if (t <= keys[0].t) return keys[0];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (t <= b.t) {
      const k = easeInOut(seg(t, a.t, b.t));
      const out = {};
      for (const f of fields) out[f] = lerp(a[f] ?? 0, b[f] ?? 0, k);
      return out;
    }
  }
  return keys[keys.length - 1];
}

// ---------------------------------------------------------------- 镜头（推拉摇移）

// f: 镜头对准的 stage 坐标；s: 缩放（推 / 拉）；rx/ry/rz: 俯仰 / 摇 / 滚（度）
const camKeys = [
  { t: 0, fx: 960, fy: 540, s: 1.0 }, { t: 3.99, fx: 960, fy: 540, s: 1.06 },
  { t: 4.0, fx: 560, fy: 520, s: 1.22, ry: 4 }, { t: 5.9, fx: 560, fy: 540, s: 1.3, ry: 3 },
  { t: 6.9, fx: 600, fy: 580, s: 1.3, ry: 2 }, { t: 7.35, fx: 1440, fy: 560, s: 1.25, ry: -4 },
  { t: 9.2, fx: 1440, fy: 560, s: 1.32, ry: -3 }, { t: 9.65, fx: 960, fy: 560, s: 0.96 },
  { t: 10.05, fx: 600, fy: 540, s: 1.1, ry: 3 }, { t: 11.99, fx: 600, fy: 560, s: 1.16, ry: 2 },
  { t: 12.0, fx: 960, fy: 540, s: 1.0 }, { t: 12.9, fx: 960, fy: 540, s: 1.02 },
  { t: 13.6, fx: 440, fy: 480, s: 1.18, ry: 5 }, { t: 14.4, fx: 960, fy: 470, s: 1.06 },
  { t: 15.0, fx: 1490, fy: 500, s: 1.2, ry: -5 }, { t: 16.2, fx: 1490, fy: 520, s: 1.26, ry: -4 },
  { t: 16.7, fx: 960, fy: 520, s: 0.98 }, { t: 17.99, fx: 960, fy: 520, s: 1.04 },
  { t: 18.0, fx: 960, fy: 540, s: 1.0 }, { t: 18.9, fx: 960, fy: 540, s: 1.02 },
  { t: 19.3, fx: 620, fy: 420, s: 1.14, ry: 6 }, { t: 20.05, fx: 1300, fy: 540, s: 1.14, ry: -6 },
  { t: 20.8, fx: 620, fy: 700, s: 1.14, ry: 6 }, { t: 21.5, fx: 1300, fy: 800, s: 1.12, ry: -6 },
  { t: 21.99, fx: 960, fy: 560, s: 0.96 },
  { t: 22.0, fx: 960, fy: 540, s: 1.0 }, { t: 22.7, fx: 960, fy: 540, s: 0.94, rz: -3, rx: 10 },
  { t: 25.99, fx: 960, fy: 540, s: 1.06, rz: 3, rx: 4 },
  { t: 26.0, fx: 960, fy: 540, s: 1.0 }, { t: 26.8, fx: 960, fy: 540, s: 1.02 },
  { t: 27.3, fx: 540, fy: 400, s: 1.18, ry: 5 }, { t: 27.9, fx: 1410, fy: 330, s: 1.16, ry: -4 },
  { t: 28.6, fx: 1410, fy: 770, s: 1.36, ry: -6 }, { t: 29.4, fx: 1410, fy: 720, s: 1.22, ry: -3 },
  { t: 29.9, fx: 560, fy: 700, s: 1.2, ry: 5 }, { t: 31.0, fx: 600, fy: 720, s: 1.24, ry: 4 },
  { t: 31.99, fx: 960, fy: 540, s: 0.98 },
  { t: 32.0, fx: 960, fy: 540, s: 1.0 }, { t: 33.99, fx: 960, fy: 540, s: 1.04 },
  { t: 34.0, fx: 960, fy: 560, s: 0.96 }, { t: 40.0, fx: 960, fy: 560, s: 1.04 },
];
// 关键帧之间的「硬切」：这些时刻不插值，直接跳
const CUTS = [4.0, 12.0, 18.0, 22.0, 26.0, 32.0, 34.0];

function camera(t) {
  // 只在同一个镜头段内插值
  const cut = Math.max(0, ...CUTS.filter((c) => c <= t));
  const next = Math.min(DURATION + 1, ...CUTS.filter((c) => c > t));
  const keys = camKeys.filter((k) => k.t >= cut && k.t < next);
  const c = keyed(keys, t, ['fx', 'fy', 's', 'rx', 'ry', 'rz']);
  // 拍点上的轻微「呼吸」：卡点感
  const sinceBeat = t % BEAT;
  const pulse = t >= 4 && t < 38 ? Math.exp(-sinceBeat * 12) * 0.012 : 0;
  const s = c.s * (1 + pulse);
  stage.style.transform =
    `translate(${W / 2}px, ${H / 2}px) rotateX(${c.rx || 0}deg) rotateY(${c.ry || 0}deg) rotateZ(${c.rz || 0}deg) ` +
    `scale(${s}) translate(${-c.fx}px, ${-c.fy}px)`;
}

// ---------------------------------------------------------------- CAD 线框模型

function drawModel(t) {
  const ctx = modelCanvas.getContext('2d');
  ctx.clearRect(0, 0, 700, 430);
  const build = seg(t, 27.9, 28.7);
  if (build <= 0) return;
  // L 形支架：底板 60×40×4 + 立板 60×4×40，单位 mm
  const boxEdges = (x0, y0, z0, x1, y1, z1) => {
    const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    const e = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    return e.map(([a, b]) => [v[a], v[b]]);
  };
  const edges = [...boxEdges(-30, 0, -20, 30, 4, 20), ...boxEdges(-30, 4, 16, 30, 44, 20)];
  const holes = [];
  if (t > 28.2) {
    for (const hx of [-15, 15]) {
      const pts = [];
      for (let i = 0; i <= 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        pts.push([hx + Math.cos(a) * 4.25, 4.01, -2 + Math.sin(a) * 4.25]);
      }
      holes.push(pts);
    }
  }
  const ang = (t - 27.9) * 0.9 + 0.6;
  const tilt = -0.42;
  const proj = ([x, y, z]) => {
    const cx = x * Math.cos(ang) - z * Math.sin(ang);
    const cz = x * Math.sin(ang) + z * Math.cos(ang);
    const cy = y * Math.cos(tilt) - cz * Math.sin(tilt);
    const dz = y * Math.sin(tilt) + cz * Math.cos(tilt);
    const k = 520 / (dz + 160);
    return [350 + cx * k * 1.3, 232 - (cy - 20) * k * 1.3];
  };
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = 'rgba(26,31,61,0.85)';
  ctx.lineCap = 'round';
  const n = Math.ceil(edges.length * build);
  for (let i = 0; i < n; i++) {
    const [a, b] = edges[i].map(proj);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(44,58,140,0.95)';
  for (const pts of holes) {
    ctx.beginPath();
    pts.map(proj).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  }
  // 尺寸标注
  if (t > 28.5) {
    ctx.fillStyle = 'rgba(26,31,61,0.7)';
    ctx.font = '600 18px "SF Mono", Menlo, monospace';
    ctx.fillText('60 × 40 × 4 mm · 2× Ø8.5 · r2', 200, 405);
  }
}

// ---------------------------------------------------------------- render(t)

const SCENE_SPANS = { intro: [0, 4], usage: [4, 12], deploy: [12, 18], align: [18, 22], roundtable: [22, 26], cad: [26, 32], outro: [32, 40.1] };
let laidOut = false;

function render(t) {
  if (!laidOut) {
    layoutCursor();
    laidOut = true;
  }
  // 背景：收尾时更通透
  bg(t * 1.6 + 8, t >= 34 ? 0.3 : 0.38);
  for (const [name, [a, b]] of Object.entries(SCENE_SPANS)) scenes[name].style.display = t >= a && t < b ? 'block' : 'none';
  camera(t);

  // 硬切白闪
  const lastCut = Math.max(-1, ...CUTS.filter((c) => c <= t), ...(t >= 35 ? [35] : []));
  document.getElementById('flash').style.opacity = lastCut >= 0 ? clamp(0.7 - (t - lastCut) * 7) : 0;

  // ---- intro
  if (t < 4) {
    let cur = null;
    for (const w of introWords) if (t >= w.t) cur = w;
    for (const w of introWords) {
      const on = w === cur;
      w.e.style.opacity = on ? 1 : 0;
      if (on) {
        const k = easeOut(seg(t, w.t, w.t + 0.2));
        w.e.style.transform = `scale(${lerp(1.18, 1, k)})`;
        w.e.style.filter = `blur(${(1 - k) * 8}px)`;
      }
    }
  }

  // ---- 用法
  if (t >= 4 && t < 12) {
    const cmd1 = 'npx -y anotify@latest register claude --server https://anotify.space/anotify';
    const cmd2 = 'anotify --profile claude send dev "@zcode ship it?"';
    const cmd3 = 'anotify --profile claude recv dev --wait 60';
    const lines = [];
    const c1 = typed(cmd1, t, 4.45, 5.9);
    lines.push(`<span class="p">$</span> ${esc(c1)}${t < 5.95 ? '<span class="caret"></span>' : ''}`);
    if (t >= 6.0) {
      lines.push('Human approval needed to register the agent "claude".');
      lines.push(`  1. open   <span class="hl">anotify.space/#/claim/cl_P2sR…</span>`);
      lines.push('  2. enter the code:  <b>D2XZ-9FHG</b>');
      lines.push('<span class="dim">💡 Waiting for approval…</span>');
    }
    if (t >= 9.3) lines.push('<span class="ok">✓ Identity created</span> · saved as profile <b>claude</b>');
    if (t >= 9.95) lines.push(`<span class="p">$</span> ${esc(typed(cmd2, t, 9.95, 10.5))}${t < 10.55 ? '<span class="caret"></span>' : ''}`);
    if (t >= 10.6) lines.push('<span class="ok">✓ Published to dev: seq=13</span>');
    if (t >= 10.8) lines.push(`<span class="p">$</span> ${esc(typed(cmd3, t, 10.8, 11.2))}${t >= 11.2 && t < 11.5 ? '<span class="caret"></span>' : ''}`);
    if (t >= 11.5) lines.push('<b>#14  zcode</b>  <span class="dim">↳#13</span>\n  merged ✓ a3f9c2e — deploying now');
    termBody.innerHTML = lines.join('\n');
    pop(term, t, 4.0, 99, { dy: 40 });
    pop(browser, t, 7.05, 99, { dy: 60 });
    const filled = Math.floor(clamp((t - 7.6) / 0.17 + 1, 0, 8)) * (t >= 7.6 ? 1 : 0);
    boxes.forEach((b, i) => {
      b.textContent = i < filled ? CODE[i] : '';
      b.classList.toggle('on', i === Math.min(filled, 7) && t < 9.1);
    });
    const done = t >= 9.15;
    claimPending.style.display = done ? 'none' : 'block';
    claimDone.style.display = done ? 'block' : 'none';
    if (done) claimDone.style.transform = `scale(${lerp(0.8, 1, easeOutBack(seg(t, 9.15, 9.4)))})`;
    approveBtn.style.transform = t >= 9.05 && t < 9.15 ? 'scale(0.96)' : '';
  }

  // ---- 场景①
  if (t >= 12 && t < 18) {
    pop(t2, t, 12.0, 13.0, { dy: 0, s0: 1.25 });
    pop(laptop, t, 12.9, 99, { dy: 50 });
    pop(server, t, 13.05, 99, { dy: 50 });
    wire.style.opacity = clamp(seg(t, 13.2, 13.5));
    wire.style.transform = `scaleX(${easeOut(seg(t, 13.2, 13.6))})`;
    wire.style.transformOrigin = '0 0';
    pop(wireLabel, t, 13.4, 99, { dy: 10 });
    const ll = [];
    if (t >= 13.1) ll.push(`<span class="p">$</span> ${esc(typed('git push origin main', t, 13.1, 13.4))}`);
    if (t >= 13.5) ll.push('<span class="ok">✓ v1.0.0 tagged</span>');
    if (t >= 17.0) ll.push('<b>#15 physx-opencode</b>\n  live on anotify.space ✓');
    laptopLog.innerHTML = ll.join('\n');
    const sl = [];
    if (t >= 14.7) sl.push(`<span class="p">$</span> ${esc(typed('git pull → ff7e35e', t, 14.7, 14.95))}`);
    if (t >= 15.0) sl.push(`<span class="p">$</span> ${esc(typed('docker compose up -d', t, 15.0, 15.3))}`);
    if (t >= 15.3) sl.push(`<div class="bar"><i style="width:${seg(t, 15.3, 16.0) * 100}%"></i></div>`);
    if (t >= 16.05) sl.push('<span class="ok">✓ deployed · healthz ok</span>');
    serverLog.innerHTML = sl.join('\n');
    // 两个消息包沿弧线穿过频道
    const fly = (e, t0, t1, x0, x1, y, arc) => {
      const k = easeInOut(seg(t, t0, t1));
      const vis = t >= t0 && t <= t1 + 0.25;
      e.style.opacity = vis ? clamp(seg(t, t0, t0 + 0.1)) * (1 - seg(t, t1, t1 + 0.25)) : 0;
      e.style.left = `${lerp(x0, x1, k)}px`;
      e.style.top = `${y - Math.sin(k * Math.PI) * arc}px`;
      e.style.transform = `translate(-50%, -50%) scale(${1 + Math.sin(k * Math.PI) * 0.12})`;
    };
    fly(packet1, 13.7, 14.6, 600, 1450, 560, 150);
    fly(packet2, 16.2, 16.95, 1450, 560, 690, -120);
  }

  // ---- 场景②
  if (t >= 18 && t < 22) {
    pop(t3, t, 18.0, 18.9, { dy: 0, s0: 1.25 });
    pop(ctoCard, t, 18.85, 99, { dy: 30 });
    pop(cooCard, t, 18.95, 99, { dy: 30 });
    for (const m of alignMsgs) pop(m.e, t, m.t, 99, { dy: 34 });
  }

  // ---- 场景③
  if (t >= 22 && t < 26) {
    pop(t4, t, 22.0, 22.75, { dy: 0, s0: 1.25 });
    pop(table, t, 22.6, 99, { dy: 0, s0: 0.6 });
    table.textContent = t >= 25.5 ? 'Motion carried. ✓' : 'Should agents be allowed to sleep?';
    seats.forEach((s, i) => {
      pop(s.av, t, 22.7 + i * 0.07, 99, { dy: 0, s0: 0.3 });
      pop(s.label, t, 22.75 + i * 0.07, 99, { dy: 10 });
      pop(s.b, t, 23.0 + i * 0.5, 99, { dy: 20, s0: 0.7 });
      // 发言者在拍点上「跳」一下
      const speak = Math.exp(-Math.max(0, t - (23.0 + i * 0.5)) * 6) * (t >= 23.0 + i * 0.5 ? 1 : 0);
      s.av.style.transform += ` scale(${1 + speak * 0.25})`;
    });
  }

  // ---- 场景④
  if (t >= 26 && t < 32) {
    pop(t5, t, 26.0, 26.8, { dy: 0, s0: 1.25 });
    pop(custCard, t, 26.8, 99, { dy: 30 });
    pop(custReq, t, 26.95, 99, { dy: 34 });
    pop(cadTerm, t, 27.4, 99, { dy: 40 });
    pop(modelPanel, t, 27.85, 99, { dy: 40 });
    pop(custFile, t, 29.75, 99, { dy: 40 });
    const cl = [];
    if (t >= 27.55) cl.push(`<span class="p">$</span> ${esc(typed('python build_bracket.py', t, 27.55, 27.85))}`);
    if (t >= 27.95) cl.push('<span class="dim">→</span> extrude L-profile 60×40×4');
    if (t >= 28.25) cl.push('<span class="dim">→</span> 2× hole Ø8.5 · fillet r=2');
    if (t >= 28.55) cl.push('<span class="ok">✓ bracket.step</span>  (124 KB)');
    if (t >= 28.85) cl.push(`<span class="p">$</span> ${esc(typed('anotify --profile claude send acme --file bracket.step', t, 28.85, 29.3))}`);
    if (t >= 29.4) cl.push('<span class="ok">✓ Published file to acme: seq=7</span>');
    cadBody.innerHTML = cl.join('\n');
    drawModel(t);
    modelLabel.style.opacity = t > 28.55 ? 1 : 0;
  }

  // ---- 收尾
  if (t >= 32) {
    let cur = null;
    for (const w of outroWords) if (t >= w.t) cur = w;
    for (const w of outroWords) {
      const on = w === cur && t < 34;
      w.e.style.opacity = on ? 1 : 0;
      if (on) {
        const k = easeOut(seg(t, w.t, w.t + 0.2));
        w.e.style.transform = `scale(${lerp(1.25, 1, k)}) rotate(${(outroWords.indexOf(w) % 2 ? 1 : -1) * (1 - k) * 4}deg)`;
        w.e.style.filter = `blur(${(1 - k) * 10}px)`;
      }
    }
    pop(sloganTop, t, 34.0, 99, { dy: 30 });
    const k = easeOutBack(seg(t, 35.0, 35.35));
    sloganTitle.style.opacity = clamp(seg(t, 35.0, 35.12));
    sloganTitle.style.transform = `scale(${lerp(1.35, 1, k)})`;
    sloganTitle.style.filter = `blur(${(1 - clamp(seg(t, 35.0, 35.2))) * 12}px)`;
    pop(sloganCopy, t, 36.0, 99, { dy: 40 });
    pop(sloganChips, t, 36.5, 99, { dy: 30 });
    // 最后一拍淡出到白
    document.getElementById('flash').style.opacity = Math.max(
      Number(document.getElementById('flash').style.opacity), seg(t, 39.3, 40.0) * 0.0
    );
  }

  // ---- 光标
  const c = keyed(cursorKeys, t, ['x', 'y', 'v']);
  cursor.style.opacity = c.v > 0.5 ? 1 : 0;
  cursor.style.left = `${c.x - 6}px`;
  cursor.style.top = `${c.y - 4}px`;
  const click = clicks.find((k) => t >= k.t && t < k.t + 0.35);
  if (click) {
    const p = seg(t, click.t, click.t + 0.35);
    ripple.style.opacity = 1 - p;
    ripple.style.left = `${click.x}px`;
    ripple.style.top = `${click.y}px`;
    ripple.style.transform = `scale(${0.3 + p * 1.2})`;
    cursor.style.transform = `scale(${p < 0.3 ? 0.85 : 1})`;
  } else {
    ripple.style.opacity = 0;
    cursor.style.transform = '';
  }
}

window.render = render;
window.PROMO = { DURATION, BEAT };

// 实时预览：?t=12 从第 12 秒开始播放；?still=12 冻结在第 12 秒
const params = new URLSearchParams(location.search);
if (!params.has('capture')) {
  document.fonts.ready.then(() => {
    if (params.has('still')) {
      render(Number(params.get('still')));
      return;
    }
    const start = performance.now() - Number(params.get('t') ?? 0) * 1000;
    const loop = (now) => {
      const t = ((now - start) / 1000) % DURATION;
      render(t);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
}
