// 文件 blob 存储：流式落盘 + sha256 + 限额，启动时孤儿回收（设计见 DESIGN.md §12）
import { createReadStream, createWriteStream, mkdirSync, readdirSync, renameSync, rmSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError } from './schemas.js';

export const newFileId = () => 'f_' + randomBytes(12).toString('base64url');

const FILE_ID_RE = /^f_[A-Za-z0-9_-]{16}$/;

/**
 * @param {string} dir  blob 根目录：<dir>/<file_id> 为正式 blob，<dir>/tmp/ 为上传中的临时文件
 */
export function createBlobStore(dir) {
  const tmpDir = join(dir, 'tmp');
  mkdirSync(tmpDir, { recursive: true });

  const pathOf = (fileId) => {
    if (!FILE_ID_RE.test(fileId)) throw new HttpError(404, 'file_not_found', `file "${fileId}" not found`);
    return join(dir, fileId);
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

  /** 临时文件原子转正（同一文件系统内 rename） */
  function commit(tmpPath, fileId) {
    renameSync(tmpPath, pathOf(fileId));
  }

  function discard(tmpPath) {
    rmSync(tmpPath, { force: true });
  }

  function remove(fileId) {
    rmSync(pathOf(fileId), { force: true });
  }

  /** 打开 blob 读流；blob 丢失返回 null */
  function open(fileId) {
    const p = pathOf(fileId);
    if (!existsSync(p)) return null;
    return createReadStream(p);
  }

  /**
   * 孤儿回收：清空 tmp/，删除没有 files 行引用的 blob。
   * 上传顺序是「先 rename 再提交事务、事务失败即删」，崩溃最多留下无引用 blob，由这里兜底。
   */
  function sweep(isKnownFileId) {
    let removed = 0;
    for (const name of readdirSync(tmpDir)) {
      rmSync(join(tmpDir, name), { force: true, recursive: true });
      removed++;
    }
    for (const name of readdirSync(dir)) {
      if (name === 'tmp') continue;
      const p = join(dir, name);
      if (!statSync(p).isFile()) continue;
      if (!FILE_ID_RE.test(name) || !isKnownFileId(name)) {
        rmSync(p, { force: true });
        removed++;
      }
    }
    return removed;
  }

  return { dir, receive, commit, discard, remove, open, sweep };
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
