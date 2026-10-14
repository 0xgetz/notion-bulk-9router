'use strict';

/**
 * Zero-dependency HTTP-over-SOCKS5 client.
 *
 * Bulk account creation hits per-IP limits on both the mail API and Notion, so
 * every request can be routed through a rotating proxy. Each proxy URL is a
 * SOCKS5 endpoint, optionally with sticky-session credentials:
 *
 *   socks5://user:pass@host:port
 *
 * Many residential providers encode the session in the username (e.g.
 * `res-any-sid-986128199`); rotating the sid rotates the exit IP, which is all
 * the toolkit needs.
 */

const net = require('net');
const tls = require('tls');
const { URL } = require('url');

/** Perform the SOCKS5 handshake over an existing socket. */
function socksHandshake(socket, { host, port, user, pass }) {
  return new Promise((resolve, reject) => {
    const methods = user ? [0x00, 0x02] : [0x00];
    socket.write(Buffer.from([0x05, methods.length, ...methods]));

    let stage = 'method';
    let buf = Buffer.alloc(0);

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'method') {
        if (buf.length < 2) return;
        const [ver, method] = buf;
        if (ver !== 0x05) return reject(new Error('socks5: bad version'));
        buf = buf.slice(2);
        if (method === 0x02) {
          // username/password auth
          const u = Buffer.from(user || '');
          const p = Buffer.from(pass || '');
          socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
          stage = 'auth';
        } else if (method === 0x00) {
          sendConnect();
        } else {
          reject(new Error('socks5: no acceptable auth method'));
        }
      } else if (stage === 'auth') {
        if (buf.length < 2) return;
        if (buf[1] !== 0x00) return reject(new Error('socks5: auth failed'));
        buf = buf.slice(2);
        sendConnect();
      } else if (stage === 'connect') {
        if (buf.length < 4) return;
        const rep = buf[1];
        if (rep !== 0x00) return reject(new Error(`socks5: connect failed (0x${rep.toString(16)})`));
        // Address length depends on ATYP; consume exactly the reply, then give
        // any leftover bytes (early app data) back to the socket stream.
        const atyp = buf[3];
        let addrLen;
        if (atyp === 0x01) addrLen = 4;
        else if (atyp === 0x04) addrLen = 16;
        else if (atyp === 0x03) addrLen = 1 + (buf[4] || 0);
        else return reject(new Error(`socks5: unknown atyp 0x${atyp.toString(16)}`));
        const need = 4 + addrLen + 2;
        if (buf.length < need) return;
        const leftover = buf.slice(need);
        socket.removeListener('data', onData);
        if (leftover.length) socket.unshift(leftover);
        resolve(socket);
      }
    };

    const sendConnect = () => {
      stage = 'connect';
      const h = Buffer.from(host);
      const req = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h, Buffer.from([(port >> 8) & 0xff, port & 0xff])]);
      socket.write(req);
    };

    socket.on('data', onData);
    socket.on('error', reject);
  });
}

/** Open a TCP connection to host:port through a SOCKS5 proxy. */
async function socksConnect(proxy, host, port) {
  const p = proxy instanceof URL ? proxy : new URL(proxy);
  const socket = net.connect({ host: p.hostname, port: parseInt(p.port || '1080', 10) });
  await new Promise((res, rej) => {
    socket.once('connect', res);
    socket.once('error', rej);
  });
  return socksHandshake(socket, {
    host,
    port,
    user: decodeURIComponent(p.username || ''),
    pass: decodeURIComponent(p.password || ''),
  });
}

/**
 * Minimal fetch that supports an optional SOCKS5 proxy. Falls back to global
 * fetch when no proxy is given. Supports GET/POST with a string body.
 */
async function proxyFetch(url, { method = 'GET', headers = {}, body = null, proxy = null, timeoutMs = 30000 } = {}) {
  if (!proxy) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, { method, headers, body, signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
  }

  const u = new URL(url);
  const port = u.port ? parseInt(u.port, 10) : u.protocol === 'https:' ? 443 : 80;
  let socket = await socksConnect(proxy, u.hostname, port);

  if (u.protocol === 'https:') {
    socket = tls.connect({ socket, servername: u.hostname });
    await new Promise((res, rej) => {
      socket.once('secureConnect', res);
      socket.once('error', rej);
    });
  }

  const hdrs = { Host: u.hostname, Connection: 'close', ...headers };
  if (body != null && !('Content-Length' in hdrs) && !('content-length' in hdrs)) {
    hdrs['Content-Length'] = Buffer.byteLength(body);
  }
  const head = `${method} ${u.pathname}${u.search} HTTP/1.1\r\n` + Object.entries(hdrs).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n';

  return new Promise((resolve, reject) => {
    let chunks = Buffer.alloc(0);
    socket.on('data', (c) => (chunks = Buffer.concat([chunks, c])));
    socket.on('end', () => {
      try {
        resolve(parseHttpResponse(chunks));
      } catch (e) {
        reject(e);
      }
    });
    socket.on('error', reject);
    socket.write(head);
    if (body != null) socket.write(body);
  });
}

/** Parse a raw HTTP/1.1 response into { ok, status, headers, text(), json() }. */
function parseHttpResponse(buf) {
  const sep = buf.indexOf('\r\n\r\n');
  const head = buf.slice(0, sep).toString('utf8');
  let bodyBuf = buf.slice(sep + 4);
  const lines = head.split('\r\n');
  const status = parseInt(lines[0].split(' ')[1], 10);
  const headers = {};
  for (const l of lines.slice(1)) {
    const i = l.indexOf(':');
    if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  if ((headers['transfer-encoding'] || '').includes('chunked')) {
    bodyBuf = dechunk(bodyBuf);
  }
  const text = bodyBuf.toString('utf8');
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    text: () => Promise.resolve(text),
    // Kept await-friendly: returns a resolved promise so callers can uniformly
    // `await res.json()` / `await res.text()` for both proxy and direct fetch.
    json: () => Promise.resolve().then(() => JSON.parse(text)),
  };
}

function dechunk(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf('\r\n', i);
    if (nl < 0) break;
    const size = parseInt(buf.slice(i, nl).toString('utf8').trim(), 16);
    if (!size) break;
    out.push(buf.slice(nl + 2, nl + 2 + size));
    i = nl + 2 + size + 2;
  }
  return Buffer.concat(out);
}

/** A tiny rotating proxy pool. */
class ProxyPool {
  constructor(urls = []) {
    this.urls = urls.slice();
    this.i = 0;
  }

  get size() {
    return this.urls.length;
  }

  next() {
    if (!this.urls.length) return null;
    const p = this.urls[this.i % this.urls.length];
    this.i++;
    return p;
  }
}

module.exports = { proxyFetch, socksConnect, ProxyPool, parseHttpResponse };
