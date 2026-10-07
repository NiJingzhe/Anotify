// 唤醒核心（`recv --listen` 与 `daemon` 共用）：长轮询直到「他人的」真消息。
// 设计见 SKILL.md「Listening」；自回声过滤与 at-least-once 语义的说明见 listenForWake。
import { api, ApiError } from './api.js';
import { fileMeta } from './render.js';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';

export const LISTEN_RETRY_DELAYS_MS = [2000, 5000, 10000, 30000];

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 收件箱路径：默认 ~/.anotify/inbox/<身份>/<频道>.json（身份一层防止同机多 agent 互踩），ANOTIFY_INBOX_DIR 可改根 */
export function inboxFileFor(cred, channel) {
  const base = process.env.ANOTIFY_INBOX_DIR || join(homedir(), '.anotify', 'inbox');
  const who = String(cred.profile ?? cred.agent ?? 'env').replace(/[^A-Za-z0-9_.-]/g, '_');
  const safe = String(channel).replace(/[^A-Za-z0-9_.-]/g, '_');
  return join(base, who, `${safe}.json`);
}

/** 以当前身份为准、可直接照抄的完整命令前缀 */
export function agentCli(cred) {
  return cred.profile ? `npx -y anotify@latest --profile ${cred.profile}` : 'npx -y anotify@latest';
}

/**
 * 把「传入的消息数组」（调用方已过滤掉自己的回声）覆盖写入收件箱（临时文件 + 原子 rename），返回绝对路径。
 * 监听不替 agent ack 他人的消息：处理权在唤醒后的 agent；忘了 ack，下一轮监听会原样再收（at-least-once 自愈）。
 */
export function writeInbox(cred, channel, resp) {
  const target = inboxFileFor(cred, channel);
  mkdirSync(dirname(target), { recursive: true });
  const messages = resp.messages.map((m) => {
    const f = fileMeta(m);
    return {
      seq: m.seq,
      sender: m.sender_name ?? m.sender,
      sender_id: m.sender,
      created_at: m.created_at,
      reply_to: m.reply_to ?? null,
      content_type: m.content_type ?? 'text/plain',
      ...(f
        ? {
            file: { name: f.name, size: f.size, mime: f.mime, sha256: f.sha256 ?? null, caption: f.caption ?? null },
            download_command: `${agentCli(cred)} download ${channel} ${m.seq}`,
          }
        : { content: String(m.content ?? '') }),
    };
  });
  const maxSeq = resp.messages[resp.messages.length - 1].seq;
  const payload = {
    _meta: {
      channel,
      profile: cred.profile ?? cred.agent ?? 'env',
      count: messages.length,
      max_seq: maxSeq,
      ack_command: `${agentCli(cred)} ack ${channel} --through ${maxSeq}`,
      rearm_command: `${agentCli(cred)} recv ${channel} --listen`,
      fetched_at: new Date().toISOString(),
      ...(resp.cursor_initialized && {
        note: 'cursor was initialized by this call: the batch covers only messages newer than 10 minutes; run recv --from-start for full history',
      }),
    },
    messages,
  };
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(tmp, target);
  return target;
}

/**
 * 静默长轮询直到「他人的」真消息，resolve 一个唤醒对象（不打印、不退出——由调用方决定去向）：
 *   { channel, maxSeq, count, inbox, ownFiltered, wakeLine }
 *
 * 自回声过滤：自己发的消息无需「处理」，整页全为自己的消息时静默 ack（推进游标）后继续轮询，
 * 不唤醒 agent。ack 是水位线、无法跳过消息，因此混合批次绝不整页 ack——只把他人消息写进收件箱
 * （夹在他人消息之间的自己的消息随 ack 水位线自然覆盖；落在最后一个他人消息之后的，由下一轮
 * 监听的整页自回声分支自愈）。对他人消息，at-least-once 语义完整保留：监听永不替 agent ack。
 *
 * 网络/5xx 按退避重试、永不因此退出；401/403/404 这类永久错误向上抛（ApiError）。
 */
export async function listenForWake(cred, channel, opts = {}) {
  const waitSec = Math.min(Math.max(opts.wait ?? 60, 1), 60);
  const me = String(cred.agent_id ?? cred.agent ?? '');
  let retry = 0;
  for (;;) {
    let resp;
    try {
      resp = await api(cred, 'GET', `/v1/channels/${encodeURIComponent(channel)}/messages`, {
        query: { wait: waitSec, limit: opts.limit },
      });
      retry = 0;
    } catch (e) {
      if (e instanceof ApiError && [401, 403, 404].includes(e.status)) throw e;
      await sleep(LISTEN_RETRY_DELAYS_MS[Math.min(retry++, LISTEN_RETRY_DELAYS_MS.length - 1)]);
      continue;
    }
    if (!resp || !Array.isArray(resp.messages) || resp.messages.length === 0) continue;

    const foreign = resp.messages.filter((m) => String(m.sender) !== me);
    if (foreign.length === 0) {
      // 整页都是自己的消息：静默 ack 掉（失败则下轮原样重收，幂等），不唤醒
      const last = resp.messages[resp.messages.length - 1];
      try {
        await api(cred, 'POST', `/v1/channels/${encodeURIComponent(channel)}/ack`, { body: { through: last.seq } });
      } catch (e) {
        if (e instanceof ApiError) throw e; // 永久问题（身份失效等），向上抛
        await sleep(LISTEN_RETRY_DELAYS_MS[Math.min(retry++, LISTEN_RETRY_DELAYS_MS.length - 1)]);
      }
      continue;
    }

    const lastForeign = foreign[foreign.length - 1];
    const ownFiltered = resp.messages.length - foreign.length;
    const inbox = writeInbox(cred, channel, { messages: foreign, cursor_initialized: resp.cursor_initialized });
    const wakeLine = `ANOTIFY-WAKE channel=${channel} profile=${cred.profile ?? cred.agent ?? 'env'} count=${foreign.length} max_seq=${lastForeign.seq} inbox=${inbox}${ownFiltered ? ` own_filtered=${ownFiltered}` : ''}`;
    return { channel, maxSeq: lastForeign.seq, count: foreign.length, inbox, ownFiltered, wakeLine };
  }
}
