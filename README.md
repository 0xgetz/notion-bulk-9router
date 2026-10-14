<div align="center">

<img src="brand/banner.svg" alt="notion-bulk-9router" width="640">

### Bulk-create Notion accounts → auto-extract sessions → serve them through 9Router

*One command spins up N Notion workspaces, harvests each `token_v2`, and wires them into a
load-balanced OpenAI-compatible pool behind a single 9Router endpoint.*

<br>

[![License: MIT](https://img.shields.io/badge/License-MIT-8B7CF6.svg?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-6EE7F9.svg?style=flat-square)](package.json)
[![Dependencies](https://img.shields.io/badge/dependencies-0-F472B6.svg?style=flat-square)](#zero-dependencies)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-8B7CF6.svg?style=flat-square)](#contributing)
[![Made with CDP](https://img.shields.io/badge/powered%20by-Chrome%20DevTools%20Protocol-6EE7F9.svg?style=flat-square)](#how-the-browser-relay-works)

<br>

[🇬🇧 English](README.md) · [🇮🇩 Bahasa](i18n/README.id.md) · [🇨🇳 简体中文](i18n/README.zh.md) · [🇯🇵 日本語](i18n/README.ja.md) · [🇪🇸 Español](i18n/README.es.md)

</div>

---

## What this does

Notion AI has **no public API**, and its internal write endpoints reject datacenter
IPs outright. This toolkit flips that into an advantage:

1. **Creates accounts in bulk** — drives the real Notion signup wizard in a browser,
   verifying each account through a disposable inbox.
2. **Extracts the session automatically** — pulls `token_v2` + workspace/user ids
   straight from the browser's cookie jar.
3. **Serves them as one API** — an OpenAI-compatible adapter runs every request
   *inside a live Notion tab* (residential IP + real cookie jar), and registers the
   whole pool into **9Router** so any coding agent can use it.

```text
notion-bulk create --count 5 --router http://127.0.0.1:20128
```

That's it — five accounts, five sessions, one pool.

---

## Features

| | |
|---|---|
| 🧬 **Bulk accounts** | `--count N` signs up N workspaces end-to-end, no manual steps |
| 🍪 **Auto session capture** | Reads httpOnly `token_v2` over CDP and stores it |
| 🌐 **Residential-IP relay** | Writes run inside the browser tab, defeating the datacenter IP gate |
| 🔁 **Round-robin pool** | The adapter load-balances across every stored account |
| 🎯 **Model selection** | Pick any of ~36 usable Notion models per thread |
| 🧩 **9Router ready** | One command registers the provider node + key |
| 📦 **Zero dependencies** | Pure Node ≥18 — hand-rolled CDP, no `node_modules` |
| 🔒 **Self-contained** | Your accounts and cookies stay in your own `accounts.json` |

---

## Architecture

```text
┌──────────┐   POST /v1/chat/completions    ┌──────────────┐
│  client  │ ─────────────────────────────► │  9Router     │  prefix: notion/*
│ (Continue│                                │   :20128     │
│  Cline…) │ ◄───────────────────────────── │              │
└──────────┘        OpenAI-compatible       └──────┬───────┘
                                                   │  forwards to provider
                                                   ▼
                                          ┌──────────────────┐
                                          │  adapter  :8790  │  round-robin
                                          │  + failover      │
                                          └────────┬─────────┘
                                                   │  createAgentThread …
                                                   ▼
                                       ┌────────────────────────┐
                                       │ browser-transport.js   │  fetch() runs
                                       │ (live app.notion.com)  │  INSIDE the tab
                                       └────────────┬───────────┘
                                                    │  residential IP + cookie jar
                                                    ▼
                                          ┌──────────────────┐
                                          │   Notion AI      │
                                          │   api/v3         │
                                          └──────────────────┘
```

Full breakdown in [`STRUCTURE.md`](STRUCTURE.md); the internal API is documented in
[`docs/PROTOCOL.md`](docs/PROTOCOL.md).

---

## Quickstart

### 1. Get a browser to drive

**Browser Use cloud** (easiest — it also auto-solves the disposable-inbox
Turnstile and gives you a residential IP):

```bash
export BU_CDP_WS="wss://<your-cdp-endpoint>"
```

**or** your own Chrome with a debug port:

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=~/.chrome-notion
export NOTION_CDP_URL="http://127.0.0.1:9222"
```

### 2. Create accounts

```bash
node src/cli.js create --count 3 --domain mydomain.tld
```

Each account is written to `accounts.json`. Progress prints per step:

```text
Creating 3 account(s)...
  --- account 1/3 ---
  mail: a4f2c1@mydomain.tld
  notion: signing up
  mail: waiting for verification code
  mail: code 748213
  notion: 3f9d872b-… @ space bb30413a-…
  notion: 39 models available
  router: connection 8f21
  done
```

### 3. Serve the pool

```bash
node src/cli.js serve            # OpenAI-compatible adapter on :8790
```

### 4. Register into 9Router

```bash
node src/cli.js connect --router http://127.0.0.1:20128
```

Output:

```json
{
  "clientKey": "sk-…",
  "nodeId": "notion",
  "connectionId": "8f21",
  "baseUrl": "http://127.0.0.1:20128/v1"
}
```

### 5. Use it

```bash
curl http://127.0.0.1:20128/v1/chat/completions \
  -H "Authorization: Bearer sk-…" \
  -H "Content-Type: application/json" \
  -d '{"model":"notion/baseten-deepseek-v4.1-flash",
       "messages":[{"role":"user","content":"hi"}]}'
```

---

## Commands

| Command | What it does |
|---|---|
| `create --count N` | Bulk-create N accounts and (optionally) connect them to 9Router |
| `serve` | Run the OpenAI-compatible adapter on `:8790` |
| `connect` | Register the adapter as a provider inside 9Router |
| `models` | List the live Notion model catalog (needs a logged-in tab) |
| `extract` | Capture `token_v2` + ids from an already-logged-in tab |
| `accounts` | Show the account store |

### Useful flags

```text
--count N              how many accounts to create            (create)
--domain <d>           inbox domain for dispose.lol           (create)
--name <s>             profile name for each workspace        (create)
--router <url>         register into this 9Router             (create/connect)
--adapter <url>        adapter base URL                       (create/connect)
--prefix <p>           provider prefix in 9Router (notion)    (create/connect)
--file <path>          account-store path (accounts.json)     (all)
```

---

## How the browser relay works

Notion's internal API behaves differently per operation:

| | datacenter IP | residential IP |
|---|:---:|:---:|
| reads (`getThreadTranscript`, `getAvailableModels`) | ✅ | ✅ |
| writes (`createAgentThread`, `sendEventToAgentThread`) | ❌ `UserValidationError` | ✅ |

A valid cookie is **not enough** — Notion checks the IP of the writer.
`browser-transport.js` therefore executes each write `fetch()` **inside a live,
logged-in `app.notion.com` tab** over CDP with `credentials: 'include'`. The
request leaves through the browser's residential IP, carrying the page's real
cookie jar. Two headers are intentionally **dropped** in relay mode:

- `cookie` — sending the session cookie header makes Notion answer `400`.
- `x-notion-active-user-header` — a value from a *different* account than the
  logged-in tab makes Notion answer `401`; the live page session already
  supplies the correct identity.

---

## Zero dependencies

No `package.json` dependencies, no `node_modules`. The toolkit ships its own:

- **`cdp.js`** — a from-scratch Chrome DevTools Protocol client (raw
  `WebSocket` + request/event plumbing).
- **`browser-transport.js`** — evaluate-arbitrary-JS-in-a-tab helper.
- **`dispose-mail.js`** — the disposable-inbox RPC client.

Everything runs on Node's standard library, so `git clone && node src/cli.js …`
just works.

---

## Requirements & notes

- **Node ≥ 18** (uses global `fetch` and `WebSocket`).
- A **browser with a residential IP** for account creation and serving —
  Browser Use cloud, or your own Chrome launched with `--remote-debugging-port`.
- **Disposable inbox**: Notion rejects well-known disposable *domains* at signup.
  Point `--domain` at a **custom domain** routed to the dispose.lol mailbox
  backend; the toolkit reads the verification code from there.
- **One CDP client per tab.** Do not run the adapter and an interactive
  debugging session against the same tab at once — Notion's `fetch()` and CDP
  `Runtime.evaluate` will contend. Use separate tabs/browsers for parallel work.
- Accounts and cookies live only in your local `accounts.json` (git-ignored).

---

## Project layout

```text
src/           the engine (provision, signup, adapter, transport, cdp)
i18n/          translated READMEs
brand/         logo, banner, icon (SVG)
docs/          PROTOCOL.md — the reverse-engineered API
examples/      ready-to-paste client configs
```

See [`STRUCTURE.md`](STRUCTURE.md) for the full tree and request path.

---

## Disclaimer

For **educational and research** purposes. Automating account creation may violate
Notion's Terms of Service. Use at your own risk — you assume all responsibility for
how you use it. Not affiliated with Notion or 9Router.

---

## Contributing

Issues and PRs welcome. Keep it zero-dependency and match the existing style.

## License

[MIT](LICENSE) © 2026 0xgetz
