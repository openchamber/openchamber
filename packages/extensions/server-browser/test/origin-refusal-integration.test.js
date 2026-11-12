import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import { installCaptureGuard } from '../src/capture-guard.js';
import { connectCdp } from '../src/cdp-client.js';
import { createChromeProcess, resolveChromePath } from '../src/chrome-process.js';
import { createPolicyProxy } from '../src/policy-proxy.js';

let chromePath = null;
try {
  chromePath = resolveChromePath();
} catch {
  // Chrome-dependent tests follow the package's skip-on-unavailable precedent.
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test('Chrome refuses direct navigation, redirects, frames and popups to own origins', { skip: !chromePath, timeout: 25_000 }, async () => {
  // Given real Chrome and an otherwise reachable front door.
  let reached = 0;
  const front = http.createServer((_req, res) => { reached += 1; res.end('private'); });
  const frontPort = await listen(front);
  const own = `http://127.0.0.1:${frontPort}`;
  const web = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: `${own}/redirected` });
      res.end();
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(`<title>Allowed</title><iframe src="${own}/frame"></iframe>`);
  });
  const port = await listen(web);
  const chrome = createChromeProcess({ chromePath });
  let cdp;
  try {
    const launched = await chrome.ensure();
    cdp = await connectCdp(launched.endpoint);
    const blocked = new Set();
    const waiters = new Map();
    const guardedCdp = {
      ...cdp,
      sendSession: async (sessionId, method, params) => {
        const result = await cdp.sendSession(sessionId, method, params);
        if (method === 'Fetch.failRequest') {
          blocked.add(params.requestId);
          waiters.get(params.requestId)?.();
        }
        return result;
      },
    };
    const requests = new Map();
    cdp.onEvent((event) => {
      if (event.method === 'Fetch.requestPaused') requests.set(event.params.request.url, event.params.requestId);
    });
    const failed = (url) => new Promise((resolve) => {
      const cleanup = cdp.onEvent((event) => {
        if (event.method !== 'Fetch.requestPaused' || event.params.request.url !== url) return;
        cleanup();
        waiters.set(event.params.requestId, resolve);
      });
      const id = requests.get(url);
      if (blocked.has(id)) { cleanup(); resolve(); }
    });
    await installCaptureGuard(guardedCdp, { openchamberOrigins: [own] });
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const session = await cdp.attach(targetId);
    // When direct navigation and an allowed site's redirect reach the origin.
    for (const url of [`${own}/direct`, `http://127.0.0.1:${port}/redirect`]) {
      const target = url.endsWith('/direct') ? url : `${own}/redirected`;
      const refusal = failed(target);
      await cdp.sendSession(session, 'Page.navigate', { url });
      await refusal;
    }
    // When an allowed document opens a subframe and a popup.
    const frame = failed(`${own}/frame`);
    await cdp.sendSession(session, 'Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await frame;
    const popup = failed(`${own}/popup`);
    await cdp.sendSession(session, 'Runtime.evaluate', { expression: `window.open('${own}/popup')`, userGesture: true });
    await popup;
    // Then the private server has received none of their requests.
    assert.equal(reached, 0);
    assert.ok(blocked.size >= 4);
  } finally {
    cdp?.close();
    await chrome.close();
    for (const server of [front, web]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

test('Chrome upgrades an allowed WebSocket while the proxy refuses an own-server handshake', { skip: !chromePath, timeout: 25_000 }, async () => {
  // Given real Chrome using the policy proxy, with reachable WebSocket servers.
  const handshakes = { allowed: 0, protected: 0 };
  const servers = [];
  const sockets = new Set();
  const ports = {};
  for (const name of ['allowed', 'protected']) {
    const server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<title>WebSocket test</title>'); });
    server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    server.on('upgrade', (req, socket) => {
      handshakes[name] += 1;
      const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    });
    ports[name] = await listen(server);
    servers.push(server);
  }
  const own = `http://127.0.0.1:${ports.protected}`;
  const proxy = createPolicyProxy({ openchamberOrigins: [own], allowPrivateNetwork: true });
  const proxyAddress = await proxy.listen();
  const chrome = createChromeProcess({ chromePath, proxyServer: `http://${proxyAddress}` });
  let cdp;
  try {
    cdp = await connectCdp((await chrome.ensure()).endpoint);
    await installCaptureGuard(cdp, { openchamberOrigins: [own] });
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const session = await cdp.attach(targetId);
    await cdp.sendSession(session, 'Page.enable');
    const loaded = new Promise((resolve) => {
      const cleanup = cdp.onEvent((event) => {
        if (event.sessionId !== session || event.method !== 'Page.loadEventFired') return;
        cleanup();
        resolve();
      });
    });
    await cdp.sendSession(session, 'Page.navigate', { url: `http://127.0.0.1:${ports.allowed}/` });
    await loaded;
    // When the page opens allowed and protected WebSockets through Chrome.
    const result = await cdp.sendSession(session, 'Runtime.evaluate', {
      expression: `Promise.all(${JSON.stringify([ports.allowed, ports.protected])}.map(port => new Promise(resolve => {
        const socket = new WebSocket('ws://127.0.0.1:' + port + '/socket');
        socket.onopen = () => { socket.close(); resolve('open'); };
        socket.onerror = () => resolve('error');
      })))`,
      awaitPromise: true, returnByValue: true,
    });
    // Then a real upgrade succeeds and the protected server sees no handshake.
    assert.deepEqual(result.result.value, ['open', 'error']);
    assert.deepEqual(handshakes, { allowed: 1, protected: 0 });
  } finally {
    cdp?.close();
    await chrome.close();
    await proxy.close();
    for (const socket of sockets) socket.destroy();
    for (const server of servers) await new Promise((resolve) => server.close(resolve));
  }
});
