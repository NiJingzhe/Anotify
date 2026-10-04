import { useEffect, useRef } from 'react';
import * as THREE from 'three';

// 弥散渐变（diffuse gradient）shader：fbm 域扭曲 + 多个高斯色斑漂移，
// 多巴胺色调（热粉 / 珊瑚橙 / 柠檬黄 / 青柠 / 湖水青 / 紫罗兰）。
// 混色策略：screen 混合（重叠处变亮变艳）+ 饱和度自适应补偿（不往灰塌），
// 每斑异速运动 + 相邻调色板色慢速轮换，保证长时间观看也有明显变化。
const vertexShader = /* glsl */ `
  void main() {
    gl_Position = vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;

  uniform float u_time;
  uniform vec2 u_resolution;

  vec2 hash2(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(dot(hash2(i + vec2(0.0, 0.0)), f - vec2(0.0, 0.0)),
          dot(hash2(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),
      mix(dot(hash2(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)),
          dot(hash2(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)), u.x),
      u.y);
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += a * noise(p);
      p = p * 2.03 + vec2(11.7, 5.3);
      a *= 0.5;
    }
    return v;
  }

  // 多巴胺调色板：全部高饱和
  vec3 pal(int i) {
    if (i == 0) return vec3(1.00, 0.29, 0.59); // hot pink
    if (i == 1) return vec3(1.00, 0.50, 0.12); // coral orange
    if (i == 2) return vec3(0.55, 0.95, 0.18); // lime
    if (i == 3) return vec3(0.10, 0.88, 0.80); // teal
    if (i == 4) return vec3(0.52, 0.30, 1.00); // violet
    return vec3(1.00, 0.82, 0.16);             // lemon
  }

  vec3 screenBlend(vec3 base, vec3 c) {
    return 1.0 - (1.0 - base) * (1.0 - clamp(c, 0.0, 1.0));
  }

  void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);

    // 提速 2~3x：10 秒内肉眼可见的位置与构图变化
    float t = u_time * 0.26;
    // 慢速整体色相漂移（ping-pong，无跳变）
    float hueT = u_time * 0.02;

    // fbm 域扭曲：色斑边界呈现"弥散"感而非干净的圆
    vec2 warp = vec2(
      fbm(uv * 1.6 + t * 0.35),
      fbm(uv * 1.6 - t * 0.28 + 5.2)
    );
    vec2 p = uv + 0.38 * warp;

    vec3 col = vec3(0.0);
    for (int i = 0; i < 6; i++) {
      float fi = float(i);
      // 各斑速度/相位/半径不同 → 相对位置持续换牌，不呈现刚性旋转
      vec2 center = vec2(
        sin(t * (0.70 + 0.13 * fi) + fi * 1.7) * (0.34 + 0.05 * fi),
        cos(t * (0.90 - 0.11 * fi) + fi * 2.3) * (0.30 + 0.06 * fi)
      );
      float radius = 0.78 + 0.10 * sin(fi * 2.1 + t * 0.55);
      vec2 d = p - center;
      float w = exp(-dot(d, d) / (radius * radius));
      // 色斑 i 在 pal(i) 与 pal(i+1) 间慢速往返 → 色相缓慢漂移
      float f = abs(fract(hueT + fi / 6.0) * 2.0 - 1.0);
      int j = (i + 1 == 6) ? 0 : (i + 1);
      vec3 c = mix(pal(i), pal(j), smoothstep(0.0, 1.0, f));
      // screen 混合：重叠处变亮变艳，而非平均后发闷
      col = screenBlend(col, c * w);
    }

    // 饱和度自适应补偿：越接近灰补得越狠，保证任意时刻画面保持高饱和主导
    float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
    float mx = max(col.r, max(col.g, col.b));
    float mn = min(col.r, min(col.g, col.b));
    float sat = (mx - mn) / max(mx, 1e-4);
    float boost = mix(1.75, 1.12, smoothstep(0.05, 0.70, sat));
    col = max(mix(vec3(luma), col, boost), 0.0);

    col = pow(col, vec3(0.90));       // 轻微提亮
    col *= 1.0 - 0.20 * dot(uv, uv);  // 极轻暗角，给衬线标题让对比度

    // 细颗粒，避免大面积渐变的色带
    float grain = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233)) + u_time * 60.0) * 43758.5453);
    col += (grain - 0.5) * 0.035;

    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;

export default function GradientCanvas() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const uniforms = {
      u_time: { value: 0 },
      u_resolution: { value: new THREE.Vector2() },
    };
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms }),
    );
    scene.add(mesh);

    const resize = () => {
      const w = canvas.clientWidth || window.innerWidth;
      const h = canvas.clientHeight || window.innerHeight;
      renderer.setSize(w, h, false);
      const dpr = renderer.getPixelRatio();
      uniforms.u_resolution.value.set(w * dpr, h * dpr);
    };
    resize();
    window.addEventListener('resize', resize);

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const clock = new THREE.Clock();
    let raf = 0;
    const loop = () => {
      uniforms.u_time.value = clock.getElapsedTime();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    if (reduced) {
      // 减少动态偏好：渲染单帧静态渐变
      renderer.render(scene, camera);
    } else {
      loop();
    }

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      mesh.geometry.dispose();
      mesh.material.dispose();
      renderer.dispose();
    };
  }, []);

  return <canvas ref={canvasRef} className="bg-canvas" aria-hidden="true" />;
}
