// 回归测试：richText 解析器曾因递归共用一个带 g 标志的正则而死循环（页面一打开内存暴涨）。
// 死循环是同步的，进程内无法用定时器兜底，所以每个语言在子进程里跑，并设硬超时。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const src = new URL('../src/', import.meta.url).href;
const child = `
  globalThis.localStorage = { getItem: () => process.argv[1] };
  const { richText } = await import(${JSON.stringify(src + 'i18n.js')});
  const dict = (await import(${JSON.stringify(src + 'locales/')} + process.argv[1] + '.js')).default;
  const keys = Object.keys(dict).filter((k) => /<(b|em|code)>|<a href/.test(dict[k]));
  for (const k of keys) richText(k, { n: 2, name: 'x', count: 3, url: 'u' });
  console.log(keys.length);
`;

for (const lang of ['en', 'zh']) {
  test(`richText renders every tagged ${lang} string without hanging`, () => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', child, lang], { encoding: 'utf8', timeout: 15000 });
    assert.equal(r.error, undefined, `child failed or timed out: ${r.error?.message}`);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(Number(r.stdout.trim()) > 0, 'expected at least one tagged string');
  });
}
