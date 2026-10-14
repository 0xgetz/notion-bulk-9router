#!/usr/bin/env node
'use strict';

/**
 * Extract a Notion session (token_v2 + cookies + workspace ids) from a live
 * browser over CDP, and write outputs/notion-session.json + a NOTION_COOKIE
 * env file. Run this whenever the session expires or you log into another
 * Notion account.
 *
 *   BU_CDP_WS=wss://...  node src/extract-session.js
 *   # or a local Chrome with --remote-debugging-port=9222
 *   NOTION_CDP_URL=http://127.0.0.1:9222 node src/extract-session.js
 *
 * The tab must already be logged into app.notion.com.
 */

const fs = require('fs');
const path = require('path');
const { CDP } = require('./cdp');

const UA = 'notion-9router/1.0';

async function resolveWs() {
  if (process.env.NOTION_CDP_WS) return process.env.NOTION_CDP_WS;
  if (process.env.BU_CDP_WS) {
    const host = process.env.BU_CDP_WS.replace(/^wss?:\/\//, '').split('/')[0];
    const v = await fetch(`https://${host}/json/version`).then((r) => r.json());
    return v.webSocketDebuggerUrl;
  }
  const url = process.env.NOTION_CDP_URL || 'http://127.0.0.1:9222';
  const v = await fetch(`${url}/json/version`).then((r) => r.json());
  return v.webSocketDebuggerUrl;
}

(async () => {
  const ws = await resolveWs();
  const cdp = new CDP(ws);
  await cdp.connect();

  // Attach to the Notion tab.
  const { targetInfos } = await cdp.send('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page' && /app\.notion\.com/.test(t.url));
  if (!page) throw new Error('No app.notion.com tab open in the target browser');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });

  await cdp.send('Network.enable', {}, sessionId);
  const { cookies } = await cdp.send(
    'Network.getCookies',
    { urls: ['https://app.notion.com', 'https://www.notion.so', 'https://notion.so'] },
    sessionId
  );

  const NEED = [
    'notion_browser_id',
    'g_state',
    'csrf',
    'token_v2',
    'NEXT_LOCALE',
    'notion_locale',
    '__Host-session_binding',
    'onetap_nonce',
    'device_id',
    'notion_user_id',
    'notion_sync_user_id',
    'notion_users',
    '_cioid',
  ];
  const map = new Map();
  for (const c of cookies) if (NEED.includes(c.name)) map.set(c.name, c.value);
  const cookieHeader = NEED.filter((n) => map.has(n))
    .map((n) => `${n}=${map.get(n)}`)
    .join('; ');

  if (!map.has('token_v2')) throw new Error('token_v2 not found - is this tab logged into Notion?');

  const userId = map.get('notion_user_id') || '';
  // Discover the default space id: the space record whose id differs from the
  // user id in the getSpaces record map.
  const spaceId = await cdp
    .send(
      'Runtime.evaluate',
      {
        expression: `(async () => {
          try {
            const r = await fetch('https://app.notion.com/api/v3/getSpaces', {method:'POST',headers:{'Content-Type':'application/json','x-notion-active-user-header':'${userId}'},credentials:'include',body:'{}'});
            const t = await r.text();
            const ids = [...t.matchAll(/"space_id":"([0-9a-f-]{36})"/g)].map(x => x[1]);
            return [...new Set(ids)][0] || '';
          } catch(e){ return ''; }
        })()`,
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId
    )
    .then((r) => (r.result && r.result.value) || '')
    .catch(() => '');

  const session = {
    email: process.env.NOTION_EMAIL || null,
    userId,
    spaceId: spaceId || null,
    notionClientVersion: '23.13.20261014.0455',
    cookie: cookieHeader,
    extractedAt: new Date().toISOString(),
  };

  const outDir = path.join(__dirname, '..', '..', 'outputs');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'notion-session.json'), JSON.stringify(session, null, 2));
  fs.writeFileSync(
    path.join(outDir, 'notion-session.env'),
    `NOTION_COOKIE='${cookieHeader}'\n${userId ? `NOTION_USER_ID=${userId}\n` : ''}${spaceId ? `NOTION_SPACE_ID=${spaceId}\n` : ''}`
  );
  console.log('Wrote outputs/notion-session.json and outputs/notion-session.env');
  console.log('user:', userId, '| space:', spaceId || '(discover at runtime)');
  cdp.close();
})().catch((e) => {
  console.error('error:', e.message);
  process.exit(1);
});
