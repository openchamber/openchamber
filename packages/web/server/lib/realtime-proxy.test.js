import { afterEach, describe, expect, it } from 'bun:test';
import express from 'express';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

import { attachRealtimeProxy, buildRealtimeProxySseUrl, buildRealtimeProxyWsUrl } from './realtime-proxy.js';
import { createUiAuth } from './ui-auth/ui-auth.js';

const servers = [];

const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
  return `http://127.0.0.1:${address.port}`;
};

const closeServer = async (server) => {
  await new Promise((resolve) => server.close(() => resolve()));
};

const startProxyServer = async ({ apiBaseUrl, authToken = 'ui-token', originAllowed = true } = {}) => {
  const app = express();
  const server = http.createServer(app);
  const runtime = attachRealtimeProxy({
    app,
    server,
    getDesktopRuntimeConfig: () => ({
      apiBaseUrl,
      requestHeaders: { 'X-Proxy-Auth': 'secret' },
    }),
    getUiAuthController: () => ({
      ensureSessionToken: async () => authToken,
    }),
    isRequestOriginAllowed: async () => originAllowed,
  });
  const origin = await listen(server);
  return { origin, runtime };
};

const startProxyServerWithAuthController = async ({ apiBaseUrl, uiAuthController, originAllowed = true } = {}) => {
  const app = express();
  const server = http.createServer(app);
  const runtime = attachRealtimeProxy({
    app,
    server,
    getDesktopRuntimeConfig: () => ({
      apiBaseUrl,
      requestHeaders: { 'X-Proxy-Auth': 'secret' },
    }),
    getUiAuthController: () => uiAuthController,
    isRequestOriginAllowed: async () => originAllowed,
  });
  const origin = await listen(server);
  return { origin, runtime };
};

const startSseUpstream = async ({ path = '/api/global/event' } = {}) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    if (new URL(req.url || '/', 'http://127.0.0.1').pathname !== path) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    });
    res.write('data: first\n\n');
    res.end('data: second\n\n');
  });
  const origin = await listen(server);
  return { origin, requests };
};

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    await closeServer(server);
  }
});

describe('realtime proxy URL builders', () => {
  it('builds local SSE proxy URLs with target URL encoded as query data', () => {
    const url = new URL(buildRealtimeProxySseUrl('http://127.0.0.1:57123', 'https://remote.example/api/global/event?x=1'));

    expect(url.origin).toBe('http://127.0.0.1:57123');
    expect(url.pathname).toBe('/api/openchamber/realtime-proxy/sse');
    expect(url.searchParams.get('url')).toBe('https://remote.example/api/global/event?x=1');
  });

  it('builds local WebSocket proxy URLs with ws protocol', () => {
    const url = new URL(buildRealtimeProxyWsUrl('https://127.0.0.1:57123', 'wss://remote.example/api/global/event/ws'));

    expect(url.protocol).toBe('wss:');
    expect(url.host).toBe('127.0.0.1:57123');
    expect(url.pathname).toBe('/api/openchamber/realtime-proxy/ws');
    expect(url.searchParams.get('url')).toBe('wss://remote.example/api/global/event/ws');
  });
});

describe('realtime proxy', () => {
  it('streams SSE chunks and forwards safe SSE headers with configured runtime headers', async () => {
    const upstream = await startSseUpstream();
    const { origin, runtime } = await startProxyServer({ apiBaseUrl: upstream.origin });

    try {
      const response = await fetch(buildRealtimeProxySseUrl(origin, `${upstream.origin}/api/global/event`), {
        headers: {
          Accept: 'text/event-stream',
          'Last-Event-ID': 'evt-42',
          Origin: 'openchamber-ui://app',
        },
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('data: first\n\ndata: second\n\n');
      expect(upstream.requests).toHaveLength(1);
      expect(upstream.requests[0].headers.accept).toBe('text/event-stream');
      expect(upstream.requests[0].headers['last-event-id']).toBe('evt-42');
      expect(upstream.requests[0].headers['x-proxy-auth']).toBe('secret');
    } finally {
      runtime.stop();
    }
  });

  it('rejects unauthenticated SSE proxy requests', async () => {
    const upstream = await startSseUpstream();
    const { origin, runtime } = await startProxyServer({ apiBaseUrl: upstream.origin, authToken: null });

    try {
      const response = await fetch(buildRealtimeProxySseUrl(origin, `${upstream.origin}/api/global/event`), {
        headers: { Origin: 'openchamber-ui://app' },
      });

      expect(response.status).toBe(401);
      expect(upstream.requests).toHaveLength(0);
    } finally {
      runtime.stop();
    }
  });

  it('rejects SSE proxy requests from disallowed origins', async () => {
    const upstream = await startSseUpstream();
    const { origin, runtime } = await startProxyServer({ apiBaseUrl: upstream.origin, originAllowed: false });

    try {
      const response = await fetch(buildRealtimeProxySseUrl(origin, `${upstream.origin}/api/global/event`), {
        headers: { Origin: 'https://evil.example' },
      });

      expect(response.status).toBe(403);
      expect(upstream.requests).toHaveLength(0);
    } finally {
      runtime.stop();
    }
  });

  it('rejects targets outside the active runtime origin', async () => {
    const upstream = await startSseUpstream();
    const { origin, runtime } = await startProxyServer({ apiBaseUrl: 'https://different.example' });

    try {
      const response = await fetch(buildRealtimeProxySseUrl(origin, `${upstream.origin}/api/global/event`), {
        headers: { Origin: 'openchamber-ui://app' },
      });

      expect(response.status).toBe(404);
      expect(upstream.requests).toHaveLength(0);
    } finally {
      runtime.stop();
    }
  });

  it('rejects targets outside the realtime path allowlist', async () => {
    const upstream = await startSseUpstream({ path: '/api/config/settings' });
    const { origin, runtime } = await startProxyServer({ apiBaseUrl: upstream.origin });

    try {
      const response = await fetch(buildRealtimeProxySseUrl(origin, `${upstream.origin}/api/config/settings`), {
        headers: { Origin: 'openchamber-ui://app' },
      });

      expect(response.status).toBe(404);
      expect(upstream.requests).toHaveLength(0);
    } finally {
      runtime.stop();
    }
  });

  it('proxies WebSocket upgrades using query params from the raw upgrade request URL', async () => {
    let upstreamRequest = null;
    const upstreamServer = http.createServer();
    const upstreamWs = new WebSocketServer({ server: upstreamServer });
    upstreamWs.on('connection', (socket, request) => {
      upstreamRequest = request;
      socket.on('message', (data, isBinary) => {
        socket.send(isBinary ? data : `echo:${data.toString()}`, { binary: isBinary });
      });
    });
    const upstreamOrigin = await listen(upstreamServer);
    const { origin, runtime } = await startProxyServer({ apiBaseUrl: upstreamOrigin });

    try {
      const target = `${upstreamOrigin.replace(/^http:/, 'ws:')}/api/global/event/ws?lastEventId=evt-1`;
      const client = new WebSocket(buildRealtimeProxyWsUrl(origin, target), {
        headers: { Origin: 'openchamber-ui://app' },
      });
      await new Promise((resolve, reject) => {
        client.once('open', resolve);
        client.once('error', reject);
      });

      const message = await new Promise((resolve) => {
        client.once('message', (data) => resolve(data.toString()));
        client.send('ping');
      });

      expect(message).toBe('echo:ping');
      expect(upstreamRequest?.url).toBe('/api/global/event/ws?lastEventId=evt-1');
      expect(upstreamRequest?.headers['x-proxy-auth']).toBe('secret');
      client.close();
      upstreamWs.close();
    } finally {
      runtime.stop();
    }
  });

  it('allows first passwordless WebSocket proxy upgrade without an existing cookie', async () => {
    const upstreamServer = http.createServer();
    const upstreamWs = new WebSocketServer({ server: upstreamServer });
    upstreamWs.on('connection', (socket) => {
      socket.send('ready');
    });
    const upstreamOrigin = await listen(upstreamServer);
    const uiAuthController = createUiAuth({ password: '' });
    const { origin, runtime } = await startProxyServerWithAuthController({ apiBaseUrl: upstreamOrigin, uiAuthController });

    try {
      const target = `${upstreamOrigin.replace(/^http:/, 'ws:')}/api/global/event/ws`;
      const client = new WebSocket(buildRealtimeProxyWsUrl(origin, target), {
        headers: { Origin: 'openchamber-ui://app' },
      });
      const message = await new Promise((resolve, reject) => {
        client.once('message', (data) => resolve(data.toString()));
        client.once('error', reject);
      });

      expect(message).toBe('ready');
      client.close();
      upstreamWs.close();
    } finally {
      runtime.stop();
      uiAuthController.dispose?.();
    }
  });
});
