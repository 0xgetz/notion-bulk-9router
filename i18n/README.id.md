<div align="center">

<img src="../brand/banner.svg" alt="notion-bulk-9router" width="640">

### Buat akun Notion massal → ekstrak sesi otomatis → sajikan lewat 9Router

*Satu perintah membuat N workspace Notion, mengambil `token_v2` masing-masing, dan
menyambungkannya ke pool kompatibel-OpenAI yang load-balanced di balik satu endpoint 9Router.*

<br>

[![License: MIT](https://img.shields.io/badge/License-MIT-8B7CF6.svg?style=flat-square)](../LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-6EE7F9.svg?style=flat-square)](../package.json)
[![Dependencies](https://img.shields.io/badge/dependencies-0-F472B6.svg?style=flat-square)](#nol-dependensi)

<br>

[🇬🇧 English](../README.md) · [🇮🇩 Bahasa](README.id.md) · [🇨🇳 简体中文](README.zh.md) · [🇯🇵 日本語](README.ja.md) · [🇪🇸 Español](README.es.md)

</div>

---

## Apa yang dilakukan ini

Notion AI **tidak punya API publik**, dan endpoint tulis internalnya menolak IP
datacenter. Toolkit ini mengubahnya menjadi keunggulan:

1. **Membuat akun massal** — menggerakkan wizard pendaftaran Notion asli di browser,
   memverifikasi tiap akun lewat inbox sekali-pakai.
2. **Mengekstrak sesi otomatis** — mengambil `token_v2` + id workspace/user langsung
   dari cookie jar browser.
3. **Menyajikannya sebagai satu API** — adapter kompatibel-OpenAI menjalankan setiap
   permintaan *di dalam tab Notion yang aktif* (IP residensial + cookie jar asli), lalu
   mendaftarkan seluruh pool ke **9Router**.

```text
notion-bulk create --count 5 --router http://127.0.0.1:20128
```

Itu saja — lima akun, lima sesi, satu pool.

---

## Fitur

| | |
|---|---|
| 🧬 **Akun massal** | `--count N` mendaftarkan N workspace tanpa langkah manual |
| 🍪 **Tangkap sesi otomatis** | Membaca `token_v2` httpOnly lewat CDP dan menyimpannya |
| 🌐 **Relay IP residensial** | Penulisan berjalan di dalam tab, menembus gerbang IP datacenter |
| 🔁 **Pool round-robin** | Adapter menyeimbangkan beban ke seluruh akun tersimpan |
| 🎯 **Pemilihan model** | Pilih salah satu dari ~36 model Notion yang bisa dipakai |
| 🧩 **Siap 9Router** | Satu perintah mendaftarkan provider node + key |
| 📦 **Nol dependensi** | Node ≥18 murni — CDP buatan sendiri, tanpa `node_modules` |

---

## Arsitektur

```text
┌──────────┐   POST /v1/chat/completions    ┌──────────────┐
│  klien   │ ─────────────────────────────► │  9Router     │  prefix: notion/*
│ (Continue│                                │   :20128     │
│  Cline…) │ ◄───────────────────────────── │              │
└──────────┘       kompatibel-OpenAI        └──────┬───────┘
                                                   ▼
                                          ┌──────────────────┐
                                          │  adapter  :8790  │  round-robin
                                          │  + failover      │
                                          └────────┬─────────┘
                                                   ▼
                                       ┌────────────────────────┐
                                       │ browser-transport.js   │  fetch() dijalankan
                                       │ (app.notion.com aktif) │  DI DALAM tab
                                       └────────────┬───────────┘
                                                    ▼
                                          ┌──────────────────┐
                                          │   Notion AI      │
                                          └──────────────────┘
```

Rincian lengkap di [`STRUCTURE.md`](../STRUCTURE.md); API internal di
[`docs/PROTOCOL.md`](../docs/PROTOCOL.md).

---

## Mulai cepat

### 1. Siapkan browser

**Browser Use cloud** (termudah — juga menyelesaikan Turnstile inbox otomatis):

```bash
export BU_CDP_WS="wss://<endpoint-cdp-anda>"
```

**atau** Chrome sendiri dengan debug port:

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=~/.chrome-notion
export NOTION_CDP_URL="http://127.0.0.1:9222"
```

### 2. Buat akun

```bash
node src/cli.js create --count 3 --domain domainku.tld
```

Setiap akun ditulis ke `accounts.json`.

### 3. Jalankan pool

```bash
node src/cli.js serve            # adapter kompatibel-OpenAI di :8790
```

### 4. Daftarkan ke 9Router

```bash
node src/cli.js connect --router http://127.0.0.1:20128
```

### 5. Pakai

```bash
curl http://127.0.0.1:20128/v1/chat/completions \
  -H "Authorization: Bearer sk-…" \
  -H "Content-Type: application/json" \
  -d '{"model":"notion/baseten-deepseek-v4.1-flash",
       "messages":[{"role":"user","content":"hai"}]}'
```

---

## Perintah

| Perintah | Fungsi |
|---|---|
| `create --count N` | Buat N akun massal dan (opsional) sambungkan ke 9Router |
| `serve` | Jalankan adapter kompatibel-OpenAI di `:8790` |
| `connect` | Daftarkan adapter sebagai provider di 9Router |
| `models` | Tampilkan katalog model Notion (butuh tab yang sudah login) |
| `extract` | Tangkap `token_v2` + id dari tab yang sudah login |
| `accounts` | Tampilkan penyimpanan akun |

---

## Cara relay browser bekerja

| | IP datacenter | IP residensial |
|---|:---:|:---:|
| baca (`getThreadTranscript`, `getAvailableModels`) | ✅ | ✅ |
| tulis (`createAgentThread`, `sendEventToAgentThread`) | ❌ `UserValidationError` | ✅ |

Cookie yang valid **tidak cukup** — Notion memeriksa IP penulis.
`browser-transport.js` menjalankan tiap `fetch()` tulis **di dalam tab
`app.notion.com` yang aktif** lewat CDP dengan `credentials: 'include'`.
Header cookie sesi sengaja **dihilangkan** dalam mode relay.

---

## Nol dependensi

Tanpa dependensi `package.json`, tanpa `node_modules`. Toolkit membawa sendiri
`cdp.js` (klien CDP murni), `browser-transport.js`, dan `dispose-mail.js`.

---

## Persyaratan & catatan

- **Node ≥ 18** (memakai `fetch` dan `WebSocket` global).
- **Browser ber-IP residensial** untuk membuat akun dan menyajikan.
- **Inbox sekali-pakai**: Notion menolak *domain* sekali-pakai umum. Arahkan
  `--domain` ke **domain kustom** yang diarahkan ke backend mailbox dispose.lol.
- **Satu klien CDP per tab.** Jangan menjalankan adapter dan sesi debug
  interaktif pada tab yang sama sekaligus.
- Akun & cookie hanya ada di `accounts.json` lokal (di-gitignore).

---

## Lisensi

[MIT](../LICENSE) © 2026 0xgetz
