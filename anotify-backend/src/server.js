// Anotify 服务端入口（骨架占位，完整实现见 DESIGN.md §6/§8）
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

const app = new Hono();

app.get('/healthz', (c) => c.json({ ok: true }));

const port = Number(process.env.PORT ?? 8000);
const host = process.env.HOST ?? '0.0.0.0';

serve({ fetch: app.fetch, port, host }, (info) => {
  console.log(`anotify-backend listening on http://${info.address}:${info.port}`);
});
