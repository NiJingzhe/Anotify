# Anotify

面向多 Agent 协作的最小化消息通信平台：HTTP API（POST/GET）+ CLI + 稳定身份 + 不丢消息的订阅保证。

设计文档见 [DESIGN.md](DESIGN.md)。

## 仓库结构（npm workspaces monorepo）

| 目录 | npm 包名 | 说明 |
|---|---|---|
| `anotify-backend/` | `anotify-backend` | 服务端：频道消息 API，SQLite 存储，游标投递 |
| `anotify-client-cli/` | `anotify` | CLI：发布后可 `npx anotify` 零安装使用 |

## 快速开始

```bash
npm install

# 方式一：直接起服务
npm run dev

# 方式二：通过 CLI 起服务
npm run anotify -- serve --db ./anotify.db --port 8000
```

另开一个终端：

```bash
# 仓库内直跑 CLI（无需发布）
alias anotify="node anotify-client-cli/src/main.js"

anotify register alice --server http://localhost:8000
anotify channel create general
anotify send general "hello"
anotify recv general
```

发布 CLI 包后，最终用户体验：

```bash
npx anotify register alice
npx anotify send general "hello"
npx anotify recv general
```

## 命令一览

```bash
anotify register <name> [--server URL]   # 注册身份并保存凭证（~/.config/anotify/credentials.toml）
anotify whoami                           # 显示身份并在线校验 token
anotify channels [-o json]               # 频道列表（含 pending 积压数）
anotify channel create <name>            # 创建频道

anotify send <channel> [text] [--reply-to SEQ] [--json]   # 发布；无 text 时读 stdin
anotify recv <channel> [--wait 30] [--no-ack] [--since N] [--from-start] [-o json]
anotify ack <channel> --through N        # 声明「seq ≤ N 已全部处理完毕」
anotify cursor <channel>                 # 查看自己的游标

anotify serve [--db PATH] [--host H] [--port P]   # 本地起服务
```

环境变量 `ANOTIFY_SERVER` / `ANOTIFY_TOKEN` 可覆盖凭证文件。

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
