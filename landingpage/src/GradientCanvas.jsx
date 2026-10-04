import { useEffect, useRef } from 'react';
import * as THREE from 'three';

// 弥散渐变（diffuse gradient）shader：fbm 域扭曲 + 多个高斯色斑缓动漂移，
// 多巴胺色调（热粉 / 珊瑚橙 / 柠檬黄 / 青柠 / 湖水青 / 紫罗兰）
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

  // 高斯衰减的柔边色斑
  vec3 blob(vec2 p, vec2 center, float radius, vec3 color) {
    float d = distance(p, center);
    return color * exp(-(d * d) / (radius * radius));
  }

  void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);
    float t = u_time * 0.12;

    // fbm 域扭曲：让色斑边界呈现"弥散"感而非干净的圆
    vec2 warp = vec2(
      fbm(uv * 1.6 + t * 0.35),
      fbm(uv * 1.6 - t * 0.28 + 5.2)
    );
    vec2 p = uv + 0.38 * warp;

    vec3 col = vec3(0.0);
    col += blob(p, vec2(sin(t * 0.90) * 0.55,       cos(t * 0.70) * 0.38),      0.85, vec3(1.00, 0.29, 0.59)); // hot pink
    col += blob(p, vec2(cos(t * 0.60) * 0.62,       sin(t * 0.80) * 0.46 + 0.08), 0.80, vec3(1.00, 0.54, 0.16)); // coral
    col += blob(p, vec2(sin(t * 0.75 + 2.0) * 0.66, cos(t * 0.50 + 1.0) * 0.42), 0.75, vec3(0.58, 0.92, 0.25)); // lime
    col += blob(p, vec2(cos(t * 0.50 + 4.0) * 0.52, sin(t * 0.85 + 3.0) * 0.50), 0.72, vec3(0.16, 0.85, 0.82)); // teal
    col += blob(p, vec2(sin(t * 0.65 + 5.5) * 0.46, sin(t * 0.60 + 2.5) * 0.55), 0.80, vec3(0.55, 0.33, 1.00)); // violet
    col += blob(p, vec2(cos(t * 0.80 + 1.5) * 0.40, cos(t * 0.45 + 4.5) * 0.52), 0.62, vec3(1.00, 0.83, 0.20)); // lemon

    // 柔和 tonemap + gamma 提亮，保留多巴胺的饱和度但不出硬块
    col = col / (1.0 + col);
    col = pow(col, vec3(0.82));

    // 极轻的暗角，给衬线标题让一点对比度
    col *= 1.0 - 0.22 * dot(uv, uv);

    // 细颗粒，避免大面积渐变的色带
    float grain = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233)) + u_time * 60.0) * 43758.5453);
    col += (grain - 0.5) * 0.035;

    gl_FragColor = vec4(col, 1.0);
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
