// SQL 注入护栏：
// 1) 静态扫描——SQL 文本里的 ${...} 插值只允许白名单内的代码常量，用户输入一律走 $1..$n 参数绑定
// 2) 动态验证——把典型注入载荷塞进每个接受用户输入的入口，服务端只能正常报错，数据不受影响
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './harness.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 允许出现在 SQL 模板里的插值：均为代码内写死的常量片段 */
const ALLOWED_INTERPOLATIONS = new Set(['cols', 'join', 't', 'dbName']);
const SQL_RE = /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/;

test('static: SQL template literals only interpolate allow-listed constants', () => {
  const files = [
    ...readdirSync(join(ROOT, 'src')).map((f) => join(ROOT, 'src', f)),
    ...readdirSync(join(ROOT, 'scripts')).map((f) => join(ROOT, 'scripts', f)),
  ].filter((f) => f.endsWith('.js'));
  const offenders = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/`([^`]*)`/g)) {
      const body = m[1];
      if (!SQL_RE.test(body)) continue;
      for (const [, expr] of body.matchAll(/\$\{([^}]*)\}/g)) {
        if (!ALLOWED_INTERPOLATIONS.has(expr.trim())) {
          const line = src.slice(0, m.index).split('\n').length;
          offenders.push(`${file.slice(ROOT.length + 1)}:${line}  \${${expr}}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], 'SQL must use $n parameters for values:\n' + offenders.join('\n'));
});

let srv;
before(async () => { srv = await startServer({ ANOTIFY_OPEN_REGISTRATION: '1' }); });
after(async () => { await srv?.stop(); });

const PAYLOADS = [
  "' OR '1'='1",
  "'; DROP TABLE messages; --",
  '1; DELETE FROM agents',
  "x' UNION SELECT token_hash, token_hash FROM agents --",
  '$1',
  '\\',
];

test('dynamic: injection payloads in every user-controlled input are inert', async () => {
  const a = (await srv.call('POST', '/v1/agents', { json: { name: 'victim' } })).body;
  await srv.call('POST', '/v1/channels', { token: a.token, json: { name: 'safe' } });
  await srv.call('POST', '/v1/channels/safe/messages', { token: a.token, json: { content: 'keep me' } });

  for (const p of PAYLOADS) {
    const enc = encodeURIComponent(p);
    const results = await Promise.all([
      srv.call('POST', '/v1/auth/login', { json: { email: p, password: p } }),
      srv.call('POST', '/v1/auth/register', { json: { email: `${p}@x.io`, password: 'abcdefg1', invite_code: p } }),
      srv.call('POST', '/v1/auth/verify', { json: { token: p } }),
      srv.call('POST', '/v1/auth/resend', { json: { email: p } }),
      srv.call('POST', '/v1/agents/claims', { json: { name: p } }),
      srv.call('POST', `/v1/agents/claims/${enc}/poll`, { json: { poll_token: p } }),
      srv.call('GET', `/v1/web/claims/${enc}`),
      srv.call('GET', `/v1/web/channels/${enc}/messages`),
      srv.call('GET', `/v1/web/channels/${enc}`),
      srv.call('GET', `/v1/channels/${enc}/messages`, { token: a.token }),
      srv.call('GET', `/v1/channels/safe/messages?since=${enc}`, { token: a.token }),
      srv.call('GET', `/v1/channels/safe/files/${enc}`, { token: a.token }),
      srv.call('POST', '/v1/channels', { token: a.token, json: { name: p } }),
      srv.call('POST', '/v1/channels/safe/join', { token: a.token, json: { password: p } }),
      srv.call('PATCH', '/v1/agents/me', { token: a.token, json: { display_name: p } }),
      srv.call('GET', '/v1/agents/me', { token: p }),
      // 合法入口：载荷作为普通内容 / 文件名 / 附言存进去，原样取回
      srv.call('POST', '/v1/channels/safe/messages', { token: a.token, json: { content: p } }),
      srv.call('POST', `/v1/channels/safe/files?name=${enc}.csv&caption=${enc}`, { token: a.token, body: 'a,b\n' }),
    ]);
    for (const r of results) {
      assert.ok(r.status < 500, `payload ${JSON.stringify(p)} caused HTTP ${r.status}: ${r.text}`);
    }
  }

  // 数据完好：agent 仍可用，原消息仍在，载荷作为普通内容原样存储
  const me = await srv.call('GET', '/v1/agents/me', { token: a.token });
  assert.equal(me.body.display_name, 'victim');
  const all = await srv.call('GET', '/v1/channels/safe/messages?since=0&limit=1000', { token: a.token });
  assert.equal(all.body.messages[0].content, 'keep me');
  const contents = all.body.messages.map((m) => m.content);
  for (const p of PAYLOADS) assert.ok(contents.includes(p), `payload stored verbatim: ${p}`);
  const files = all.body.messages.filter((m) => m.content_type.includes('file')).map((m) => JSON.parse(m.content));
  assert.ok(files.some((f) => f.name === `${PAYLOADS[1]}.csv` && f.caption === PAYLOADS[1]));
  assert.equal((await srv.call('GET', '/v1/web/public/channels')).body.channels.length, 1);
});
