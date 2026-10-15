'use strict';

/**
 * Temporary Microsoft inbox driver (22.do/temporary-outlook).
 *
 * 22.do hands out real @hotmail.com addresses of the form
 *   <random>+<visitor-tag>@hotmail.com
 * Each address is a live Microsoft mailbox with a 24-hour lifetime, and it is
 * one that Notion accepts (Notion rejects most disposable domains but takes
 * Microsoft addresses). Mail is read through 22.do's own same-origin JSON
 * endpoints:
 *
 *   POST /action/mailbox/applyToken   { email, uuid }        -> { token, expireTime }
 *   POST /action/mailbox/message      { email, lastime }     -> [{ messageId, subject, from, time }]
 *        (Authorization: Bearer <token>)
 *   GET  /content/<messageId>                                -> HTML page with
 *                                                              <iframe src="https://22.do/view/<id>">
 *   GET  /view/<id>                                          -> the rendered message body
 *
 * Everything runs inside a live 22.do tab via the browser transport, so the
 * requests ride the browser's IP and pass Cloudflare (the host never talks to
 * 22.do directly, which Cloudflare blocks from datacenter IPs).
 *
 * The driver is transport-agnostic: pass anything with `evalInPage(expr)` and
 * `navigate(url)` (see browser-transport.js).
 */

const GEN_URL = 'https://22.do/temporary-outlook';
const INBOX_URL = 'https://22.do/inbox/';

class TwentytwoDoMail {
  constructor(transport, { domain = 'hotmail.com', uuid = '' } = {}) {
    this.transport = transport;
    this.domain = domain; // 'hotmail.com' (only domain 22.do offers on this page)
    // 22.do's applyToken wants a FingerprintJS-style 32-hex visitor id. The site
    // stores its own in localStorage; this is only the fallback.
    this.uuid = uuid || randomHex32();
    this.address = null;
    this.token = null;
  }

  /**
   * Create a fresh @hotmail.com inbox by driving the generator page.
   * Clicks "Random" for a unique local part, then "Open" to register the
   * mailbox on 22.do and land on its inbox.
   * @returns {Promise<string>} the new address
   */
  async createEmail(opts = {}) {
    const attempts = opts.attempts || 3;
    let last = null;
    for (let i = 0; i < attempts; i++) {
      const addr = await this._createOnce();
      if (addr) {
        this.address = addr;
        return addr;
      }
      last = addr;
      await this.transport.evalInPage(`new Promise(r=>setTimeout(r,1500))`);
    }
    throw new Error(`22.do: could not create a @${this.domain} mailbox (last: ${last})`);
  }

  /** One create attempt: generate + open; returns the address (or null). */
  async _createOnce() {
    await this.transport.navigate(GEN_URL);
    await sleep(3500);

    // Pick the Microsoft domain (only @hotmail.com is offered here).
    if (this.domain) {
      await this.transport.evalInPage(
        `(function(){const s=document.querySelector('#mail-choices');if(s&&[...s.options].some(o=>o.value===${JSON.stringify(this.domain)})){s.value=${JSON.stringify(this.domain)};s.dispatchEvent(new Event('change',{bubbles:true}));}return 'ok';})()`
      );
    }

    // "Random" yields an unused local part, then "Open" registers the mailbox
    // and navigates to the inbox. Any in-page sleep across that navigation would
    // kill the execution context ("Inspected target navigated or closed"), so we
    // sleep host-side between clicks.
    await this._clickButton('Random');
    await sleep(1500);
    await this._clickButton('Open');
    await sleep(5000);

    const addr = await this.transport.evalInPage(`location.hash.replace(/^#\\/?/,'')||''`).catch(() => '');
    const clean = String(addr).trim();
    if (clean && /@/.test(clean)) return clean;
    // Fall back to the address rendered in the inbox header.
    const shown = await this.transport.evalInPage(
      `(document.body.innerText.match(/[a-z0-9][a-z0-9._+-]*@[a-z0-9.-]+\\.[a-z]{2,}/i)||[])[0]||''`
    ).catch(() => '');
    return shown ? String(shown).replace(/^"|"$/g, '') : null;
  }

  /** Click a button by its exact visible label (React-friendly). */
  async _clickButton(label) {
    return this.transport.evalInPage(
      `(function(){
        const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()===${JSON.stringify(label)});
        if(!b) return 'nf';
        b.click();
        return 'ok';
      })()`
    );
  }

  /** Obtain (and cache) the bearer token used to read this mailbox. */
  async _applyToken() {
    if (this.token) return this.token;
    const email = this.address;
    if (!email) throw new Error('22.do: no address yet (call createEmail first)');
    // 22.do ties the token to a FingerprintJS-style visitor id: the page stores
    // a 32-hex `uuid` in localStorage (set by the site's own FingerprintJS
    // bootstrap). Reuse that when present; otherwise generate a 32-hex id.
    const uuid = this.uuid;
    const raw = await this.transport.evalInPage(`(async()=>{
      const stored = localStorage.getItem('uuid') || ${JSON.stringify(uuid)};
      const r = await fetch('/action/mailbox/applyToken',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({email:${JSON.stringify(email)},uuid:stored})
      });
      return await r.text();
    })()`);
    let data;
    try { data = JSON.parse(raw); } catch { data = null; }
    if (!data || !data.status || !data.data || !data.data.token) {
      throw new Error(`22.do: applyToken failed (${String(raw).slice(0, 160)})`);
    }
    this.token = data.data.token;
    return this.token;
  }

  /**
   * List messages in the current mailbox.
   * @returns {Promise<Array<{id,from,subject,receivedAt}>>}
   */
  async listMessages() {
    const token = await this._applyToken();
    const raw = await this.transport.evalInPage(`(async()=>{
      const r = await fetch('/action/mailbox/message',{
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+${JSON.stringify(token)}},
        body:JSON.stringify({email:${JSON.stringify(this.address)},lastime:0})
      });
      return await r.text();
    })()`);
    let data;
    try { data = JSON.parse(raw); } catch { return []; }
    if (!data || !data.status || !Array.isArray(data.data)) return [];
    return data.data.map((m) => ({
      id: m.messageId,
      from: m.from || '',
      subject: m.subject || '',
      receivedAt: m.time || '',
    }));
  }

  /**
   * Fetch one message's body. 22.do renders it through a two-step viewer:
   * /content/<id> embeds an <iframe src="/view/<opaque>">, and the iframe
   * holds the actual message HTML.
   * @returns {Promise<{id,from,subject,receivedAt,text,html}|null>}
   */
  async getMessage(id) {
    const raw = await this.transport.evalInPage(`(async()=>{
      const html = await fetch('/content/'+encodeURIComponent(${JSON.stringify(id)})).then(r=>r.text());
      const m = html.match(/src="(https:\\/\\/22\\.do\\/view\\/[^"]+)"/);
      let view = '';
      if (m) view = await fetch(m[1]).then(r=>r.text());
      const text = (view||html)
        .replace(/<style[\\s\\S]*?<\\/style>/gi,' ')
        .replace(/<script[\\s\\S]*?<\\/script>/gi,' ')
        .replace(/<[^>]+>/g,' ')
        .replace(/&nbsp;/g,' ')
        .replace(/&amp;/g,'&')
        .replace(/&#(\\d+);/g,(_,d)=>String.fromCharCode(+d))
        .replace(/\\s+/g,' ')
        .trim();
      const subj = (html.match(/Rubject[：:]\\s*([^<]+)/)||[])[1] || '';
      const from = (html.match(/From[：:]\\s*([^<]+)/)||[])[1] || '';
      return JSON.stringify({view:!!view, subject:subj.trim(), from:from.trim(), text:text.slice(0,8000)});
    })()`);
    let d;
    try { d = JSON.parse(raw); } catch { return null; }
    if (!d || !d.text) return null;
    return { id, from: d.from, subject: d.subject, receivedAt: '', text: d.text, html: '' };
  }

  /**
   * Poll the inbox for a message matching a regex and return its extracted text.
   * @returns {Promise<{subject,from,body,raw}|null>}
   */
  async waitForMessage(match, { timeoutMs = 150000, pollMs = 4000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    const seen = new Set();
    while (Date.now() < deadline) {
      let msgs = [];
      try { msgs = await this.listMessages(); } catch { msgs = []; }
      for (const m of msgs) {
        if (seen.has(m.id)) continue;
        if (match && !(match.test(m.subject || '') || match.test(m.from || ''))) { seen.add(m.id); continue; }
        const full = await this.getMessage(m.id);
        if (!full) continue;
        seen.add(m.id);
        const blob = `${full.subject}\n${full.text}`;
        if (!match || match.test(full.subject || '') || match.test(blob)) {
          return { ...m, body: full.text, html: full.html, raw: full };
        }
      }
      await this.transport.evalInPage(`new Promise(r=>setTimeout(r,${pollMs}))`).catch(() => {});
    }
    return null;
  }
}

/** Extract a numeric/alpha verification code from message text. */
function findCode(text, { len = [4, 8] } = {}) {
  const [lo, hi] = len;
  const m = String(text).match(new RegExp(`\\b\\d{${lo},${hi}}\\b`));
  return m ? m[0] : null;
}

/** Host-side sleep (never runs inside the page, so navigation cannot kill it). */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** A 32-char hex id, in the shape 22.do expects for its visitor uuid. */
function randomHex32() {
  let s = '';
  while (s.length < 32) s += Math.floor(Math.random() * 16).toString(16);
  return s.slice(0, 32);
}

module.exports = { TwentytwoDoMail, findCode, GEN_URL, INBOX_URL };
