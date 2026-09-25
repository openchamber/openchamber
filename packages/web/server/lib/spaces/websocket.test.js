// The WebSocket forwarder against a stand-in for the server inside a space: an HTTP server with
// the host's real UI auth in front of a terminal-like echo socket, so the login, the cookie,
// the origin check and the refusal of a bad session are the real ones.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { SpaceError } from './errors.js';
import { createSpaceDispatcher } from './dispatcher.js';
import { buildHandshake, closeFrame, createSpaceWebSocketForwarder, parseHandshakeAnswer } from './websocket.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-space-ws-test-'));
process.env.OPENCHAMBER_DATA_DIR = dataDir;

const ID = 'a1b2c3d4e5f6';
const OTHER = '0f0f0f0f0f0f';
const TOKEN = 'tok_' + 'a'.repeat(40);

const listen = (server) => new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** The stand-in inside: the host's UI auth, the terminal's upgrade rule, an echo socket that reports what it saw. */
const startInside = async () => {
  const { createUiAuth } = await import('../ui-auth/ui-auth.js');
  const auth = createUiAuth({ password: TOKEN, readSettingsFromDiskMigrated: async () => ({}) });
  const state = { logins: 0, refuseNext: 0, upgrades: [], sockets: new Set() };
  const app = express();
  app.post('/auth/session', express.json(), (req, res) => { state.logins += 1; return auth.handleSessionCreate(req, res); });
  const server = http.createServer(app);
  const wsServer = new WebSocketServer({ noServer: true });
  wsServer.on('connection', (socket, req) => {
    state.sockets.add(socket);
    socket.on('close', () => state.sockets.delete(socket));
    socket.send(JSON.stringify({ hello: req.url, headers: req.headers }));
    socket.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }));
  });
  server.on('upgrade', (req, socket, head) => {
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    const reject = (status, text) => { socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); socket.destroy(); };
    void (async () => {
      state.upgrades.push({ url: req.url, headers: req.headers });
      if (state.refuseNext > 0) { state.refuseNext -= 1; reject(401, 'Unauthorized'); return; }
      if (!await auth.ensureSessionToken(req, null)) { reject(401, 'Unauthorized'); return; }
      // The origin rule of the server: the origin's host must be the request's host.
      const origin = req.headers.origin ?? '';
      if (!origin || new URL(origin).host !== req.headers.host) { reject(403, 'Invalid origin'); return; }
      if (pathname === '/api/dev-tunnel' && searchParams.get('port') !== '3000') { reject(403, 'That port is not an available dev server'); return; }
      if (!['/api/terminal/ws', '/api/dev-tunnel', '/api/event/ws', '/api/global/event/ws'].includes(pathname)) { reject(404, 'Not Found'); return; }
      wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit('connection', ws, req));
    })();
  });
  await listen(server);
  return { server, port: server.address().port, state, stop: async () => { wsServer.close(); await close(server); } };
};

const transportTo = (inside) => {
  const calls = { connect: 0 };
  return {
    calls,
    ids: [ID],
    listSpaceIds: async function () { return this.ids; },
    connect: async function (spaceId) {
      calls.connect += 1;
      if (!this.ids.includes(spaceId)) throw new SpaceError('space_not_found', `Space ${spaceId} has no container`);
      return net.connect({ host: '127.0.0.1', port: inside().port });
    },
    readToken: async () => TOKEN,
  };
};

const logs = [];
const logger = { warn: (line) => logs.push(line) };

/** The host: a bare HTTP server whose only upgrade handler is the forwarder's. */
const startHost = async (forwarder) => {
  const server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  server.on('upgrade', forwarder.upgradeHandler);
  await listen(server);
  return { server, port: server.address().port, url: (suffix) => `ws://127.0.0.1:${server.address().port}${suffix}`, stop: () => close(server) };
};

/** Opens a socket and resolves the first message, or the HTTP refusal as `{ status, body }`. */
const open = (url, options = {}) => new Promise((resolve, reject) => {
  const socket = new WebSocket(url, { ...options, headers: { origin: 'http://app.test', ...(options.headers ?? {}) } });
  socket.on('unexpected-response', (_request, response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
  });
  socket.on('error', reject);
  socket.once('message', (data) => resolve({ socket, first: JSON.parse(data.toString('utf8')) }));
});

const until = async (check, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await sleep(25);
  return check();
};

const waitForClose = (socket) => new Promise((resolve) => { socket.on('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') })); });

describe('the handshake pieces', () => {
  it('builds the request inside with the space session, the loopback origin and the client\'s socket headers, without the user\'s credentials', () => {
    const request = buildHandshake({
      innerPath: '/api/terminal/ws',
      search: '?a=1',
      requestHeaders: { host: 'app.test', origin: 'http://app.test', cookie: 'oc_ui_session_3000=user', authorization: 'Bearer user', upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'abc', 'sec-websocket-version': '13', 'sec-websocket-protocol': 'p1', 'x-forwarded-for': '1.2.3.4' },
      cookie: 'oc_ui_session_27600=space',
    });
    const [line, ...rest] = request.split('\r\n');
    expect(line).toBe('GET /api/terminal/ws?a=1 HTTP/1.1');
    const headers = Object.fromEntries(rest.filter(Boolean).map((entry) => entry.split(': ')));
    expect(headers).toMatchObject({ host: '127.0.0.1:27600', origin: 'http://127.0.0.1:27600', cookie: 'oc_ui_session_27600=space', upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'abc', 'sec-websocket-version': '13', 'sec-websocket-protocol': 'p1' });
    expect(headers.authorization).toBeUndefined();
    expect(headers['x-forwarded-for']).toBeUndefined();
    expect(request.endsWith('\r\n\r\n')).toBe(true);
    expect(() => buildHandshake({ innerPath: '/api/terminal/ws', search: '', requestHeaders: { 'sec-websocket-key': 'a\r\nx-injected: 1' }, cookie: 'c' })).toThrow(/line break/);
  });

  it('parses the answer inside and keeps the bytes after its headers', () => {
    expect(parseHandshakeAnswer(Buffer.from('HTTP/1.1 101 Switching'))).toBeNull();
    const parsed = parseHandshakeAnswer(Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: xyz\r\n\r\n\x81\x01a', 'latin1'));
    expect(parsed.status).toBe(101);
    expect(parsed.headers).toEqual({ upgrade: 'websocket', 'sec-websocket-accept': 'xyz' });
    expect(parsed.rest).toEqual(Buffer.from('\x81\x01a', 'latin1'));
    expect(() => parseHandshakeAnswer(Buffer.from('hello\r\n\r\n'))).toThrow(/not HTTP/);
  });

  it('writes a close frame as the protocol has it', () => {
    const frame = closeFrame(1011, 'space_unreachable');
    expect(frame[0]).toBe(0x88);
    expect(frame[1]).toBe(2 + 'space_unreachable'.length);
    expect(frame.readUInt16BE(2)).toBe(1011);
    expect(frame.subarray(4).toString('utf8')).toBe('space_unreachable');
    expect(closeFrame(1000, 'x'.repeat(200))[1]).toBe(125);
  });
});

describe('the WebSocket forwarder', () => {
  let inside;
  let host;
  let transport;
  let dispatcher;
  let forwarder;

  const start = async ({ uiAuthController = { enabled: false }, isRequestOriginAllowed = async (req) => req.headers.origin === 'http://app.test', maxSocketsPerSpace } = {}) => {
    inside = await startInside();
    transport = transportTo(() => inside);
    dispatcher = createSpaceDispatcher({ transport, logger });
    forwarder = createSpaceWebSocketForwarder({ dispatcher, connect: (spaceId) => transport.connect(spaceId), uiAuthController, isRequestOriginAllowed, logger, maxSocketsPerSpace });
    host = await startHost(forwarder);
  };

  afterEach(async () => {
    forwarder?.close();
    dispatcher?.close();
    await host?.stop();
    await inside?.stop();
    logs.length = 0;
  });

  afterAll(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

  it('forwards the terminal socket with the user\'s credentials removed, the space session added and the loopback origin', async () => {
    await start();
    const { socket, first } = await open(host.url(`/api/spaces/${ID}/terminal/ws?a=1&oc_url_token=secret-url`), { headers: { cookie: 'oc_ui_session_3000=user-cookie', authorization: 'Bearer user-bearer', 'x-custom': 'kept' } });
    expect(first.hello).toBe('/api/terminal/ws?a=1');
    expect(first.headers.cookie).toMatch(/^oc_ui_session_27600=[^;]+$/);
    expect(first.headers.cookie).not.toContain('user-cookie');
    expect(first.headers.authorization).toBeUndefined();
    expect(first.headers.origin).toBe('http://127.0.0.1:27600');
    expect(first.headers.host).toBe('127.0.0.1:27600');
    expect(first.headers['x-custom']).toBe('kept');
    expect(JSON.stringify(inside.state.upgrades)).not.toContain('secret-url');

    socket.send('ping');
    const echoed = await new Promise((resolve) => socket.once('message', (data) => resolve(data.toString('utf8'))));
    expect(echoed).toBe('ping');
    expect(inside.state.logins).toBe(1);
    expect(transport.calls.connect).toBe(2);
    socket.close();
    expect(await until(() => inside.state.sockets.size === 0)).toBe(true);
    expect(await until(() => forwarder.openSocketCount(ID) === 0)).toBe(true);
  });

  it('carries large frames whole in both directions', async () => {
    await start();
    const { socket } = await open(host.url(`/api/spaces/${ID}/event/ws?directory=${encodeURIComponent(`/spaces/${ID}/repo`)}`));
    const payload = crypto.randomBytes(4 * 1024 * 1024);
    socket.send(payload);
    const echoed = await new Promise((resolve) => socket.once('message', (data) => resolve(data)));
    expect(crypto.createHash('sha256').update(echoed).digest('hex')).toBe(crypto.createHash('sha256').update(payload).digest('hex'));
    socket.close();
  });

  it('refuses before the upgrade with a stable code: unknown space, host-only route, unknown socket, a directory outside the space', async () => {
    await start();
    const cases = [
      [`/api/spaces/${OTHER}/terminal/ws`, 404, 'space_not_found'],
      ['/api/spaces/not-an-id/terminal/ws', 404, 'space_not_found'],
      [`/api/spaces/${ID}/dictation/ws`, 403, 'host_only_route'],
      [`/api/spaces/${ID}/preview/proxy/3000/ws`, 403, 'refused_across_boundary'],
      [`/api/spaces/${ID}/guests/server-chrome/surface/ws`, 403, 'host_only_route'],
      [`/api/spaces/${ID}/other/ws`, 404, 'space_socket_unknown'],
      [`/api/spaces/${ID}/event/ws?directory=/home/me`, 400, 'directory_outside_space'],
      [`/api/spaces/${ID}/event/ws?directory=/spaces/${OTHER}/repo`, 400, 'directory_outside_space'],
    ];
    for (const [suffix, status, code] of cases) {
      const answer = await open(host.url(suffix));
      expect(answer.status, suffix).toBe(status);
      expect(answer.body, suffix).toMatchObject({ code });
    }
    expect(inside.state.upgrades).toHaveLength(0);
    expect(transport.calls.connect).toBe(0);
  });

  it('answers the place\'s refusal and the space\'s own refusal with their codes', async () => {
    await start();
    const stoppedConnect = transport.connect;
    transport.connect = async () => { throw new SpaceError('space_not_running', `Space ${ID} is stopped`); };
    const stopped = await open(host.url(`/api/spaces/${ID}/terminal/ws`));
    expect(stopped.status).toBe(503);
    expect(stopped.body).toMatchObject({ code: 'space_not_running' });
    transport.connect = stoppedConnect;

    const refused = await open(host.url(`/api/spaces/${ID}/dev-tunnel?port=4000`));
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'space_socket_refused' });
    const accepted = await open(host.url(`/api/spaces/${ID}/dev-tunnel?port=3000`));
    expect(accepted.first.hello).toBe('/api/dev-tunnel?port=3000');
    accepted.socket.close();
  });

  it('applies the host\'s own auth and origin rules before anything reaches the space', async () => {
    const uiAuthController = {
      enabled: true,
      ensureSessionToken: async (req) => (req.headers.cookie === 'oc_ui_session_3000=user' ? 'user' : null),
      resolveAuthContext: async (req) => (req.headers.authorization === 'Bearer client' ? { type: 'client', token: 'client:d' } : req.headers.cookie === 'oc_ui_session_3000=user' ? { type: 'session', token: 'user' } : null),
    };
    await start({ uiAuthController });
    const anonymous = await open(host.url(`/api/spaces/${ID}/terminal/ws`));
    expect(anonymous.status).toBe(401);
    const badOrigin = await open(host.url(`/api/spaces/${ID}/terminal/ws`), { headers: { cookie: 'oc_ui_session_3000=user', origin: 'http://evil.test' } });
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.body).toMatchObject({ code: 'invalid_origin' });
    expect(inside.state.upgrades).toHaveLength(0);
    const user = await open(host.url(`/api/spaces/${ID}/terminal/ws`), { headers: { cookie: 'oc_ui_session_3000=user' } });
    expect(user.first.hello).toBe('/api/terminal/ws');
    user.socket.close();

    // The dev tunnel also takes a client with its own token and no origin, as the host's does.
    const client = await new Promise((resolve, reject) => {
      const socket = new WebSocket(host.url(`/api/spaces/${ID}/dev-tunnel?port=3000`), { headers: { authorization: 'Bearer client' } });
      socket.on('error', reject);
      socket.on('unexpected-response', (_request, response) => resolve({ status: response.statusCode }));
      socket.once('message', (data) => resolve({ socket, first: JSON.parse(data.toString('utf8')) }));
    });
    expect(client.first.hello).toBe('/api/dev-tunnel?port=3000');
    expect(client.first.headers.authorization).toBeUndefined();
    client.socket.close();
    const sessionNoOrigin = await new Promise((resolve, reject) => {
      const socket = new WebSocket(host.url(`/api/spaces/${ID}/dev-tunnel?port=3000`), { headers: { cookie: 'oc_ui_session_3000=user' } });
      socket.on('error', reject);
      socket.on('unexpected-response', (_request, response) => resolve({ status: response.statusCode }));
    });
    expect(sessionNoOrigin.status).toBe(403);
  });

  it('renews the session once when the server inside refuses it, and opens the socket on the fresh one', async () => {
    await start();
    (await open(host.url(`/api/spaces/${ID}/terminal/ws`))).socket.close();
    inside.state.refuseNext = 1;
    const { socket, first } = await open(host.url(`/api/spaces/${ID}/terminal/ws`));
    expect(first.hello).toBe('/api/terminal/ws');
    expect(inside.state.logins).toBe(2);
    socket.close();
  });

  it('closes the client with a code when the stream inside dies, and kills the stream when the client leaves', async () => {
    await start();
    const { socket } = await open(host.url(`/api/spaces/${ID}/terminal/ws`));
    const closed = waitForClose(socket);
    // The server inside drops the socket, as it does when the space stops.
    for (const insideSocket of inside.state.sockets) insideSocket.terminate();
    expect(await closed).toEqual({ code: 1012, reason: 'space_closed' });
    expect(await until(() => forwarder.openSocketCount(ID) === 0)).toBe(true);

    const second = await open(host.url(`/api/spaces/${ID}/terminal/ws`));
    expect(forwarder.openSocketCount(ID)).toBe(1);
    second.socket.terminate();
    expect(await until(() => inside.state.sockets.size === 0)).toBe(true);
    expect(await until(() => forwarder.openSocketCount(ID) === 0)).toBe(true);
  });

  it('counts a handshake under way against the cap, and gives the slot back when the client leaves during it', async () => {
    await start({ maxSocketsPerSpace: 2 });
    // The session inside exists already; what hangs below is the upgrade, not the login.
    (await open(host.url(`/api/spaces/${ID}/terminal/ws`))).socket.close();
    expect(await until(() => forwarder.openSocketCount(ID) === 0)).toBe(true);
    // A stand-in that accepts the stream and never answers the upgrade.
    // It reads, so it notices when the host lets go of a stream.
    const silent = net.createServer((connection) => { connection.on('error', () => {}); connection.resume(); });
    await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const held = new Set();
    silent.on('connection', (connection) => { held.add(connection); connection.on('close', () => held.delete(connection)); });
    transport.connect = async () => net.connect({ host: '127.0.0.1', port: silent.address().port });
    const pending = [0, 1].map(() => {
      const socket = new WebSocket(host.url(`/api/spaces/${ID}/terminal/ws`), { headers: { origin: 'http://app.test' } });
      socket.on('error', () => {});
      return socket;
    });
    expect(await until(() => held.size === 2)).toBe(true);
    expect(forwarder.openSocketCount(ID)).toBe(2);
    const third = await open(host.url(`/api/spaces/${ID}/terminal/ws`));
    expect(third.status).toBe(503);
    expect(third.body).toMatchObject({ code: 'space_socket_limit' });

    // The client leaves in the middle of the handshake: the stream inside is killed at once.
    pending[0].terminate();
    expect(await until(() => held.size === 1)).toBe(true);
    expect(await until(() => forwarder.openSocketCount(ID) === 1)).toBe(true);
    pending[1].terminate();
    expect(await until(() => held.size === 0)).toBe(true);
    await new Promise((resolve) => silent.close(resolve));
  });

  it('ends every socket when it is closed', async () => {
    await start();
    const a = await open(host.url(`/api/spaces/${ID}/terminal/ws`));
    const b = await open(host.url(`/api/spaces/${ID}/event/ws`));
    const closes = Promise.all([waitForClose(a.socket), waitForClose(b.socket)]);
    forwarder.close();
    await closes;
    expect(inside.state.sockets.size).toBe(0);
  });
});
