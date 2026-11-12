import { afterAll, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { WebSocket } from 'ws';

import { attachRealtimeProxy, buildRealtimeProxyWsUrl } from './realtime-proxy.js';
import { createRequestSecurityRuntime } from './security/request-security.js';
import { createTerminalRuntime } from './terminal/runtime.js';
import { readTerminalWsControlFrame } from './terminal/terminal-ws-protocol.js';

const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-proxy-terminal-'));
process.env.OPENCHAMBER_DATA_DIR = dataDir;
const { createUiAuth } = await import('./ui-auth/ui-auth.js');

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
};

const login = async (origin, password) => {
  const response = await fetch(`${origin}/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const minted = await fetch(`${origin}/auth/url-token`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}',
  });
  expect(minted.status).toBe(200);
  const { token } = await minted.json();
  expect(token).toBeTruthy();
  return token;
};

const connect = (url, origin = 'openchamber-ui://app') => new Promise((resolve, reject) => {
  const socket = new WebSocket(url, { origin });
  let hello = null;
  let status = null;
  const timeout = setTimeout(() => {
    socket.terminate();
    reject(new Error('Timed out waiting for terminal handshake'));
  }, 3000);
  socket.on('upgrade', (response) => { status = response.statusCode; });
  socket.on('unexpected-response', (_request, response) => {
    status = response.statusCode;
    response.resume();
    socket.terminate();
  });
  socket.on('message', (raw) => {
    hello = readTerminalWsControlFrame(raw);
    socket.close();
  });
  socket.on('error', () => {});
  socket.on('close', (code) => {
    clearTimeout(timeout);
    resolve({ hello, status, code });
  });
});

it('connects through the desktop proxy to an authenticated terminal without weakening either gate', async () => {
  const password = crypto.randomBytes(24).toString('hex');
  const remoteAuth = createUiAuth({ password });
  const localAuth = createUiAuth({ password });
  const remoteApp = express();
  const localApp = express();
  for (const [app, auth] of [[remoteApp, remoteAuth], [localApp, localAuth]]) {
    app.use(express.json());
    app.post('/auth/session', auth.handleSessionCreate);
    app.post('/auth/url-token', auth.handleUrlAuthToken);
  }
  const remote = http.createServer(remoteApp);
  const local = http.createServer(localApp);
  const security = createRequestSecurityRuntime({ readSettingsFromDiskMigrated: async () => ({}) });
  const received = [];
  remote.on('upgrade', (req) => {
    received.push({ origin: req.headers.origin, custom: req.headers['x-proxy-test'] });
  });
  const rejected = [];
  const terminal = createTerminalRuntime({
    app: remoteApp, server: remote, fs, path, uiAuthController: remoteAuth,
    buildAugmentedPath: () => process.env.PATH || '',
    searchPathFor: () => null,
    isExecutable: () => false,
    isRequestOriginAllowed: security.isRequestOriginAllowed,
    rejectWebSocketUpgrade: (socket, status, reason) => {
      rejected.push(status);
      security.rejectWebSocketUpgrade(socket, status, reason);
    },
    TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: 30_000,
  });
  let proxy;
  try {
    const remoteOrigin = await listen(remote);
    const localOrigin = await listen(local);
    proxy = attachRealtimeProxy({
      app: localApp, server: local,
      getDesktopRuntimeConfig: () => ({
        apiBaseUrl: remoteOrigin,
        requestHeaders: { 'X-Proxy-Test': 'present' },
      }),
      getUiAuthController: () => localAuth,
      isRequestOriginAllowed: security.isRequestOriginAllowed,
    });
    const remoteToken = await login(remoteOrigin, password);
    const localToken = await login(localOrigin, password);
    const target = new URL('/api/terminal/ws', remoteOrigin);
    target.protocol = 'ws:';
    target.searchParams.set('oc_url_token', remoteToken);
    const proxied = new URL(buildRealtimeProxyWsUrl(localOrigin, target.toString()));
    proxied.searchParams.set('oc_url_token', localToken);

    expect((await connect(target.toString())).hello).toEqual({ t: 'hello', v: 3 });
    expect((await connect(proxied.toString())).hello).toEqual({ t: 'hello', v: 3 });
    expect(received.at(-1)).toEqual({ origin: remoteOrigin, custom: 'present' });
    expect(rejected).toEqual([]);

    const beforeRejectedLocal = received.length;
    expect((await connect(proxied.toString(), 'https://untrusted.example')).status).toBe(403);
    const unauthenticatedLocal = new URL(proxied);
    unauthenticatedLocal.searchParams.delete('oc_url_token');
    expect((await connect(unauthenticatedLocal.toString())).status).toBe(401);
    expect(received).toHaveLength(beforeRejectedLocal);

    target.searchParams.delete('oc_url_token');
    proxied.searchParams.set('url', target.toString());
    expect((await connect(proxied.toString())).hello).toBeNull();
    expect(rejected).toEqual([401]);
  } finally {
    proxy?.stop();
    await terminal.shutdown();
    remoteAuth.dispose();
    localAuth.dispose();
    await Promise.all([remote, local].map((server) => new Promise((resolve) => server.close(resolve))));
  }
});
