<div align="center">

<img src="../brand/banner.svg" alt="notion-bulk-9router" width="640">

### Notion アカウントを一括作成 → セッションを自動抽出 → 9Router 経由で配信

*1 つのコマンドで N 個の Notion ワークスペースを作成し、各 `token_v2` を取得して、
単一の 9Router エンドポイントの背後で負荷分散された OpenAI 互換プールに接続します。*

<br>

[![License: MIT](https://img.shields.io/badge/License-MIT-8B7CF6.svg?style=flat-square)](../LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-6EE7F9.svg?style=flat-square)](../package.json)
[![Dependencies](https://img.shields.io/badge/dependencies-0-F472B6.svg?style=flat-square)](#依存ゼロ)

<br>

[🇬🇧 English](../README.md) · [🇮🇩 Bahasa](README.id.md) · [🇨🇳 简体中文](README.zh.md) · [🇯🇵 日本語](README.ja.md) · [🇪🇸 Español](README.es.md)

</div>

---

## これは何をするか

Notion AI には**公開 API がなく**、内部の書き込みエンドポイントはデータセンター IP を
拒否します。本ツールはそれを強みに変えます：

1. **アカウントを一括作成** — ブラウザで実際の Notion サインアップウィザードを操作し、
   使い捨て受信箱で各アカウントを認証します。
2. **セッションを自動抽出** — ブラウザの Cookie jar から `token_v2` と
   ワークスペース/ユーザー ID を直接取得します。
3. **1 つの API として提供** — OpenAI 互換アダプタが各リクエストを*生きた Notion タブ内*で
   実行し（住宅 IP + 本物の Cookie jar）、プール全体を **9Router** に登録します。

```text
notion-bulk create --count 5 --router http://127.0.0.1:20128
```

これだけ — 5 アカウント、5 セッション、1 プール。

---

## 機能

| | |
|---|---|
| 🧬 **一括アカウント** | `--count N` で N ワークスペースを手動操作なしで登録 |
| 🍪 **セッション自動取得** | CDP 経由で httpOnly `token_v2` を読み取り保存 |
| 🌐 **住宅 IP リレー** | 書き込みをタブ内で実行し、データセンター IP 制限を突破 |
| 🔁 **ラウンドロビン・プール** | アダプタが全アカウントに負荷分散 |
| 🎯 **モデル選択** | 約 36 の利用可能な Notion モデルから選択 |
| 🧩 **9Router 対応** | 1 コマンドで provider ノード + キーを登録 |
| 📦 **依存ゼロ** | 純粋な Node ≥18 — 自前 CDP、`node_modules` なし |

---

## アーキテクチャ

```text
┌──────────┐   POST /v1/chat/completions    ┌──────────────┐
│ クライアント│ ────────────────────────────► │  9Router     │  接頭辞: notion/*
│ (Continue│                                │   :20128     │
│  Cline…) │ ◄───────────────────────────── │              │
└──────────┘        OpenAI 互換             └──────┬───────┘
                                                   ▼
                                          ┌──────────────────┐
                                          │  adapter  :8790  │  ラウンドロビン
                                          │  + フェイルオーバー│
                                          └────────┬─────────┘
                                                   ▼
                                       ┌────────────────────────┐
                                       │ browser-transport.js   │  fetch() は
                                       │ (生きた app.notion.com) │  タブ内で実行
                                       └────────────┬───────────┘
                                                    ▼
                                          ┌──────────────────┐
                                          │   Notion AI      │
                                          └──────────────────┘
```

詳細は [`STRUCTURE.md`](../STRUCTURE.md)、内部 API は
[`docs/PROTOCOL.md`](../docs/PROTOCOL.md) を参照。

---

## クイックスタート

### 1. ブラウザを準備

**自前の Chrome/Chromium** をデバッグポート付きで（専用プロファイルを使い、**普段使いのプロファイルは使わない**）：

```bash
chromium --remote-debugging-port=9222 --user-data-dir=~/.chromium-notion
# または: google-chrome --remote-debugging-port=9222 --user-data-dir=~/.chrome-notion
export NOTION_CDP_URL="http://127.0.0.1:9222"
```

ブラウザは**住宅用IP**から出る必要があります — Notion（および使い捨て受信箱）は
データセンターIPを拒否/制限し、Notion AI の書き込みエンドポイントは完全に拒否します。
VPS がデータセンターIPの場合、ブラウザを住宅用プロキシ経由にしてください。すでに
運用中のリモートブラウザを指定してもかまいません。

**または** CDP ウェブソケットを公開する任意のリモートブラウザ：

```bash
export NOTION_CDP_WS="wss://<host>/devtools/browser/<id>"
```

### 2. アカウント作成

```bash
node src/cli.js create --count 3 --domain mydomain.tld
```

各アカウントは `accounts.json` に書き込まれます。

### 3. プールを起動

```bash
node src/cli.js serve            # OpenAI 互換アダプタ :8790
```

### 4. 9Router に登録

```bash
node src/cli.js connect --router http://127.0.0.1:20128
```

### 5. 使用

```bash
curl http://127.0.0.1:20128/v1/chat/completions \
  -H "Authorization: Bearer sk-…" \
  -H "Content-Type: application/json" \
  -d '{"model":"notion/baseten-deepseek-v4.1-flash",
       "messages":[{"role":"user","content":"こんにちは"}]}'
```

---

## コマンド

| コマンド | 説明 |
|---|---|
| `create --count N` | N アカウントを一括作成し（任意で）9Router に接続 |
| `serve` | `:8790` で OpenAI 互換アダプタを起動 |
| `connect` | アダプタを 9Router の provider として登録 |
| `models` | ライブの Notion モデル一覧（要ログインタブ） |
| `extract` | ログイン済みタブから `token_v2` と ID を取得 |
| `accounts` | アカウントストアを表示 |

---

## Notion AI のモデル

ライブカタログ（39 モデル、2026/10/15 に `getAvailableModels` から取得 —
Free で使えるのは 36、3 つは Business/Enterprise が必要）。id は
`notion/<id>` の形で指定。`notion/auto` なら Notion が自動選択。最新の一覧は
ログイン済みブラウザで `node src/cli.js models` を実行してください。

| モデル id | 名前 | ファミリー | プラン |
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

## ブラウザリレーの仕組み

| | データセンター IP | 住宅 IP |
|---|:---:|:---:|
| 読み取り (`getThreadTranscript`, `getAvailableModels`) | ✅ | ✅ |
| 書き込み (`createAgentThread`, `sendEventToAgentThread`) | ❌ `UserValidationError` | ✅ |

有効な Cookie だけでは**不十分** — Notion は書き込み元の IP を検査します。
`browser-transport.js` は各書き込み `fetch()` を**生きた `app.notion.com`
タブ内**で CDP 経由、`credentials: 'include'` で実行します。リレーモードでは
セッション Cookie ヘッダーを**意図的に省略**します。

---

## 依存ゼロ

`package.json` 依存も `node_modules` もありません。自前の `cdp.js`（純粋な CDP
クライアント）、`browser-transport.js`、`dispose-mail.js` を同梱します。

---

## 要件・注意

- **Node ≥ 18**（グローバル `fetch` と `WebSocket` を使用）。
- アカウント作成と配信には**住宅 IP のブラウザ**が必要。
- **使い捨て受信箱**：Notion はサインアップ時に既知の使い捨て*ドメイン*を拒否します。
  `--domain` は dispose.lol のメールバックエンドにルーティングされた**カスタム
  ドメイン**を指定してください。
- **タブごとに 1 つの CDP クライアント。** 同じタブでアダプタと対話的デバッグ
  セッションを同時に動かさないでください。
- アカウントと Cookie はローカルの `accounts.json` にのみ保存（gitignore 済み）。

---

## ライセンス

[MIT](../LICENSE) © 2026 0xgetz
