# Project Structure

```text
notion-bulk-9router/
│
├── README.md                  ← you are here (English)
│
├── src/                       ── THE ENGINE ─────────────────────────────
│   ├── provision.js           ── orchestrator: inbox → signup → session → 9Router
│   ├── notion-signup.js       ── drives the Notion signup wizard in the browser
│   ├── dispose-mail.js        ── disposable inbox (dispose.lol RPC + Turnstile)
│   ├── notion.js              ── Notion AI driver (threads, transcript, models)
│   ├── browser-transport.js   ── runs fetch() inside the live Notion tab (residential IP)
│   ├── cdp.js                 ── zero-dep Chrome DevTools Protocol client
│   ├── adapter.js             ── OpenAI-compatible pool server  :8790
│   ├── connect-9router.js     ── registers the adapter into 9Router   :20128
│   ├── extract-session.js     ── capture token_v2 + ids from a logged-in tab
│   └── cli.js                 ── command-line entry (create / serve / connect / …)
│
├── i18n/                      ── translations ────────────────────────────
│   ├── README.id.md           · Bahasa Indonesia
│   ├── README.zh.md           · 简体中文
│   ├── README.ja.md           · 日本語
│   └── README.es.md           · Español
│
├── brand/                     ── identity ───────────────────────────────
│   ├── logo.svg               · square app mark
│   ├── banner.svg             · horizontal wordmark
│   └── icon.svg               · favicon / social icon
│
├── docs/
│   └── PROTOCOL.md            ── reverse-engineered Notion AI protocol
│
├── examples/
│   └── cursor-config.json     ── wiring 9Router into a coding agent
│
├── run.sh                     ── one-shot launcher
├── STRUCTURE.md               ← this file
├── LICENSE                    · MIT
└── .gitignore
```

---

## Runtime data files (git-ignored, created at runtime)

```text
accounts.json                  the pool: [{ email, userId, spaceId, cookie, router }]
```

---

## The request path, end to end

```text
 ①  client                    any OpenAI-compatible app (Continue, Cline, curl, …)
      │  POST /v1/chat/completions   { model: "notion/<codename>", messages: […] }
      ▼
 ②  9Router  :20128           matches prefix "notion" → provider node (openai-compatible)
      │  forwards to adapter :8790/v1/chat/completions with the node's api key
      ▼
 ③  adapter.js  :8790         picks the next LIVE account (round-robin + failover)
      │  createAgentThread → sendEventToAgentThread → poll /syncRecordValues
      ▼
 ④  browser-transport.js      runs the fetch() INSIDE the logged-in app.notion.com tab
      │  rides the tab's residential IP + cookie jar (datacenter IPs are rejected)
      ▼
 ⑤  Notion AI  (api/v3)       returns assistant_message patches → streamed back as SSE
      ▼
```

---

## Why the browser relay exists

Notion AI has no public API. Its internal `app/v3` endpoints accept reads from
anywhere but reject **writes** from datacenter IPs with `UserValidationError`,
even when the cookie is valid.

`browser-transport.js` solves this by executing the request *inside a real,
logged-in Notion tab* over CDP, using the page's own cookie jar
(`credentials: 'include'`). The request therefore originates from the browser's
residential IP with a matching TLS fingerprint. The session cookie header is
deliberately **dropped** in relay mode — sending it alongside the live jar makes
Notion answer `400`.

---

## Account lifecycle

```text
 create inbox ──► signup wizard ──► verify code ──► extract token_v2 ──► store
   dispose.lol     notion.com        inbox poll        Network.getCookies    accounts.json
        │                                                                        │
        └────────────────────────── repeat per --count ──────────────────────────┘
                                                                                 │
                                          register as 9Router provider ◄─────────┘
```
