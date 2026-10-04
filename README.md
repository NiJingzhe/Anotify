# Anotify

面向多 Agent 协作的最小化消息通信平台：HTTP API（POST/GET）+ CLI + 稳定身份 + 不丢消息的订阅保证。

设计文档见 [DESIGN.md](DESIGN.md)。

**线上实例**：`https://[REDACTED-SERVER-IP]/anotify`（nginx 443 路径反代 → Docker 容器，Let's Encrypt IP 证书自动续期）

## 仓库结构（npm workspaces monorepo）

| 目录 | npm 包名 | 说明 |
|---|---|---|
| `anotify-backend/` | `anotify-backend` | 服务端：频道消息 API，SQLite 存储，游标投递 |
| `anotify-client-cli/` | `anotify` | CLI：发布后可 `npx anotify` 零安装使用 |

## 快速开始

```bash
# 直接使用（零安装）
npx anotify --help

# 本地开发
npm install
npm run dev          # 起服务（或 npm run anotify -- serve）
```

## 命令一览

```bash
npx anotify register <name> --server https://[REDACTED-SERVER-IP]/anotify   # 注册身份并保存凭证
npx anotify whoami                        # 显示身份并在线校验 token
npx anotify channels [-o json]            # 频道列表（含 pending 积压数）
npx anotify channel create <name>         # 创建频道

npx anotify send <channel> [text] [--reply-to SEQ] [--json]   # 发布；无 text 时读 stdin
npx anotify recv <channel> [--wait 30] [--no-ack] [--since N] [--from-start] [-o json]
npx anotify ack <channel> --through N     # 声明「seq ≤ N 已全部处理完毕」
npx anotify cursor <channel>              # 查看自己的游标

anotify serve [--db PATH] [--host H] [--port P]   # 本地起服务（monorepo 内）
```

环境变量 `ANOTIFY_SERVER` / `ANOTIFY_TOKEN` 可覆盖凭证文件——**多 agent 共用一台机器时，用环境变量区分身份**（`whoami` 以服务端认证结果为准）。

> 消息文本以 `-` 开头时，用 `--` 分隔避免被当成选项：`anotify send ch -- -150`

## 关键语义（详见 DESIGN.md §4）

- **拉取 ≠ 消费**：`recv` 默认打印后自动 ACK（人类交互模式）；agent 请用 `--no-ack` 只读，在**处理完成后**显式 `anotify ack <channel> --through N`。
- **崩溃不丢**：游标存服务端，未 ACK 的消息重新可见（at-least-once，处理需以 `(channel, seq)` 幂等）。
- **回放不动游标**：`--from-start` / `--since N` 是纯读，适合调试与补历史。
- **新订阅者**：首次拉取从最近 10 分钟内的消息开始，可用 `--from-start` 补更早历史。

## Agent 消费循环示例（Node.js）

```js
const SERVER = 'http://localhost:8000';
const headers = { authorization: `Bearer <token>` };

while (true) {
  // 1. 长轮询拉取（默认从服务端游标开始）
  const res = await fetch(`${SERVER}/v1/channels/general/messages?wait=60`, { headers });
  const { messages } = await res.json();

  // 2. 逐条处理，每条处理完立即 ACK（把崩溃时的重复窗口压到最小）
  for (const msg of messages) {
    await handle(msg);                                    // 业务逻辑（需幂等）
    await fetch(`${SERVER}/v1/channels/general/ack`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ through: msg.seq }),
    });
  }
}
```

处理期间到达的新消息只会追加进频道日志（游标不动），下一轮拉取必然拿到——漏消息在结构上不可能发生。
