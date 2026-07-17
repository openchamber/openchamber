import { afterEach, describe, expect, it } from 'bun:test';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

import { createClientHandshake } from '../../../../ui/src/lib/relay/handshake.ts';
import { createTunnelAuth, createInternalTransportMarker, DIRECT_E2EE_TRANSPORT_HEADER } from '../opencode/tunnel-auth.js';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { exportPublicKeyJwk, generateEcdhKeyPair } from '../relay/e2ee.js';
import { TunnelFrameType, decodeJsonPayload, decodeTunnelFrame, encodeJsonPayload, encodeTunnelFrame } from '../relay/tunnel-codec.js';
import { createDirectE2eeService, DIRECT_E2EE_PATH } from './service.js';

const cleanups = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((fn) => fn())));
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const waitFor = async (predicate) => {
  for (let i = 0; i < 200; i += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  throw new Error('condition not reached');
};

const startFixture = async ({ authDeadlineMs = 500, limits = {}, logs = [], rejectPairing = false, authResponseDelayMs = 0, pairingResponseDelayMs = 0, authState = { valid: true } } = {}) => {
  const marker = createInternalTransportMarker();
  const tunnelAuth = createTunnelAuth({ internalRemoteClientMarker: marker });
  const keys = await generateEcdhKeyPair();
  const received = [];
  const lifecycle = {
    aborted: 0,
    authResponses: 0,
    closedResponses: 0,
    pairingResponses: 0,
    sseClosed: 0,
    wsClosed: 0,
    innerClosed: [],
  };
  const authenticateBearerToken = async (token) => authState.valid && token === 'valid-client' ? { ok: true, clientId: 'client-1' } : null;
  const uiAuth = createUiAuth({ requireClientAuth: true, clientAuthController: { authenticateBearerToken } });
  const origin = http.createServer((req, res) => {
    const scope = tunnelAuth.classifyRequestScope(req);
    received.push({ method: req.method, url: req.url, headers: req.headers, scope });
    req.on('aborted', () => { lifecycle.aborted += 1; });
    res.on('close', () => { if (!res.writableEnded) lifecycle.closedResponses += 1; });
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok', openchamberVersion: 'test' }));
    if (req.url === '/auth/session' && authState.valid && req.headers.authorization === 'Bearer valid-client') {
      return void setTimeout(() => {
        lifecycle.authResponses += 1;
        res.end(JSON.stringify({ authenticated: true, scope: 'client' }));
      }, authResponseDelayMs);
    }
    if (req.url === '/auth/session') { res.statusCode = 401; return res.end(JSON.stringify({ authenticated: false })); }
    if (req.url === '/auth/url-token') return res.end(JSON.stringify({ token: 'url-token' }));
    if (req.url === '/auth/passkey/status') return res.end(JSON.stringify({ enabled: true, rpId: 'direct.example.test', passkeyCount: 1 }));
    if (req.url === '/api/client-auth/pairing/redeem') {
      if (rejectPairing) res.statusCode = 400;
      return void setTimeout(() => {
        lifecycle.pairingResponses += 1;
        res.end(JSON.stringify(rejectPairing ? { error: 'rejected' } : { token: 'valid-client' }));
      }, pairingResponseDelayMs);
    }
    if (req.url?.startsWith('/api/config/settings')) {
      return void uiAuth.requireAuth(req, {
        status(code) { res.statusCode = code; return this; },
        json(value) { res.end(JSON.stringify(value)); return this; },
        setHeader: (...args) => res.setHeader(...args),
      }, () => { res.statusCode = 204; res.end(); });
    }
    if (req.url === '/api/test' && authState.valid && req.headers.authorization === 'Bearer valid-client') return res.end(JSON.stringify({ ok: true }));
    if (req.url === '/api/stream') { res.write('one\n'); setTimeout(() => res.end('two\n'), 10); return; }
    if (req.url === '/api/slow') { res.write('first\n'); return; }
    if (req.url === '/api/sse') {
      res.on('close', () => { lifecycle.sseClosed += 1; });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      setTimeout(() => res.write('data: two\n\n'), 10);
      return;
    }
    res.statusCode = 401; res.end('{}');
  });
  const nestedWss = new WebSocketServer({ noServer: true });
  origin.on('upgrade', async (req, socket, head) => {
    const context = await uiAuth.resolveAuthContext(req, null);
    if (!context) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
    nestedWss.handleUpgrade(req, socket, head, (ws) => nestedWss.emit('connection', ws));
  });
  nestedWss.on('connection', (ws) => {
    ws.on('message', (data, binary) => ws.send(data, { binary }));
    ws.on('close', () => { lifecycle.wsClosed += 1; });
  });
  await listen(origin);
  const outer = http.createServer();
  const service = createDirectE2eeService({
    getActiveProfile: () => ({ id: 'p1', mode: 'managed-remote', hostname: 'direct.example.test', directE2eeEnabled: true }),
    getRelayIdentity: async () => ({ hostEncPrivateKey: keys.privateKey }),
    getLocalPort: () => origin.address().port,
    internalTransportMarker: marker,
    authenticateBearerToken,
    limits: { authenticationDeadlineMs: authDeadlineMs, ...limits },
    logger: { warn: (...args) => logs.push(args) },
    onInnerStreamClosed: (event) => lifecycle.innerClosed.push(event),
  });
  service.attach(outer);
  await listen(outer);
  cleanups.push(() => new Promise((resolve) => {
    service.detach();
    for (const socket of nestedWss.clients) socket.terminate();
    nestedWss.close();
    outer.closeAllConnections?.();
    origin.closeAllConnections?.();
    outer.close(() => origin.close(resolve));
  }));
  const mintUrlToken = async () => {
    let body;
    const response = { setHeader() {}, status() { return this; }, json(value) { body = value; return this; }, type() { return this; }, send() { return this; } };
    await uiAuth.handleUrlAuthToken({ method: 'POST', path: '/auth/url-token', headers: { authorization: 'Bearer valid-client', accept: 'application/json' } }, response);
    return body.token;
  };
  return { service, outer, keys, received, marker, lifecycle, mintUrlToken, logs };
};

const connectEncrypted = async (fx) => {
  const client = await createClientHandshake(await exportPublicKeyJwk(fx.keys.publicKey), { batch: false });
  const ws = new WebSocket(`ws://127.0.0.1:${fx.outer.address().port}${DIRECT_E2EE_PATH}`, { headers: { Host: 'direct.example.test' }, perMessageDeflate: false });
  let channel;
  const frames = [];
  ws.on('message', async (data, binary) => {
    if (!binary) {
      const action = await client.handleText(data.toString());
      if (action.type === 'established') channel = action.channel;
      return;
    }
    frames.push(decodeTunnelFrame(await channel.decryptor.decrypt(new Uint8Array(data))));
  });
  await new Promise((resolve) => ws.once('open', resolve));
  ws.send(client.helloText);
  await waitFor(() => channel);
  const encrypt = (frame) => channel.encryptor.encrypt(frame);
  const sendEncrypted = (encrypted) => ws.send(encrypted, { binary: true });
  const send = async (frame) => sendEncrypted(await encrypt(frame));
  const request = async (id, method, path, headers = {}, query = '') => {
    await send(encodeTunnelFrame(TunnelFrameType.HttpRequest, id, encodeJsonPayload({ method, path, query, headers })));
    await send(encodeTunnelFrame(TunnelFrameType.StreamEnd, id, new Uint8Array()));
    await waitFor(() => frames.some((frame) => frame.streamId === id && frame.frameType === TunnelFrameType.StreamEnd));
    const response = frames.find((frame) => frame.streamId === id && frame.frameType === TunnelFrameType.HttpResponse);
    return decodeJsonPayload(response.payload, (value) => value);
  };
  const promote = () => request(99, 'GET', '/auth/session', { authorization: 'Bearer valid-client' });
  return { ws, frames, send, encrypt, sendEncrypted, request, promote };
};

describe('direct E2EE encrypted integration', () => {
  it('closes the outer session for a disallowed HTTP path', async () => {
    const fx = await startFixture();
    const client = await connectEncrypted(fx);
    await client.send(encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({ method: 'GET', path: '/forbidden', query: '', headers: {} })));
    await new Promise((resolve) => client.ws.once('close', resolve));
    expect(fx.received).toHaveLength(0);
  });

  it('closes the outer session for a disallowed WebSocket path', async () => {
    const fx = await startFixture();
    const client = await connectEncrypted(fx);
    await client.send(encodeTunnelFrame(TunnelFrameType.WsOpen, 1, encodeJsonPayload({ path: '/forbidden', query: '', protocols: [] })));
    await new Promise((resolve) => client.ws.once('close', resolve));
    expect(fx.service.getCounts().total).toBe(0);
  });

  it('closes the outer session for an unsolicited unknown-stream fragment', async () => {
    const fx = await startFixture();
    const client = await connectEncrypted(fx);
    await client.send(encodeTunnelFrame(TunnelFrameType.WsText, 77, new Uint8Array([1]), true));
    await new Promise((resolve) => client.ws.once('close', resolve));
    expect(fx.service.getCounts().total).toBe(0);
  });

  it('confirms health, remote-client marker classification, and bearer-only promotion', async () => {
    const fx = await startFixture();
    const client = await connectEncrypted(fx);
    expect((await client.request(1, 'GET', '/health')).status).toBe(200);
    expect(fx.received[0].scope).toBe('remote-client');
    expect(fx.received[0].headers[DIRECT_E2EE_TRANSPORT_HEADER]).toBe(fx.marker);

    expect((await client.request(2, 'POST', '/api/client-auth/pairing/redeem')).status).toBe(200);
    expect(fx.service.getCounts().preauthenticated).toBe(1);
    expect((await client.request(3, 'GET', '/auth/session', { authorization: 'Bearer valid-client' })).status).toBe(200);
    expect(fx.service.getCounts().authenticated).toBe(1);
    expect((await client.request(4, 'GET', '/api/stream', { authorization: 'Bearer valid-client' })).status).toBe(200);
    expect(client.frames.filter((frame) => frame.streamId === 4 && frame.frameType === TunnelFrameType.HttpBody).length).toBe(2);
    fx.service.revokeClient('client-1');
    await new Promise((resolve) => client.ws.once('close', resolve));
    expect(fx.service.getActiveSessionCount()).toBe(0);
  });

  it('blocks pre-auth routes and spoofed transport headers before loopback', async () => {
    const fx = await startFixture();
    const client = await connectEncrypted(fx);
    const before = fx.received.length;
    await client.send(encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({ method: 'POST', path: '/auth/session', query: '', headers: {
      cookie: 'oc_ui_session=secret', forwarded: 'for=attacker', 'x-forwarded-for': 'attacker',
      'cf-connecting-ip': 'attacker', origin: 'https://attacker.test', [DIRECT_E2EE_TRANSPORT_HEADER]: 'attacker',
    } })));
    await new Promise((resolve) => client.ws.once('close', resolve));
    expect(fx.received.length).toBe(before);
  });

  it('allows only the three exact authenticated auth requests and keeps the channel usable', async () => {
    const fx = await startFixture();
    const client = await connectEncrypted(fx);
    await client.promote();

    expect((await client.request(1, 'GET', '/auth/session', { authorization: 'Bearer valid-client' })).status).toBe(200);
    expect((await client.request(3, 'POST', '/auth/url-token')).status).toBe(200);
    expect((await client.request(5, 'GET', '/auth/passkey/status')).status).toBe(200);
    expect((await client.request(7, 'GET', '/api/test', { authorization: 'Bearer valid-client' })).status).toBe(200);
    expect(fx.received.map((request) => request.url)).toEqual(expect.arrayContaining([
      '/auth/session',
      '/auth/url-token',
      '/auth/passkey/status',
    ]));
    client.ws.terminate();
  });

  it('fails closed on preauthenticated passkey status without origin dispatch', async () => {
    const fx = await startFixture();
    const client = await connectEncrypted(fx);
    await client.send(encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({ method: 'GET', path: '/auth/passkey/status', query: '', headers: {} })));
    await new Promise((resolve) => client.ws.once('close', resolve));
    expect(fx.received.some((request) => request.url === '/auth/passkey/status')).toBe(false);
  });

  it('fails closed on every other authenticated auth target using fresh channels', async () => {
    const fx = await startFixture();
    const cases = [
      { method: 'GET', path: '/auth/session', query: 'refresh=1' },
      { method: 'POST', path: '/auth/session', query: '' },
      { method: 'POST', path: '/auth/url-token', query: 'scope=ws' },
      { method: 'GET', path: '/auth/url-token', query: '' },
      { method: 'GET', path: '/auth/passkey/status', query: 'refresh=1' },
      { method: 'POST', path: '/auth/passkey/status', query: '' },
      { method: 'POST', path: '/auth/passkey/register', query: '' },
      { method: 'GET', path: '/auth/passkey/status/details', query: '' },
      { method: 'GET', path: '/auth', query: '' },
      { method: 'GET', path: '/auth/unknown', query: '' },
      { method: 'GET', path: '/Auth/session', query: '' },
    ];

    for (const testCase of cases) {
      const client = await connectEncrypted(fx);
      await client.promote();
      const before = fx.received.length;
      await client.send(encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({ ...testCase, headers: {} })));
      await new Promise((resolve) => client.ws.once('close', resolve));
      expect(fx.received).toHaveLength(before);
    }
  });

  it('logs only fixed categories for auth and pairing rejection', async () => {
    const logs = [];
    const fx = await startFixture({ logs, rejectPairing: true });
    const client = await connectEncrypted(fx);
    const authSecret = 'auth-secret\r\nforged\u2028line';
    await client.send(encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({ method: 'GET', path: '/auth/session', query: '', headers: { authorization: `Bearer ${authSecret}`, cookie: 'oc_ui_session=cookie-secret' } })));
    await new Promise((resolve) => client.ws.once('close', resolve));
    const serialized = JSON.stringify(logs);
    for (const secret of [authSecret, 'cookie-secret']) expect(serialized).not.toContain(secret);
    expect(logs.map((entry) => entry[1].reason)).toContain('preauth-auth-rejected');
  });

  it('keeps the authentication deadline independent from encrypted Ping', async () => {
    const fx = await startFixture({ authDeadlineMs: 40 });
    const client = await connectEncrypted(fx);
    const timer = setInterval(() => void client.send(encodeTunnelFrame(TunnelFrameType.Ping, 0, new Uint8Array())), 5);
    await new Promise((resolve) => client.ws.once('close', resolve));
    clearInterval(timer);
    expect(fx.service.getCounts().total).toBe(0);
  });

  it('streams ordered SSE and aborts it when the outer connection closes', async () => {
    const fx = await startFixture();
    const client = await connectEncrypted(fx);
    await client.promote();
    await client.send(encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({ method: 'GET', path: '/api/sse', query: '', headers: { authorization: 'Bearer valid-client' } })));
    await waitFor(() => client.frames.filter((frame) => frame.streamId === 1 && frame.frameType === TunnelFrameType.HttpBody).map((frame) => Buffer.from(frame.payload).toString()).join('').includes('data: two'));
    const body = client.frames.filter((frame) => frame.streamId === 1 && frame.frameType === TunnelFrameType.HttpBody).map((frame) => Buffer.from(frame.payload).toString()).join('');
    expect(body).toBe('data: one\n\ndata: two\n\n');
    client.ws.terminate();
    await waitFor(() => fx.lifecycle.innerClosed.some((event) => event.streamId === 1 && event.kind === 'http' && event.reason === 'connection closed'));
    expect(fx.service.getCounts().total).toBe(0);
  });

  it('runs nested WebSocket text, binary, close, and real URL-token gates', async () => {
    const fx = await startFixture();
    const client = await connectEncrypted(fx);
    await client.promote();
    const token = await fx.mintUrlToken();
    const open = async (streamId, query) => {
      await client.send(encodeTunnelFrame(TunnelFrameType.WsOpen, streamId, encodeJsonPayload({ path: '/api/global/event/ws', query, protocols: [] })));
      await waitFor(() => client.frames.some((frame) => frame.streamId === streamId && [TunnelFrameType.WsOpened, TunnelFrameType.StreamAbort].includes(frame.frameType)));
      return client.frames.find((frame) => frame.streamId === streamId && [TunnelFrameType.WsOpened, TunnelFrameType.StreamAbort].includes(frame.frameType));
    };
    expect((await open(1, `oc_url_token=${encodeURIComponent(token)}`)).frameType).toBe(TunnelFrameType.WsOpened);
    await client.send(encodeTunnelFrame(TunnelFrameType.WsText, 1, Buffer.from('hello')));
    await client.send(encodeTunnelFrame(TunnelFrameType.WsBinary, 1, new Uint8Array([1, 2, 3])));
    await waitFor(() => client.frames.filter((frame) => frame.streamId === 1 && [TunnelFrameType.WsText, TunnelFrameType.WsBinary].includes(frame.frameType)).length === 2);
    expect(Buffer.from(client.frames.find((frame) => frame.streamId === 1 && frame.frameType === TunnelFrameType.WsText).payload).toString()).toBe('hello');
    expect([...client.frames.find((frame) => frame.streamId === 1 && frame.frameType === TunnelFrameType.WsBinary).payload]).toEqual([1, 2, 3]);
    await client.send(encodeTunnelFrame(TunnelFrameType.WsClose, 1, encodeJsonPayload({ code: 1000, reason: 'done' })));
    await waitFor(() => fx.lifecycle.wsClosed === 1);

    expect((await open(3, '')).frameType).toBe(TunnelFrameType.StreamAbort);
    const originalNow = Date.now;
    Date.now = () => originalNow() + 61_000;
    expect((await open(5, `oc_url_token=${encodeURIComponent(token)}`)).frameType).toBe(TunnelFrameType.StreamAbort);
    Date.now = originalNow;

    const fresh = await fx.mintUrlToken();
    expect((await open(7, `oc_url_token=${encodeURIComponent(fresh)}`)).frameType).toBe(TunnelFrameType.WsOpened);
    expect((await open(9, `oc_url_token=${encodeURIComponent(fresh)}`)).frameType).toBe(TunnelFrameType.WsOpened);
    expect((await client.request(11, 'GET', '/api/config/settings', {}, `oc_url_token=${encodeURIComponent(fresh)}`)).status).toBe(401);
    client.ws.terminate();
  });

  it('fails closed on replayed, reordered, and old-session encrypted ciphertext', async () => {
    const fx = await startFixture();
    const first = await connectEncrypted(fx);
    const ping = encodeTunnelFrame(TunnelFrameType.Ping, 0, new Uint8Array());
    const encrypted1 = await first.encrypt(ping);
    const encrypted2 = await first.encrypt(ping);
    first.sendEncrypted(encrypted2);
    first.sendEncrypted(encrypted1);
    await new Promise((resolve) => first.ws.once('close', resolve));
    expect(fx.service.getCounts().total).toBe(0);

    const second = await connectEncrypted(fx);
    second.sendEncrypted(encrypted1);
    await new Promise((resolve) => second.ws.once('close', resolve));
    expect(fx.service.getCounts().total).toBe(0);

    const third = await connectEncrypted(fx);
    const replay = await third.encrypt(ping);
    third.sendEncrypted(replay);
    await waitFor(() => third.frames.some((frame) => frame.frameType === TunnelFrameType.Pong));
    third.sendEncrypted(replay);
    await new Promise((resolve) => third.ws.once('close', resolve));
  });

  it('cleans disconnects during health, redemption, streamed output, nested WS, and never-ended bodies', async () => {
    for (const operation of ['health', 'redeem', 'stream', 'ws', 'body']) {
      const fx = await startFixture();
      const client = await connectEncrypted(fx);
      if (operation === 'stream' || operation === 'ws' || operation === 'body') await client.promote();
      if (operation === 'health') await client.send(encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({ method: 'GET', path: '/health', query: '', headers: {} })));
      if (operation === 'redeem') await client.send(encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({ method: 'POST', path: '/api/client-auth/pairing/redeem', query: '', headers: {} })));
      if (operation === 'stream') await client.send(encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({ method: 'GET', path: '/api/slow', query: '', headers: { authorization: 'Bearer valid-client' } })));
      if (operation === 'ws') {
        const token = await fx.mintUrlToken();
        await client.send(encodeTunnelFrame(TunnelFrameType.WsOpen, 1, encodeJsonPayload({ path: '/api/global/event/ws', query: `oc_url_token=${encodeURIComponent(token)}`, protocols: [] })));
      }
      if (operation === 'body') await client.send(encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({ method: 'POST', path: '/api/slow', query: '', headers: { authorization: 'Bearer valid-client' } })));
      if (operation === 'redeem' || operation === 'body') {
        await client.send(encodeTunnelFrame(TunnelFrameType.HttpBody, 1, new Uint8Array([1])));
      }
      await waitFor(() => fx.received.some((request) => request.url === (operation === 'health' ? '/health' : operation === 'redeem' ? '/api/client-auth/pairing/redeem' : '/api/slow')) || operation === 'ws');
      client.ws.terminate();
      await waitFor(() => fx.service.getCounts().total === 0);
    }
  });

  it('enforces HTTP, nested WS, fragment, and open-rate limit + 1 with cleanup', async () => {
    const cases = [
      { limits: { maxStreams: 1 }, frames: [
        [TunnelFrameType.HttpRequest, 1, { method: 'POST', path: '/api/slow', query: '', headers: { authorization: 'Bearer valid-client' } }],
        [TunnelFrameType.HttpRequest, 3, { method: 'POST', path: '/api/slow', query: '', headers: { authorization: 'Bearer valid-client' } }],
      ] },
      { limits: { maxWebSockets: 1 }, ws: true },
      { limits: { maxIncompleteFragments: 1 }, fragments: true },
      { limits: { maxStreamOpens: 1, streamOpenWindowMs: 60_000 }, opens: true },
    ];
    for (const testCase of cases) {
      const fx = await startFixture({ limits: testCase.limits });
      const client = await connectEncrypted(fx);
      await client.promote();
      if (testCase.frames) for (const [type, id, payload] of testCase.frames) await client.send(encodeTunnelFrame(type, id, encodeJsonPayload(payload)));
      if (testCase.ws) {
        const token = await fx.mintUrlToken();
        for (const id of [1, 3]) await client.send(encodeTunnelFrame(TunnelFrameType.WsOpen, id, encodeJsonPayload({ path: '/api/global/event/ws', query: `oc_url_token=${token}`, protocols: [] })));
      }
      if (testCase.fragments) {
        await client.send(encodeTunnelFrame(TunnelFrameType.WsText, 1, new Uint8Array([1]), true));
        await client.send(encodeTunnelFrame(TunnelFrameType.WsBinary, 3, new Uint8Array([2]), true));
      }
      if (testCase.opens) {
        await client.send(encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({ method: 'POST', path: '/api/slow', query: '', headers: { authorization: 'Bearer valid-client' } })));
        await client.send(encodeTunnelFrame(TunnelFrameType.HttpRequest, 3, encodeJsonPayload({ method: 'GET', path: '/api/slow', query: '', headers: { authorization: 'Bearer valid-client' } })));
      }
      await new Promise((resolve) => client.ws.once('close', resolve));
      expect(fx.service.getCounts().total).toBe(0);
    }
  });

  it('preserves reconnect reserve under pre-auth saturation and enforces authenticated capacity', async () => {
    const fx = await startFixture({ authDeadlineMs: 5_000, limits: { maxPreauthenticated: 1, reconnectReserve: 1, maxAuthenticated: 1, reconnectDeadlineMs: 1_000 } });
    const attacker = await connectEncrypted(fx);
    expect(fx.service.getCounts()).toMatchObject({ preauthenticated: 1, reserved: 0 });
    const reconnect = await connectEncrypted(fx);
    expect(fx.service.getCounts()).toMatchObject({ preauthenticated: 2, reserved: 1 });
    await reconnect.request(1, 'GET', '/health');
    await reconnect.promote();
    expect(fx.service.getCounts()).toMatchObject({ authenticated: 1, preauthenticated: 1, reserved: 0 });
    const excess = await connectEncrypted(fx);
    await excess.send(encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({ method: 'GET', path: '/auth/session', query: '', headers: { authorization: 'Bearer valid-client' } })));
    await excess.send(encodeTunnelFrame(TunnelFrameType.StreamEnd, 1, new Uint8Array()));
    await new Promise((resolve) => excess.ws.once('close', resolve));
    expect(fx.service.getCounts().authenticated).toBe(1);
    attacker.ws.terminate(); reconnect.ws.terminate();
  });

  it('does not promote a stale aborted auth generation after stream ID reuse', async () => {
    const fx = await startFixture({ authResponseDelayMs: 40, authDeadlineMs: 500 });
    const client = await connectEncrypted(fx);
    await client.send(encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({ method: 'GET', path: '/auth/session', query: '', headers: { authorization: 'Bearer valid-client' } })));
    await waitFor(() => fx.received.some((request) => request.url === '/auth/session'));
    await client.send(encodeTunnelFrame(TunnelFrameType.StreamAbort, 1, new Uint8Array()));
    await client.send(encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({ method: 'GET', path: '/health', query: '', headers: {} })));
    await client.send(encodeTunnelFrame(TunnelFrameType.StreamEnd, 1, new Uint8Array()));
    await waitFor(() => fx.lifecycle.authResponses === 1);
    expect(fx.service.getCounts()).toMatchObject({ authenticated: 0, preauthenticated: 1 });
    client.ws.terminate();
  });

  it('cleans pairing generation bookkeeping when its stream aborts', async () => {
    const logs = [];
    const fx = await startFixture({ logs, rejectPairing: true, pairingResponseDelayMs: 40 });
    const client = await connectEncrypted(fx);
    await client.send(encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({ method: 'POST', path: '/api/client-auth/pairing/redeem', query: '', headers: {} })));
    await client.send(encodeTunnelFrame(TunnelFrameType.HttpBody, 1, new Uint8Array([1])));
    await waitFor(() => fx.received.some((request) => request.url === '/api/client-auth/pairing/redeem'));
    await client.send(encodeTunnelFrame(TunnelFrameType.StreamAbort, 1, new Uint8Array()));
    await waitFor(() => fx.lifecycle.pairingResponses === 1);
    expect(logs.map((entry) => entry[1].reason)).not.toContain('pairing-rejected');
    client.ws.terminate();
  });

  it('switches from the preauth fragment budget to the configured authenticated budget', async () => {
    const fx = await startFixture({ limits: { maxPreauthFragmentBytes: 3, maxAuthenticatedFragmentBytes: 8 } });
    const client = await connectEncrypted(fx);
    await client.promote();
    const token = await fx.mintUrlToken();
    await client.send(encodeTunnelFrame(TunnelFrameType.WsOpen, 1, encodeJsonPayload({ path: '/api/global/event/ws', query: `oc_url_token=${token}`, protocols: [] })));
    await waitFor(() => client.frames.some((frame) => frame.streamId === 1 && frame.frameType === TunnelFrameType.WsOpened));
    await client.send(encodeTunnelFrame(TunnelFrameType.WsBinary, 1, new Uint8Array(6), true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    client.ws.terminate();
  });

  it('enforces per-source preauth caps by evicting the oldest same-source probation', async () => {
    const fx = await startFixture({ authDeadlineMs: 5_000, limits: { maxPreauthenticated: 3, maxPreauthenticatedPerSource: 1 } });
    const oldest = await connectEncrypted(fx);
    const closed = new Promise((resolve) => oldest.ws.once('close', resolve));
    const newest = await connectEncrypted(fx);
    await closed;
    expect(fx.service.getCounts()).toMatchObject({ preauthenticated: 1, reserved: 0 });
    newest.ws.terminate();
  });

  it('turns over full hostile reserve occupancy so prompt health and bearer can progress', async () => {
    const fx = await startFixture({ authDeadlineMs: 5_000, limits: { maxPreauthenticated: 1, reconnectReserve: 1, maxReservedPerSource: 1, reconnectDeadlineMs: 1_000 } });
    const ordinary = await connectEncrypted(fx);
    const slowReserve = await connectEncrypted(fx);
    const evicted = new Promise((resolve) => slowReserve.ws.once('close', resolve));
    const prompt = await connectEncrypted(fx);
    await evicted;
    expect((await prompt.request(1, 'GET', '/health')).status).toBe(200);
    expect((await prompt.request(3, 'GET', '/auth/session', { authorization: 'Bearer valid-client' })).status).toBe(200);
    expect(fx.service.getCounts()).toMatchObject({ authenticated: 1, preauthenticated: 1, reserved: 0 });
    ordinary.ws.terminate(); prompt.ws.terminate();
  });

  it('survives repeated saturation, fragment churn, and disconnect cycles without accounting drift', async () => {
    const fx = await startFixture({ limits: { maxPreauthenticated: 1, reconnectReserve: 1, maxIncompleteFragments: 1, reconnectDeadlineMs: 100 } });
    for (let cycle = 0; cycle < 10; cycle += 1) {
      const first = await connectEncrypted(fx);
      const second = await connectEncrypted(fx);
      await second.send(encodeTunnelFrame(TunnelFrameType.WsText, 1, new Uint8Array([1]), true));
      await second.send(encodeTunnelFrame(TunnelFrameType.WsBinary, 3, new Uint8Array([2]), true));
      first.ws.terminate();
      await waitFor(() => fx.service.getCounts().total === 0);
    }
    expect(fx.service.getCounts()).toEqual({ pending: 0, preauthenticated: 0, authenticated: 0, reserved: 0, total: 0 });
  });
});
