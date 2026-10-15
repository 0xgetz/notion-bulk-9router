<div align="center">

<img src="../brand/banner.svg" alt="notion-bulk-9router" width="640">

### Crea cuentas de Notion en masa → extrae sesiones automáticamente → sírvelas vía 9Router

*Un solo comando levanta N espacios de trabajo de Notion, captura el `token_v2` de cada uno y
los conecta a un pool compatible con OpenAI, balanceado, detrás de un único endpoint 9Router.*

<br>

[![License: MIT](https://img.shields.io/badge/License-MIT-8B7CF6.svg?style=flat-square)](../LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-6EE7F9.svg?style=flat-square)](../package.json)
[![Dependencies](https://img.shields.io/badge/dependencies-0-F472B6.svg?style=flat-square)](#cero-dependencias)

<br>

[🇬🇧 English](../README.md) · [🇮🇩 Bahasa](README.id.md) · [🇨🇳 简体中文](README.zh.md) · [🇯🇵 日本語](README.ja.md) · [🇪🇸 Español](README.es.md)

</div>

---

## Qué hace

Notion AI **no tiene API pública**, y sus endpoints internos de escritura rechazan las
IP de centro de datos. Esta herramienta convierte eso en una ventaja:

1. **Crea cuentas en masa** — maneja el asistente real de registro de Notion en el navegador,
   verificando cada cuenta mediante una bandeja desechable.
2. **Extrae la sesión automáticamente** — obtiene `token_v2` y los ids de espacio/usuario
   directamente del cookie jar del navegador.
3. **Las sirve como una sola API** — un adaptador compatible con OpenAI ejecuta cada petición
   *dentro de una pestaña activa de Notion* (IP residencial + cookie jar real) y registra
   todo el pool en **9Router**.

```text
notion-bulk create --count 5 --router http://127.0.0.1:20128
```

Eso es todo — cinco cuentas, cinco sesiones, un pool.

---

## Características

| | |
|---|---|
| 🧬 **Cuentas en masa** | `--count N` registra N espacios de trabajo sin pasos manuales |
| 🍪 **Captura de sesión automática** | Lee el `token_v2` httpOnly vía CDP y lo guarda |
| 🌐 **Relay con IP residencial** | Las escrituras se ejecutan en la pestaña, superando el bloqueo de IP |
| 🔁 **Pool round-robin** | El adaptador balancea la carga entre todas las cuentas guardadas |
| 🎯 **Selección de modelo** | Elige entre ~36 modelos de Notion utilizables |
| 🧩 **Listo para 9Router** | Un comando registra el nodo proveedor + la clave |
| 📦 **Cero dependencias** | Node ≥18 puro — CDP propio, sin `node_modules` |

---

## Arquitectura

```text
┌──────────┐   POST /v1/chat/completions    ┌──────────────┐
│ cliente  │ ─────────────────────────────► │  9Router     │  prefijo: notion/*
│ (Continue│                                │   :20128     │
│  Cline…) │ ◄───────────────────────────── │              │
└──────────┘     compatible con OpenAI      └──────┬───────┘
                                                   ▼
                                          ┌──────────────────┐
                                          │  adapter  :8790  │  round-robin
                                          │  + failover      │
                                          └────────┬─────────┘
                                                   ▼
                                       ┌────────────────────────┐
                                       │ browser-transport.js   │  fetch() se ejecuta
                                       │ (app.notion.com viva)  │  DENTRO de la pestaña
                                       └────────────┬───────────┘
                                                    ▼
                                          ┌──────────────────┐
                                          │   Notion AI      │
                                          └──────────────────┘
```

Detalles en [`STRUCTURE.md`](../STRUCTURE.md); la API interna en
[`docs/PROTOCOL.md`](../docs/PROTOCOL.md).

---

## Inicio rápido

### 1. Prepara un navegador

**Tu propio Chrome/Chromium** con puerto de depuración (usa un perfil dedicado, **no** el de uso diario):

```bash
./scripts/browser.sh            # detecta Chromium automáticamente, abre :9222
# PROXY=http://user:pass@host:port ./scripts/browser.sh   # proxy residencial
# o manualmente:
chromium --remote-debugging-port=9222 --user-data-dir=~/.chromium-notion
# o: google-chrome --remote-debugging-port=9222 --user-data-dir=~/.chrome-notion
export NOTION_CDP_URL="http://127.0.0.1:9222"
```

El navegador debe salir por una **IP residencial** — Notion (y el correo temporal)
rechazan o limitan las IP de datacenter, y los endpoints de escritura de Notion AI
las rechazan directamente. Si tu VPS tiene IP de datacenter, enruta el navegador
por un proxy residencial, o apunta la toolkit a un navegador remoto que ya ejecutes.

**O** cualquier navegador remoto que exponga un websocket CDP:

```bash
export NOTION_CDP_WS="wss://<host>/devtools/browser/<id>"
```

### 2. Crea cuentas

```bash
node src/cli.js create --count 3            # bandeja por defecto: 22.do (…@hotmail.com/@outlook.com)
node src/cli.js create --count 3 --inbox dispose --domain midominio.tld
```

Cada cuenta se escribe en `accounts.json`.

### 3. Sirve el pool

```bash
node src/cli.js serve            # adaptador compatible con OpenAI en :8790
```

### 4. Regístralo en 9Router

```bash
node src/cli.js connect --router http://127.0.0.1:20128
```

### 5. Úsalo

```bash
curl http://127.0.0.1:20128/v1/chat/completions \
  -H "Authorization: Bearer sk-…" \
  -H "Content-Type: application/json" \
  -d '{"model":"notion/baseten-deepseek-v4.1-flash",
       "messages":[{"role":"user","content":"hola"}]}'
```

---

## Comandos

| Comando | Qué hace |
|---|---|
| `create --count N` | Crea N cuentas y (opcionalmente) las conecta a 9Router |
| `serve` | Ejecuta el adaptador compatible con OpenAI en `:8790` |
| `connect` | Registra el adaptador como proveedor dentro de 9Router |
| `models` | Lista el catálogo de modelos de Notion (requiere pestaña con sesión) |
| `extract` | Captura `token_v2` + ids de una pestaña ya autenticada |
| `accounts` | Muestra el almacén de cuentas |

---

## Modelos de Notion AI

Catálogo en vivo (39 modelos, obtenido de `getAvailableModels` el 15 oct 2026 —
36 usables en Free, 3 requieren Business/Enterprise). Usa el id como
`notion/<id>`; `notion/auto` deja que Notion elija. Ejecuta `node src/cli.js models`
en un navegador con sesión para ver la lista actual.

| Id de modelo | Nombre | Familia | Plan |
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

## Cómo funciona el relay del navegador

| | IP de centro de datos | IP residencial |
|---|:---:|:---:|
| lecturas (`getThreadTranscript`, `getAvailableModels`) | ✅ | ✅ |
| escrituras (`createAgentThread`, `sendEventToAgentThread`) | ❌ `UserValidationError` | ✅ |

Una cookie válida **no basta** — Notion comprueba la IP del escritor.
`browser-transport.js` ejecuta cada `fetch()` de escritura **dentro de una pestaña
viva de `app.notion.com`** vía CDP con `credentials: 'include'`. La cabecera de
cookie de sesión se **omite a propósito** en modo relay.

---

## Cero dependencias

Sin dependencias en `package.json`, sin `node_modules`. Incluye su propio
`cdp.js` (cliente CDP puro), `browser-transport.js` y `dispose-mail.js`.

---

## Requisitos y notas

- **Node ≥ 18** (usa `fetch` y `WebSocket` globales).
- Un **navegador con IP residencial** para crear cuentas y servir.
- **Bandeja temporal**: el proveedor por defecto es **22.do** (`--inbox 22do`),
  que entrega direcciones reales `@hotmail.com` / `@outlook.com` que Notion acepta.
  Alternativa: `--inbox dispose` con un **dominio personalizado** (`--domain`).
  Ambos sitios usan Cloudflare, así que el navegador necesita IP residencial.
- **Un cliente CDP por pestaña.** No ejecutes el adaptador y una sesión de
  depuración interactiva sobre la misma pestaña a la vez.
- Las cuentas y cookies solo viven en tu `accounts.json` local (ignorado por git).

---

## Licencia

[MIT](../LICENSE) © 2026 0xgetz
