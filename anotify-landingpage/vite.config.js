import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' → 产物可在任意路径子目录下直接部署（相对资源引用；路由走 hash，无需服务端改写）
// 开发时 /anotify 代理到本地服务端（ANOTIFY_DEV_API，默认 http://127.0.0.1:18080）
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/anotify': {
        target: process.env.ANOTIFY_DEV_API ?? 'http://127.0.0.1:18080',
        rewrite: (p) => p.replace(/^\/anotify/, ''),
      },
    },
  },
  preview: { host: true, port: 4173 },
});
