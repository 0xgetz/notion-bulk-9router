'use strict';

/**
 * Notion AI -> OpenAI-compatible adapter.
 *
 * Exposes a tiny HTTP server so 9Router (or any OpenAI client) can talk to
 * Notion AI:
 *
 *   GET  /v1/models
 *   POST /v1/chat/completions   (stream: true|false)
 *   GET  /health
 *
 * Two mutually-compatible backends (auto-selected):
 *
 *   1. cookie  — pass a Notion Cookie header (`NOTION_COOKIE`, must contain
 *                token_v2). Fast, no browser needed, but Notion rejects the AI
 *                write endpoints for flagged datacenter IPs.
 *   2. browser — point `NOTION_CDP_WS` (a CDP websocket) or `NOTION_CDP_URL`
 *                (a local Chrome/Chromium debug port) at a browser with the
 *                Notion tab logged in. Each call is executed inside that tab,
 *                so it rides the browser's residential IP and cookie jar.
 *                Works even from a datacenter host.
 *
 * Model ids come straight from Notion's catalog (see `src/notion.js`);
 * `notion/auto` maps to Notion's automatic model selection.
 */

const http = require('http');
const { NotionClient } = require('./notion');

const PORT = parseInt(process.env.ADAPTER_PORT || process.env.PORT || '8790', 10);
const HOST = process.env.ADAPTER_HOST || '127.0.0.1';
const AUTH = process.env.ADAPTER_KEY || ''; // optional bearer gate for the adapter itself

let client = null;
let cdpClient = null;
let models = [];
let ready = false;
let lastError = null;

/** Establish the Notion client: browser relay if a browser is configured, else cookie. */
async function init() {
  const cookie = process.env.NOTION_COOKIE || '';
  const browser = await resolveBrowserWs();
  if (browser) {
    const { CDP } = require('./cdp');
    const { BrowserTransport } = require('./browser-transport');
    cdpClient = new CDP(browser);
    await cdpClient.connect();
    // Prefer a tab that is already inside a live workspace (/chat or /ai). A
    // leftover /onboarding or /signup tab is logged out of a workspace and
    // makes getAvailableModels answer 400.
    const transport = new BrowserTransport(cdpClient, {
      urlMatch: /app\.notion\.com\/(chat|ai)/,
    });
    const attached = await transport
      .attach()
      .catch(() => null)
      .then((t) => t || new BrowserTransport(cdpClient).attach());
    if (!attached) throw new Error('no Notion tab found in the connected browser');
    // Resolve the workspace from the live tab so listModels/chat carry the
    // right spaceId (the client's own id may be empty in relay mode).
    const ids = await probeWorkspace(transport).catch(() => ({}));
    client = new NotionClient({
      cookie,
      transport,
      preferTransport: true,
      spaceId: ids.spaceId || process.env.NOTION_SPACE_ID || '',
      userId: ids.userId || process.env.NOTION_USER_ID || '',
    });
    console.log('[adapter] backend: browser relay ->', transport.targetId, ids.spaceId ? `space ${ids.spaceId}` : '');
  } else if (cookie) {
    client = new NotionClient({ cookie });
    console.log('[adapter] backend: cookie (direct)');
  } else {
    throw new Error('Set NOTION_CDP_WS (CDP websocket) or NOTION_CDP_URL (local Chrome/Chromium), or NOTION_COOKIE');
  }
  models = await client.listModels();
  ready = true;
  console.log(`[adapter] ${models.length} models available`);
}

/** Read the logged-in workspace id/space from the attached tab. */
async function probeWorkspace(transport) {
  const raw = await transport.evalInPage(`(async () => {
    try {
      const r = await fetch('https://app.notion.com/api/v3/getSpaces', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      const t = await r.text();
      const ids = [...t.matchAll(/"space_id":"([0-9a-f-]{36})"/g)].map((x) => x[1]);
      const spaceId = [...new Set(ids)][0] || '';
      const users = [...t.matchAll(/"id":"([0-9a-f-]{36})","/g)].map((x) => x[1]);
      const userId = [...new Set(users)][0] || '';
      return JSON.stringify({ spaceId, userId });
    } catch (e) { return JSON.stringify({ spaceId: '', userId: '', err: String(e) }); }
  })()`);
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Resolve a usable CDP websocket URL from the environment:
 *   NOTION_CDP_WS  — a full ws(s)://…/devtools/browser/… endpoint, or a ws host
 *                    whose /json/version we look up.
 *   NOTION_CDP_URL — an http debug port (e.g. http://127.0.0.1:9222) for a
 *                    local Chrome/Chromium launched with --remote-debugging-port.
 * Returns '' when neither is set.
 */
async function resolveBrowserWs() {
  const ws = process.env.NOTION_CDP_WS || '';
  if (ws) {
    if (/\/devtools\//.test(ws)) return ws;
    const host = ws.replace(/^wss?:\/\//, '').split('/')[0];
    const scheme = /^ws:\/\//.test(ws) ? 'http' : 'https';
    return (await fetch(`${scheme}://${host}/json/version`).then((r) => r.json())).webSocketDebuggerUrl;
  }
  const url = process.env.NOTION_CDP_URL || '';
  if (url) {
    return (await fetch(`${url.replace(/\/$/, '')}/json/version`).then((r) => r.json())).webSocketDebuggerUrl;
  }
  return '';
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function notAuthorized(req) {
  if (!AUTH) return false;
  const h = req.headers['authorization'] || '';
  const token = h.replace(/^Bearer\s+/i, '');
  return token !== AUTH;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 5e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/** Map an OpenAI model id to a Notion codename. */
function resolveModel(id) {
  if (!id || id === 'auto' || id === 'notion/auto') return null; // Notion picks
  const clean = id.replace(/^notion\//, '');
  const found = models.find((m) => m.id === clean || m.name === clean);
  return found ? found.id : clean;
}

function openAIResponse(id, model, text, usage) {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

async function handleChat(req, res) {
  const body = await readBody(req);
  const modelId = body.model || 'auto';
  const codename = resolveModel(modelId);
  const stream = !!body.stream;

  // Notion does not stream token-by-token; we deliver the whole answer as one
  // SSE delta so OpenAI streaming clients still work.
  try {
    const r = await client.chat({ messages: body.messages || [], model: codename });
    const text = r.text || '';
    const id = 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '');
    if (!stream) {
      return json(res, 200, openAIResponse(id, modelId, text));
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const chunk = (delta, finish) =>
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        choices: [{ index: 0, delta, finish_reason: finish || null }],
      })}\n\n`;
    res.write(chunk({ role: 'assistant', content: '' }));
    res.write(chunk({ content: text }));
    res.write(chunk({}, 'stop'));
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (e) {
    json(res, e.status && e.status >= 400 ? e.status : 500, {
      error: { message: e.message, type: 'notion_error' },
    });
  }
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];
  try {
    if (url === '/health') {
      return json(res, ready ? 200 : 503, { ok: ready, models: models.length, error: lastError });
    }
    if (notAuthorized(req)) {
      return json(res, 401, { error: { message: 'unauthorized', type: 'auth' } });
    }
    if (url === '/v1/models' && req.method === 'GET') {
      return json(res, 200, {
        object: 'list',
        data: [
          { id: 'notion/auto', object: 'model', owned_by: 'notion', name: 'Auto (Notion picks)' },
          ...models
            .filter((m) => !m.disabled)
            .map((m) => ({ id: 'notion/' + m.id, object: 'model', owned_by: 'notion', name: m.name })),
        ],
      });
    }
    if (url === '/v1/chat/completions' && req.method === 'POST') {
      return await handleChat(req, res);
    }
    json(res, 404, { error: { message: 'not found', type: 'not_found' } });
  } catch (e) {
    lastError = e.message;
    json(res, 500, { error: { message: e.message, type: 'adapter_error' } });
  }
});

init()
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`[adapter] listening on http://${HOST}:${PORT}/v1  (base_url for 9Router: http://${HOST}:${PORT}/v1)`);
    });
  })
  .catch((e) => {
    lastError = e.message;
    console.error('[adapter] init failed:', e.message);
    process.exit(1);
  });

process.on('SIGINT', () => {
  cdpClient && cdpClient.close();
  process.exit(0);
});
