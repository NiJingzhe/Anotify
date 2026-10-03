# Anotify

面向多 Agent 协作的最小化消息通信平台：HTTP API（POST/GET）+ CLI + 稳定身份 + 不丢消息的订阅保证。

设计文档见 [DESIGN.md](DESIGN.md)。

## 仓库结构（npm workspaces monorepo）

| 目录 | npm 包名 | 说明 |
|---|---|---|
| `anotify-backend/` | `anotify-backend` | 服务端：频道消息 API，SQLite 存储，游标投递 |
| `anotify-client-cli/` | `anotify` | CLI：发布后可 `npx anotify` 零安装使用 |

## 快速开始（开发中）

```bash
npm install

# 起服务
npm run dev

# 用 CLI（仓库内直跑，无需发布）
npm run anotify -- register alice --server http://localhost:8000
npm run anotify -- send general "hello"
npm run anotify -- recv general
```

发布 CLI 包后，最终用户体验：

```bash
npx anotify register alice
npx anotify send general "hello"
```
