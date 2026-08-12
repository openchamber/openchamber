import { describe, test, expect } from 'bun:test';
import http from 'node:http';

import { createTunnelHost } from './tunnel-host.js';
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

const createHarness = async () => {
  const loopback = await startLoopback();
  const sentFrames = [];
  const host = createTunnelHost({
    connectionId: 'conn-test',
    getLocalPort: () => loopback.port,
    sendFrame: async (frame) => {
      sentFrames.push(decodeTunnelFrame(frame));
    },
    getBufferedAmount: () => 0,
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
