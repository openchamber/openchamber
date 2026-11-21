import { describe, test, expect } from 'bun:test';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { gunzipSync } from 'node:zlib';

import { createFrameDecryptor, createFrameEncryptor } from './e2ee.js';
import { createTunnelHost, isAllowedRelayWebSocketPath } from './tunnel-host.js';
import { consumeRelayProof, hasRelayProvenance, RELAY_PROOF_HEADER } from './provenance.js';
import { rateLimitKey } from '../security/client-address.js';
import {
  chunkPayload,
  createOutboundFrameBatcher,
  decodeFrameBatch,
  decodeTunnelFrame,
  encodeTunnelFrame,
  encodeJsonPayload,
  MAX_TUNNEL_PAYLOAD_BYTES,
  TunnelFrameType,
} from './tunnel-codec.js';

const startLoopback = (respond = (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}) =>
  new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        requests.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        respond(req, res);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      requests,
      stop: () => new Promise((r) => server.close(() => r())),
    }));
  });

const createHarness = async (hostOverrides = {}, respond) => {
  const loopback = await startLoopback(respond);
  const sentFrames = [];
  const frames = new EventEmitter();
  const host = createTunnelHost({
    connectionId: 'conn-test',
    getLocalPort: () => loopback.port,
    sendFrame: async (frame) => {
      sentFrames.push(decodeTunnelFrame(frame));
      frames.emit(String(decodeTunnelFrame(frame).frameType));
    },
    getBufferedAmount: () => 0,
    ...hostOverrides,
  });
  const waitForFrame = type => sentFrames.some(frame => frame.frameType === type)
    ? Promise.resolve() : once(frames, String(type));
  return { host, loopback, sentFrames, waitForFrame };
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
    const { host, loopback, sentFrames, waitForFrame } = await createHarness();
    await host.handleFrame(httpHead());
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, 1, new TextEncoder().encode('alpha')));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, 1, new TextEncoder().encode('beta')));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, 1, new Uint8Array(0)));

    await waitForFrame(TunnelFrameType.StreamEnd);
    expect(loopback.requests.length).toBe(1);
    expect(loopback.requests[0].method).toBe('POST');
    expect(loopback.requests[0].body).toBe('alphabeta');
    expect(sentFrames.some((f) => f.frameType === TunnelFrameType.StreamEnd)).toBe(true);
    await loopback.stop();
  });

  test('stamps forwarded requests with this server\'s relay proof, replacing a client-sent one', async () => {
    const { host, loopback, waitForFrame } = await createHarness();
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({
      method: 'GET',
      path: '/api/health',
      query: '',
      headers: { [RELAY_PROOF_HEADER]: 'client-guess', 'x-openchamber-relay-connection': 'other' },
    })));

    await waitForFrame(TunnelFrameType.StreamEnd);
    const forwarded = { headers: loopback.requests[0].headers };
    expect(forwarded.headers[RELAY_PROOF_HEADER]).not.toBe('client-guess');
    expect(forwarded.headers['x-openchamber-relay-connection']).toBe('conn-test');
    consumeRelayProof(forwarded);
    expect(hasRelayProvenance(forwarded)).toBe(true);
    expect(forwarded.headers[RELAY_PROOF_HEADER]).toBeUndefined();
    await loopback.stop();
  });

  test('hands a redirect back to the device instead of following it with the relay proof', async () => {
    const elsewhere = await startLoopback();
    const { host, loopback, sentFrames, waitForFrame } = await createHarness({}, (req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${elsewhere.port}/landing` });
      res.end();
    });
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({
      method: 'GET', path: '/api/redirecting', query: '', headers: {},
    })));

    await waitForFrame(TunnelFrameType.StreamEnd);
    const head = JSON.parse(new TextDecoder().decode(sentFrames.find((f) => f.frameType === TunnelFrameType.HttpResponse).payload));
    expect(head.status).toBe(302);
    expect(head.headers.location).toBe(`http://127.0.0.1:${elsewhere.port}/landing`);
    expect(elsewhere.requests).toEqual([]);
    await loopback.stop();
    await elsewhere.stop();
  });

  test('body-expected request with zero delivered frames is aborted as ambiguous, not forwarded', async () => {
    const { host, loopback, sentFrames, waitForFrame } = await createHarness();
    await host.handleFrame(httpHead({ hasBody: true }));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, 1, new Uint8Array(0)));

    await waitForFrame(TunnelFrameType.StreamAbort);
    expect(sentFrames.some((f) => f.frameType === TunnelFrameType.StreamAbort)).toBe(true);
    // Loopback must never have seen a request with a lost body.
    expect(loopback.requests.length).toBe(0);
    await loopback.stop();
  });

  test('bodyless request (hasBody absent, legacy client) still forwards empty', async () => {
    const { host, loopback, waitForFrame } = await createHarness();
    await host.handleFrame(httpHead());
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, 1, new Uint8Array(0)));

    await waitForFrame(TunnelFrameType.StreamEnd);
    expect(loopback.requests.length).toBe(1);
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
    const { host, loopback, waitForFrame } = await createHarness();
    await host.handleFrame(httpHead({ hasBody: true }));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, 1, new Uint8Array(0)));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, 1, new Uint8Array(0)));

    await waitForFrame(TunnelFrameType.StreamEnd);
    expect(loopback.requests.length).toBe(1);
    expect(loopback.requests[0].body).toBe('');
    await loopback.stop();
  });

  test('GET forwards immediately with no body wait', async () => {
    const { host, loopback, waitForFrame } = await createHarness();
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({
      method: 'GET',
      path: '/api/health',
      query: '',
      headers: {},
    })));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, 1, new Uint8Array(0)));

    await waitForFrame(TunnelFrameType.StreamEnd);
    expect(loopback.requests.length).toBe(1);
    expect(loopback.requests[0].method).toBe('GET');
    await loopback.stop();
  });

  test('a relay that drops one encrypted body message fails the channel instead of shortening the body', async () => {
    const { host, loopback } = await createHarness();
    const keyBytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const key = await globalThis.crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    const encryptor = createFrameEncryptor(key);
    const decryptor = createFrameDecryptor(key);

    // Default batcher: a full-size body chunk travels alone, so the client
    // sends [head] [A] [B] [CCCC + StreamEnd] as four encrypted messages.
    const plaintexts = [];
    const batcher = createOutboundFrameBatcher({ sendBatch: (p) => plaintexts.push(p) });
    batcher.enqueue(httpHead({ hasBody: true }));
    const body = Buffer.concat([
      Buffer.alloc(MAX_TUNNEL_PAYLOAD_BYTES, 'A'),
      Buffer.alloc(MAX_TUNNEL_PAYLOAD_BYTES, 'B'),
      Buffer.from('CCCC'),
    ]);
    for (const piece of chunkPayload(new Uint8Array(body))) {
      batcher.enqueue(encodeTunnelFrame(TunnelFrameType.HttpBody, 1, piece));
    }
    batcher.enqueue(encodeTunnelFrame(TunnelFrameType.StreamEnd, 1, new Uint8Array(0)));
    batcher.dispose();
    expect(plaintexts.length).toBe(4);
    const wire = [];
    for (const plaintext of plaintexts) wire.push(await encryptor.encrypt(plaintext));

    // The relay drops the "B" message; the host decrypts and dispatches the rest
    // as host-client.js does, and tears the tunnel down on the decrypt error.
    const deliver = async (message) => {
      for (const frame of decodeFrameBatch(await decryptor.decrypt(message))) await host.handleFrame(frame);
    };
    await deliver(wire[0]);
    await deliver(wire[1]);
    await expect(deliver(wire[3])).rejects.toThrow('frame counter gap');
    host.close();

    await new Promise((r) => setTimeout(r, 50));
    expect(loopback.requests.length).toBe(0);
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
    let finish;
    const finished = new Promise(resolve => { finish = resolve; });
    const host = createTunnelHost({
      connectionId: 'conn-test',
      getLocalPort: () => loopback.port,
      sendFrame: async (frame) => {
        const decoded = decodeTunnelFrame(frame);
        sentFrames.push(decoded);
        if (decoded.frameType === TunnelFrameType.StreamEnd) finish();
      },
      getBufferedAmount: () => 0,
    });
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({
      method: 'GET', path, query: '', headers,
    })));
    await finished;
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

describe('tunnel-host sign-in budget provenance', () => {
  test('marks dispatched requests for the relay budget, which an ordinary loopback request cannot claim', async () => {
    const keys = [];
    const server = http.createServer((req, res) => {
      keys.push(rateLimitKey(req, 'no-ip'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    server.prependListener('request', consumeRelayProof);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    let finish;
    const finished = new Promise((resolve) => { finish = resolve; });
    const host = createTunnelHost({
      connectionId: 'conn-test',
      getLocalPort: () => port,
      sendFrame: async (frame) => {
        if (decodeTunnelFrame(frame).frameType === TunnelFrameType.StreamEnd) finish();
      },
      getBufferedAmount: () => 0,
    });
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({
      method: 'GET',
      path: '/auth/session',
      query: '',
      headers: { 'x-forwarded-for': '203.0.113.7', [RELAY_PROOF_HEADER]: 'forged' },
    })));
    await finished;
    host.close();

    await fetch(`http://127.0.0.1:${port}/auth/session`, {
      headers: { 'x-forwarded-for': '203.0.113.8', 'x-openchamber-relay-connection': 'conn-test' },
    });
    await new Promise((resolve) => server.close(resolve));

    expect(keys).toEqual(['relay', '203.0.113.8']);
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
