// Unit tests for the relay tunnel client against an in-memory wire pair whose
// responder side is built from the SAME protocol modules (createHostHandshake +
// the tunnel codec). No network, no real WebSocket.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  exportPublicKeyJwk,
  generateEcdhKeyPair,
  type FrameDecryptor,
  type FrameEncryptor,
} from './crypto';
import { createHostHandshake } from './handshake';
import { TunnelFrameType } from './protocol';
import {
  createFragmentAssembler,
  decodeFrameBatch,
  decodeJsonPayload,
  decodeTunnelFrame,
  encodeFrameBatch,
  encodeJsonPayload,
  encodeTunnelFrame,
  type TunnelFrame,
} from './tunnel-codec';
import {
  createRelayTunnelClient,
  type RelayTunnelClient,
  type TunnelWireSocket,
} from './tunnel-client';

const WS_OPEN = 1;
const WS_CLOSED = 3;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const isWsOpenPayload = (
  value: unknown,
): value is { path: string; query: string; protocols?: string[] } =>
  typeof value === 'object' && value !== null && typeof (value as { path?: unknown }).path === 'string';

const isHttpRequestPayload = (
  value: unknown,
): value is { method: string; path: string; query: string; headers: Record<string, string> } =>
  typeof value === 'object' && value !== null && typeof (value as { path?: unknown }).path === 'string';

class FakeEndpoint implements TunnelWireSocket {
  readyState = WS_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  peer: FakeEndpoint | null = null;
  closed = false;
  // Count binary (encrypted) WS messages that cross this endpoint's send path —
  // the billable unit the batching optimization is designed to reduce.
  binarySent = 0;

  send(data: string | ArrayBuffer | Uint8Array): void {
    if (this.closed) return;
    if (typeof data !== 'string') this.binarySent += 1;
    const peer = this.peer;
    if (!peer) return;
    // Copy bytes so the receiver can't observe later mutation.
    const payload = typeof data === 'string' ? data : data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0));
    queueMicrotask(() => {
      if (peer.closed) return;
      peer.onmessage?.({ data: payload });
    });
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = WS_CLOSED;
    const peer = this.peer;
    queueMicrotask(() => this.onclose?.({ code, reason }));
    if (peer && !peer.closed) {
      peer.closed = true;
      peer.readyState = WS_CLOSED;
      queueMicrotask(() => peer.onclose?.({ code, reason }));
    }
  }
}

type MiniHostOptions = {
  silent?: boolean;
  onConnect?: () => void;
  // Delay handling of the first inbound text frame: with a delay longer than
  // the client's helloRetryMs this reproduces the first-connect race where the
  // client retries `hello` and the host answers every retry with `ready`.
  firstHelloDelayMs?: number;
  // Advertise batching from the host (default true = matches production).
  batch?: boolean;
  // Records every tunnel frame the host received, in arrival order.
  recordFrame?: (frame: TunnelFrame) => void;
};

// A minimal host responder wired to one endpoint. Answers a few routes so the
// client's HTTP/WS/abort paths can be exercised end to end.
const attachMiniHost = (endpoint: FakeEndpoint, hostPrivateKey: CryptoKey, options: MiniHostOptions = {}): void => {
  const handshake = createHostHandshake(hostPrivateKey, { batch: options.batch });
  let encryptor: FrameEncryptor | null = null;
  let decryptor: FrameDecryptor | null = null;
  let batchNegotiated = false;
  const assembler = createFragmentAssembler();
  const httpBodies = new Map<number, Uint8Array[]>();
  const httpRequests = new Map<number, { method: string; path: string }>();
  const aborted = new Set<number>();
  let sendChain: Promise<void> = Promise.resolve();
  let recvChain: Promise<void> = Promise.resolve();

  const sendFrame = (frame: Uint8Array): void => {
    sendChain = sendChain.then(async () => {
      if (!encryptor || endpoint.closed) return;
      // When batching is negotiated the client always expects a container tag,
      // so wrap even single frames (tag 0x00). The host here does not coalesce.
      const plaintext = batchNegotiated ? encodeFrameBatch([frame]) : frame;
      endpoint.send(await encryptor.encrypt(plaintext));
    });
  };

  const respondJson = (streamId: number, status: number, body: unknown): void => {
    sendFrame(encodeTunnelFrame(TunnelFrameType.HttpResponse, streamId, encodeJsonPayload({ status, headers: { 'content-type': 'application/json' } })));
    sendFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, streamId, textEncoder.encode(JSON.stringify(body))));
    sendFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, streamId, new Uint8Array(0)));
  };

  const respondHttp = (streamId: number, path: string, body: Uint8Array): void => {
    if (path === '/health') {
      respondJson(streamId, 200, { ok: true });
    } else if (path === '/echo-body') {
      sendFrame(encodeTunnelFrame(TunnelFrameType.HttpResponse, streamId, encodeJsonPayload({ status: 200, headers: {} })));
      sendFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, streamId, body));
      sendFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, streamId, new Uint8Array(0)));
    } else if (path === '/stream') {
      sendFrame(encodeTunnelFrame(TunnelFrameType.HttpResponse, streamId, encodeJsonPayload({ status: 200, headers: {} })));
      const emit = (index: number): void => {
        if (aborted.has(streamId)) return;
        if (index >= 3) {
          sendFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, streamId, new Uint8Array(0)));
          return;
        }
        sendFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, streamId, textEncoder.encode(`chunk${index};`)));
        setTimeout(() => emit(index + 1), 10);
      };
      emit(0);
    } else if (path === '/never-ends') {
      sendFrame(encodeTunnelFrame(TunnelFrameType.HttpResponse, streamId, encodeJsonPayload({ status: 200, headers: {} })));
      const pump = (): void => {
        if (aborted.has(streamId) || endpoint.closed) return;
        sendFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, streamId, textEncoder.encode('tick;')));
        setTimeout(pump, 10);
      };
      pump();
    } else {
      respondJson(streamId, 404, { error: 'not found' });
    }
  };

  const handleTunnelFrame = (frame: TunnelFrame): void => {
    options.recordFrame?.(frame);
    if (options.silent) return;
    if (frame.frameType === TunnelFrameType.Ping) {
      sendFrame(encodeTunnelFrame(TunnelFrameType.Pong, frame.streamId, new Uint8Array(0)));
      return;
    }
    if (frame.frameType === TunnelFrameType.HttpRequest) {
      const req = decodeJsonPayload(frame.payload, isHttpRequestPayload);
      httpBodies.set(frame.streamId, []);
      httpRequests.set(frame.streamId, { method: req.method, path: req.path });
      if (req.method === 'GET' || req.method === 'HEAD') {
        respondHttp(frame.streamId, req.path, new Uint8Array(0));
      }
      return;
    }
    if (frame.frameType === TunnelFrameType.HttpBody) {
      httpBodies.get(frame.streamId)?.push(frame.payload);
      return;
    }
    if (frame.frameType === TunnelFrameType.StreamAbort) {
      aborted.add(frame.streamId);
      return;
    }
    if (frame.frameType === TunnelFrameType.StreamEnd) {
      const request = httpRequests.get(frame.streamId);
      if (!request || request.method === 'GET' || request.method === 'HEAD') return;
      const bodyChunks = httpBodies.get(frame.streamId) ?? [];
      const total = bodyChunks.reduce((sum, c) => sum + c.length, 0);
      const body = new Uint8Array(total);
      let off = 0;
      for (const c of bodyChunks) {
        body.set(c, off);
        off += c.length;
      }
      respondHttp(frame.streamId, request.path, body);
      return;
    }
    if (frame.frameType === TunnelFrameType.WsOpen) {
      const open = decodeJsonPayload(frame.payload, isWsOpenPayload);
      sendFrame(encodeTunnelFrame(TunnelFrameType.WsOpened, frame.streamId, encodeJsonPayload(open.protocols?.length ? { protocol: open.protocols[0] } : {})));
      return;
    }
    if (frame.frameType === TunnelFrameType.WsText) {
      const complete = assembler.push(frame);
      if (!complete) return;
      const text = textDecoder.decode(complete);
      sendFrame(encodeTunnelFrame(TunnelFrameType.WsText, frame.streamId, textEncoder.encode(`echo:${text}`)));
      return;
    }
    if (frame.frameType === TunnelFrameType.WsClose) {
      sendFrame(encodeTunnelFrame(TunnelFrameType.WsClose, frame.streamId, frame.payload));
    }
  };

  let firstHelloDelayed = false;
  endpoint.onmessage = (event) => {
    const data = event.data;
    recvChain = recvChain.then(async () => {
      if (typeof data === 'string') {
        if (options.firstHelloDelayMs && !firstHelloDelayed) {
          firstHelloDelayed = true;
          await new Promise((resolve) => setTimeout(resolve, options.firstHelloDelayMs));
        }
        const action = await handshake.handleText(data);
        if (action.type === 'established') {
          encryptor = action.channel.encryptor;
          decryptor = action.channel.decryptor;
          batchNegotiated = action.batch;
          if (action.replyText) endpoint.send(action.replyText);
          options.onConnect?.();
        } else if (action.type === 'send-text' && action.text) {
          endpoint.send(action.text);
        }
        return;
      }
      if (!decryptor) return;
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
      const plaintext = await decryptor.decrypt(bytes);
      const frames = batchNegotiated ? decodeFrameBatch(plaintext) : [plaintext];
      for (const frame of frames) handleTunnelFrame(decodeTunnelFrame(frame));
    });
  };
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const setupClient = async (
  hostOptions: MiniHostOptions = {},
  clientOverrides: Partial<Parameters<typeof createRelayTunnelClient>[0]> = {},
): Promise<{
  client: RelayTunnelClient;
  connectionCount: () => number;
  killWire: () => void;
  sendTextToClient: (text: string) => void;
  clientBinaryCount: () => number;
  requestedUrls: () => string[];
}> => {
  const hostKeyPair = await generateEcdhKeyPair();
  const hostPubJwk = await exportPublicKeyJwk(hostKeyPair.publicKey);
  let count = 0;
  let lastClientEndpoint: FakeEndpoint | null = null;
  let lastHostEndpoint: FakeEndpoint | null = null;
  const urls: string[] = [];
  const client = createRelayTunnelClient({
    relayUrl: 'wss://relay.test/ws',
    serverId: 'server-1',
    hostEncPubJwk: hostPubJwk,
    helloRetryMs: 20,
    pingIntervalMs: 40,
    pingTimeoutMs: 120,
    reconnectBaseDelayMs: 20,
    reconnectMaxDelayMs: 80,
    ...clientOverrides,
    createWireSocket: (url) => {
      urls.push(url);
      count += 1;
      const clientEndpoint = new FakeEndpoint();
      const hostEndpoint = new FakeEndpoint();
      clientEndpoint.peer = hostEndpoint;
      hostEndpoint.peer = clientEndpoint;
      lastClientEndpoint = clientEndpoint;
      lastHostEndpoint = hostEndpoint;
      attachMiniHost(hostEndpoint, hostKeyPair.privateKey, hostOptions);
      queueMicrotask(() => clientEndpoint.onopen?.());
      return clientEndpoint;
    },
  });
  return {
    client,
    connectionCount: () => count,
    killWire: (code = 1006, reason = 'killed') => lastClientEndpoint?.close(code, reason),
    sendTextToClient: (text: string) => lastHostEndpoint?.send(text),
    clientBinaryCount: () => lastClientEndpoint?.binarySent ?? 0,
    requestedUrls: () => urls,
  };
};

let openClients: RelayTunnelClient[] = [];
afterEach(() => {
  for (const client of openClients) client.close();
  openClients = [];
});

const track = (client: RelayTunnelClient): RelayTunnelClient => {
  openClients.push(client);
  return client;
};

describe('createRelayTunnelClient', () => {
  test('does not publish or expose a channel until readiness succeeds', async () => {
    let release!: () => void;
    const readiness = new Promise<void>((resolve) => { release = resolve; });
    const { client } = await setupClient({}, { channelReadiness: async ({ fetch }) => {
      const health = await fetch('/health');
      expect(health.status).toBe(200);
      await readiness;
    } });
    track(client);
    const request = client.fetch('/health');
    await wait(50);
    expect(client.getStatus().state).not.toBe('connected');
    let settled = false;
    void request.finally(() => { settled = true; });
    await wait(10);
    expect(settled).toBe(false);
    release();
    expect((await request).status).toBe(200);
    expect(client.getStatus().state).toBe('connected');
  });

  test('runs readiness again before queued requests resume after reconnect', async () => {
    let checks = 0;
    let releaseSecond!: () => void;
    const second = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const { client, killWire } = await setupClient({}, { channelReadiness: async ({ fetch }) => {
      checks += 1;
      expect((await fetch('/health')).status).toBe(200);
      if (checks === 2) await second;
    } });
    track(client);
    await client.fetch('/health');
    killWire();
    await wait(10);
    const queued = client.fetch('/health');
    await wait(80);
    expect(checks).toBe(2);
    expect(client.getStatus().state).not.toBe('connected');
    releaseSecond();
    expect((await queued).status).toBe(200);
  });

  test('keeps public fetch and WebSocket blocked together until readiness publishes', async () => {
    let release!: () => void;
    const readiness = new Promise<void>((resolve) => { release = resolve; });
    const { client } = await setupClient({}, { channelReadiness: async () => readiness });
    track(client);
    const request = client.fetch('/health');
    const socket = client.openWebSocket('/api/event/ws');
    let fetchSettled = false;
    let socketOpened = false;
    void request.then(() => { fetchSettled = true; });
    socket.onopen = () => { socketOpened = true; };
    await wait(50);
    expect(fetchSettled).toBe(false);
    expect(socketOpened).toBe(false);
    expect(socket.readyState).toBe(0);
    release();
    expect((await request).status).toBe(200);
    await wait(20);
    expect(socketOpened).toBe(true);
  });
  test('preserves relay URL construction by default and accepts an exact outer URL', async () => {
    const relay = await setupClient();
    track(relay.client);
    await relay.client.fetch('/health');
    const relayUrl = new URL(relay.requestedUrls()[0]);
    expect(relayUrl.origin + relayUrl.pathname).toBe('wss://relay.test/ws');
    expect(relayUrl.searchParams.get('role')).toBe('client');
    expect(relayUrl.searchParams.get('serverId')).toBe('server-1');

    const direct = await setupClient({}, { outerWebSocketUrl: 'wss://managed.example/api/openchamber/direct-e2ee/ws' });
    track(direct.client);
    await direct.client.fetch('/health');
    expect(direct.requestedUrls()[0]).toBe('wss://managed.example/api/openchamber/direct-e2ee/ws');
  });

  test('performs concurrent fetches over one tunnel', async () => {
    const { client } = await setupClient();
    track(client);
    const [a, b, c] = await Promise.all([
      client.fetch('/health'),
      client.fetch('/health'),
      client.fetch('/echo-body', { method: 'POST', body: 'payload-xyz' }),
    ]);
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ ok: true });
    expect(b.status).toBe(200);
    expect(await b.text()).toBe(await new Response('{"ok":true}').text());
    expect(await c.text()).toBe('payload-xyz');
  });

  test('does not send request body frames or StreamEnd for GET and HEAD', async () => {
    const received: TunnelFrame[] = [];
    const { client } = await setupClient({ recordFrame: (frame) => received.push(frame) });
    track(client);

    await client.fetch('/health');
    await client.fetch('/health', { method: 'HEAD' });
    await wait(20);

    const requestStreamIds = received
      .filter((frame) => frame.frameType === TunnelFrameType.HttpRequest)
      .map((frame) => frame.streamId);
    expect(requestStreamIds).toHaveLength(2);
    expect(received.some((frame) => requestStreamIds.includes(frame.streamId) && frame.frameType === TunnelFrameType.HttpBody)).toBe(false);
    expect(received.some((frame) => requestStreamIds.includes(frame.streamId) && frame.frameType === TunnelFrameType.StreamEnd)).toBe(false);
  });

  test('sends StreamEnd immediately after POST and DELETE requests without bodies', async () => {
    const received: TunnelFrame[] = [];
    const { client } = await setupClient({ recordFrame: (frame) => received.push(frame) });
    track(client);

    for (const method of ['POST', 'DELETE']) {
      const response = await client.fetch('/echo-body', { method });
      expect(await response.text()).toBe('');
    }

    const requests = received.filter((frame) => frame.frameType === TunnelFrameType.HttpRequest);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const streamFrames = received.filter((frame) => frame.streamId === request.streamId);
      expect(streamFrames.map((frame) => frame.frameType)).toEqual([
        TunnelFrameType.HttpRequest,
        TunnelFrameType.StreamEnd,
      ]);
    }
  });

  test('sends streamed request body frames before StreamEnd', async () => {
    const received: TunnelFrame[] = [];
    const { client } = await setupClient({ recordFrame: (frame) => received.push(frame) });
    track(client);

    const response = await client.fetch('/echo-body', { method: 'POST', body: 'streamed-body' });
    expect(await response.text()).toBe('streamed-body');

    const request = received.find((frame) => frame.frameType === TunnelFrameType.HttpRequest);
    expect(request).toBeDefined();
    const streamFrames = received.filter((frame) => frame.streamId === request?.streamId);
    expect(streamFrames[0]?.frameType).toBe(TunnelFrameType.HttpRequest);
    expect(streamFrames.at(-1)?.frameType).toBe(TunnelFrameType.StreamEnd);
    expect(streamFrames.slice(1, -1).every((frame) => frame.frameType === TunnelFrameType.HttpBody)).toBe(true);
    expect(streamFrames.slice(1, -1).length).toBeGreaterThan(0);
  });

  test('streams a response body incrementally', async () => {
    const { client } = await setupClient();
    track(client);
    const response = await client.fetch('/stream');
    expect(response.body).not.toBeNull();
    const reader = response.body!.getReader();
    const chunks: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(textDecoder.decode(value));
    }
    expect(chunks.join('')).toBe('chunk0;chunk1;chunk2;');
    // The body arrived as multiple frames, not one buffered blob.
    expect(chunks.length).toBeGreaterThan(1);
  });

  test('propagates abort to the host and errors the stream', async () => {
    const { client } = await setupClient();
    track(client);
    const controller = new AbortController();
    const response = await client.fetch('/never-ends', { signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await expect(reader.read()).rejects.toThrow();
  });

  test('opens, echoes, and closes a tunneled WebSocket', async () => {
    const { client } = await setupClient();
    track(client);
    const socket = client.openWebSocket('/api/global/event/ws?x=1');
    const opened = new Promise<void>((resolve) => {
      socket.onopen = () => resolve();
    });
    await opened;
    expect(socket.readyState).toBe(WS_OPEN);
    const message = new Promise<string>((resolve) => {
      socket.onmessage = (event) => {
        if (typeof event.data === 'string') resolve(event.data);
      };
    });
    socket.send('hello');
    expect(await message).toBe('echo:hello');
    const closed = new Promise<number>((resolve) => {
      socket.onclose = (event) => resolve(event.code);
    });
    socket.close(1000, 'done');
    await closed;
    expect(socket.readyState).toBe(WS_CLOSED);
  });

  test('fails open streams on reconnect and recovers on retry', async () => {
    const { client, connectionCount, killWire } = await setupClient();
    track(client);
    const failures: string[] = [];
    client.subscribeStatus((status) => {
      if (status.failureClassification) failures.push(status.failureClassification);
    });
    const response = await client.fetch('/never-ends');
    const reader = response.body!.getReader();
    await reader.read();
    const socket = client.openWebSocket('/api/event/ws');
    const socketClosed = new Promise<number>((resolve) => {
      socket.onclose = (event) => resolve(event.code);
    });
    const firstConnections = connectionCount();

    // Kill the relay socket: all open streams must fail so callers' retry
    // machinery recovers. Tunnel-killed sockets close with 1012.
    killWire();
    await expect(reader.read()).rejects.toThrow();
    expect(await socketClosed).toBe(1012);
    expect(failures).toContain('network');

    // The client reconnects a fresh wire and works again.
    const health = await client.fetch('/health');
    expect(health.status).toBe(200);
    expect(connectionCount()).toBeGreaterThan(firstConnections);
  });

  test('reconnects when keepalive times out against a silent host', async () => {
    const { client, connectionCount } = await setupClient({ silent: true });
    track(client);
    // Wait for the first handshake to establish, then for the keepalive timeout
    // to fire and trigger a reconnect (a new wire connection).
    await wait(400);
    expect(connectionCount()).toBeGreaterThan(1);
    const status = client.getStatus();
    expect(['reconnecting', 'connecting', 'connected', 'error']).toContain(status.state);
  });

  test('survives duplicate ready frames from a slow first handshake (first-request 500 regression)', async () => {
    // firstHelloDelayMs > helloRetryMs (20ms): the client retries `hello`
    // several times, and the host answers every retry with `ready`. The
    // duplicate `ready` frames arrive after the client established and must
    // NOT reset the channel or fail the first in-flight request.
    const { client, connectionCount, sendTextToClient } = await setupClient({ firstHelloDelayMs: 70 });
    track(client);
    // First request in flight with a streamed response...
    const response = await client.fetch('/stream');
    const reader = response.body!.getReader();
    await reader.read();
    // ...when a straggler duplicate `ready` (the host's answer to a retried
    // hello) lands on the established channel. Real-world timing: the retry
    // answer crosses the relay ~helloRetryMs after the first `ready`.
    sendTextToClient(JSON.stringify({ t: 'ready', v: 1 }));
    const chunks: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(textDecoder.decode(value));
    }
    expect(chunks.join('')).toContain('chunk');
    expect(connectionCount()).toBe(1);
    expect(client.getStatus().state).toBe('connected');
    const again = await client.fetch('/health');
    expect(again.status).toBe(200);
    expect(connectionCount()).toBe(1);
  });

  test('fails closed on non-ready plaintext after establishment', async () => {
    const { client, connectionCount, sendTextToClient } = await setupClient();
    track(client);
    const failures: string[] = [];
    client.subscribeStatus((status) => {
      if (status.failureClassification) failures.push(status.failureClassification);
    });
    await client.fetch('/health');
    expect(connectionCount()).toBe(1);
    sendTextToClient('{"anything":"plaintext"}');
    // The channel must reset (fail closed) and the client reconnect a new wire.
    await wait(150);
    expect(connectionCount()).toBeGreaterThan(1);
    expect(failures).toContain('protocol');
  });

  test('publishes status transitions to subscribers', async () => {
    const { client } = await setupClient();
    track(client);
    const seen: string[] = [];
    client.subscribeStatus((status) => seen.push(status.state));
    await client.fetch('/health');
    expect(seen).toContain('connected');
  });

  test('packs a burst of WS messages into far fewer wire messages, preserving order', async () => {
    const received: TunnelFrame[] = [];
    const { client, clientBinaryCount } = await setupClient(
      { recordFrame: (frame) => received.push(frame) },
      { batchWindowMs: 100 },
    );
    track(client);
    const socket = client.openWebSocket('/api/event/ws');
    await new Promise<void>((resolve) => {
      socket.onopen = () => resolve();
    });

    const echoes: string[] = [];
    socket.onmessage = (event) => {
      if (typeof event.data === 'string') echoes.push(event.data);
    };

    const BURST = 50;
    const baseline = clientBinaryCount(); // WsOpen etc. before the burst
    for (let i = 0; i < BURST; i += 1) socket.send(`m${i}`);

    // Wait for the trailing window to flush and echoes to round-trip.
    await wait(250);

    const bodyFrames = received.filter((f) => f.frameType === TunnelFrameType.WsText);
    expect(bodyFrames.length).toBe(BURST);
    // Order preserved: the host saw m0..m49 in sequence.
    expect(bodyFrames.map((f) => textDecoder.decode(f.payload))).toEqual(
      Array.from({ length: BURST }, (_, i) => `m${i}`),
    );
    // Echoes arrived in order too.
    expect(echoes).toEqual(Array.from({ length: BURST }, (_, i) => `echo:m${i}`));

    // The 50 frames crossed the wire as a handful of encrypted messages, not 50.
    const burstWireMessages = clientBinaryCount() - baseline;
    expect(burstWireMessages).toBeLessThan(BURST / 3);
    expect(burstWireMessages).toBeGreaterThan(0);
  });

  test('leading edge: a single frame after idle is delivered immediately, not a window later', async () => {
    const WINDOW = 300;
    let firstWsTextAt = 0;
    const { client } = await setupClient(
      {
        recordFrame: (frame) => {
          if (frame.frameType === TunnelFrameType.WsText && firstWsTextAt === 0) {
            firstWsTextAt = Date.now();
          }
        },
      },
      { batchWindowMs: WINDOW },
    );
    track(client);
    const socket = client.openWebSocket('/api/event/ws');
    await new Promise<void>((resolve) => {
      socket.onopen = () => resolve();
    });
    // Stay idle beyond the window so the next frame takes the leading edge.
    await wait(WINDOW + 50);
    const sentAt = Date.now();
    socket.send('solo');
    await wait(WINDOW / 2);
    expect(firstWsTextAt).toBeGreaterThan(0);
    // Delivered well within a full window (leading-edge flush), not delayed.
    expect(firstWsTextAt - sentAt).toBeLessThan(WINDOW / 2);
  });

  test('boundary frame (StreamEnd) flushes buffered body immediately', async () => {
    // A large batch window would stall a POST body if StreamEnd did not force a
    // flush; the request completing quickly proves the boundary flush.
    const { client } = await setupClient({}, { batchWindowMs: 1_000 });
    track(client);
    const start = Date.now();
    const response = await client.fetch('/echo-body', { method: 'POST', body: 'boundary-body' });
    expect(await response.text()).toBe('boundary-body');
    expect(Date.now() - start).toBeLessThan(500);
  });

  test('keepalive: no ping while frames flow, ping fires after idle', async () => {
    const pings: number[] = [];
    const { client } = await setupClient(
      {
        recordFrame: (frame) => {
          if (frame.frameType === TunnelFrameType.Ping) pings.push(Date.now());
        },
      },
      { pingIntervalMs: 40, pingTimeoutMs: 5_000, batchWindowMs: 20 },
    );
    track(client);
    const socket = client.openWebSocket('/api/event/ws');
    await new Promise<void>((resolve) => {
      socket.onopen = () => resolve();
    });

    // Keep traffic flowing faster than the ping interval for a few intervals.
    const busyUntil = Date.now() + 200;
    while (Date.now() < busyUntil) {
      socket.send('keepbusy');
      await wait(10);
    }
    expect(pings.length).toBe(0);

    // Now go idle: a ping must appear once we exceed the interval.
    await wait(150);
    expect(pings.length).toBeGreaterThan(0);
  });

  test('negotiates legacy (no batch) when the host does not advertise batching', async () => {
    // Host advertises batch:false -> both directions fall back to one frame per
    // encrypted message. Everything still works end to end.
    const { client } = await setupClient({ batch: false });
    track(client);
    const socket = client.openWebSocket('/api/event/ws');
    await new Promise<void>((resolve) => {
      socket.onopen = () => resolve();
    });
    const message = new Promise<string>((resolve) => {
      socket.onmessage = (event) => {
        if (typeof event.data === 'string') resolve(event.data);
      };
    });
    socket.send('legacy');
    expect(await message).toBe('echo:legacy');
    const health = await client.fetch('/health');
    expect(health.status).toBe(200);
  });
});
