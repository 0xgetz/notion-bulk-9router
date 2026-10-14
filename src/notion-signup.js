'use strict';

/**
 * Notion signup driver.
 *
 * Drives the real app.notion.com signup flow inside a browser:
 *
 *   /signup  → type work email → Continue
 *            → Notion emails a numeric code → type it → Continue
 *            → /onboarding: profile name → use-case → role → goal
 *              → invite (skip) → plan (Free) → desktop (skip)
 *            → /chat  (workspace ready, AI available)
 *
 * Requires a mailbox address and a way to read the verification code
 * (see dispose-mail.js). Returns the workspace/user identifiers together with
 * the session cookie, ready to hand to `NotionClient` or 9Router.
 *
 * The browser's own residential IP is used, so Notion accepts the signup and
 * the resulting session is valid.
 */

const SIGNUP_URL = 'https://app.notion.com/signup';
const CLIENT_VERSION = '23.13.20261014.0455';

const ONBOARD = {
  profileName: 'Notion User',
  useCase: 'For work',
  role: 'Founder',
  goal: 'Track projects and tasks',
  plan: 'Free',
};

class NotionSignup {
  constructor(transport, { clientVersion = CLIENT_VERSION } = {}) {
    this.transport = transport;
    this.clientVersion = clientVersion;
  }

  /**
   * Run the full signup.
   * @param {object} opts
   * @param {string} opts.email
   * @param {() => Promise<string>} opts.getCode  resolves the verification code
   * @param {string} [opts.profileName]
   * @param {string} [opts.password]  optional; the web flow is code-only
   * @returns {Promise<{email,userId,spaceId,workspaceName,cookie,modelCount}>}
   */
  async signup({ email, getCode, profileName = ONBOARD.profileName, onStep } = {}) {
    this.onStep = onStep || (() => {});
    this.email = email;
    await this.transport.navigate(SIGNUP_URL);
    await this._wait(3000);

    // 1) Work email → Continue. Wait for the form to hydrate first.
    if (!(await this._waitForSelector('input[type=email], input[name=email]', 25000))) {
      throw new Error('signup: email field never appeared');
    }
    const filled = await this.transport.evalInPage(`(() => {
      const inp = document.querySelector('input[type=email]') || document.querySelector('input[name=email]') || document.querySelector('input');
      if (!inp) return 'no-input';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, ${JSON.stringify(email)});
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return 'filled';
    })()`);
    if (filled !== 'filled') throw new Error(`signup: email field not found (${filled})`);
    await this._wait(700);

    // Click Continue, then wait for the code step. Notion occasionally ignores
    // the first click if React hasn't attached yet, so retry the click.
    let reachedCode = false;
    for (let attempt = 0; attempt < 3 && !reachedCode; attempt++) {
      await this._clickContinue();
      reachedCode = await this._waitForText('Verification code', attempt === 0 ? 15000 : 10000);
      if (!reachedCode) {
        const rejected = await this.transport.evalInPage(
          `(document.body.innerText.match(/could not reach|couldn't reach|different email|valid email/i)||[])[0]||''`
        );
        if (rejected) throw new Error(`signup: email rejected (${rejected})`);
        await this._wait(2000);
      }
    }
    if (!reachedCode) throw new Error('signup: verification-code step never appeared');

    // 2) Verification code.
    const code = await getCode();
    if (!code) throw new Error('signup: no verification code received');
    await this.transport.evalInPage(`(() => {
      const inp = [...document.querySelectorAll('input')].find(i => i.placeholder && /code/i.test(i.placeholder)) ||
                  [...document.querySelectorAll('input')].find(i => i.type === 'text');
      if (!inp) return 'no-code-input';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, ${JSON.stringify(String(code))});
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return 'filled';
    })()`);
    await this._wait(700);
    await this._clickContinue();
    await this._wait(8000);

    // 3) Onboarding wizard.
    await this._onboard(profileName);

    // 4) Extract the session from the now-logged-in tab.
    return this.extractSession();
  }

  async _onboard(profileName) {
    // Drive the wizard by detecting whichever screen we're on, until the
    // workspace loads. Each screen is handled once, matching option cards by
    // PREFIX because Notion renders them as "For work\nTrack projects, ...".
    const handled = new Set();
    const deadline = Date.now() + 180000;
    let typedName = false;
    let idleWizardSteps = 0;

    while (Date.now() < deadline) {
      const url = await this.transport.evalInPage(`location.href`).catch(() => '');
      if (/app\.notion\.com\/(chat|ai)/.test(url)) return true;

      const text = await this.transport.evalInPage(`document.body.innerText`).catch(() => '');
      const has = (s) => text.includes(s);
      const log = this.onStep || (() => {});

      // Arrival heuristic 1: once the desktop step is done, Notion often leaves
      // us on /onboarding with the workspace already created and a lingering
      // "Skip for now". The definitive signal is that getSpaces now returns a
      // workspace id — poll it and stop as soon as it does.
      if (handled.has('desktop')) {
        const probe = await this._probeWorkspace().catch(() => ({ spaceId: '' }));
        if (probe.spaceId) return true;
        idleWizardSteps++;
        if (idleWizardSteps >= 6) return true;
      }

      if (has('Customize your profile') && !typedName) {
        log('onboard: profile name');
        await this.transport.evalInPage(`(() => {
          const inp = document.querySelector('input[type=text]');
          if (!inp) return 'nf';
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(inp, ${JSON.stringify(profileName)});
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          return 'ok';
        })()`);
        typedName = true;
        await this._wait(500);
        await this._clickContinue();
      } else if (has('Join teammates or create a workspace') && !handled.has('join')) {
        handled.add('join');
        log('onboard: create new workspace');
        const j = await this._clickStartsWith('Create new workspace');
        if (j !== 'ok') await this._clickExact('Create new workspace');
      } else if (has('How do you want to use Notion') && !handled.has('usecase')) {
        handled.add('usecase');
        log('onboard: use case');
        await this._clickStartsWith(ONBOARD.useCase);
        await this._wait(700);
        await this._clickContinue();
      } else if (has('What kind of work do you do') && !handled.has('role')) {
        handled.add('role');
        log('onboard: role');
        await this._clickStartsWith(ONBOARD.role);
        await this._wait(700);
        await this._clickContinue();
      } else if (has('What do you want to get done') && !handled.has('goal')) {
        handled.add('goal');
        log('onboard: goal');
        await this._clickStartsWith(ONBOARD.goal);
        await this._wait(700);
        await this._clickContinue();
      } else if (has('Who else is on your team') && !handled.has('invite')) {
        handled.add('invite');
        log('onboard: invite (skip)');
        await this._clickContinue();
      } else if (has('Choose your Plan') && !handled.has('plan')) {
        handled.add('plan');
        log('onboard: plan');
        await this._clickContinue();
      } else if ((has('Desktop App') || has('faster with the Desktop App') || has('Get desktop app')) && !handled.has('desktop')) {
        handled.add('desktop');
        log('onboard: desktop (skip)');
        await this._clickStartsWith('Skip for now');
      } else if (has('Customize your profile') && typedName) {
        // Name step re-rendered with the continue not taking; click again.
        await this._clickContinue();
      } else {
        // Unknown/transitional screen: if a skip affordance is present, use it.
        if (handled.size >= 6 && (await this._clickExact('Skip for now')) === 'ok') {
          log('onboard: skip (fallback)');
        } else {
          log('onboard: waiting (' + url.replace('https://app.notion.com', '') + ')');
        }
      }

      await this._wait(900);
    }
    return false;
  }

  /** Read the Notion session (cookie + ids) from the current tab. */
  async extractSession() {
    // Give the workspace a moment to settle (chat or AI surface).
    await this._waitForText('Notion AI', 20000);
    const cookies = await this.transport.cdp
      .send(
        'Network.getCookies',
        { urls: ['https://app.notion.com', 'https://www.notion.so'] },
        this.transport.sessionId
      )
      .then((r) => r.cookies)
      .catch(() => []);
    const NEED = [
      'token_v2', 'notion_browser_id', 'notion_user_id', 'notion_users',
      'notion_sync_user_id', 'csrf', 'NEXT_LOCALE', 'notion_locale',
      'device_id', 'g_state', 'onetap_nonce',
    ];
    const map = new Map();
    for (const c of cookies) if (NEED.includes(c.name)) map.set(c.name, c.value);
    if (!map.has('token_v2')) throw new Error('signup: token_v2 missing (signup did not complete)');
    const cookieHeader = NEED.filter((n) => map.has(n)).map((n) => `${n}=${map.get(n)}`).join('; ');
    const userId = map.get('notion_user_id') || '';

    // Wait for the workspace to finish provisioning, then probe with retries.
    let spaceId = '';
    let modelCount = 0;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const probe = await this._probeWorkspace();
      if (probe.spaceId) {
        spaceId = probe.spaceId;
        modelCount = probe.modelCount || 0;
        if (modelCount > 0) break;
      }
      await this._wait(3000);
    }
    const workspaceName = await this.transport
      .evalInPage(`(document.title.replace(/\\s*[|•].*$/, '').trim()) || ''`)
      .catch(() => '');
    return { email: this.email, userId, spaceId, workspaceName, cookie: cookieHeader, modelCount };
  }

  async _probeWorkspace() {
    const out = await this.transport.evalInPage(`(async () => {
      try {
        const r1 = await fetch('https://app.notion.com/api/v3/getSpaces', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: '{}'
        });
        const t1 = await r1.text();
        const ids = [...t1.matchAll(/"space_id":"([0-9a-f-]{36})"/g)].map((x) => x[1]);
        const spaceId = [...new Set(ids)][0] || '';
        const r2 = await fetch('https://app.notion.com/api/v3/getAvailableModels', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-notion-space-id': spaceId, 'notion-client-version': ${JSON.stringify(CLIENT_VERSION)} },
          credentials: 'include',
          body: JSON.stringify({ spaceId })
        });
        let count = 0;
        try { count = (JSON.parse(await r2.text()).models || []).length; } catch (e) {}
        return JSON.stringify({ spaceId, modelCount: count });
      } catch (e) { return JSON.stringify({ spaceId: '', modelCount: 0, error: String(e) }); }
    })()`);
    return safeJson(out) || { spaceId: '', modelCount: 0 };
  }

  // --- UI helpers ---------------------------------------------------------

  /** Click the primary "Continue" button (a div[role=button] in Notion). */
  async _clickContinue() {
    return this.transport.evalInPage(`(() => {
      const els = [...document.querySelectorAll('div[role=button],button')];
      const b = els.find(e => e.innerText && e.innerText.trim() === 'Continue');
      if (!b) return 'nf';
      b.click();
      return 'ok';
    })()`);
  }

  /** Click any element whose exact text matches (button, role=button or leaf). */
  async _clickExact(text) {
    return this.transport.evalInPage(`(() => {
      const btns = [...document.querySelectorAll('div[role=button],button,[role=button]')];
      let el = btns.find(e => e.innerText && e.innerText.trim() === ${JSON.stringify(text)});
      if (!el) {
        el = [...document.querySelectorAll('*')].find(e => e.innerText && e.innerText.trim() === ${JSON.stringify(text)} && e.children.length <= 1);
      }
      if (!el) return 'nf';
      el.click();
      return 'ok';
    })()`);
  }

  /**
   * Click the first button whose text STARTS WITH `text`. Notion's onboarding
   * option cards render as "For work\nTrack projects, company goals, ...", so an
   * exact match never fires — a prefix match is what reliably selects them.
   */
  async _clickStartsWith(text) {
    return this.transport.evalInPage(`(() => {
      const btns = [...document.querySelectorAll('div[role=button],button,[role=button]')];
      const el = btns.find(e => e.innerText && e.innerText.trim().split('\\n')[0].trim().toLowerCase() === ${JSON.stringify(text)}.toLowerCase())
              || btns.find(e => e.innerText && e.innerText.trim().toLowerCase().startsWith(${JSON.stringify(text)}.toLowerCase()));
      if (!el) return 'nf';
      el.click();
      return 'ok';
    })()`);
  }

  async _waitForText(text, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const has = await this.transport.evalInPage(`document.body.innerText.includes(${JSON.stringify(text)})`);
      if (has === 'true' || has === true) return true;
      await this._wait(1000);
    }
    return false;
  }

  async _waitForSelector(selector, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const has = await this.transport.evalInPage(`!!document.querySelector(${JSON.stringify(selector)})`);
      if (has === 'true' || has === true) return true;
      await this._wait(1000);
    }
    return false;
  }

  _wait(ms) {
    return this.transport.evalInPage(`new Promise(r=>setTimeout(r,${ms}))`).catch(() => {});
  }
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

module.exports = { NotionSignup, SIGNUP_URL, CLIENT_VERSION };
