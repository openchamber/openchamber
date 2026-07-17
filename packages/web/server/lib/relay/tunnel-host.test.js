import { afterEach, describe, expect, it } from 'bun:test';
import http from 'node:http';
import { WebSocketServer } from 'ws';

import { createTunnelHost } from './tunnel-host.js';
import { MAX_TUNNEL_PAYLOAD_BYTES, TunnelFrameType, decodeJsonPayload, decodeTunnelFrame, encodeJsonPayload, encodeTunnelFrame } from './tunnel-codec.js';

const servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

const startOrigin = async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    received.push({ headers: req.headers, url: req.url });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, received };
};

const startBodyOrigin = async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ body: Buffer.concat(chunks), headers: req.headers, url: req.url });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, received };
};

const startWsOrigin = async (onConnection = () => {}) => {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws)));
  wss.on('connection', onConnection);
  servers.push({ close: (done) => { for (const ws of wss.clients) ws.terminate(); wss.close(); server.closeAllConnections?.(); server.close(done); } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, wss };
};

const openNested = async (host, sent, streamId = 1) => {
  await host.handleFrame(encodeTunnelFrame(TunnelFrameType.WsOpen, streamId, encodeJsonPayload({ path: '/api/global/event/ws', query: '', protocols: [] })));
  await waitFor(() => sent.some((raw) => {
    const frame = decodeTunnelFrame(raw);
    return frame.streamId === streamId && frame.frameType === TunnelFrameType.WsOpened;
  }));
};

const waitFor = async (predicate) => {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
};

const openHttpAndWaitCompleted = async (host, sent, streamId, method) => {
  await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpRequest, streamId, encodeJsonPayload({
    method, path: '/health', query: '', headers: {},
  })));
  if (method !== 'GET' && method !== 'HEAD') {
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, streamId, new Uint8Array([0])));
  }
  await host.handleFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, streamId, new Uint8Array()));
  await waitFor(() => sent.some((raw) => {
    const frame = decodeTunnelFrame(raw);
    return frame.streamId === streamId && frame.frameType === TunnelFrameType.StreamEnd;
  }));
};

describe('tunnel host policy seams', () => {
  it('retains an immediate request body frame while policy approval is pending', async () => {
    const origin = await startBodyOrigin();
    const sent = [];
    let approvePolicy;
    const policyResult = new Promise((resolve) => { approvePolicy = resolve; });
    const host = createTunnelHost({
      connectionId: 'early-body',
      getLocalPort: () => origin.port,
      getBufferedAmount: () => 0,
      sendFrame: (frame) => sent.push(frame),
      requestPolicy: () => policyResult,
    });

    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({
      method: 'DELETE', path: '/health', query: '', headers: {},
    })));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, 1, new Uint8Array([1, 2, 3])));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, 1, new Uint8Array()));

    expect(origin.received).toHaveLength(0);
    approvePolicy(true);
    await waitFor(() => origin.received.length === 1);
    expect([...origin.received[0].body]).toEqual([1, 2, 3]);
    host.close();
  });

  it('strips untrusted forwarding and internal headers before trusted context injection', async () => {
    const origin = await startOrigin();
    const sent = [];
    const host = createTunnelHost({
      connectionId: 'direct-1',
      getLocalPort: () => origin.port,
      getBufferedAmount: () => 0,
      sendFrame: (frame) => sent.push(frame),
      transportContext: {
        metadataHeader: null,
        stripOrigin: true,
        requestHeaders: { 'x-openchamber-transport': 'trusted-marker' },
      },
    });
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({
      method: 'GET', path: '/health', query: '', headers: {
        forwarded: 'for=attacker', 'x-forwarded-for': 'attacker', 'cf-connecting-ip': 'attacker',
        origin: 'https://attacker.test', 'x-openchamber-transport': 'attacker', accept: 'application/json',
      },
    })));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, 1, new Uint8Array()));
    await waitFor(() => origin.received.length === 1);
    const headers = origin.received[0].headers;
    expect(headers.forwarded).toBeUndefined();
    expect(headers['x-forwarded-for']).toBeUndefined();
    expect(headers['cf-connecting-ip']).toBeUndefined();
    expect(headers.origin).toBeUndefined();
    expect(headers['x-openchamber-transport']).toBe('trusted-marker');
    expect(headers['x-openchamber-relay-connection']).toBeUndefined();
    host.close();
  });

  it('fails closed for disallowed HTTP and WebSocket paths', async () => {
    const origin = await startOrigin();
    let failures = 0;
    const host = createTunnelHost({
      connectionId: 'closed-paths', getLocalPort: () => origin.port, getBufferedAmount: () => 0,
      sendFrame() {}, failClosedPolicy: true, onProtocolFailure: () => { failures += 1; },
    });
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({ method: 'GET', path: '/forbidden', query: '', headers: {} })));
    await waitFor(() => failures === 1);
    await expect(host.handleFrame(encodeTunnelFrame(TunnelFrameType.WsOpen, 3, encodeJsonPayload({ path: '/forbidden', query: '', protocols: [] })))).rejects.toThrow('path rejected');
    host.close();
  });

  it('rejects unknown-stream fragments before assembly', async () => {
    const host = createTunnelHost({ connectionId: 'unknown-fragment', getLocalPort: () => 1, getBufferedAmount: () => 0, sendFrame() {} });
    await expect(host.handleFrame(encodeTunnelFrame(TunnelFrameType.WsText, 99, new Uint8Array([1]), true))).rejects.toThrow('unsolicited websocket data');
    host.close();
  });

  it('enforces aggregate fragment bytes, frees them on abort, and switches to the authenticated budget', async () => {
    const origin = await startWsOrigin();
    const sent = [];
    let authenticated = false;
    const host = createTunnelHost({
      connectionId: 'fragment-budget', getLocalPort: () => origin.port, getBufferedAmount: () => 0,
      sendFrame: (frame) => sent.push(frame), limits: { getMaxIncompleteFragmentBytes: () => authenticated ? 8 : 3 },
    });
    await openNested(host, sent, 1);
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.WsText, 1, new Uint8Array([1, 2, 3]), true));
    await expect(host.handleFrame(encodeTunnelFrame(TunnelFrameType.WsBinary, 1, new Uint8Array([4]), true))).rejects.toThrow('incomplete fragment byte limit exceeded');
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.StreamAbort, 1, new Uint8Array()));
    await openNested(host, sent, 3);
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.WsText, 3, new Uint8Array([1, 2, 3]), true));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.StreamAbort, 3, new Uint8Array()));
    authenticated = true;
    await openNested(host, sent, 5);
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.WsText, 5, new Uint8Array(8), true));
    host.close();
  });

  it('rejects ambiguous paths while preserving normal paths and encoded query values', async () => {
    const invalid = ['/api/../auth', '/api/%2e%2e/auth', '/api%2fauth', '/api%5cauth', '/api\\auth', '/api//health', '/api/\0x', '/api/x?hidden'];
    for (const path of invalid) {
      let failures = 0;
      const host = createTunnelHost({ connectionId: 'canonical', getLocalPort: () => 1, getBufferedAmount: () => 0, sendFrame() {}, failClosedPolicy: true, onProtocolFailure: () => { failures += 1; } });
      await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({ method: 'GET', path, query: '', headers: {} })));
      await waitFor(() => failures === 1);
      host.close();
    }
    const origin = await startOrigin();
    const sent = [];
    const host = createTunnelHost({ connectionId: 'canonical-ok', getLocalPort: () => origin.port, getBufferedAmount: () => 0, sendFrame: (frame) => sent.push(frame) });
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({ method: 'GET', path: '/api/config', query: 'value=a%2Fb%3Fc%26d', headers: {} })));
    await waitFor(() => origin.received.length === 1);
    expect(origin.received[0].url).toBe('/api/config?value=a%2Fb%3Fc%26d');
    host.close();
  });

  it('serializes fragmented text and binary messages through artificial backpressure', async () => {
    const text = 't'.repeat(MAX_TUNNEL_PAYLOAD_BYTES + 10);
    const binary = new Uint8Array(MAX_TUNNEL_PAYLOAD_BYTES + 10).fill(7);
    const origin = await startWsOrigin((ws) => { ws.send(text); ws.send(binary, { binary: true }); });
    const sent = [];
    let blocked = true;
    const host = createTunnelHost({ connectionId: 'serialized', getLocalPort: () => origin.port, getBufferedAmount: () => blocked ? 5 * 1024 * 1024 : 0, sendFrame: (frame) => sent.push(frame) });
    await openNested(host, sent);
    await new Promise((resolve) => setTimeout(resolve, 30));
    blocked = false;
    await waitFor(() => sent.filter((raw) => [TunnelFrameType.WsText, TunnelFrameType.WsBinary].includes(decodeTunnelFrame(raw).frameType)).length === 4);
    const types = sent.map(decodeTunnelFrame).filter((frame) => [TunnelFrameType.WsText, TunnelFrameType.WsBinary].includes(frame.frameType)).map((frame) => frame.frameType);
    expect(types).toEqual([TunnelFrameType.WsText, TunnelFrameType.WsText, TunnelFrameType.WsBinary, TunnelFrameType.WsBinary]);
    host.close();
  });

  it('turns send-chain rejection into one protocol failure and stream cleanup', async () => {
    const origin = await startWsOrigin((ws) => ws.send('payload'));
    const sent = [];
    let failures = 0;
    const closed = [];
    const host = createTunnelHost({
      connectionId: 'send-reject', getLocalPort: () => origin.port, getBufferedAmount: () => 0,
      sendFrame: (frame) => { if (decodeTunnelFrame(frame).frameType === TunnelFrameType.WsText) return Promise.reject(new Error('blocked')); sent.push(frame); },
      onProtocolFailure: () => { failures += 1; }, onStreamClosed: (event) => closed.push(event),
    });
    await openNested(host, sent);
    await waitFor(() => failures === 1);
    expect(host.streamCount).toBe(0);
    expect(closed.some((event) => event.reason === 'send-failed')).toBe(true);
    host.close();
  });

  it('rejects limit + 1 streams without changing omitted relay defaults', async () => {
    const origin = await startOrigin();
    const sent = [];
    const host = createTunnelHost({
      connectionId: 'limited', getLocalPort: () => origin.port, getBufferedAmount: () => 0,
      sendFrame: (frame) => sent.push(frame), limits: { maxStreams: 1 },
    });
    const request = (streamId) => host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpRequest, streamId, encodeJsonPayload({
      method: 'POST', path: '/health', query: '', headers: {},
    })));
    await request(1);
    await request(2);
    await waitFor(() => sent.some((raw) => {
      const frame = decodeTunnelFrame(raw);
      return frame.streamId === 2 && frame.frameType === TunnelFrameType.StreamAbort
        && decodeJsonPayload(frame.payload, (value) => value).reason === 'stream limit exceeded';
    }));
    expect(host.streamCount).toBe(1);
    host.close();
  });

  it('tolerates bounded late DELETE body frames and consumes the tombstone on StreamEnd', async () => {
    const origin = await startOrigin();
    const sent = [];
    const host = createTunnelHost({
      connectionId: 'late-delete', getLocalPort: () => origin.port, getBufferedAmount: () => 0,
      sendFrame: (frame) => sent.push(frame), limits: { maxLateHttpBodyFrames: 2, maxLateHttpBodyBytes: 4 },
    });
    await openHttpAndWaitCompleted(host, sent, 1, 'DELETE');
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, 1, new Uint8Array([1, 2])));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, 1, new Uint8Array([3, 4])));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, 1, new Uint8Array()));
    await expect(host.handleFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, 1, new Uint8Array()))).rejects.toThrow('unsolicited stream end');
    host.close();
  });

  it('tolerates a late GET StreamEnd but rejects a late GET body', async () => {
    const origin = await startOrigin();
    const sent = [];
    const host = createTunnelHost({ connectionId: 'late-get', getLocalPort: () => origin.port, getBufferedAmount: () => 0, sendFrame: (frame) => sent.push(frame) });
    await openHttpAndWaitCompleted(host, sent, 1, 'GET');
    await expect(host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, 1, new Uint8Array([1])))).rejects.toThrow('unsolicited http body');
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, 1, new Uint8Array()));
    host.close();
  });

  it('keeps unknown IDs and tombstoned ID reuse fatal', async () => {
    const origin = await startOrigin();
    const sent = [];
    const host = createTunnelHost({ connectionId: 'unknown-reuse', getLocalPort: () => origin.port, getBufferedAmount: () => 0, sendFrame: (frame) => sent.push(frame) });
    await expect(host.handleFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, 99, new Uint8Array()))).rejects.toThrow('unsolicited stream end');
    await expect(host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, 99, new Uint8Array([1])))).rejects.toThrow('unsolicited http body');
    await openHttpAndWaitCompleted(host, sent, 1, 'GET');
    await expect(host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({ method: 'GET', path: '/health', query: '', headers: {} })))).rejects.toThrow('completed stream id reused');
    host.close();
  });

  it('expires and evicts completed HTTP tombstones deterministically', async () => {
    const origin = await startOrigin();
    const sent = [];
    let now = 100;
    const host = createTunnelHost({
      connectionId: 'tombstone-bounds', getLocalPort: () => origin.port, getBufferedAmount: () => 0,
      sendFrame: (frame) => sent.push(frame), limits: { completedHttpStreamTtlMs: 5, maxCompletedHttpStreams: 1, now: () => now },
    });
    await openHttpAndWaitCompleted(host, sent, 1, 'GET');
    await openHttpAndWaitCompleted(host, sent, 2, 'GET');
    await expect(host.handleFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, 1, new Uint8Array()))).rejects.toThrow('unsolicited stream end');
    now = 106;
    await expect(host.handleFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, 2, new Uint8Array()))).rejects.toThrow('unsolicited stream end');
    host.close();
  });

  it('rejects late body frames that exceed frame or byte budgets', async () => {
    const origin = await startOrigin();
    const sent = [];
    const host = createTunnelHost({
      connectionId: 'late-body-budget', getLocalPort: () => origin.port, getBufferedAmount: () => 0,
      sendFrame: (frame) => sent.push(frame), limits: { maxLateHttpBodyFrames: 1, maxLateHttpBodyBytes: 2 },
    });
    await openHttpAndWaitCompleted(host, sent, 1, 'DELETE');
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, 1, new Uint8Array([1, 2])));
    await expect(host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, 1, new Uint8Array([3])))).rejects.toThrow('late http body budget exceeded');
    await openHttpAndWaitCompleted(host, sent, 2, 'DELETE');
    await expect(host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, 2, new Uint8Array([1, 2, 3])))).rejects.toThrow('late http body budget exceeded');
    host.close();
  });

  it('clears completed HTTP tombstones on close', async () => {
    const origin = await startOrigin();
    const sent = [];
    const host = createTunnelHost({ connectionId: 'clear-tombstones', getLocalPort: () => origin.port, getBufferedAmount: () => 0, sendFrame: (frame) => sent.push(frame) });
    await openHttpAndWaitCompleted(host, sent, 1, 'GET');
    expect(host.completedHttpStreamCount).toBe(1);
    host.close();
    expect(host.completedHttpStreamCount).toBe(0);
  });
});
