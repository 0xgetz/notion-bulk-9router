'use strict';

/**
 * Provisioning orchestrator.
 *
 * One account = one Notion workspace + one 9Router connection. The pipeline:
 *
 *   1. create a disposable inbox            (dispose-mail.js)
 *   2. sign up on Notion + verify the code  (notion-signup.js)
 *   3. extract the session (token_v2 + ids)
 *   4. register the account with the running Notion adapter / 9Router
 *   5. persist the session + connection record to the account store
 *
 * The account store is a JSON file (accounts.json) that doubles as the input to
 * the adapter's connection pool, so many accounts can back one 9Router prefix
 * with round-robin failover.
 */

const fs = require('fs');
const path = require('path');
const { BrowserTransport } = require('./browser-transport');
const { DisposeMail, findCode, DISPOSE_URL } = require('./dispose-mail');
const { NotionSignup, SIGNUP_URL } = require('./notion-signup');

class AccountStore {
  constructor(file) {
    this.file = file;
    this.accounts = this._load();
  }

  _load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return [];
    }
  }

  all() {
    return this.accounts;
  }

  add(acc) {
    this.accounts.push(acc);
    this.save();
    return acc;
  }

  update(email, patch) {
    const a = this.accounts.find((x) => x.email === email);
    if (a) Object.assign(a, patch);
    this.save();
    return a;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.accounts, null, 2));
  }
}

class Provisioner {
  /**
   * @param {object} opts
   * @param {object} opts.cdp           connected CDP client
   * @param {string} [opts.domain]      dispose.lol custom domain ('' = auto)
   * @param {string} [opts.profileName]
   * @param {string} [opts.storeFile]   accounts.json path
   * @param {object} [opts.router]      { base, password, adapterUrl, prefix }
   * @param {object} [opts.inbox]       { provider:'dispose' }
   */
  constructor({ cdp, domain = '', profileName = 'Notion User', storeFile, router = {}, isolate = true, inbox = null, proxyPool = null }) {
    this.cdp = cdp;
    this.domain = domain;
    this.profileName = profileName;
    this.isolate = isolate;
    this.inbox = inbox;
    this.proxyPool = proxyPool;
    this.store = new AccountStore(storeFile || path.join(process.cwd(), 'accounts.json'));
    this.router = router;
  }

  /** Create one fully-provisioned account in its own browser context. */
  async createOne({ onStep } = {}) {
    const step = (s) => onStep && onStep(s);

    // Each account gets an isolated cookie jar so it cannot inherit a previous
    // account's session. With isolate:false the tab persists (for serving), so
    // we clear any existing Notion session first to guarantee a fresh account.
    let contextId = null;
    if (this.isolate) {
      const r = await this.cdp.send('Target.createBrowserContext', { disposeOnDetach: true }, null);
      contextId = r.browserContextId;
    } else {
      await this.cdp.send('Network.clearBrowserCookies', {}, null).catch(() => {});
    }
    let mailTransport = null;
    const notionTransport = new BrowserTransport(this.cdp, { urlMatch: /app\.notion\.com|notion\.com/ });

    try {
      // 1) Mint a mailbox by driving dispose.lol in the browser. It hands out
      //    custom-domain inboxes (e.g. name@your.domain) that Notion both
      //    accepts at signup AND actually delivers to.
      let mail;
      let email;
      step('mail: opening dispose.lol');
      mailTransport = new BrowserTransport(this.cdp, { urlMatch: /dispose\.lol/ });
      await mailTransport.openInContext(contextId, DISPOSE_URL);
      mail = new DisposeMail(mailTransport, { domain: this.domain });
      email = await mail.createEmail();
      step(`mail: ${email}`);

      step('notion: signing up');
      await notionTransport.openInContext(contextId, SIGNUP_URL);
      const signup = new NotionSignup(notionTransport);
      signup.email = email;

      const session = await signup.signup({
        email,
        profileName: this.profileName,
        onStep: step,
        getCode: async () => {
          step('mail: waiting for verification code');
          const msg = await mail.waitForMessage(/notion|signup code|verification/i, { timeoutMs: 150000 });
          if (!msg) throw new Error('no verification email received');
          const code = findCode(msg.body + ' ' + msg.subject, { len: [4, 8] });
          if (!code) throw new Error('verification code not found in email');
          step(`mail: code ${code}`);
          return code;
        },
      });
      step(`notion: ${session.userId} @ space ${session.spaceId}`);

      const account = {
        email,
        userId: session.userId,
        spaceId: session.spaceId,
        workspaceName: session.workspaceName,
        cookie: session.cookie,
        modelCount: session.modelCount || 0,
        createdAt: new Date().toISOString(),
        router: null,
      };
      if (account.modelCount) step(`notion: ${account.modelCount} models available`);

      // Register with 9Router if a router target was provided.
      if (this.router && this.router.base) {
        try {
          const { connect } = require('./connect-9router');
          const r = await connect({
            base: this.router.base,
            password: this.router.password || '123456',
            adapterUrl: this.router.adapterUrl || 'http://127.0.0.1:8790/v1',
            prefix: this.router.prefix || 'notion',
            name: `Notion ${email}`,
            defaultModel: this.router.defaultModel || 'notion/auto',
          });
          account.router = r;
          step(`router: connection ${r.connectionId}`);
        } catch (e) {
          step(`router: connect failed (${e.message})`);
          account.routerError = e.message;
        }
      }

      this.store.add(account);
      step('done');
      return account;
    } finally {
      if (mailTransport) await mailTransport.closeTab();
      // Dispose the whole context (closes its tabs) when isolated. In
      // --persist mode the Notion tab is left open and logged in so the
      // adapter can immediately serve requests through it.
      if (contextId) {
        await this.cdp
          .send('Target.disposeBrowserContext', { browserContextId: contextId }, null)
          .catch(() => {});
      }
    }
  }

  /**
   * Close leftover throwaway tabs (about:blank and ad-heavy disposable-inbox
   * tabs) so a long debugging session does not pile up targets. A browser
   * choked with stale tabs makes CDP `Runtime.evaluate` slow or time out
   * mid-signup, so this runs once before a batch.
   */
  async sweepStaleTabs() {
    try {
      const { targetInfos } = await this.cdp.send('Target.getTargets', {}, null);
      const stale = targetInfos.filter(
        (t) => t.type === 'page' && (/^about:blank$/.test(t.url) || /dispose\.lol/.test(t.url))
      );
      // Keep one blank tab as the anchor; close the rest.
      let keptBlank = false;
      for (const t of stale) {
        if (/^about:blank$/.test(t.url) && !keptBlank) { keptBlank = true; continue; }
        await this.cdp.send('Target.closeTarget', { targetId: t.targetId }, null).catch(() => {});
      }
    } catch {
      /* best effort */
    }
  }

  /** Create N accounts sequentially. */
  async createMany(count, { onStep } = {}) {
    await this.sweepStaleTabs();
    const out = [];
    for (let i = 0; i < count; i++) {
      if (onStep) onStep(`--- account ${i + 1}/${count} ---`);
      try {
        out.push(await this.createOne({ onStep }));
      } catch (e) {
        if (onStep) onStep(`account ${i + 1} failed: ${e.message}`);
        out.push({ error: e.message, email: null });
      }
    }
    return out;
  }
}

module.exports = { Provisioner, AccountStore };
