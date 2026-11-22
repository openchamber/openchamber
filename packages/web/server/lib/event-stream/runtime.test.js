import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createGlobalUiEventBroadcaster, createMessageStreamWsRuntime } from './runtime.js';
import { createGlobalMessageStreamHub } from './global-hub.js';
import { decodeOpenChamberCursor } from './sse-cursor.js';
import { MESSAGE_STREAM_WS_MAX_PAYLOAD_BYTES } from './protocol.js';
import { createNotificationEmitterRuntime } from '../notifications/emitter-runtime.js';

// OpenCode's cursor form, `<instance>:<sequence>`, as its feed puts it in `id:` lines. Only such ids
// reach the browser as cursors, so the fixtures below that check cursors use them.
const INSTANCE = '6b1f3c2e-8d4a-4f7b-9c3e-2a5d7e9f1b40';

it('serializes a UI broadcast once per wire format and isolates failed clients', () => {
  let serializations = 0;
  const payload = { toJSON() { serializations++; return { type: 'openchamber:test', properties: { value: 'same' } }; } };
  const writes = [];
  const sseClients = new Set(Array.from({ length: 4 }, () => ({ write: text => writes.push(text) })));
  const sockets = Array.from({ length: 4 }, () => ({ readyState: 1, bufferedAmount: 0, send: text => writes.push(text) }));
  const failed = { readyState: 1, bufferedAmount: 0, send() { throw new Error('closed'); } };
  const wsClients = new Set([...sockets, failed]);
  const { writeSseEvent } = createNotificationEmitterRuntime({});
  const broadcast = createGlobalUiEventBroadcaster({ sseClients, wsClients, writeSseEvent });
  broadcast(payload);
  expect(serializations).toBe(2);
  expect(writes).toHaveLength(8);
  expect(wsClients.has(failed)).toBe(false);
  expect(wsClients.size).toBe(4);
  expect(writes[0]).toBe(writes[3]);
  expect(writes[4]).toBe(writes[7]);
  sseClients.clear(); wsClients.clear();
  broadcast(payload);
  expect(serializations).toBe(2);
});

it('delivers oversized events live, but reports a replay gap instead of replaying across it', async () => {
  const hub = createGlobalMessageStreamHub({
    buildOpenCodeUrl: path => `http://127.0.0.1:4096${path}`,
    getOpenCodeAuthHeaders: () => ({}),
    replayByteLimit: 512,
    fetchImpl: async (_url, options) => createSseResponse({
      signal: options.signal, holdOpen: true,
      blocks: [
        `id: ${INSTANCE}:1\ndata: {"id":"first","type":"first","properties":{}}\n\n`,
        `id: ${INSTANCE}:2\ndata: ${JSON.stringify({ id: 'large', type: 'large', properties: { text: '界'.repeat(1024) } })}\n\n`,
        `id: ${INSTANCE}:3\ndata: {"id":"last","type":"last","properties":{}}\n\n`,
      ],
    }),
  });
  const runtime = createMessageStreamWsRuntime({
    server: new EventEmitter(), globalEventHub: hub, wsClients: new Set(),
    uiAuthController: null, isRequestOriginAllowed: async () => true,
    rejectWebSocketUpgrade() {}, buildOpenCodeUrl: path => `http://127.0.0.1:4096${path}`,
    getOpenCodeAuthHeaders: () => ({}), processForwardedEventPayload() {},
  });
  const first = new FakeSocket();
  const reconnect = new FakeSocket();
  try {
    runtime.wsServer.emit('connection', first, { url: '/api/global/event/ws' });
    await expect.poll(() => first.sent.filter(frame => frame.type === 'event').length).toBe(3);
    expect(first.sent.find(frame => decodeOpenChamberCursor(frame.eventId)?.upstream === `${INSTANCE}:2`).payload.properties.text).toHaveLength(1024);
    expect(hub.replayAfter(`${INSTANCE}:1`)).toBeNull();
    expect(hub.replayAfter(`${INSTANCE}:3`)).toEqual([]);
    // A legacy cursor from before OpenCode ids is one the buffer cannot answer: it gets a reset.
    runtime.wsServer.emit('connection', reconnect, { url: '/api/global/event/ws?lastEventId=first' });
    await expect.poll(() => reconnect.sent.length).toBeGreaterThan(0);
    expect(reconnect.sent).toHaveLength(1);
    expect(reconnect.sent[0]).toMatchObject({ type: 'ready', scope: 'global', replayReset: true });
    expect(decodeOpenChamberCursor(reconnect.sent[0].headEventId)?.upstream).toBe(`${INSTANCE}:3`);
  } finally {
    first.close(); reconnect.close(); hub.stop(); await runtime.close();
  }
});

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
    this.closeCalls = [];
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  ping() {
    void 0;
  }

  close(code, reason) {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.closeCalls.push({ code, reason });
    this.emit('close');
  }
}

function createSseResponse({ blocks = [], signal, holdOpen = false }) {
  const encoder = new TextEncoder();
  let index = 0;

  return {
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            if (index < blocks.length) {
              const next = blocks[index++];
              return { value: encoder.encode(next), done: false };
            }

            if (!holdOpen) {
              return { value: undefined, done: true };
            }

            return new Promise((resolve, reject) => {
              const onAbort = () => {
                signal.removeEventListener('abort', onAbort);
                const error = new Error('Aborted');
                error.name = 'AbortError';
                reject(error);
              };
              signal.addEventListener('abort', onAbort, { once: true });
            });
          },
        };
      },
    },
  };
}

describe('event stream broadcaster', () => {
  it('fans out synthetic events to SSE and WS clients', () => {
    const sseEvents = [];
    const wsPayloads = [];
    const sseClient = { id: 'sse-1' };
    const wsClient = {
      readyState: 1,
      send(payload) {
        wsPayloads.push(JSON.parse(payload));
      },
    };

    const broadcast = createGlobalUiEventBroadcaster({
      sseClients: new Set([sseClient]),
      wsClients: new Set([wsClient]),
      writeSseEvent(res, payload) {
        sseEvents.push({ res, payload });
      },
    });

    broadcast({ type: 'openchamber:session-status' }, { eventId: 'evt-1', directory: '/tmp/project' });

    expect(sseEvents).toEqual([
      {
        res: sseClient,
        payload: { type: 'openchamber:session-status' },
      },
    ]);
    expect(wsPayloads).toEqual([
      {
        type: 'event',
        payload: { type: 'openchamber:session-status' },
        eventId: 'evt-1',
        directory: '/tmp/project',
      },
    ]);
  });

  it('removes websocket clients that fail to receive a payload', () => {
    const wsClients = new Set([
      {
        readyState: 1,
        send() {
          throw new Error('socket write failed');
        },
      },
    ]);

    const broadcast = createGlobalUiEventBroadcaster({
      sseClients: new Set(),
      wsClients,
      writeSseEvent() {
        throw new Error('should not be called');
      },
    });

    broadcast({ type: 'openchamber:notification' });

    expect(wsClients.size).toBe(0);
  });
});

describe('message stream websocket runtime', () => {
  it('shares one global upstream SSE reader across multiple websocket clients', async () => {
    const server = new EventEmitter();
    const wsClients = new Set();
    let fetchCalls = 0;

    const runtime = createMessageStreamWsRuntime({
      server,
      uiAuthController: null,
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade() {
        throw new Error('upgrade should not be used in this test');
      },
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      processForwardedEventPayload() {},
      wsClients,
      upstreamReconnectDelayMs: 0,
      fetchImpl: async (_url, options) => {
        fetchCalls += 1;
        return createSseResponse({
          signal: options.signal,
          holdOpen: true,
          blocks: [
            `id: ${INSTANCE}:1\ndata: {"id":"evt-1","type":"server.connected","data":{}}\n\n`,
          ],
        });
      },
    });

    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    runtime.wsServer.emit('connection', firstSocket, { url: '/api/global/event/ws' });
    runtime.wsServer.emit('connection', secondSocket, { url: '/api/global/event/ws' });

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(fetchCalls).toBe(1);
    expect(firstSocket.sent).toContainEqual({ type: 'ready', scope: 'global' });
    expect(secondSocket.sent).toContainEqual({ type: 'ready', scope: 'global' });
    for (const socket of [firstSocket, secondSocket]) {
      const greeting = socket.sent.find((frame) => frame.payload?.type === 'server.connected');
      expect(greeting).toEqual(expect.objectContaining({
        type: 'event',
        payload: { id: 'evt-1', type: 'server.connected', data: {} },
        directory: 'global',
      }));
      // A greeting that carries an OpenCode id line is an ordinary upstream event and gets a cursor.
      expect(decodeOpenChamberCursor(greeting.eventId)?.upstream).toBe(`${INSTANCE}:1`);
    }

    firstSocket.close();
    secondSocket.close();
    await runtime.close();
  });

  it('replays buffered global events after a reconnecting client Last-Event-ID', async () => {
    const server = new EventEmitter();
    const wsClients = new Set();
    let fetchCalls = 0;

    const runtime = createMessageStreamWsRuntime({
      server,
      uiAuthController: null,
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade() {
        throw new Error('upgrade should not be used in this test');
      },
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      processForwardedEventPayload() {},
      wsClients,
      upstreamReconnectDelayMs: 0,
      fetchImpl: async (_url, options) => {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          return createSseResponse({
            signal: options.signal,
            holdOpen: true,
            blocks: [
              `id: ${INSTANCE}:1\ndata: {"id":"evt-1","type":"session.renamed","location":{"directory":"/tmp/project"},"data":{"sessionID":"s1","title":"t"}}\n\n`,
              `id: ${INSTANCE}:2\ndata: {"id":"evt-2","type":"session.updated","location":{"directory":"/tmp/project"},"data":{"sessionID":"s1"}}\n\n`,
            ],
          });
        }

        return createSseResponse({
          signal: options.signal,
          holdOpen: true,
          blocks: [],
        });
      },
    });

    const firstSocket = new FakeSocket();
    runtime.wsServer.emit('connection', firstSocket, { url: '/api/global/event/ws' });

    await new Promise((resolve) => setTimeout(resolve, 5));
    firstSocket.close();

    const secondSocket = new FakeSocket();
    runtime.wsServer.emit('connection', secondSocket, { url: `/api/global/event/ws?lastEventId=${INSTANCE}:1` });

    await new Promise((resolve) => setTimeout(resolve, 5));

    // The buffer holds the cursor's successors, so the client resumed: it needs no refetch.
    expect(secondSocket.sent[0].type).toBe('ready');
    expect(secondSocket.sent[0].resumed).toBe(true);
    expect(decodeOpenChamberCursor(secondSocket.sent[0].headEventId)?.upstream).toBe(`${INSTANCE}:2`);
    expect(secondSocket.sent[1]).toEqual(expect.objectContaining({
      type: 'event',
      payload: { id: 'evt-2', type: 'session.updated', location: { directory: '/tmp/project' }, data: { sessionID: 's1' } },
      directory: '/tmp/project',
    }));
    expect(decodeOpenChamberCursor(secondSocket.sent[1].eventId)?.upstream).toBe(`${INSTANCE}:2`);

    secondSocket.close();
    await runtime.close();
  });

  it('keeps directory websocket streams on separate upstream readers', async () => {
    const server = new EventEmitter();
    const wsClients = new Set();
    const fetchUrls = [];

    const runtime = createMessageStreamWsRuntime({
      server,
      uiAuthController: null,
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade() {
        throw new Error('upgrade should not be used in this test');
      },
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      processForwardedEventPayload() {},
      wsClients,
      upstreamReconnectDelayMs: 0,
      fetchImpl: async (url, options) => {
        fetchUrls.push(url);
        return createSseResponse({
          signal: options.signal,
          holdOpen: true,
          blocks: [
            'data: {"id":"evt-1","type":"server.connected","data":{}}\n\n',
          ],
        });
      },
    });

    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    runtime.wsServer.emit('connection', firstSocket, { url: '/api/event/ws?directory=/tmp/one' });
    runtime.wsServer.emit('connection', secondSocket, { url: '/api/event/ws?directory=/tmp/two' });

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(fetchUrls).toHaveLength(2);
    expect(new URL(fetchUrls[0]).searchParams.get('directory')).toBe('/tmp/one');
    expect(new URL(fetchUrls[1]).searchParams.get('directory')).toBe('/tmp/two');
    expect(firstSocket.sent).toContainEqual({ type: 'ready', scope: 'directory' });
    expect(secondSocket.sent).toContainEqual({ type: 'ready', scope: 'directory' });

    firstSocket.close();
    secondSocket.close();
    await runtime.close();
  });

  it('refuses repeated directory or lastEventId params instead of silently first-picking one (#2315)', async () => {
    const server = new EventEmitter();
    const wsClients = new Set();
    let fetchCalls = 0;

    const runtime = createMessageStreamWsRuntime({
      server,
      uiAuthController: null,
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade() {
        throw new Error('upgrade should not be used in this test');
      },
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      processForwardedEventPayload() {},
      wsClients,
      upstreamReconnectDelayMs: 0,
      fetchImpl: async (_url, options) => {
        fetchCalls += 1;
        return createSseResponse({
          signal: options.signal,
          holdOpen: true,
          blocks: [],
        });
      },
    });

    const ambiguousUrls = [
      '/api/event/ws?directory=/tmp/one&directory=/tmp/two',
      '/api/event/ws?directory=/tmp/one&lastEventId=1&lastEventId=2',
      '/api/global/event/ws?lastEventId=1&lastEventId=2',
    ];

    for (const url of ambiguousUrls) {
      const socket = new FakeSocket();
      runtime.wsServer.emit('connection', socket, { url });

      expect(socket.sent).toEqual([
        {
          type: 'error',
          message: 'Ambiguous message stream parameters: directory and lastEventId may each appear at most once',
        },
      ]);
      expect(socket.closeCalls).toEqual([{ code: 1008, reason: 'Ambiguous message stream parameters' }]);
    }

    // No ambiguous connection reached an upstream reader or a bridge.
    expect(fetchCalls).toBe(0);

    await runtime.close();
  });

  it('closes the websocket and triggers health check on initial upstream unavailable response', async () => {
    const server = new EventEmitter();
    const wsClients = new Set();
    let triggerHealthCheckCalls = 0;

    const runtime = createMessageStreamWsRuntime({
      server,
      uiAuthController: null,
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade() {
        throw new Error('upgrade should not be used in this test');
      },
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      processForwardedEventPayload() {},
      wsClients,
      triggerHealthCheck: () => {
        triggerHealthCheckCalls += 1;
      },
      upstreamReconnectDelayMs: 0,
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        body: null,
      }),
    });

    const socket = new FakeSocket();
    runtime.wsServer.emit('connection', socket, { url: '/api/global/event/ws' });

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(socket.sent).toEqual([
      {
        type: 'error',
        message: 'OpenCode event stream unavailable (503)',
      },
    ]);
    expect(socket.closeCalls).toEqual([
      {
        code: 1011,
        reason: 'OpenCode event stream unavailable',
      },
    ]);
    expect(triggerHealthCheckCalls).toBe(1);
    expect(wsClients.size).toBe(0);

    await runtime.close();
  });

  it('closes the websocket without health check when OpenCode URL cannot be built', async () => {
    const server = new EventEmitter();
    const wsClients = new Set();
    let triggerHealthCheckCalls = 0;
    let fetchCalls = 0;

    const runtime = createMessageStreamWsRuntime({
      server,
      uiAuthController: null,
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade() {
        throw new Error('upgrade should not be used in this test');
      },
      buildOpenCodeUrl() {
        throw new Error('missing OpenCode port');
      },
      getOpenCodeAuthHeaders: () => ({}),
      processForwardedEventPayload() {},
      wsClients,
      triggerHealthCheck: () => {
        triggerHealthCheckCalls += 1;
      },
      upstreamReconnectDelayMs: 0,
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error('fetch should not be called');
      },
    });

    const socket = new FakeSocket();
    runtime.wsServer.emit('connection', socket, { url: '/api/global/event/ws' });

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(socket.sent).toEqual([
      {
        type: 'error',
        message: 'OpenCode service unavailable',
      },
    ]);
    expect(socket.closeCalls).toEqual([
      {
        code: 1011,
        reason: 'OpenCode service unavailable',
      },
    ]);
    expect(fetchCalls).toBe(0);
    expect(triggerHealthCheckCalls).toBe(0);

    await runtime.close();
  });

  it('reconnects a stalled upstream SSE stream and resumes from the last event id', async () => {
    const server = new EventEmitter();
    const wsClients = new Set();
    let triggerHealthCheckCalls = 0;
    const fetchCalls = [];
    let upstreamAttempt = 0;

    const runtime = createMessageStreamWsRuntime({
      server,
      uiAuthController: null,
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade() {
        throw new Error('upgrade should not be used in this test');
      },
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      processForwardedEventPayload() {},
      wsClients,
      triggerHealthCheck: () => {
        triggerHealthCheckCalls += 1;
      },
      heartbeatIntervalMs: 50,
      upstreamStallTimeoutMs: 20,
      upstreamReconnectDelayMs: 0,
      fetchImpl: async (_url, options) => {
        const lastEventId = options?.headers?.['Last-Event-ID'] ?? null;
        fetchCalls.push(lastEventId);
        upstreamAttempt += 1;

        if (upstreamAttempt === 1) {
          return createSseResponse({
            signal: options.signal,
            holdOpen: true,
            blocks: [
              `id: ${INSTANCE}:1\ndata: {"id":"evt-1","type":"session.updated","data":{"sessionID":"s1"}}\n\n`,
            ],
          });
        }

        return createSseResponse({
          signal: options.signal,
          holdOpen: true,
          blocks: [
            `id: ${INSTANCE}:2\ndata: {"id":"evt-2","type":"session.updated","data":{"sessionID":"s1"}}\n\n`,
          ],
        });
      },
    });

    const socket = new FakeSocket();
    runtime.wsServer.emit('connection', socket, { url: '/api/global/event/ws' });

    try {
      // Wait for the reconnect event itself; a 35ms sleep raced the event
      // loop when the workspace build and test workers ran together.
      await expect.poll(() => socket.sent.filter((frame) => frame.type === 'ready').length).toBeGreaterThanOrEqual(2);
      const eventFrames = socket.sent.filter((frame) => frame.type === 'event' && frame.payload?.type === 'session.updated');
      expect(eventFrames.length).toBeGreaterThanOrEqual(2);
      // The first two events arrive in order, the second on the connection that resumed from the first.
      expect(eventFrames.slice(0, 2).map((frame) => decodeOpenChamberCursor(frame.eventId)?.upstream))
        .toEqual([`${INSTANCE}:1`, `${INSTANCE}:2`]);
      expect(fetchCalls.slice(0, 2)).toEqual([null, `${INSTANCE}:1`]);
      expect(triggerHealthCheckCalls).toBe(0);
    } finally {
      socket.close();
      await runtime.close();
    }
  });

  it('keeps synthetic event processing on forwarded upstream events', async () => {
    const server = new EventEmitter();
    const wsClients = new Set();

    const runtime = createMessageStreamWsRuntime({
      server,
      uiAuthController: null,
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade() {
        throw new Error('upgrade should not be used in this test');
      },
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      processForwardedEventPayload(payload, emitSynthetic) {
        // The bridge forwards the RAW v2 payload; the synthetic frames the UI
        // also expects are derived from it in `index.js`.
        if (payload.type === 'session.renamed') {
          emitSynthetic({ type: 'openchamber:session-status', sessionID: 'ses_1' });
        }
      },
      wsClients,
      upstreamReconnectDelayMs: 0,
      fetchImpl: async (_url, options) => createSseResponse({
        signal: options.signal,
        holdOpen: true,
        blocks: [
          `id: ${INSTANCE}:1\ndata: {"id":"evt-1","type":"session.renamed","location":{"directory":"/tmp/project"},"data":{"sessionID":"s1","title":"t"}}\n\n`,
        ],
      }),
    });

    const socket = new FakeSocket();
    runtime.wsServer.emit('connection', socket, { url: '/api/global/event/ws' });

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(socket.sent).toContainEqual(expect.objectContaining({
      type: 'event',
      payload: { id: 'evt-1', type: 'session.renamed', location: { directory: '/tmp/project' }, data: { sessionID: 's1', title: 't' } },
      directory: '/tmp/project',
    }));
    expect(decodeOpenChamberCursor(
      socket.sent.find((frame) => frame.payload?.type === 'session.renamed').eventId,
    )?.upstream).toBe(`${INSTANCE}:1`);
    expect(socket.sent).toContainEqual({
      type: 'event',
      payload: { type: 'openchamber:session-status', sessionID: 'ses_1' },
      directory: 'global',
    });

    socket.close();
    await runtime.close();
  });
});

describe('message stream WS payload cap (#1108)', () => {
  async function startRuntime() {
    const server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const hub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: path => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl: async (_url, options) => createSseResponse({
        signal: options.signal, holdOpen: true,
        blocks: [
          `id: ${INSTANCE}:1\ndata: {"id":"first","type":"first","properties":{}}\n\n`,
        ],
      }),
    });
    const runtime = createMessageStreamWsRuntime({
      server, globalEventHub: hub, wsClients: new Set(),
      uiAuthController: null, isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade(_socket, statusCode) {
        throw new Error(`unexpected upgrade rejection: ${statusCode}`);
      },
      buildOpenCodeUrl: path => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}), processForwardedEventPayload() {},
    });
    return { server, hub, runtime, port: server.address().port };
  }

  async function stopRuntime({ server, hub, runtime }) {
    hub.stop();
    await runtime.close();
    await new Promise((resolve) => server.close(resolve));
  }

  function connectClient(port, onMessage) {
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/global/event/ws`);
    if (onMessage) client.on('message', onMessage);
    return new Promise((resolve, reject) => {
      client.once('open', () => resolve(client));
      client.once('error', reject);
    });
  }

  it('closes over-cap message events without relying on ws maxPayload enforcement', async () => {
    const ctx = await startRuntime();
    const atCap = new FakeSocket();
    const overCap = new FakeSocket();
    try {
      ctx.runtime.wsServer.emit('connection', atCap, { url: '/api/global/event/ws' });
      ctx.runtime.wsServer.emit('connection', overCap, { url: '/api/global/event/ws' });
      atCap.emit('message', Buffer.alloc(MESSAGE_STREAM_WS_MAX_PAYLOAD_BYTES), true);
      overCap.emit('message', Buffer.alloc(MESSAGE_STREAM_WS_MAX_PAYLOAD_BYTES + 1), true);

      expect(atCap.closeCalls).toEqual([]);
      expect(overCap.closeCalls).toEqual([{ code: 1009, reason: 'Message stream frame too large' }]);
    } finally {
      atCap.close();
      overCap.close();
      await stopRuntime(ctx);
    }
  }, 20_000);

  it('closes with 1009 when a single frame exceeds the payload cap', async () => {
    const ctx = await startRuntime();
    const client = await connectClient(ctx.port);
    try {
      const closed = new Promise((resolve) => client.once('close', (code) => resolve(code)));
      client.send(Buffer.alloc(MESSAGE_STREAM_WS_MAX_PAYLOAD_BYTES + 1, 0x61));
      const code = await Promise.race([
        closed,
        new Promise((resolve) => setTimeout(() => resolve(0), 5_000)),
      ]);
      expect(code).toBe(1009);
    } finally {
      client.close();
      await stopRuntime(ctx);
    }
  }, 20_000);

  it('keeps the ready flow and an at-cap frame on an open connection', async () => {
    const ctx = await startRuntime();
    const frames = [];
    const client = await connectClient(ctx.port, (data) => frames.push(JSON.parse(String(data))));
    try {
      await expect.poll(() => frames.length).toBeGreaterThan(0);
      expect(frames.some((frame) => frame.type === 'ready' || frame.type === 'event')).toBe(true);
      client.send(Buffer.alloc(MESSAGE_STREAM_WS_MAX_PAYLOAD_BYTES, 0x62));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(client.readyState).toBe(WebSocket.OPEN);
    } finally {
      client.close();
      await stopRuntime(ctx);
    }
  }, 20_000);
});
