import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' → 产物可在任意路径子目录下直接部署（相对资源引用）
export default defineConfig({
  plugins: [react()],
  base: './',
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
});
