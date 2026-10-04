# Anotify

面向多 Agent 协作的最小化消息通信平台：HTTP API（POST/GET）+ CLI + 稳定身份 + 不丢消息的订阅保证。

设计文档见 [DESIGN.md](DESIGN.md)。

## 特性

- **极简核心**：以频道为单位，`POST` 发布、`GET` 拉取（支持 0–60s 长轮询），纯 HTTP
- **不丢消息**：append-only 日志 + 服务端游标 + ACK 水位线——agent 处理期间到达的新消息在结构上不可能漏，崩溃重启后未处理消息自动重新可见（at-least-once）
- **稳定身份**：不可变的 `agent_id`（全服唯一）+ 可修改的 `display_name`（频道内唯一），改名不弃号
- **频道密码锁**：上锁频道的读写以成员名册为门，防乱入；公开频道零门槛
- **零安装 CLI**：`npx anotify` 即用

## 仓库结构（npm workspaces monorepo）

| 目录 | npm 包名 | 说明 |
|---|---|---|
| `anotify-backend/` | `anotify-backend` | 服务端：频道消息 API，SQLite 存储，游标投递 |
| `anotify-client-cli/` | `anotify` | CLI：发布后可 `npx anotify` 零安装使用 |

## 快速开始

### 自建服务端（Docker）

```bash
git clone https://github.com/PhySpace/Anotify.git
cd Anotify
docker compose up -d --build     # 默认监听宿主机 8000 端口，数据落 ./data/
```

也可以裸跑：`npm install && npm run dev`。

### 客户端

```bash
# 注册身份（<server-url> 换成你的服务端地址，如 http://localhost:8000）
npx anotify register alice --server <server-url>

npx anotify channel create dev                 # 公开频道
npx anotify channel create ops --password s3cret   # 上锁频道
npx anotify send dev "hello"
npx anotify recv dev --wait 30
```

凭证保存在 `~/.config/anotify/credentials.toml`；环境变量 `ANOTIFY_SERVER` / `ANOTIFY_TOKEN` 可覆盖——**多 agent 共用一台机器时，用环境变量区分身份**（或 `register --no-save`）。

## 命令一览

```bash
npx anotify register <name> [--server URL] [--no-save]  # 注册身份（--no-save 不写凭证文件）
npx anotify whoami                       # 显示 id + display_name（以服务端认证为准）
npx anotify rename <new-name>            # 改 display_name（agent_id 不变）
npx anotify channels [-o json]           # 频道列表（🔒 标记 + pending 积压数）
npx anotify channel create <name> [--password PW]
npx anotify channel passwd <ch> <pw>     # 改/清除密码（仅创建者；空串清除）
npx anotify join <channel> [--password PW]
npx anotify members <channel>

npx anotify send <channel> [text] [--reply-to SEQ] [--json]   # 发布；无 text 时读 stdin
npx anotify recv <channel> [--wait 30] [--no-ack] [--since N] [--from-start] [-o json]
npx anotify ack <channel> --through N    # 声明「seq ≤ N 已全部处理完毕」
npx anotify cursor <channel>

npx anotify serve [--db PATH] [--host H] [--port P]   # 本地起服务（monorepo 内）
```

## 关键语义（详见 DESIGN.md §4）

- **拉取 ≠ 消费**：`recv` 默认打印后自动 ACK（人类交互模式）；agent 请用 `--no-ack` 只读，在**处理完成后**显式 `anotify ack <channel> --through N`。
- **崩溃不丢**：游标存服务端，未 ACK 的消息重新可见（at-least-once，处理需以 `(channel, seq)` 幂等）。
- **回放不动游标**：`--from-start` / `--since N` 是纯读，适合调试与补历史。
- **新订阅者**：首次拉取从最近 10 分钟内的消息开始，可用 `--from-start` 补更早历史。
- **密码锁**：上锁频道的读/写/名册仅成员可用，`join --password` 入册；公开频道行为不变。
- 消息文本以 `-` 开头时，用 `--` 分隔：`anotify send ch -- -150`。

## Agent 消费循环示例（Node.js）

```js
const SERVER = '<server-url>';
const headers = { authorization: `Bearer <token>` };

while (true) {
  // 1. 长轮询拉取（默认从服务端游标开始）
  const res = await fetch(`${SERVER}/v1/channels/dev/messages?wait=60`, { headers });
  const { messages } = await res.json();

  // 2. 逐条处理，每条处理完立即 ACK（把崩溃时的重复窗口压到最小）
  for (const msg of messages) {
    await handle(msg);                                    // 业务逻辑（需幂等）
    await fetch(`${SERVER}/v1/channels/dev/ack`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ through: msg.seq }),
    });
  }
}
```

处理期间到达的新消息只会追加进频道日志（游标不动），下一轮拉取必然拿到——漏消息在结构上不可能发生。

## 技术栈

Node.js ≥ 18 · Hono + better-sqlite3（服务端）· commander（CLI）· 纯 ESM、零构建
