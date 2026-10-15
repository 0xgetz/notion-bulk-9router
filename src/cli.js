#!/usr/bin/env node
'use strict';

/**
 * notion-bulk-9router CLI.
 *
 *   create --count N [--inbox 22do|dispose] [--domain d] [--router URL] [--adapter URL]   bulk-create + connect
 *   extract [--out file]                                          capture session from a browser
 *   connect [--router URL] [--adapter URL]                        register adapter in 9Router
 *   serve                                                          run the OpenAI-compatible adapter
 *   models                                                         list Notion models
 *   accounts [--file file]                                         show the account store
 *
 * Browser comes from NOTION_CDP_WS (a CDP websocket, e.g. a cloud browser you
 * provisioned) or NOTION_CDP_URL (a local Chrome/Chromium debug port). Each
 * account needs its own browser context/tab; run one browser per parallel worker.
 */

const path = require('path');
const fs = require('fs');
const { CDP } = require('./cdp');
const { Provisioner, AccountStore } = require('./provision');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}
function flag(name) {
  return process.argv.includes('--' + name);
}

async function connectBrowser() {
  const { CDP } = require('./cdp');
  let ws = process.env.NOTION_CDP_WS;
  if (!ws) {
    const url = process.env.NOTION_CDP_URL || 'http://127.0.0.1:9222';
    const v = await fetch(`${url}/json/version`).then((r) => r.json());
    ws = v.webSocketDebuggerUrl;
  } else if (!/\/devtools\//.test(ws)) {
    const host = ws.replace(/^wss?:\/\//, '').split('/')[0];
    const v = await fetch(`https://${host}/json/version`).then((r) => r.json());
    ws = v.webSocketDebuggerUrl;
  }
  const cdp = new CDP(ws, { commandTimeoutMs: 180000 });
  await cdp.connect();
  return cdp;
}

(async () => {
  const cmd = process.argv[2] || 'help';

  if (cmd === 'serve') {
    require('./adapter');
    return;
  }

  if (cmd === 'models') {
    const { NotionClient } = require('./notion');
    const cdp = await connectBrowser();
    const { BrowserTransport } = require('./browser-transport');
    const t = await new BrowserTransport(cdp).attach();
    if (!(await t.isLoggedIn())) {
      console.error('No logged-in app.notion.com tab found.');
      console.error('Log into Notion in the connected browser (or run `create` first), then retry.');
      cdp.close();
      process.exit(1);
    }
    const client = new NotionClient({ transport: t });
    const models = await client.listModels();
    const active = models.filter((m) => !m.disabled);
    console.log(`Models (${active.length} usable / ${models.length} total):`);
    for (const m of models) console.log(`  ${m.disabled ? '(x)' : '   '} notion/${m.id.padEnd(28)} ${m.name}  [${m.family}]${m.reason ? ' - ' + m.reason : ''}`);
    cdp.close();
    return;
  }

  if (cmd === 'connect') {
    const { connect, listRouterModels } = require('./connect-9router');
    const base = arg('router', process.env.NINE_ROUTER_URL || 'https://9router.com');
    const r = await connect({
      base,
      password: arg('password', process.env.NINE_ROUTER_PASSWORD || '123456'),
      adapterUrl: arg('adapter', process.env.ADAPTER_URL || 'http://127.0.0.1:8790/v1'),
      prefix: arg('prefix', 'notion'),
      defaultModel: arg('model', 'notion/auto'),
    });
    const models = await listRouterModels(base, r.clientKey).catch(() => []);
    console.log(JSON.stringify({ ...r, modelCount: models.length, sample: models.slice(0, 6) }, null, 2));
    return;
  }

  if (cmd === 'accounts') {
    const file = arg('file', process.env.ACCOUNTS_FILE || path.join(process.cwd(), 'accounts.json'));
    const store = new AccountStore(file);
    const all = store.all();
    console.log(`Accounts (${all.length}):`);
    for (const a of all) {
      console.log(`  ${a.email || '(failed)'}  space=${a.spaceId || '-'}  models=${a.modelCount || '-'}  router=${a.router ? a.router.connectionId || 'ok' : '-'}`);
    }
    return;
  }

  if (cmd === 'extract') {
    const { execFileSync } = require('child_process');
    execFileSync(process.execPath, [path.join(__dirname, 'extract-session.js')], { stdio: 'inherit' });
    return;
  }

  if (cmd === 'create') {
    const count = parseInt(arg('count', '1'), 10);
    const cdp = await connectBrowser();
    const provisioner = new Provisioner({
      cdp,
      domain: arg('domain', process.env.INBOX_DOMAIN || ''),
      profileName: arg('name', process.env.NOTION_PROFILE_NAME || 'Notion User'),
      isolate: !flag('persist'),
      inbox: { provider: arg('inbox', process.env.INBOX_PROVIDER || '22do') },
      storeFile: arg('file', process.env.ACCOUNTS_FILE || path.join(process.cwd(), 'accounts.json')),
      router: {
        base: arg('router', process.env.NINE_ROUTER_URL || ''),
        password: arg('password', process.env.NINE_ROUTER_PASSWORD || '123456'),
        adapterUrl: arg('adapter', process.env.ADAPTER_URL || 'http://127.0.0.1:8790/v1'),
        prefix: arg('prefix', 'notion'),
      },
    });
    console.log(`Creating ${count} account(s)...`);
    const results = await provisioner.createMany(count, {
      onStep: (s) => console.log('  ' + s),
    });
    const ok = results.filter((r) => r.email && !r.error);
    console.log(`\nDone: ${ok.length}/${count} created.`);
    for (const r of results) console.log(`  ${r.email || '(failed)'}${r.error ? '  ERROR: ' + r.error : ''}`);
    console.log(`\nStore: ${provisioner.store.file}`);
    cdp.close();
    return;
  }

  console.log(`notion-bulk-9router

Usage:
  node src/cli.js create --count N [--inbox 22do|dispose] [--domain <d>] [--router <url>] [--adapter <url>]
  node src/cli.js extract
  node src/cli.js connect --router <url> --adapter <url>
  node src/cli.js serve
  node src/cli.js models
  node src/cli.js accounts

Browser: set NOTION_CDP_WS (CDP websocket) or NOTION_CDP_URL (local Chrome/Chromium).
`);
})().catch((e) => {
  console.error('error:', e.message);
  process.exit(1);
});
