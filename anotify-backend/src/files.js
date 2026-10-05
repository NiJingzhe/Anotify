// 文件 blob 存储：流式接收 + sha256 + 限额，转正到 MinIO（S3）或本地目录，启动时孤儿回收（设计见 DESIGN.md §12）
import { copyFileSync, createReadStream, createWriteStream, mkdirSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as Minio from 'minio';
import { HttpError } from './schemas.js';

export const newFileId = () => 'f_' + randomBytes(12).toString('base64url');

const FILE_ID_RE = /^f_[A-Za-z0-9_-]{16}$/;

/**
 * 上传流程统一：请求体先流式落到本地 <tmpDir>（边写边计量 / 算 sha256），校验通过后 commit 转正。
 * 转正目标二选一（DESIGN §12）：
 *   - S3 兼容对象存储（MinIO）：配置了 s3.endpoint 时，对象键 files/<file_id>
 *   - 本地目录：<dir>/<file_id>（开发 / 单机兜底，也是 SQLite 时代的存储格式）
 *
 * @param {{ dir: string, s3?: { endpoint: string, accessKey: string, secretKey: string, bucket: string, region?: string } }} opts
 */
export async function createBlobStore({ dir, s3 }) {
  const tmpDir = join(dir, 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  const backend = s3?.endpoint ? await s3Backend(s3) : diskBackend(dir);

  const assertId = (fileId) => {
    if (!FILE_ID_RE.test(fileId)) throw new HttpError(404, 'file_not_found', `file "${fileId}" not found`);
    return fileId;
  };

  /**
   * 把请求体流式写入临时文件，边写边算 sha256 与字节数；超过 maxBytes 立即中止（413）。
   * 返回 { tmpPath, size, sha256 }；失败时临时文件已清理。
   */
  async function receive(webStream, maxBytes) {
    const tmpPath = join(tmpDir, randomBytes(12).toString('hex'));
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) {
          cb(new HttpError(413, 'file_too_large', `file exceeds ${maxBytes} bytes`));
          return;
        }
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      const source = webStream ? Readable.fromWeb(webStream) : Readable.from([]);
      await pipeline(source, meter, createWriteStream(tmpPath, { mode: 0o600 }));
    } catch (e) {
      rmSync(tmpPath, { force: true });
      throw e;
    }
    return { tmpPath, size, sha256: hash.digest('hex') };
  }

  /** 临时文件转正；无论成败临时文件都不再保留 */
  async function commit(tmpPath, fileId, { size, mime }) {
    try {
      await backend.put(tmpPath, assertId(fileId), { size, mime });
    } finally {
      rmSync(tmpPath, { force: true });
    }
  }

  function discard(tmpPath) {
    rmSync(tmpPath, { force: true });
  }

  async function remove(fileId) {
    await backend.remove(assertId(fileId));
  }

  /** 打开 blob 读流；blob 丢失返回 null */
  async function open(fileId) {
    return backend.open(assertId(fileId));
  }

  /**
   * 孤儿回收：清空 tmp/，删除没有 files 行引用的 blob。
   * 上传顺序是「先转正再提交事务、事务失败即删」，崩溃最多留下无引用 blob，由这里兜底。
   */
  async function sweep(isKnownFileId) {
    let removed = 0;
    for (const name of readdirSync(tmpDir)) {
      rmSync(join(tmpDir, name), { force: true, recursive: true });
      removed++;
    }
    for (const id of await backend.list()) {
      if (!FILE_ID_RE.test(id) || !(await isKnownFileId(id))) {
        await backend.remove(id);
        removed++;
      }
    }
    return removed;
  }

  return { kind: backend.kind, receive, commit, discard, remove, open, sweep, put: backend.put };
}

function diskBackend(dir) {
  return {
    kind: `disk ${dir}`,
    async put(srcPath, fileId) {
      copyFileSync(srcPath, join(dir, fileId));
    },
    async remove(fileId) {
      rmSync(join(dir, fileId), { force: true });
    },
    async open(fileId) {
      const p = join(dir, fileId);
      return existsSync(p) ? createReadStream(p) : null;
    },
    async list() {
      return readdirSync(dir).filter((n) => n !== 'tmp' && statSync(join(dir, n)).isFile());
    },
  };
}

async function s3Backend({ endpoint, accessKey, secretKey, bucket, region = 'us-east-1' }) {
  const u = new URL(endpoint);
  const useSSL = u.protocol === 'https:';
  const client = new Minio.Client({
    endPoint: u.hostname,
    port: u.port ? Number(u.port) : (useSSL ? 443 : 80),
    useSSL, accessKey, secretKey, region,
  });
  if (!(await client.bucketExists(bucket))) await client.makeBucket(bucket, region);
  const key = (fileId) => `files/${fileId}`;
  return {
    kind: `s3 ${endpoint}/${bucket}`,
    async put(srcPath, fileId, { size, mime }) {
      await client.putObject(bucket, key(fileId), createReadStream(srcPath), size, { 'Content-Type': mime });
    },
    async remove(fileId) {
      await client.removeObject(bucket, key(fileId));
    },
    async open(fileId) {
      try {
        return await client.getObject(bucket, key(fileId));
      } catch (e) {
        if (e.code === 'NoSuchKey' || e.code === 'NotFound') return null;
        throw e;
      }
    },
    async list() {
      const ids = [];
      for await (const obj of client.listObjectsV2(bucket, 'files/', true)) {
        if (obj.name) ids.push(obj.name.slice('files/'.length));
      }
      return ids;
    },
  };
}

const MIME_BY_EXT = {
  csv: 'text/csv', tsv: 'text/tab-separated-values', txt: 'text/plain', log: 'text/plain',
  md: 'text/markdown', json: 'application/json', jsonl: 'application/x-ndjson', ndjson: 'application/x-ndjson',
  yaml: 'application/yaml', yml: 'application/yaml', toml: 'application/toml', xml: 'application/xml',
  html: 'text/html', htm: 'text/html', js: 'text/javascript', ts: 'text/plain', py: 'text/x-python',
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp', zip: 'application/zip', gz: 'application/gzip',
  tgz: 'application/gzip', tar: 'application/x-tar', parquet: 'application/vnd.apache.parquet',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** 按扩展名推断 MIME；未知时退回客户端声明的类型，再退回 octet-stream */
export function guessMime(name, declared) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  const d = (declared ?? '').split(';')[0].trim().toLowerCase();
  if (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(d)) return d;
  return 'application/octet-stream';
}
