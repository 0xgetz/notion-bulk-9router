# Notion AI — reverse-engineered protocol

Everything in this document was established empirically against a live account
(October 2026). It describes the internal endpoints the toolkit drives.

Base URL: `https://app.notion.com/api/v3`

## Authentication

Session auth is carried by the **`token_v2` cookie** (httpOnly). Because it is
httpOnly it never appears in `document.cookie`; read it with
`Network.getCookies` over CDP.

Required headers on every call:

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `notion-client-version` | e.g. `23.13.20261014.0455` |
| `x-notion-active-user-header` | the `userId` |
| `x-notion-space-id` | the target `spaceId` |
| `notion-audit-log-platform` | `web` |
| `Cookie` | `token_v2=…; …` |

Reads work from any IP. **Writes do not** — see "IP gate" below.

## Endpoints

### `POST /getSpaces`
Returns the user's workspaces. First `space_id` in the map is the default one.

### `POST /getAvailableModels`
```json
{ "spaceId": "<uuid>" }
```
Returns `{ models: [{ id, name, family, disabled, ... }] }`. 39 models exist on a
free workspace; 3 (GPT-6 Astra, Fable 5, Fable 5.1) require Business/Enterprise
and are returned `disabled`.

### `POST /createAgentThread`
Starts a new AI thread **and posts the first user message**.
```json
{
  "spaceId": "<uuid>",
  "threadId": "<client-generated-uuid>",
  "transcript": [{ "type": "user_message", "text": "<prompt>" }],
  "model": "baseten-deepseek-v4.1-flash"
}
```
The **model is chosen here**, via the `model` field (a codename such as
`baseten-deepseek-v4.1-flash` or `grapefruit-zeppole`). The thread record then
stores it as `selectedModel`. There is no separate "set model" call.

### `POST /sendEventToAgentThread`
Posts a follow-up message into an existing thread.
```json
{
  "spaceId": "<uuid>",
  "threadId": "<uuid>",
  "event": { "type": "user_message", "text": "<prompt>" }
}
```

### `POST /getThreadTranscript` and `/syncRecordValues`
Both return the thread's transcript. The assistant reply arrives as a sequence of
`assistant_message` **patches**, not a token stream:

```json
{ "recordMap": { "thread_message": { "<id>": { "value": { "value": {
  "type": "assistant_message",
  "content": "…",
  "patches": [ { "type": "patch", "ops": [ … ] } ]
} } } } } }
```

Poll until a terminal status (`completed` / `error`) appears. Streaming to the
client (SSE) is synthesized by the adapter from successive poll diffs.

## IP gate (the important part)

| Operation | Datacenter IP | Residential IP |
|---|---|---|
| `getSpaces`, `getAvailableModels`, `getThreadTranscript` | ✅ works | ✅ works |
| `createAgentThread`, `sendEventToAgentThread` | ❌ `UserValidationError` | ✅ works |

A valid `token_v2` is **not enough** for writes from a server: Notion enforces
the request IP. The fix is the browser relay — run the write `fetch()` inside a
live, logged-in `app.notion.com` tab over CDP with `credentials: 'include'`, so
it leaves through the browser's residential IP and carries the real cookie jar.

> ⚠️ In relay mode **do not** attach a `Cookie` header. The page's own jar is
> already used; sending the session cookie header as well makes the write fail
> with HTTP `400`.

## Browser relay request shape

```js
await transport.evalInPage(`(async () => {
  const r = await fetch("https://app.notion.com/api/v3/createAgentThread", {
    method: "POST",
    headers: { "Content-Type": "application/json",
               "notion-client-version": "...",
               "x-notion-active-user-header": "<userId>",
               "x-notion-space-id": "<spaceId>" },   // NO cookie header
    credentials: "include",
    body: JSON.stringify({ spaceId, threadId, transcript, model })
  });
  return JSON.stringify({ status: r.status, text: await r.text() });
})()`);
```

## Signup flow (for bulk creation)

1. `GET https://www.notion.com/signup` → enter email → **Continue**.
2. Notion mails a numeric verification code to that address.
3. Enter the code → profile-name step → onboarding wizard → workspace created.
4. Extract the session with `Network.getCookies` on the logged-in tab:
   `token_v2`, `notion_user_id`, `notion_browser_id`, plus the space id from
   `getSpaces`.

### Email requirement

Notion **rejects well-known disposable domains** (Gmail-style `+`/dotted
addresses on `gmail.com` and similar) at step 1 with *"we could not reach the
email address"*. A **custom-domain** inbox is accepted — the toolkit uses
`dispose.lol` mailboxes, which are real-domain addresses on a disposable
backend.

## Known models (selection)

| Codename | Display name |
|---|---|
| `baseten-deepseek-v4.1-flash` | DeepSeek V4.1 Flash |
| `grapefruit-zeppole` | Gemini 3.7 Flash |
| `sunflower-donut` | GPT-5.5 |

Run `node src/cli.js models` (with a logged-in tab) for the full live catalog.
