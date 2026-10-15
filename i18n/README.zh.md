<div align="center">

<img src="../brand/banner.svg" alt="notion-bulk-9router" width="640">

### 批量创建 Notion 账号 → 自动提取会话 → 通过 9Router 提供服务

*一条命令即可创建 N 个 Notion 工作区、抓取各自的 `token_v2`，并把它们接入一个
负载均衡、兼容 OpenAI 的池，统一暴露在单个 9Router 端点之后。*

<br>

[![License: MIT](https://img.shields.io/badge/License-MIT-8B7CF6.svg?style=flat-square)](../LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-6EE7F9.svg?style=flat-square)](../package.json)
[![Dependencies](https://img.shields.io/badge/dependencies-0-F472B6.svg?style=flat-square)](#零依赖)

<br>

[🇬🇧 English](../README.md) · [🇮🇩 Bahasa](README.id.md) · [🇨🇳 简体中文](README.zh.md) · [🇯🇵 日本語](README.ja.md) · [🇪🇸 Español](README.es.md)

</div>

---

## 它做什么

Notion AI **没有公开 API**，其内部写入端点是拒绝数据中心 IP 的。本工具把它变成优势：

1. **批量创建账号** — 在浏览器中驱动真实的 Notion 注册向导，通过一次性邮箱验证每个账号。
2. **自动提取会话** — 直接从浏览器 cookie jar 中取出 `token_v2` 及工作区/用户 id。
3. **统一为一个 API** — 兼容 OpenAI 的适配器把每个请求*运行在活跃的 Notion 标签页内*
   （住宅 IP + 真实 cookie jar），并把整个池注册进 **9Router**。

```text
notion-bulk create --count 5 --router http://127.0.0.1:20128
```

就这些 — 五个账号、五个会话、一个池。

---

## 特性

| | |
|---|---|
| 🧬 **批量账号** | `--count N` 端到端注册 N 个工作区，无需手动操作 |
| 🍪 **自动会话抓取** | 通过 CDP 读取 httpOnly `token_v2` 并存储 |
| 🌐 **住宅 IP 中继** | 写入在标签页内执行，突破数据中心 IP 限制 |
| 🔁 **轮询池** | 适配器在所有已存账号间做负载均衡 |
| 🎯 **模型选择** | 可为每个线程选择约 36 个可用 Notion 模型之一 |
| 🧩 **开箱即用 9Router** | 一条命令注册 provider 节点 + key |
| 📦 **零依赖** | 纯 Node ≥18 — 自研 CDP，无 `node_modules` |

---

## 架构

```text
┌──────────┐   POST /v1/chat/completions    ┌──────────────┐
│  客户端  │ ─────────────────────────────► │  9Router     │  前缀: notion/*
│ (Continue│                                │   :20128     │
│  Cline…) │ ◄───────────────────────────── │              │
└──────────┘        兼容 OpenAI             └──────┬───────┘
                                                   ▼
                                          ┌──────────────────┐
                                          │  adapter  :8790  │  轮询 + 故障转移
                                          └────────┬─────────┘
                                                   ▼
                                       ┌────────────────────────┐
                                       │ browser-transport.js   │  fetch() 运行在
                                       │ (活跃 app.notion.com)  │  标签页内
                                       └────────────┬───────────┘
                                                    ▼
                                          ┌──────────────────┐
                                          │   Notion AI      │
                                          └──────────────────┘
```

完整说明见 [`STRUCTURE.md`](../STRUCTURE.md)；内部 API 见
[`docs/PROTOCOL.md`](../docs/PROTOCOL.md)。

---

## 快速开始

### 1. 准备浏览器

**自己的 Chrome/Chromium** 加调试端口（使用专用配置，**不要**用日常配置）：

```bash
chromium --remote-debugging-port=9222 --user-data-dir=~/.chromium-notion
# 或：google-chrome --remote-debugging-port=9222 --user-data-dir=~/.chrome-notion
export NOTION_CDP_URL="http://127.0.0.1:9222"
```

浏览器必须通过**住宅 IP** 出口 — Notion（以及临时邮箱）会拒绝或限速数据中心 IP，
Notion AI 的写入端点更是直接拒绝。如果你的 VPS 是数据中心 IP，请让浏览器走住宅代理，
或把工具指向你已经在运行的远程浏览器。

**或**任何暴露 CDP websocket 的远程浏览器：

```bash
export NOTION_CDP_WS="wss://<host>/devtools/browser/<id>"
```

### 2. 创建账号

```bash
node src/cli.js create --count 3 --domain 我的域名.tld
```

每个账号写入 `accounts.json`。

### 3. 运行池

```bash
node src/cli.js serve            # 兼容 OpenAI 适配器在 :8790
```

### 4. 注册到 9Router

```bash
node src/cli.js connect --router http://127.0.0.1:20128
```

### 5. 使用

```bash
curl http://127.0.0.1:20128/v1/chat/completions \
  -H "Authorization: Bearer sk-…" \
  -H "Content-Type: application/json" \
  -d '{"model":"notion/baseten-deepseek-v4.1-flash",
       "messages":[{"role":"user","content":"你好"}]}'
```

---

## 命令

| 命令 | 作用 |
|---|---|
| `create --count N` | 批量创建 N 个账号并（可选）接入 9Router |
| `serve` | 在 `:8790` 运行兼容 OpenAI 适配器 |
| `connect` | 把适配器注册为 9Router 中的 provider |
| `models` | 列出实时 Notion 模型目录（需已登录标签页） |
| `extract` | 从已登录标签页抓取 `token_v2` 及 id |
| `accounts` | 显示账号存储 |

---

## Notion AI 模型

实时目录（39 个模型，2026-10-15 从 `getAvailableModels` 获取 — Free 可用 36 个，
3 个需要 Business/Enterprise）。以 `notion/<id>` 作为模型 id；`notion/auto` 由
Notion 自动选择。在已登录的浏览器上运行 `node src/cli.js models` 查看最新列表。

| 模型 id | 名称 | 家族 | 套餐 |
|---|---|---|---|
| `notion/omniberry-sundae` | GPT-6.1 Sol | openai | Free |
| `notion/orchid-muffin` | GPT-5.6 Terra | openai | Free |
| `notion/omodi` | GPT-6 Luna | openai | Free |
| `notion/albuquerque-quinn` | Opus 5.5 | anthropic | Free |
| `notion/soursop-shortcake` | Grok 4.6 | xai | Free |
| `notion/olive-jellyroll` | GPT-5.6 Luna | openai | Free |
| `notion/orange-mousse` | GPT-5.6 Sol | openai | Free |
| `notion/oatmeal-cookie` | GPT-5.2 | openai | Free |
| `notion/oval-kumquat-medium` | GPT-5.4 | openai | Free |
| `notion/opal-quince-medium` | GPT-5.5 | openai | Free |
| `notion/vertex-gemini-3.5-flash` | Gemini 3.5 Flash | gemini | Free |
| `notion/vertex-gemini-3.6-flash` | Gemini 3.6 Flash | gemini | Free |
| `notion/grapefruit-zeppole` | Gemini 3.7 Flash | gemini | Free |
| `notion/almond-croissant-low` | Sonnet 4.6 | anthropic | Free |
| `notion/angel-cake-high` | Sonnet 5 | anthropic | Free |
| `notion/achira-donut` | Sonnet 5.5 | anthropic | Free |
| `notion/amla-jam` | Haiku 5.5 | anthropic | Free |
| `notion/avocado-froyo-medium` | Opus 4.6 | anthropic | Free |
| `notion/apricot-sorbet-high` | Opus 4.7 | anthropic | Free |
| `notion/ambrosia-tart-high` | Opus 4.8 | anthropic | Free |
| `notion/agave-flan` | Opus 5 | anthropic | Free |
| `notion/oregon-grape-medium` | GPT-5.4 Mini | openai | Free |
| `notion/otaheite-apple-medium` | GPT-5.4 Nano | openai | Free |
| `notion/fireworks-kimi-k3` | Kimi K3 | mystery | Free |
| `notion/baseten-deepseek-v4-pro` | DeepSeek V4 Pro | mystery | Free |
| `notion/baseten-deepseek-v4-flash` | DeepSeek V4 Flash | mystery | Free |
| `notion/baseten-deepseek-v4.1-flash` | DeepSeek V4.1 Flash | mystery | Free |
| `notion/baseten-glm-5.2` | GLM 5.2 | mystery | Free |
| `notion/baseten-glm-5.3` | GLM 5.3 | mystery | Free |
| `notion/baseten-glm-5.3-flash` | GLM 5.3 Flash | mystery | Free |
| `notion/xigua-mochi-medium` | Grok 4.3 | xai | Free |
| `notion/strawberry-whoopiepie` | Grok 4.5 | xai | Free |
| `notion/xinomavro-cake` | Grok Build 0.1 | xai | Free |
| `notion/galette-medium-thinking` | Gemini 3.1 Pro | gemini | Free |
| `notion/anthropic-haiku-4.5` | Haiku 4.5 | anthropic | Free |
| `notion/gingerbread` | Gemini 3 Flash | gemini | Free |
| `notion/orlando-quinn` | GPT-6 Astra | openai | Business/Enterprise |
| `notion/assam-chai` | Fable 5.1 | anthropic | Business/Enterprise |
| `notion/acai-budino-high` | Fable 5 | anthropic | Business/Enterprise |

---

## 浏览器中继如何工作

| | 数据中心 IP | 住宅 IP |
|---|:---:|:---:|
| 读 (`getThreadTranscript`, `getAvailableModels`) | ✅ | ✅ |
| 写 (`createAgentThread`, `sendEventToAgentThread`) | ❌ `UserValidationError` | ✅ |

仅有有效 cookie **是不够的** — Notion 会检查写入方 IP。
`browser-transport.js` 把每次写入 `fetch()` 运行在**活跃的 `app.notion.com`
标签页内**，通过 CDP 并使用 `credentials: 'include'`。中继模式下会**刻意省略**
会话 cookie 头。

---

## 零依赖

无 `package.json` 依赖，无 `node_modules`。工具自带 `cdp.js`（纯 CDP 客户端）、
`browser-transport.js` 和 `dispose-mail.js`。

---

## 要求与说明

- **Node ≥ 18**（使用全局 `fetch` 与 `WebSocket`）。
- 创建账号与提供服务需要**住宅 IP 浏览器**。
- **一次性邮箱**：Notion 在注册时会拒绝知名一次性*域名*。请把 `--domain`
  指向一个路由到 dispose.lol 邮箱后端的**自定义域名**。
- **每个标签页一个 CDP 客户端。** 不要同时对同一标签页运行适配器和交互式调试会话。
- 账号与 cookie 仅存于本地 `accounts.json`（已 gitignore）。

---

## 许可证

[MIT](../LICENSE) © 2026 0xgetz
