import { afterEach, describe, expect, it } from 'bun:test';
import express from 'express';
import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';

import { REALTIME_PROXY_UPSTREAM_WS_MAX_PAYLOAD_BYTES, REALTIME_PROXY_WS_MAX_PAYLOAD_BYTES, attachRealtimeProxy, buildRealtimeProxySseUrl, buildRealtimeProxyWsUrl } from './realtime-proxy.js';
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

const startProxyServer = async ({ apiBaseUrl, authToken = 'ui-token', originAllowed = true, proxyOptions = {} } = {}) => {
  const app = express();
  const server = http.createServer(app);
  const runtime = attachRealtimeProxy({
    app,
    server,
    ...proxyOptions,
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

  it('rejects an SSE proxy request with a repeated url parameter instead of dialing the first (#2324)', async () => {
    const upstream = await startSseUpstream();
    const { origin, runtime } = await startProxyServer({ apiBaseUrl: upstream.origin });

    try {
      const target = encodeURIComponent(upstream.origin + '/api/global/event');
      const response = await fetch(origin + '/api/openchamber/realtime-proxy/sse?url=' + target + '&url=' + target, {
        headers: { Origin: 'openchamber-ui://app' },
      });

      expect(response.status).toBe(404);
      expect(upstream.requests).toHaveLength(0);
    } finally {
      runtime.stop();
    }
  });

  it('closes a WebSocket proxy upgrade with a repeated url parameter instead of dialing the first (#2324)', async () => {
    let upstreamConnections = 0;
    const upstreamServer = http.createServer();
    const upstreamWs = new WebSocketServer({ server: upstreamServer });
    upstreamWs.on('connection', (socket) => {
      upstreamConnections += 1;
      socket.close();
    });
    const upstreamOrigin = await listen(upstreamServer);
    const { origin, runtime } = await startProxyServer({ apiBaseUrl: upstreamOrigin });

    try {
      const target = encodeURIComponent(upstreamOrigin.replace(/^http:/, 'ws:') + '/api/global/event/ws');
      const client = new WebSocket(origin.replace(/^http:/, 'ws:') + '/api/openchamber/realtime-proxy/ws?url=' + target + '&url=' + target, {
        headers: { Origin: 'openchamber-ui://app' },
      });
      const closedCode = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 2_000);
        client.once('close', (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });

      expect(closedCode).toBe(1008);
      expect(upstreamConnections).toBe(0);
      client.close();
      upstreamWs.close();
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

  it('proxies the sockets of an isolated space by path shape, and refuses another path under the prefix', async () => {
    const seen = [];
    const upstreamServer = http.createServer();
    const upstreamWs = new WebSocketServer({ server: upstreamServer });
    upstreamWs.on('connection', (socket, request) => {
      seen.push(request.url);
      socket.send('ready');
    });
    const upstreamOrigin = await listen(upstreamServer);
    const { origin, runtime } = await startProxyServer({ apiBaseUrl: upstreamOrigin });
    const attempt = (path) => new Promise((resolve, reject) => {
      const client = new WebSocket(buildRealtimeProxyWsUrl(origin, `${upstreamOrigin.replace(/^http:/, 'ws:')}${path}`), { headers: { Origin: 'openchamber-ui://app' } });
      client.once('message', (data) => { client.close(); resolve({ message: data.toString() }); });
      client.once('close', (code) => resolve({ code }));
      client.once('error', reject);
    });

    try {
      expect(await attempt('/api/spaces/a1b2c3d4e5f6/terminal/ws')).toEqual({ message: 'ready' });
      expect(await attempt('/api/spaces/a1b2c3d4e5f6/event/ws?directory=%2Fspaces%2Fa1b2c3d4e5f6%2Frepo')).toEqual({ message: 'ready' });
      expect(await attempt('/api/spaces/a1b2c3d4e5f6/dictation/ws')).toEqual({ code: 1008 });
      expect(await attempt('/api/spaces/A1B2C3D4E5F6/terminal/ws')).toEqual({ code: 1008 });
      expect(seen).toEqual(['/api/spaces/a1b2c3d4e5f6/terminal/ws', '/api/spaces/a1b2c3d4e5f6/event/ws?directory=%2Fspaces%2Fa1b2c3d4e5f6%2Frepo']);
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

describe('realtime proxy WebSocket bounds', () => {
  // A raw TCP host for the upstream side: it can stall the handshake
  // forever, or complete it by hand and then read nothing — the two stall
  // shapes the bounds exist for. A real WebSocket server cannot be made to
  // stall either way on every runtime.
  const startRawHost = async ({ completeHandshake }) => {
    const state = { handshakes: 0, sockets: new Set() };
    const server = net.createServer((socket) => {
      state.sockets.add(socket);
      socket.on('close', () => state.sockets.delete(socket));
      let upgraded = false;
      let head = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        if (upgraded) return;
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end === -1 || !completeHandshake) return;
        const key = /sec-websocket-key:\s*(\S+)/i.exec(head.subarray(0, end).toString())?.[1];
        const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        upgraded = true;
        state.handshakes += 1;
        socket.pause();
      });
    });
    const origin = await listen(server);
    return { origin, state };
  };

  const connectClient = async (origin, target) => {
    const client = new WebSocket(buildRealtimeProxyWsUrl(origin, target), {
      headers: { Origin: 'openchamber-ui://app' },
    });
    await new Promise((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });
    return client;
  };

  const nextClose = (client) => new Promise((resolve) => client.once('close', (code) => resolve(code)));

  const destroyHostSockets = (host) => {
    for (const socket of host.state.sockets) socket.destroy();
  };

  it('closes the client when the upstream handshake never completes', async () => {
    const host = await startRawHost({ completeHandshake: false });
    const { origin, runtime } = await startProxyServer({
      apiBaseUrl: host.origin,
      proxyOptions: { handshakeTimeoutMs: 300 },
    });
    try {
      const target = `${host.origin.replace(/^http:/, 'ws:')}/api/global/event/ws`;
      const startedAt = Date.now();
      const client = await connectClient(origin, target);
      const code = await nextClose(client);
      expect(code).toBe(1011);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      runtime.stop();
      destroyHostSockets(host);
    }
  }, 10_000);

  it('drops the pair when a client floods a stalled handshake past the pending bound', async () => {
    const host = await startRawHost({ completeHandshake: false });
    const { origin, runtime } = await startProxyServer({
      apiBaseUrl: host.origin,
      proxyOptions: { handshakeTimeoutMs: 30_000, maxPendingBytes: 64 * 1024 },
    });
    try {
      const target = `${host.origin.replace(/^http:/, 'ws:')}/api/global/event/ws`;
      const client = await connectClient(origin, target);
      const closed = nextClose(client);
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      client.send(chunk);
      client.send(chunk);
      expect(await closed).toBe(1013);
      // The upstream attempt was terminated, not left holding the queue.
      const deadline = Date.now() + 3_000;
      while (host.state.sockets.size > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(host.state.sockets.size).toBe(0);
    } finally {
      runtime.stop();
      destroyHostSockets(host);
    }
  }, 10_000);

  const startRecordingUpstream = async () => {
    const received = [];
    const upstreamServer = http.createServer();
    const upstreamWs = new WebSocketServer({ server: upstreamServer });
    upstreamWs.on('connection', (socket) => {
      socket.on('message', (data, isBinary) => {
        received.push(Buffer.from(data));
        socket.send(data, { binary: isBinary });
      });
    });
    const upstreamOrigin = await listen(upstreamServer);
    return { received, upstreamOrigin, upstreamWs };
  };

  it('refuses a single frame over the maxPayload cap with 1009 and forwards nothing upstream', async () => {
    const { received, upstreamOrigin, upstreamWs } = await startRecordingUpstream();
    const { origin, runtime } = await startProxyServer({ apiBaseUrl: upstreamOrigin });
    try {
      const target = `${upstreamOrigin.replace(/^http:/, 'ws:')}/api/global/event/ws`;
      const client = await connectClient(origin, target);
      const closed = nextClose(client);
      client.send(Buffer.alloc(REALTIME_PROXY_WS_MAX_PAYLOAD_BYTES + 1, 0x63));
      expect(await closed).toBe(1009);
      expect(received).toEqual([]);
      upstreamWs.close();
    } finally {
      runtime.stop();
    }
  }, 10_000);

  it('forwards a single frame at the maxPayload cap byte-identically', async () => {
    const { received, upstreamOrigin, upstreamWs } = await startRecordingUpstream();
    const { origin, runtime } = await startProxyServer({ apiBaseUrl: upstreamOrigin });
    try {
      const target = `${upstreamOrigin.replace(/^http:/, 'ws:')}/api/global/event/ws`;
      const client = await connectClient(origin, target);
      const frame = Buffer.alloc(REALTIME_PROXY_WS_MAX_PAYLOAD_BYTES, 0x64);
      const echoed = new Promise((resolve) => client.once('message', (data) => resolve(Buffer.from(data))));
      client.send(frame);
      expect(await echoed).toEqual(frame);
      expect(received).toEqual([frame]);
      client.close();
      upstreamWs.close();
    } finally {
      runtime.stop();
    }
  }, 10_000);

  const startSendingUpstream = async () => {
    const sockets = [];
    const received = [];
    const upstreamServer = http.createServer();
    const upstreamWs = new WebSocketServer({ server: upstreamServer });
    upstreamWs.on('connection', (socket) => {
      sockets.push(socket);
      socket.on('message', (data) => {
        received.push(Buffer.from(data));
      });
    });
    const upstreamOrigin = await listen(upstreamServer);
    const waitForSocket = async () => {
      const deadline = Date.now() + 3_000;
      while (sockets.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (sockets.length === 0) throw new Error('Upstream socket never connected');
      return sockets[0];
    };
    return { received, upstreamOrigin, upstreamWs, waitForSocket };
  };

  it('refuses a single upstream frame over the upstream maxPayload cap with 1009 and forwards nothing to the client', async () => {
    const { upstreamOrigin, upstreamWs, waitForSocket } = await startSendingUpstream();
    const { origin, runtime } = await startProxyServer({ apiBaseUrl: upstreamOrigin });
    try {
      const target = `${upstreamOrigin.replace(/^http:/, 'ws:')}/api/global/event/ws`;
      const client = await connectClient(origin, target);
      const upstreamSocket = await waitForSocket();
      const receivedByClient = [];
      client.on('message', (data) => receivedByClient.push(Buffer.from(data)));
      const closed = nextClose(client);
      upstreamSocket.send(Buffer.alloc(REALTIME_PROXY_UPSTREAM_WS_MAX_PAYLOAD_BYTES + 1, 0x67));
      expect(await closed).toBe(1009);
      expect(receivedByClient).toEqual([]);
      upstreamWs.close();
    } finally {
      runtime.stop();
    }
  }, 30_000);

  it('forwards a single upstream frame at the upstream maxPayload cap byte-identically', async () => {
    const { received, upstreamOrigin, upstreamWs, waitForSocket } = await startSendingUpstream();
    const { origin, runtime } = await startProxyServer({ apiBaseUrl: upstreamOrigin });
    try {
      const target = `${upstreamOrigin.replace(/^http:/, 'ws:')}/api/global/event/ws`;
      const client = await connectClient(origin, target);
      const upstreamSocket = await waitForSocket();
      const frame = Buffer.alloc(REALTIME_PROXY_UPSTREAM_WS_MAX_PAYLOAD_BYTES, 0x68);
      const delivered = new Promise((resolve) => client.once('message', (data) => resolve(Buffer.from(data))));
      upstreamSocket.send(frame);
      const deliveredFrame = await delivered;
      // Byte-identity via Buffer.equals: vitest's toEqual on two 16 MiB
      // buffers OOMs the test worker even when they are identical (#1394).
      expect(deliveredFrame.length).toBe(frame.length);
      expect(deliveredFrame.equals(frame)).toBe(true);
      // The pair survived: a small client frame still reaches upstream.
      client.send(Buffer.from('still-open'));
      const deadline = Date.now() + 3_000;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(received).toEqual([Buffer.from('still-open')]);
      client.close();
      upstreamWs.close();
    } finally {
      runtime.stop();
    }
  }, 30_000);

  it('closes the pair when the upstream stops draining after connect', async () => {
    const host = await startRawHost({ completeHandshake: true });
    const { origin, runtime } = await startProxyServer({
      apiBaseUrl: host.origin,
      proxyOptions: { maxBufferedBytes: 64 * 1024 },
    });
    try {
      const target = `${host.origin.replace(/^http:/, 'ws:')}/api/global/event/ws`;
      const client = await connectClient(origin, target);
      const closed = nextClose(client);
      const deadline = Date.now() + 3_000;
      while (host.state.handshakes === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(host.state.handshakes).toBe(1);
      const chunk = Buffer.alloc(64 * 1024, 0x62);
      let sent = 0;
      const TOTAL = 32 * 1024 * 1024;
      const timer = setInterval(() => {
        if (client.readyState !== WebSocket.OPEN || sent >= TOTAL) {
          if (sent >= TOTAL) clearInterval(timer);
          return;
        }
        sent += chunk.length;
        client.send(chunk);
      }, 5);
      const code = await closed;
      clearInterval(timer);
      expect(code).toBe(1013);
      expect(sent).toBeLessThan(TOTAL);
    } finally {
      runtime.stop();
      destroyHostSockets(host);
    }
  }, 15_000);
});
