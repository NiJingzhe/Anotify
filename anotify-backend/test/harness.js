// e2e 测试脚手架：为每次运行建一个全新的 Postgres 库 + MinIO bucket，拉起真实服务端进程
// 依赖本地开发栈（见 README「Development」）：TEST_PG_URL 指向可建库的 Postgres，TEST_S3_* 指向 MinIO
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ADMIN_URL = process.env.TEST_PG_URL ?? 'postgres://anotify:anotify@127.0.0.1:55432/anotify';
const S3 = {
  ANOTIFY_S3_ENDPOINT: process.env.TEST_S3_ENDPOINT ?? 'http://127.0.0.1:59000',
  ANOTIFY_S3_ACCESS_KEY: process.env.TEST_S3_ACCESS_KEY ?? 'anotify',
  ANOTIFY_S3_SECRET_KEY: process.env.TEST_S3_SECRET_KEY ?? 'anotify-dev-secret',
};
const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.js');

export async function startServer(extraEnv = {}) {
  const suffix = randomBytes(4).toString('hex');
  const dbName = `anotify_test_${suffix}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const dbUrl = new URL(ADMIN_URL);
  dbUrl.pathname = '/' + dbName;

  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = {
    ...process.env,
    ...S3,
    ANOTIFY_S3_BUCKET: `anotify-test-${suffix}`,
    ANOTIFY_FILES_DIR: mkdtempSync(join(tmpdir(), 'anotify-test-')),
    DATABASE_URL: dbUrl.toString(),
    PORT: String(port),
    HOST: '127.0.0.1',
    ANOTIFY_OPEN_REGISTRATION: "1",
    ANOTIFY_MAX_FILE_BYTES: "1024",
    ...extraEnv,
  };
  const proc = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(url + '/healthz')).ok) break;
    } catch {}
    if (proc.exitCode !== null || i > 100) throw new Error('server failed to start:\n' + log);
    await new Promise((r) => setTimeout(r, 100));
  }

  async function stop() {
    proc.kill('SIGTERM');
    await new Promise((r) => proc.once('exit', r));
    const a = new pg.Client({ connectionString: ADMIN_URL });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await a.end();
  }

  /** fetch 包装：返回 { status, body, headers } */
  async function call(method, path, { token, json, body, headers = {}, cookie } = {}) {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    if (cookie) h.cookie = cookie;
    if (json !== undefined) {
      h['content-type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const res = await fetch(url + path, { method, headers: h, body, duplex: 'half', redirect: 'manual' });
    const text = await res.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch {}
    return { status: res.status, body: parsed, headers: res.headers, text };
  }

  return { url, env, dbUrl: dbUrl.toString(), stop, call, log: () => log };
}
