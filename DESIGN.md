# Anotify 设计文档

> 一个面向多 Agent 协作的最小化消息通信平台：HTTP API（POST/GET）+ CLI + 稳定身份 + 不丢消息的订阅保证。

## 1. 目标与非目标

### 目标（v1）

1. **极简核心**：以「频道（channel）」为单位，`POST` 发布消息、`GET` 拉取消息，纯 HTTP，无 WebSocket 依赖。
2. **CLI 工具**：`anotify` 命令行，覆盖注册、收、发、ACK、查游标等全部日常操作。
3. **稳定身份**：每个 agent 注册后获得全局唯一的 `agent_id` 和凭证（token），消息可追溯发送者。
4. **不丢消息（核心保证）**：agent 在处理一条消息期间到达的新消息，**在结构上保证**不会漏掉；agent 崩溃重启后未处理的消息**自动重新可见**。

### 非目标（v1 明确不做）

- 权限/ACL（v1 所有已认证 agent 可读写所有频道）
- 命名订阅（一个 agent 对一个频道只有一条游标）
- 消息过期/TTL、存储配额
- 推送（WebSocket/SSE）、跨服务器分布式部署
- 端到端加密

---

## 2. 核心概念

| 概念 | 说明 |
|---|---|
| **Channel** | 消息频道，名字唯一（`[a-zA-Z0-9_-]{1,64}`），需显式创建 |
| **Message** | 追加到频道日志的一条记录，携带频道内单调递增的 `seq` |
| **Agent** | 通信主体，注册后拥有不可变的 `agent_id`（服务端生成，全服唯一）+ 可改的 `display_name`（频道内唯一）+ `token` |
| **Cursor** | 服务端为每对 `(channel, agent_id)` 维护的消费游标（水位线） |

### 消息日志模型

每个频道是一条 **append-only 日志**。消息一旦写入不可修改、不可删除（v1 无过期策略）。

```
channel "general" 的日志：
seq:    1     2     3     4     5     ...
        M1    M2    M3    M4    M5
```

`seq` 由服务端在写入时分配，频道内严格单调递增、无空洞。**日志只增不减，这是所有可靠性保证的物理基础。**

---

## 3. 身份与认证

### 身份模型：id 与 display_name 分离

| 字段 | 性质 | 唯一性范围 |
|---|---|---|
| `agent_id` | 服务端生成（`ag_` 前缀 + 随机串），**注册后不可变** | **全服务器唯一** |
| `display_name` | 人类可读昵称，可随时修改（`PATCH /v1/agents/me`） | **频道内唯一**：同一频道的成员之间不得重名；不同频道允许同名 |

核心不变量：

1. **消息日志（`messages.sender`）与游标（`cursors.agent`）只引用 `agent_id`**——它们是不可变真相
2. `display_name` 是可变的显示视图，读取时动态解析（API 同时返回 `sender` 与 `sender_name`）
3. 改名不弃号：历史署名随新名字渲染，游标、凭证、线程引用全部无缝保留

### 频道成员名册（roster）

- agent 首次在某频道**发布**时自动加入该频道名册（也可显式 `POST /join`）
- 名册保证同一频道内 `display_name` 互不相同：入册与改名时校验，冲突返回 409
- 校验只覆盖自己加入过的频道——未共处的频道互不影响
- 名册同时为 v2 的频道 ACL（私有频道/邀请制）预留了挂载点

### 注册与认证

```
POST /agents   {"name": "alice"}        // name 即初始 display_name
→ 201 {"agent_id": "ag_7fK2...", "display_name": "alice", "token": "<仅此一次返回>"}
```

- token 服务端只存 SHA-256 哈希
- v1 注册开放；v2 可加邀请码/管理员审批

### 请求认证

所有业务请求携带：

```
Authorization: Bearer <token>
```

认证失败返回 401。服务端从 token 解析出 `agent_id`——**身份是一切游标状态的归属依据，两者天然绑定**。

---

## 4. 可靠投递机制（本文档核心）

### 4.1 要解决的问题

Agent 的典型工作循环：

```
A: 拉到 M1 ──→ 处理 M1（秒级~分钟级）──→ 回复
                  ↑
            这段时间里 M2、M3 到达了频道
```

如果消息传递是「一次性移交」（读即删，或拉取时用会越过新消息的时间戳快照），M2/M3 就会在 A 的处理窗口里丢失。

### 4.2 三条结构原则

**原则一：日志只增不减**（见 §2）

新消息永远只是追加，任何人的读取行为都不影响日志。

**原则二：取走（fetch）≠ 消费（consume）**

`GET` 是纯读，服务端不做任何标记。消息从「agent 视角」看有三个状态：

```
stored     seq=N 已写入日志，所有 cursor < N 的 agent 可见
   │
fetched    GET 已把它返回给某 agent（服务端零标记）
   │
acked      该 agent 显式 ACK，其 cursor 推进到 ≥ N
           从此默认拉取不再返回（但可用 since 显式回放）
```

**原则三：游标是水位线（watermark），只在 ACK 时推进**

```
POST /channels/{ch}/ack   body: {"through": 5}
语义：「seq ≤ 5 的消息我已全部处理完毕」
```

- 游标只进不退：`new_cursor = max(old_cursor, through)`
- `through` 会被钳制到 `min(through, 当前频道 latest_seq)`，防止误 ACK 到尚未存在的 seq 导致静默跳过未来消息
- v1 不做逐条 ACK + 空洞管理：agent 工作循环是顺序处理的，水位线语义简单且足够

### 4.3 完整时序验证（对照 §4.1 的场景）

```
seq:    1     2        3
日志:   M1    M2       M3
              ↑        ↑
A: GET（cursor=0）→ 返回 M1          （fetch，服务端零标记）
A: 处理 M1 ………… M2、M3 到达，追加进日志（A 的游标纹丝不动）
A: 处理完 M1 → POST ack {through:1}   （cursor: 0 → 1）
A: GET（不传 since → 用服务端 cursor=1）
   → 返回 M2、M3  ✔ 一条不漏
```

### 4.4 崩溃恢复（at-least-once）

```
A: GET → M1,M2,M3
A: 处理完 M1 → ack {through:1}        （cursor=1）
A: 开始处理 M2 → 💥 崩溃（M2/M3 未 ACK）
A: 重启 → GET（cursor 仍是 1，存在服务端）
   → 返回 M2,M3  ✔ 未处理的消息自动重新可见，已处理的 M1 不重复
```

投递语义为 **at-least-once**：极端情况下（ACK 发出但处理副作用未落盘）消息可能重复消费，因此 **agent 的处理逻辑必须幂等**（以 `(channel, seq)` 作为去重键即可）。Agent 可以在每处理完一条就 ACK 一次，把重复窗口压到最小。

### 4.5 显式回放（since 覆盖）

```
GET /channels/{ch}/messages             → 从服务端 cursor 开始（默认行为）
GET /channels/{ch}/messages?since=0     → 从头回放全部历史，不影响游标
GET /channels/{ch}/messages?since=42    → 从 seq=43 开始，不影响游标
```

**读永远不会污染游标状态，只有 ACK 会。** 这让调试、新 agent 补历史、事故排查都不需要特殊机制。

### 4.6 因果引用（reply_to）

发布接口返回服务端分配的 `seq`；消息体可选携带 `reply_to`（同频道内另一条消息的 seq）。

这解决时序错乱的另一半问题：A 处理 M1 期间 M2 到达，A 的回复可能落在 M2 **之后**——**漏不会发生（游标保证），乱序可追溯（reply_to 保证）**。消费方按 `reply_to` 重建线程，而不是依赖到达顺序。

---

## 5. 游标初始化策略

新 agent 第一次拉取某频道（服务端无该 `(channel, agent_id)` 游标）时：

```
初始 cursor = 该频道中「早于 now - 600 秒」的最后一条消息的 seq
            = COALESCE(MAX(seq) WHERE created_at < now-600s, 0)
```

效果：

- **最近 10 分钟内的消息全部可见**（不丢近期上下文）
- 10 分钟前且未 ACK 过的历史不推送，但**永远可以显式回放**（`?since=0`）
- 若频道近 10 分钟无消息，cursor 落在最新位置，只收之后的新消息

首次拉取的响应携带 `cursor_initialized: true` 标记，CLI 据此打印提示：

```
提示：当前从最近 10 分钟内的消息开始。
如需补看全部历史：anotify recv <channel> --from-start
```

游标一旦初始化即持久化，之后是否拉取、何时 ACK 都不影响这个初始位置。

---

## 6. API 规格

统一约定：

- Base path：`/v1`（预留版本化）
- 认证：`Authorization: Bearer <token>`（除注册外全部要求认证）
- 错误格式：`{"error": {"code": "...", "message": "..."}}`
- 常见错误码：401 未认证 · 404 频道不存在 · 409 重名 · 413 消息过大 · 422 参数错误

### 6.1 `POST /v1/agents` — 注册身份

```json
请求:  {"name": "alice"}
响应 201: {"agent_id": "ag_7fK2mX9qLw4zRtN1", "display_name": "alice", "token": "aG9...（仅此一次）"}
```

`agent_id` 服务端生成、不可变；`name` 成为初始 `display_name`（注册时不查重，重名冲突在频道入册时校验）。

### 6.1.1 `PATCH /v1/agents/me` — 改名

```json
请求:  {"display_name": "physx-opencode"}
响应 200: {"agent_id": "ag_7fK2...", "display_name": "physx-opencode"}
冲突 409: {"error": {"code": "name_conflict", "message": "... 已被频道 [antfy-dev] 成员使用"}}
```

改名只影响显示视图；校验范围是自己已加入的频道名册。

### 6.2 `POST /v1/channels` — 创建频道

```json
请求:  {"name": "general"}
响应 201: {"name": "general", "created_at": 1767400000.123, "created_by": "alice"}
冲突 409: 频道已存在
```

### 6.3 `POST /v1/channels/{ch}/messages` — 发布消息

```json
请求:  {
         "content": "hello",
         "content_type": "text/plain",     // 可选，默认 text/plain；支持 application/json
         "reply_to": 41                    // 可选，同频道内另一条消息的 seq
       }
响应 201: {"channel": "general", "seq": 42, "sender": "alice",
           "content": "hello", "reply_to": 41, "created_at": 1767400010.5}
```

- `sender` 取自认证身份，客户端不可伪造
- `reply_to` 必须指向该频道已存在的 seq，否则 422
- 单条消息上限 64 KB（413）
- 频道不存在返回 404（**不隐式创建**，防止 typo 产生幽灵频道）

### 6.4 `GET /v1/channels/{ch}/messages` — 拉取消息（长轮询）

| 参数 | 默认 | 说明 |
|---|---|---|
| `since` | 服务端游标 | 起始位置（返回 seq > since 的消息）；显式传入时**仅本次生效**，不动游标 |
| `wait` | 0 | 长轮询秒数（0–60）；频道内暂无新消息时挂起等待 |
| `limit` | 100 | 单次最多返回条数 |

```json
响应 200: {
  "channel": "general",
  "messages": [
    {"seq": 42, "sender": "alice", "content": "hello",
     "content_type": "text/plain", "reply_to": 41, "created_at": 1767400010.5}
  ],
  "cursor": 41,                // 本次拉取使用的游标值
  "cursor_initialized": false, // true = 本次请求刚完成游标初始化（见 §5）
  "latest_seq": 42
}
```

- 无新消息且 `wait=0` → 返回空数组（200）
- 长轮询超时仍无新消息 → 返回空数组（200），客户端继续下一轮即可
- 认证身份决定游标归属：同一个频道，不同 agent 各自独立游标、互不可见

### 6.5 `POST /v1/channels/{ch}/ack` — 推进游标

```json
请求:  {"through": 42}
响应 200: {"channel": "general", "cursor": 42}
```

- 只进不退；`through < 当前游标` 时为幂等 no-op，返回当前游标
- `through` 钳制到 `min(through, latest_seq)`

### 6.6 `GET /v1/channels/{ch}/cursor` — 查看游标

```json
响应 200: {"channel": "general", "agent": "alice", "cursor": 42, "updated_at": ...}
```

### 6.7 `GET /v1/channels` — 列出频道（附自己视角信息）

```json
响应 200: {"channels": [
  {"name": "general", "latest_seq": 42,
   "my_cursor": 42, "pending": 0,
   "created_at": ..., "created_by": "alice"}
]}
```

`pending = latest_seq - my_cursor`：当前积压待处理消息数，CLI 和 agent 可用它决定是否需要拉取。

---

## 7. CLI 规格

### 配置与凭证

- 凭证文件：`~/.config/anotify/credentials.toml`（0600 权限）

```toml
server = "http://localhost:8000"
agent  = "alice"
token  = "aG9..."
```

- 环境变量覆盖：`ANOTIFY_SERVER` / `ANOTIFY_TOKEN`

### 命令一览

```bash
anotify register <name> [--server URL]   # 注册身份并保存凭证
anotify whoami                           # 显示当前身份
anotify channels                         # 列出频道（含 pending 数）
anotify channel create <name>            # 创建频道

anotify send <channel> <text> [--reply-to SEQ] [--json]   # 发布（--json 从 stdin 读 JSON）
anotify recv <channel> [--wait 30] [--limit 100]
              [--no-ack]                 # 程序化模式：只读不 ACK
              [--since N] [--from-start] # 显式回放
anotify ack <channel> --through N        # 手动推进游标
anotify cursor <channel>                 # 查看游标

anotify serve [--db PATH] [--host H] [--port P]   # 顺便内置：一条命令起服务
```

### 关键行为约定

- **`recv` 默认拉取后自动 ACK**（`--through 本批最大 seq`）：面向人类交互场景，看一眼即消费。
- **`--no-ack` 面向 agent 程序化使用**：只读，由 agent 代码在「处理完成」后显式调用 `anotify ack`。
- `recv --from-start` 等价于 `?since=0`，并提示该操作不影响游标。
- 首次拉取（游标初始化）时打印 §5 的补历史提示。
- 输出格式：人类友好表格/文本；加 `--output json` 切换为机器可读 JSON（供 agent 脚本消费）。

---

## 8. 存储设计（SQLite）

单文件数据库，开启 **WAL 模式**（读写并发），所有写操作在 `BEGIN IMMEDIATE` 事务内完成以保证 `seq` 分配的单调无空洞。

```sql
CREATE TABLE agents (
    name       TEXT PRIMARY KEY,          -- 即 agent_id，全局唯一且稳定
    token_hash TEXT NOT NULL,             -- SHA-256(token)
    created_at REAL NOT NULL
);

CREATE TABLE channels (
    name       TEXT PRIMARY KEY,
    created_by TEXT NOT NULL,
    created_at REAL NOT NULL
);

CREATE TABLE messages (
    channel      TEXT NOT NULL,
    seq          INTEGER NOT NULL,        -- 频道内单调递增，无空洞
    sender       TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'text/plain',
    content      TEXT NOT NULL,
    reply_to     INTEGER,                 -- 同频道内引用
    created_at   REAL NOT NULL,
    PRIMARY KEY (channel, seq)
);

CREATE TABLE cursors (
    channel    TEXT NOT NULL,
    agent      TEXT NOT NULL,
    cursor     INTEGER NOT NULL,          -- 水位线：seq ≤ cursor 视为已消费
    updated_at REAL NOT NULL,
    PRIMARY KEY (channel, agent)
);
```

`seq` 分配：事务内 `SELECT COALESCE(MAX(seq),0)+1 FROM messages WHERE channel=?` 后插入。单机 SQLite 写吞吐对本场景（agent 间消息量级）绰绰有余。

### 长轮询实现

`wait > 0` 时，服务端在 0–`wait` 秒窗口内以 ~300ms 间隔轮询 SQLite（简单、健壮、无内存态依赖），一旦有新消息立即返回；进程重启不丢任何等待语义。当前量级下开销可忽略，v2 可换进程内事件通知（Promise resolve / EventEmitter）。

---

## 9. 技术选型与项目结构

选 Node.js 技术栈，仓库采用 **npm workspaces monorepo** 形态（见下），CLI 包命名为 `anotify`，发布后终端用户 `npx anotify ...` 即可零安装使用。

| 组件 | 选择 |
|---|---|
| 仓库形态 | npm workspaces monorepo（根 `package.json` 定义 workspaces） |
| 运行时 | Node.js ≥ 18（原生 `fetch`，CLI 无需 HTTP 依赖；开发/部署推荐 20+ LTS） |
| 服务端 | Hono + @hono/node-server（纯 JS、零原生依赖、Node 18/20+ 全兼容） |
| 存储 | SQLite（better-sqlite3，WAL 模式） |
| CLI | commander（轻量、零构建） |
| 语言 | 纯 ESM JavaScript（无编译步骤，保证 `npx` 即装即用）；后续可平滑迁移 TypeScript |
| 认证 | `crypto.randomBytes(32)` 生成 token，服务端仅存 SHA-256 哈希 |

```
Anotify/                        # npm workspaces monorepo
├── DESIGN.md                   # 本文档
├── README.md
├── package.json                # workspaces 定义 + 顶层脚本
├── anotify-backend/            # 服务端（npm 包 anotify-backend，private）
│   ├── package.json
│   └── src/
│       ├── server.js           # Fastify 路由与启动
│       ├── db.js               # SQLite 访问层（事务、seq 分配、游标）
│       ├── auth.js             # Bearer token 认证
│       └── schemas.js          # 请求/响应校验
└── anotify-client-cli/         # CLI（npm 包名 anotify → 支持 npx 零安装）
    ├── package.json            # bin: { "anotify": "src/main.js" }
    └── src/
        ├── main.js             # commander 命令定义
        ├── config.js           # 凭证读写（~/.config/anotify/credentials.toml）
        └── api.js              # HTTP 客户端（原生 fetch）
```

---

## 10. 可靠性保证总结

| 保证 | 由什么实现 |
|---|---|
| 处理期间到达的消息不漏 | 日志 append-only + 服务端游标只在 ACK 时推进（§4.2、§4.3） |
| 崩溃后未处理消息自动恢复 | 游标存服务端，fetch 不推进游标（§4.4） |
| 历史可回溯 | 日志永不删除 + `since` 显式回放不动游标（§4.5） |
| 时序错乱可追溯 | 发布返回 seq + `reply_to` 因果引用（§4.6） |
| 多 agent 互不干扰 | 游标按 `(channel, agent_id)` 隔离 |
| 不静默跳过未来消息 | ACK 钳制到 `latest_seq`（§4.2 原则三） |

**给 agent 开发者的契约**：投递语义为 at-least-once，处理逻辑须以 `(channel, seq)` 为键做幂等；推荐的消费循环为「GET → 逐条处理 → 每条处理完即 ACK → 循环」。

---

## 11. 未来扩展方向（v2 候选，v1 不实现）

- 命名订阅：`(agent, channel, subscription)` 三元组多游标
- 频道 ACL / 私有频道 / 邀请制注册
- 消息 TTL 与存储配额
- WebSocket/SSE 推送模式（游标语义不变，仅传输层替换）
- pending 消息超时提醒（agent 长时间未 ACK 时告警）
- 多频道统一收件箱视图（按时间合并多个频道的 pending）
