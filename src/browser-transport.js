'use strict';

/**
 * Browser transport.
 *
 * Executes arbitrary async JS inside a live app.notion.com tab through CDP, so
 * inference/write calls originate from the browser's residential IP and carry
 * its full cookie jar + TLS fingerprint. This is what makes Notion AI usable
 * from a datacenter host, where direct writes are rejected with
 * `UserValidationError`.
 *
 * Usage:
 *   const t = new BrowserTransport(cdp);        // cdp = connected CDP client
 *   await t.attach();                            // find/attach the notion tab
 *   const out = await t.evalInPage('(async()=>1)()');
 */

class BrowserTransport {
  constructor(cdp, { urlMatch = /app\.notion\.com/ } = {}) {
    this.cdp = cdp;
    this.urlMatch = urlMatch;
  }

  /**
   * Open a fresh tab inside a browser context and attach to it. Used by the
   * bulk provisioner so each account gets an isolated cookie jar.
   */
  async openInContext(contextId, url = 'about:blank') {
    const params = { url };
    if (contextId) params.browserContextId = contextId;
    const { targetId } = await this.cdp.send('Target.createTarget', params, null);
    await sleep(1500);
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true }, null);
    this.sessionId = sessionId;
    this.targetId = targetId;
    await this.cdp.send('Page.enable', {}, sessionId).catch(() => {});
    await this.cdp.send('Runtime.enable', {}, sessionId).catch(() => {});
    return this;
  }

  /** Close the attached tab. */
  async closeTab() {
    if (this.targetId) await this.cdp.send('Target.closeTarget', { targetId: this.targetId }, null).catch(() => {});
    this.targetId = null;
    this.sessionId = null;
  }

  /** Attach to an existing Notion tab, or open one. */
  async attach() {
    const { targetInfos } = await this.cdp.send('Target.getTargets');
    let page = targetInfos.find((t) => t.type === 'page' && this.urlMatch.test(t.url));
    if (!page) {
      const { targetId } = await this.cdp.send(
        'Target.createTarget',
        { url: 'https://app.notion.com/ai' },
        null
      );
      await sleep(4000);
      const t2 = await this.cdp.send('Target.getTargets');
      page = t2.targetInfos.find((t) => t.targetId === targetId);
    }
    if (!page) throw new Error('BrowserTransport: could not find an app.notion.com tab');
    const { sessionId } = await this.cdp.send('Target.attachToTarget', {
      targetId: page.targetId,
      flatten: true,
    });
    this.sessionId = sessionId;
    this.targetId = page.targetId;
    await this.cdp.send('Runtime.enable', {}, sessionId).catch(() => {});
    return this;
  }

  /** Evaluate an expression in the page; returns the string value. */
  async evalInPage(expression, { awaitPromise = true, timeoutMs = 180000 } = {}) {
    const res = await this.cdp.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise,
        returnByValue: true,
        timeout: timeoutMs,
      },
      this.sessionId
    );
    if (res.exceptionDetails) {
      const msg =
        (res.exceptionDetails.exception &&
          (res.exceptionDetails.exception.description || res.exceptionDetails.exception.value)) ||
        res.exceptionDetails.text;
      throw new Error(`evalInPage failed: ${msg}`);
    }
    const v = res.result && res.result.value;
    return typeof v === 'string' ? v : JSON.stringify(v);
  }

  /** Navigate the attached tab to a URL and wait for load. */
  async navigate(url) {
    // Skip a real navigation when we are already on the target URL; some SPAs
    // (e.g. 22.do) react badly to a reload mid-flow and it also avoids a
    // needless execution-context teardown.
    const current = await this.evalInPage('location.href').catch(() => '');
    if (current !== url) {
      const loaded = this.cdp
        .waitFor('Page.loadEventFired', { timeoutMs: 30000, sessionId: this.sessionId })
        .catch(() => {});
      await this.cdp.send('Page.navigate', { url }, this.sessionId).catch(() => {});
      await loaded;
    }
    // Wait until the document is actually interactive/complete. `loadEventFired`
    // can arrive before a client-side router has replaced the execution context,
    // which makes the next evaluate fail with "Inspected target navigated".
    await this._waitForReady();
  }

  /** Poll document.readyState until it settles (or timeout). */
  async _waitForReady(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const state = await this.evalInPage('document.readyState');
        if (state === 'complete' || state === 'interactive') {
          // One extra settle tick for late client-side render.
          await sleep(600);
          const again = await this.evalInPage('document.readyState').catch(() => '');
          if (again === 'complete') return;
        }
      } catch {
        /* execution context mid-teardown; retry */
      }
      await sleep(500);
    }
  }

  /** A convenience: open a tab on a specific origin and attach to it. */
  async attachTo(urlPattern) {
    const { targetInfos } = await this.cdp.send('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page' && urlPattern.test(t.url));
    if (!page) return null;
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    this.sessionId = sessionId;
    this.targetId = page.targetId;
    await this.cdp.send('Runtime.enable', {}, sessionId).catch(() => {});
    return this;
  }

  /** True when the attached Notion tab is logged in (not on /login). */
  async isLoggedIn() {
    const url = await this.evalInPage(`location.href`).catch(() => '');
    if (/app\.notion\.com\/login|\/signup/.test(url)) return false;
    const probe = await this.evalInPage(
      `(async () => { try { const r = await fetch('https://app.notion.com/api/v3/getAvailableModels', {method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:'{}'}); return r.status; } catch { return 0; } })()`
    ).catch(() => '0');
    return String(probe) === '200';
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { BrowserTransport };
