'use strict';

/**
 * Notion AI driver.
 *
 * Two transports:
 *  1. direct  — plain fetch from the host. Works for READ endpoints
 *               (getAvailableModels, getThreadTranscript) and, on a clean
 *               residential IP, also for the write/inference endpoints.
 *  2. browser — every request is executed inside a live Notion tab via CDP
 *               Runtime.evaluate. Required when the host IP is flagged:
 *               Notion's AI write endpoints return
 *               `UserValidationError: Something went wrong. Please try again later.`
 *               for datacenter IPs even with valid cookies.
 *
 * Notion AI is thread-based:
 *   POST /api/v3/createAgentThread   -> starts a thread with a first message
 *   POST /api/v3/sendEventToAgentThread -> append a user message to a thread
 *   POST /api/v3/getThreadTranscript  -> poll for messages (no streaming needed)
 *
 * The model is chosen with the `model` field of createAgentThread
 * (a codename such as `baseten-deepseek-v4.1-flash`).
 */

const DEFAULT_SPACE_ID = process.env.NOTION_SPACE_ID || '';
const DEFAULT_USER_ID = process.env.NOTION_USER_ID || '';
const CLIENT_VERSION = process.env.NOTION_CLIENT_VERSION || '23.13.20261014.0455';
const BASE = 'https://app.notion.com/api/v3/';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

/** Build the header set Notion expects for an authenticated web call. */
function buildHeaders({ cookie, spaceId, userId }) {
  return {
    'Content-Type': 'application/json',
    'notion-client-version': CLIENT_VERSION,
    'notion-audit-log-platform': 'web',
    'x-notion-active-user-header': userId,
    'x-notion-space-id': spaceId,
    'x-notion-cell-hint': 'prod-space-usw2-0004',
    'x-notion-cell-hint-source': 'space-id-mapping',
    origin: 'https://app.notion.com',
    referer: 'https://app.notion.com/chat',
    'user-agent': UA,
    accept: '*/*',
    ...(cookie ? { cookie } : {}),
  };
}

class NotionError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

class NotionClient {
  /**
   * @param {object} opts
   * @param {string} opts.cookie   raw Cookie header string (must contain token_v2)
   * @param {string} [opts.spaceId]
   * @param {string} [opts.userId]
   * @param {object} [opts.transport]  a browser transport exposing evalInPage(expr)
   */
  constructor({ cookie, spaceId = DEFAULT_SPACE_ID, userId = DEFAULT_USER_ID, transport = null } = {}) {
    this.cookie = cookie;
    this.spaceId = spaceId;
    this.userId = userId;
    this.transport = transport;
    this.preferTransport = !!transport;
  }

  headers() {
    return buildHeaders({ cookie: this.cookie, spaceId: this.spaceId, userId: this.userId });
  }

  /** Low-level POST. A configured transport always wins (even with a cookie). */
  async post(path, body, { browser = false } = {}) {
    if ((browser || this.preferTransport) && this.transport) {
      return this._postViaBrowser(path, body);
    }
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (!res.ok) {
      const msg = (json && (json.debugMessage || json.message)) || text.slice(0, 200);
      const err = new NotionError(`notion ${path} -> ${res.status}: ${msg}`, res.status, json);
      err.notionError = json && json.name;
      throw err;
    }
    return json;
  }

  async _postViaBrowser(path, body) {
    // Build the header set WITHOUT a cookie: the page's own live cookie jar is
    // used via credentials:'include'. Sending a stale cookie header here makes
    // Notion reject the write with `UserValidationError`.
    //
    // Likewise drop the active-user header: this client's user id may belong to
    // a different account than the tab that is actually logged in, and a
    // mismatched x-notion-active-user-header makes Notion answer 401. The live
    // page session supplies the real identity, so omitting it is correct.
    const headers = this.headers();
    delete headers.cookie;
    delete headers['x-notion-active-user-header'];
    const expr = `(async () => {
      const headers = ${JSON.stringify(headers)};
      const r = await fetch(${JSON.stringify(BASE + path)}, {
        method: 'POST', headers, credentials: 'include',
        body: ${JSON.stringify(JSON.stringify(body))}
      });
      const t = await r.text();
      return JSON.stringify({ status: r.status, text: t });
    })()`;
    const raw = await this.transport.evalInPage(expr);
    const out = JSON.parse(raw);
    let json = null;
    try {
      json = JSON.parse(out.text);
    } catch {
      /* ignore */
    }
    if (out.status < 200 || out.status >= 300) {
      const msg = (json && (json.debugMessage || json.message)) || out.text.slice(0, 200);
      throw new NotionError(`notion ${path} -> ${out.status}: ${msg}`, out.status, json);
    }
    return json;
  }

  /** Fetch the model catalog (id + display name + family + availability). */
  async listModels() {
    const j = await this.post('getAvailableModels', { spaceId: this.spaceId });
    return (j.models || []).map((m) => ({
      id: m.model,
      name: m.modelMessage,
      family: m.modelFamily,
      group: m.displayGroup,
      disabled: !!m.isDisabled,
      reason: m.disabledReason || null,
    }));
  }

  /**
   * Run a full chat turn: create a thread with the first message, wait for the
   * assistant reply, and return the transcript. One thread per request keeps
   * conversations independent, which is what an OpenAI-style API expects.
   */
  async chat({ messages, model, system, maxWaitMs = 120000 }) {
    const prompt = flattenMessages(messages, system);
    const threadId = crypto.randomUUID();
    const body = {
      type: 'personal_agent',
      spaceId: this.spaceId,
      threadId,
      enableSuggestedEditsTools: true,
      createdSource: 'full_page_chat',
      content: [{ type: 'text', text: [[prompt]] }],
      policies: { approval_mode: 'review_for_me' },
      agentMemorySettings: { useMemories: true, excludeChatFromMemories: false },
      browserEnabled: false,
      clientMessageId: crypto.randomUUID(),
    };
    if (model) body.model = model;

    const sentAt = Date.now();
    await this.post('createAgentThread', body);

    const deadline = Date.now() + maxWaitMs;
    let result = null;
    while (Date.now() < deadline) {
      await sleep(1500);
      const tr = await this.post('getThreadTranscript', {
        spaceId: this.spaceId,
        threadId,
        direction: 'backward',
        limit: 12,
      });
      const patches = tr.patches || [];
      const assistants = patches.filter(
        (p) => p.op === 'put' && p.entity && p.entity.kind === 'assistant_message'
      );
      const completed = patches.some(
        (p) => p.op === 'put' && p.entity && p.entity.kind === 'turn_completed'
      );
      if (assistants.length) {
        const latest = assistants[assistants.length - 1].entity;
        if (new Date(latest.created_at).getTime() >= sentAt - 5000) {
          result = { text: entityText(latest), threadId, completed };
          if (completed) break;
        }
      }
      if (patches.some((p) => p.op === 'put' && p.entity && /error/i.test(p.entity.kind || ''))) {
        const e = patches.find((p) => p.op === 'put' && p.entity && /error/i.test(p.entity.kind));
        throw new NotionError(`notion agent error: ${JSON.stringify(e.entity).slice(0, 300)}`, 500, e);
      }
    }
    if (!result) throw new NotionError('notion chat timed out waiting for reply', 504, null);
    return result;
  }
}

/** Reduce OpenAI-style messages to a single Notion prompt string. */
function flattenMessages(messages, system) {
  const parts = [];
  if (system) parts.push(`System: ${system}`);
  for (const m of messages || []) {
    const content =
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
        ? m.content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('')
        : '';
    if (m.role === 'system') continue;
    if (m.role === 'assistant') parts.push(`Assistant: ${content}`);
    else parts.push(content);
  }
  return parts.join('\n\n');
}

/** Pull plain text out of a Notion assistant entity. */
function entityText(entity) {
  const c = entity.content;
  if (!c) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && part.type === 'text') {
          const t = part.text;
          if (typeof t === 'string') return t;
          if (Array.isArray(t)) return t.map((x) => (Array.isArray(x) ? x[0] : x)).join('');
        }
        return '';
      })
      .join('');
  }
  return '';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { NotionClient, NotionError, buildHeaders, flattenMessages, entityText, DEFAULT_SPACE_ID, DEFAULT_USER_ID, CLIENT_VERSION };
