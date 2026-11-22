import { describe, test, expect } from 'bun:test';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';

import { createTunnelHost, isAllowedRelayWebSocketPath } from './tunnel-host.js';
import { decodeTunnelFrame, encodeTunnelFrame, encodeJsonPayload, TunnelFrameType } from './tunnel-codec.js';

const startLoopback = () =>
  new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        requests.push({
          method: req.method,
          url: req.url,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      requests,
      stop: () => new Promise((r) => server.close(() => r())),
    }));
  });

const createHarness = async (hostOverrides = {}) => {
  const loopback = await startLoopback();
  const sentFrames = [];
  const host = createTunnelHost({
    connectionId: 'conn-test',
    getLocalPort: () => loopback.port,
    sendFrame: async (frame) => {
      sentFrames.push(decodeTunnelFrame(frame));
    },
    getBufferedAmount: () => 0,
    ...hostOverrides,
  });
  return { host, loopback, sentFrames };
};

const httpHead = (overrides = {}) => encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({
  method: 'POST',
  path: '/api/submit',
  query: '',
  headers: { 'content-type': 'application/json' },
  ...overrides,
}));

const waitFor = async (predicate, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
};

describe('tunnel-host HTTP body forwarding', () => {
  test('buffers tunneled body frames and forwards the complete body', async () => {
    const { host, loopback, sentFrames } = await createHarness();
    await host.handleFrame(httpHead());
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, 1, new TextEncoder().encode('alpha')));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, 1, new TextEncoder().encode('beta')));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, 1, new Uint8Array(0)));

    const received = await waitFor(() => loopback.requests.length === 1);
    expect(received).toBe(true);
    expect(loopback.requests[0].method).toBe('POST');
    expect(loopback.requests[0].body).toBe('alphabeta');
    await waitFor(() => sentFrames.some((f) => f.frameType === TunnelFrameType.StreamEnd));
    await loopback.stop();
  });

  test('body-expected request with zero delivered frames is aborted as ambiguous, not forwarded', async () => {
    const { host, loopback, sentFrames } = await createHarness();
    await host.handleFrame(httpHead({ hasBody: true }));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, 1, new Uint8Array(0)));

    const aborted = await waitFor(() => sentFrames.some((f) => f.frameType === TunnelFrameType.StreamAbort));
    expect(aborted).toBe(true);
    // Loopback must never have seen a request with a lost body.
    expect(loopback.requests.length).toBe(0);
    await loopback.stop();
  });

  test('bodyless request (hasBody absent, legacy client) still forwards empty', async () => {
    const { host, loopback } = await createHarness();
    await host.handleFrame(httpHead());
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, 1, new Uint8Array(0)));

    const received = await waitFor(() => loopback.requests.length === 1);
    expect(received).toBe(true);
    expect(loopback.requests[0].body).toBe('');
    await loopback.stop();
  });

  test('aborts a buffered body that never completes within the delivery deadline', async () => {
    const { host, loopback, sentFrames } = await createHarness({ bodyDeliveryTimeoutMs: 50 });
    await host.handleFrame(httpHead({ hasBody: true }));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, 1, new TextEncoder().encode('partial')));
    // No StreamEnd — the tunnel stalled mid-body.

    const aborted = await waitFor(() => sentFrames.some((f) => f.frameType === TunnelFrameType.StreamAbort));
    expect(aborted).toBe(true);
    expect(loopback.requests.length).toBe(0);
    // A late StreamEnd for the dropped stream must not trigger a second abort
    // or forward the stale body.
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, 1, new Uint8Array(0)));
    await new Promise((r) => setTimeout(r, 50));
    expect(sentFrames.filter((f) => f.frameType === TunnelFrameType.StreamAbort).length).toBe(1);
    expect(loopback.requests.length).toBe(0);
    await loopback.stop();
  });

  test('forwards an empty body when the client delivered an explicit empty frame', async () => {
    const { host, loopback } = await createHarness();
    await host.handleFrame(httpHead({ hasBody: true }));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, 1, new Uint8Array(0)));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, 1, new Uint8Array(0)));

    const received = await waitFor(() => loopback.requests.length === 1);
    expect(received).toBe(true);
    expect(loopback.requests[0].body).toBe('');
    await loopback.stop();
  });

  test('GET forwards immediately with no body wait', async () => {
    const { host, loopback } = await createHarness();
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({
      method: 'GET',
      path: '/api/health',
      query: '',
      headers: {},
    })));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, 1, new Uint8Array(0)));

    const received = await waitFor(() => loopback.requests.length === 1);
    expect(received).toBe(true);
    expect(loopback.requests[0].method).toBe('GET');
    await loopback.stop();
  });
});

describe('tunnel-host response compression', () => {
  const LARGE_JSON = JSON.stringify({ items: Array.from({ length: 400 }, (_, i) => ({ id: i, text: 'tool output line '.repeat(4) })) });

  // Serves each path with its own content type, and records the
  // accept-encoding the loopback request carried.
  const startTypedLoopback = () =>
    new Promise((resolve) => {
      const acceptEncodings = [];
      const server = http.createServer((req, res) => {
        acceptEncodings.push(req.headers['accept-encoding']);
        if (req.url === '/api/event') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(`data: ${LARGE_JSON}\n\n`);
          return;
        }
        if (req.url === '/api/small') {
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': '11' });
          res.end('{"ok":true}');
          return;
        }
        if (req.url === '/api/binary') {
          res.writeHead(200, { 'content-type': 'image/png' });
          res.end(Buffer.alloc(4096, 7));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(LARGE_JSON);
      });
      server.listen(0, '127.0.0.1', () => resolve({
        port: server.address().port,
        acceptEncodings,
        stop: () => new Promise((r) => server.close(() => r())),
      }));
    });

  const fetchThroughHost = async (path, headers) => {
    const loopback = await startTypedLoopback();
    const sentFrames = [];
    const host = createTunnelHost({
      connectionId: 'conn-test',
      getLocalPort: () => loopback.port,
      sendFrame: async (frame) => { sentFrames.push(decodeTunnelFrame(frame)); },
      getBufferedAmount: () => 0,
    });
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({
      method: 'GET', path, query: '', headers,
    })));
    await waitFor(() => sentFrames.some((f) => f.frameType === TunnelFrameType.StreamEnd));
    await loopback.stop();
    const headFrame = sentFrames.find((f) => f.frameType === TunnelFrameType.HttpResponse);
    const head = JSON.parse(new TextDecoder().decode(headFrame.payload));
    const body = Buffer.concat(sentFrames.filter((f) => f.frameType === TunnelFrameType.HttpBody).map((f) => Buffer.from(f.payload)));
    return { head, body, acceptEncoding: loopback.acceptEncodings[0] };
  };

  const accepting = { 'X-OpenChamber-Tunnel-Accept-Encoding': 'gzip' };

  test('gzips a JSON body for a client that accepts it', async () => {
    const { head, body, acceptEncoding } = await fetchThroughHost('/api/session/s/message', accepting);
    expect(head.headers['x-openchamber-tunnel-content-encoding']).toBe('gzip');
    expect(body.length).toBeLessThan(LARGE_JSON.length / 4);
    expect(gunzipSync(body).toString('utf8')).toBe(LARGE_JSON);
    // Compressed once, here: the loopback server is not asked to gzip, and the
    // client's own marker never reaches it.
    expect(acceptEncoding).toBe('identity');
  });

  test('sends plain bodies to a client that does not ask', async () => {
    const { head, body, acceptEncoding } = await fetchThroughHost('/api/session/s/message', {});
    expect(head.headers['x-openchamber-tunnel-content-encoding']).toBeUndefined();
    expect(body.toString('utf8')).toBe(LARGE_JSON);
    expect(acceptEncoding).toBe('identity');
  });

  test('never compresses event streams, small bodies or binary types', async () => {
    for (const path of ['/api/event', '/api/small', '/api/binary']) {
      const { head } = await fetchThroughHost(path, accepting);
      expect(head.headers['x-openchamber-tunnel-content-encoding']).toBeUndefined();
    }
  });
});

describe('tunnel-host fragment assembly guards (#1024)', () => {
  test('does not assemble fragments for never-opened streams', async () => {
    const { host, loopback, sentFrames } = await createHarness();
    try {
      // 300 fragmented frames on 300 distinct never-opened streams, ~18 MiB
      // total: if the host fed them to the assembler, the per-key/aggregate
      // bounds would throw and the partials would be retained.
      const chunk = new Uint8Array(60 * 1024);
      for (let streamId = 1; streamId <= 600; streamId += 2) {
        await host.handleFrame(encodeTunnelFrame(TunnelFrameType.WsText, streamId, chunk, true));
      }
      expect(sentFrames).toEqual([]);
    } finally {
      await loopback.stop();
    }
  });
});

describe('relay host WebSocket allowlist', () => {
  test('allows only the exact dev-server tunnel path', () => {
    expect(isAllowedRelayWebSocketPath('/api/dev-tunnel')).toBe(true);
    expect(isAllowedRelayWebSocketPath('/api/dev-tunnel/')).toBe(false);
    expect(isAllowedRelayWebSocketPath('/api/database/ws')).toBe(false);
  });

  test('allows the sockets of an isolated space by path shape only', () => {
    for (const socket of ['terminal/ws', 'dev-tunnel', 'event/ws', 'global/event/ws']) {
      expect(isAllowedRelayWebSocketPath(`/api/spaces/a1b2c3d4e5f6/${socket}`)).toBe(true);
    }
    expect(isAllowedRelayWebSocketPath('/api/spaces/a1b2c3d4e5f6/dictation/ws')).toBe(false);
    expect(isAllowedRelayWebSocketPath('/api/spaces/A1B2C3D4E5F6/terminal/ws')).toBe(false);
    expect(isAllowedRelayWebSocketPath('/api/spaces/a1b2c3d4e5f/terminal/ws')).toBe(false);
    expect(isAllowedRelayWebSocketPath('/api/spaces/a1b2c3d4e5f6/terminal/ws/x')).toBe(false);
    expect(isAllowedRelayWebSocketPath('/api/spaces//terminal/ws')).toBe(false);
  });

  test('allows an extension surface socket by path shape only', () => {
    expect(isAllowedRelayWebSocketPath('/api/guests/server-chrome/surface/ws')).toBe(true);
    expect(isAllowedRelayWebSocketPath('/api/guests/Server/surface/ws')).toBe(false);
    expect(isAllowedRelayWebSocketPath('/api/guests/server-chrome/surface/ws/x')).toBe(false);
    expect(isAllowedRelayWebSocketPath('/api/guests/server-chrome/service/request')).toBe(false);
  });
});
