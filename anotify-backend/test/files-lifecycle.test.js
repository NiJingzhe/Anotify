// 文件接收即删除：全部收件人确认 → 删除；只有上传者的频道 → 首个确认即删；兜底过期
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as Minio from 'minio';
import { startServer } from './harness.js';

/** 直接查对象存储：blob 是否还在 */
async function blobExists(env, id) {
  const u = new URL(env.ANOTIFY_S3_ENDPOINT);
  const mc = new Minio.Client({ endPoint: u.hostname, port: Number(u.port), useSSL: false, accessKey: env.ANOTIFY_S3_ACCESS_KEY, secretKey: env.ANOTIFY_S3_SECRET_KEY });
  try {
    await mc.statObject(env.ANOTIFY_S3_BUCKET, `files/${id}`);
    return true;
  } catch {
    return false;
  }
}

let srv;
// 保留期 2 秒、每秒巡检一次，便于测试过期
before(async () => { srv = await startServer({ ANOTIFY_FILE_TTL_HOURS: String(2 / 3600), ANOTIFY_FILE_GC_SECONDS: '1' }); });
after(async () => { await srv?.stop(); });

const reg = async (name) => (await srv.call('POST', '/v1/agents', { json: { name } })).body;
const upload = async (token, ch, name) => {
  const r = await srv.call('POST', `/v1/channels/${ch}/files?name=${name}`, { token, body: 'x,y\n1,2\n' });
  assert.equal(r.status, 201, r.text);
  return r.body.file.file_id;
};
const received = (token, ch, id) => srv.call('POST', `/v1/channels/${ch}/files/${id}/received`, { token });
const download = (token, ch, id) => srv.call('GET', `/v1/channels/${ch}/files/${id}`, { token });

test('deleted once every recipient (members at upload time) confirms receipt', async () => {
  const [a, b, c] = [await reg('la'), await reg('lb'), await reg('lc')];
  await srv.call('POST', '/v1/channels', { token: a.token, json: { name: 'trio' } });
  await srv.call('POST', '/v1/channels/trio/join', { token: b.token });
  await srv.call('POST', '/v1/channels/trio/join', { token: c.token });
  const id = await upload(a.token, 'trio', 'r.csv');

  assert.equal((await received(a.token, 'trio', id)).body.remaining_recipients, 2); // 上传者不算
  assert.equal((await download(b.token, 'trio', id)).status, 200);
  assert.equal(await blobExists(srv.env, id), true);
  const rb = await received(b.token, 'trio', id);
  assert.deepEqual([rb.body.deleted, rb.body.remaining_recipients], [false, 1]);
  assert.equal((await received(b.token, 'trio', id)).body.remaining_recipients, 1); // 幂等
  assert.equal((await download(c.token, 'trio', id)).status, 200);
  const rc = await received(c.token, 'trio', id);
  assert.equal(rc.body.deleted, true);
  assert.equal(await blobExists(srv.env, id), false, 'blob removed from object storage');

  const gone = await download(c.token, 'trio', id);
  assert.equal(gone.status, 410);
  assert.equal(gone.body.error.code, 'file_deleted');
  assert.match(gone.body.error.message, /every recipient received it/);
  // 消息本身仍在日志里；web 视图标记为已送达删除
  const web = await srv.call('GET', '/v1/web/channels/trio/messages');
  assert.equal(web.body.messages.at(-1).file_deleted, 'delivered');
});

test('channel with only the uploader: first receipt by someone else deletes', async () => {
  const [a, b] = [await reg('sa'), await reg('sb')];
  await srv.call('POST', '/v1/channels', { token: a.token, json: { name: 'solo' } });
  const id = await upload(a.token, 'solo', 's.csv');
  await srv.call('POST', '/v1/channels/solo/join', { token: b.token });
  assert.equal((await received(b.token, 'solo', id)).body.deleted, true);
  assert.equal((await download(a.token, 'solo', id)).status, 410);
});

test('undelivered files expire after the retention period', async () => {
  const [a, b] = [await reg('ea'), await reg('eb')];
  await srv.call('POST', '/v1/channels', { token: a.token, json: { name: 'slow' } });
  await srv.call('POST', '/v1/channels/slow/join', { token: b.token });
  const id = await upload(a.token, 'slow', 'e.csv');
  assert.equal((await download(b.token, 'slow', id)).status, 200);
  for (let i = 0; i < 50; i++) {
    const r = await download(b.token, 'slow', id);
    if (r.status === 410) {
      assert.match(r.body.error.message, /expired/);
      assert.equal(await blobExists(srv.env, id), false, 'expired blob removed');
      const info = await srv.call('GET', '/v1/info');
      assert.equal(info.body.file_ttl_seconds, 2);
      return;
    }
    await new Promise((res) => setTimeout(res, 200));
  }
  assert.fail('file did not expire');
});
