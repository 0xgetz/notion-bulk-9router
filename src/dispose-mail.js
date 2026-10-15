'use strict';

/**
 * Disposable mailbox driver (dispose.lol).
 *
 * Creates custom-domain temporary inboxes and reads their mail. dispose.lol is a
 * SvelteKit app whose "remote" RPCs are same-origin and gated by a Cloudflare
 * Turnstile token, so creation is done by driving the site's own UI inside a
 * real browser (the browser solves Turnstile automatically). Mail is
 * read through the same-origin `getMailboxMessages` RPC.
 *
 * The driver is transport-agnostic: pass anything with `evalInPage(expr)` and
 * `navigate(url)` (see browser-transport.js).
 */

const DISPOSE_URL = 'https://dispose.lol/';
const RPC = '/_app/remote/1i1fsx0';

class DisposeMail {
  constructor(transport, { domain = '' } = {}) {
    this.transport = transport;
    this.domain = domain; // '' = let dispose.lol pick
  }

  /** Open dispose.lol and return the currently-selected inbox address. */
  async currentAddress() {
    const out = await this.transport.evalInPage(`(document.body.innerText.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}/i)||[])[0]||''`);
    return out.replace(/^"|"$/g, '');
  }

  /**
   * Create a fresh mailbox (custom-domain if `domain` is set, else Gmail).
   * Drives the Create Inbox form; the browser solves Turnstile.
   * @returns {Promise<string>} the new address
   */
  async createEmail(username, opts = {}) {
    const attempts = opts.attempts || 3;
    const wantDomain = this.domain || null;
    let last = null;
    for (let i = 0; i < attempts; i++) {
      const user = (i === 0 && username) || 'nb' + Math.random().toString(36).slice(2, 10);
      const addr = await this._createOnce(user);
      if (!addr) { last = null; continue; }
      // When a custom domain is requested we MUST land on it: a Gmail fallback
      // is rejected by Notion, so retry instead of silently accepting it.
      if (!wantDomain || addr.toLowerCase().endsWith('@' + wantDomain.toLowerCase())) {
        this.address = addr;
        return addr;
      }
      last = addr;
      await this.transport.evalInPage(`new Promise(r=>setTimeout(r,1500))`);
    }
    throw new Error(`dispose.lol: could not create a @${wantDomain} mailbox (last: ${last})`);
  }

  /** One create attempt: drives the form and returns the new address (or null). */
  async _createOnce(user) {
    await this.transport.navigate(DISPOSE_URL);
    await this.transport.evalInPage(`new Promise(r=>setTimeout(r,3500))`);

    // The page shows either the Create Inbox form directly (fresh visitor) or
    // the current inbox with a "Change" button. Open the form in the latter case.
    const prevAddr = await this._headerAddress();
    const hasForm = await this.transport.evalInPage(
      `!!document.querySelector('form[aria-label*="Create temporary"]')`
    );
    if (hasForm !== 'true' && hasForm !== true) {
      await this._formButton('Change');
      await this.transport.evalInPage(`new Promise(r=>setTimeout(r,1800))`);
    }

    // Make sure the form is present before touching its controls.
    await this._waitForForm(12000);

    if (this.domain) {
      // Select the Custom Domain tab FIRST, then confirm it is the active tab
      // (the select only renders on that tab) before filling anything.
      await this._formButton('Custom Domain');
      await this.transport.evalInPage(`new Promise(r=>setTimeout(r,1200))`);
      for (let t = 0; t < 6; t++) {
        const ready = await this.transport.evalInPage(
          `(() => { const f = document.querySelector('form[aria-label*="Create temporary"]');
             const s = f && f.querySelector('select');
             return !!(s && [...s.options].some(o => o.value === ${JSON.stringify(this.domain)})); })()`
        );
        if (ready === 'true' || ready === true) break;
        await this.transport.evalInPage(`new Promise(r=>setTimeout(r,600))`);
      }
      const filled = await this.transport.evalInPage(`(() => {
        const form = document.querySelector('form[aria-label*="Create temporary"]');
        if (!form) return 'no-form';
        const inp = form.querySelector('input[placeholder="Username"]');
        if (!inp) return 'no-input';
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, ${JSON.stringify(user)});
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        const sel = form.querySelector('select');
        if (!sel) return 'no-select';
        const opt = [...sel.options].find(o => o.value === ${JSON.stringify(this.domain)});
        if (!opt) return 'no-domain-option';
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        return 'filled:' + inp.value + '@' + sel.value;
      })()`);
      if (typeof filled === 'string' && filled.indexOf('filled:') !== 0) return null;
      await this.transport.evalInPage(`new Promise(r=>setTimeout(r,800))`);
      await this._formButton('Create Email');
    } else {
      await this._formButton('Create Gmail');
    }

    // Wait until a NEW address appears (differs from any previous one).
    const addr = await this._waitForAddress(30000, prevAddr);
    return addr || null;
  }

  /** The address shown in the header (or '' if none yet). */
  async _headerAddress() {
    const out = await this.transport.evalInPage(
      `(document.body.innerText.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}/i)||[])[0]||''`
    );
    return (out || '').replace(/^"|"$/g, '').trim();
  }

  async _waitForForm(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ok = await this.transport.evalInPage(`!!document.querySelector('form[aria-label*="Create temporary"]')`);
      if (ok === 'true' || ok === true) return true;
      await this.transport.evalInPage(`new Promise(r=>setTimeout(r,800))`);
    }
    return false;
  }

  /** Click a button inside the Create Inbox form by its exact label. */
  async _formButton(text) {
    return this.transport.evalInPage(`(() => {
      const form = document.querySelector('form[aria-label*="Create temporary"]');
      const press = (root) => {
        const b = [...root.querySelectorAll('button')].find(e => e.innerText && e.innerText.trim() === ${JSON.stringify(text)});
        if (b) { b.click(); return true; }
        return false;
      };
      if (form && press(form)) return 'ok';
      if (press(document)) return 'ok';
      return 'nf';
    })()`);
  }

  async _waitForAddress(timeoutMs, previous = '') {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
      await this.transport.evalInPage(`new Promise(r=>setTimeout(r,1000))`);
      const addr = await this._headerAddress();
      if (addr && /@/.test(addr) && addr !== previous) {
        if (addr === last) return addr;
        last = addr;
      }
    }
    return null;
  }

  /**
   * Poll the inbox for a message matching a regex and return its extracted text.
   * @returns {Promise<{subject:string, body:string, raw:any}|null>}
   */
  async waitForMessage(match, { timeoutMs = 120000, pollMs = 3000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msgs = await this.listMessages();
      for (const m of msgs) {
        if (match && !(match.test(m.subject || '') || match.test(m.from || ''))) continue;
        const full = await this.getMessage(m.id);
        if (!full) continue;
        const blob = `${full.subject}\n${full.text}`;
        if (!match || match.test(full.subject || '') || match.test(blob)) {
          return { ...m, body: full.text, html: full.html, raw: full };
        }
      }
      await this.transport.evalInPage(`new Promise(r=>setTimeout(r,${pollMs}))`);
    }
    return null;
  }

  /**
   * Read the current mailbox via the same-origin RPC. Returns normalized
   * messages: { id, from, subject, receivedAt }.
   */
  async listMessages() {
    const out = await this.transport.evalInPage(`(async () => {
      const r = await fetch('${RPC}/getMailboxMessages?payload=' + encodeURIComponent('W3siYXNzaWdubWVudElkIjotMX1d'), { credentials:'include' });
      return await r.text();
    })()`);
    const devalue = parseRpc(out);
    if (!Array.isArray(devalue) || devalue.length < 2) return [];
    const root = devalue[0]; // field map: { address, mailboxKey, messages, ... }
    if (!root || typeof root !== 'object') return [];
    const messagesRef = root.messages;
    const rawMessages = devalue[messagesRef];
    if (!Array.isArray(rawMessages)) return [];
    const msgs = [];
    for (const ref of rawMessages) {
      const m = materialize(devalue, devalue[ref]);
      if (!m) continue;
      msgs.push({
        id: m.id,
        from: m.from || '',
        subject: m.subject || '',
        receivedAt: m.receivedAt || '',
      });
    }
    return msgs;
  }

  /**
   * Fetch one message's full body via the same-origin RPC. Returns
   * { id, from, subject, receivedAt, text, html }.
   */
  async getMessage(id) {
    const payload = Buffer.from(JSON.stringify([{ id: 1, refresh: 2 }, id, true])).toString('base64');
    const out = await this.transport.evalInPage(`(async () => {
      const r = await fetch('${RPC}/getMailboxMessage', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: ${JSON.stringify(payload)}, refreshes: [] })
      });
      return await r.text();
    })()`);
    const devalue = parseRpc(out);
    if (!Array.isArray(devalue) || devalue.length < 2) return null;
    const root = devalue[0];
    const m = materialize(devalue, devalue[root.message]);
    if (!m) return null;
    const html = m.htmlBodySrcdoc || '';
    const text = (m.textBody || '').trim() || stripHtml(html);
    return { id: m.id, from: m.from || '', subject: m.subject || '', receivedAt: m.receivedAt || '', text, html };
  }
}

/** Parse the JSON envelope returned by a SvelteKit remote function. */
function parseRpc(raw) {
  let env;
  try {
    env = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!env || env.type !== 'result' || typeof env.result !== 'string') return null;
  try {
    return JSON.parse(env.result);
  } catch {
    return null;
  }
}

/**
 * Materialize a devalue node. In the flat encoding `A`, `A[0]` is the root and
 * every index points into `A`. An object node is a field map whose values are
 * indices into `A`; an array node is a list of indices into `A`. `-1` is
 * `undefined` and `-2` is a hole.
 */
function materialize(A, node, depth = 0) {
  if (depth > 12) return undefined;
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    return node.map((i) => (i === -1 ? undefined : materialize(A, A[i], depth + 1)));
  }
  const out = {};
  for (const k of Object.keys(node)) {
    const i = node[k];
    out[k] = typeof i === 'number' && i >= 0 ? materialize(A, A[i], depth + 1) : i;
  }
  return out;
}

/** Strip HTML tags/scripts back to plain text. */
function stripHtml(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Extract a numeric/alpha verification code from message text. */
function findCode(text, { len = [4, 8] } = {}) {
  const [lo, hi] = len;
  const m = text.match(new RegExp(`\\b\\d{${lo},${hi}}\\b`));
  return m ? m[0] : null;
}

module.exports = { DisposeMail, findCode, parseRpc, materialize, stripHtml, DISPOSE_URL };
