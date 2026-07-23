import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { createGlobalMessageStreamHub } from './global-hub.js';
import { createGlobalUiEventBroadcaster, createMessageStreamWsRuntime } from './runtime.js';

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
            'id: evt-1\ndata: {"type":"server.connected","properties":{}}\n\n',
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
    expect(firstSocket.sent).toContainEqual({
      type: 'event',
      payload: { type: 'server.connected', properties: {} },
      eventId: 'evt-1',
      directory: 'global',
    });
    expect(secondSocket.sent).toContainEqual({
      type: 'event',
      payload: { type: 'server.connected', properties: {} },
      eventId: 'evt-1',
      directory: 'global',
    });

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
              'id: evt-1\ndata: {"type":"server.connected","properties":{}}\n\n',
              'id: evt-2\ndata: {"type":"session.updated","properties":{"directory":"/tmp/project"}}\n\n',
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
    runtime.wsServer.emit('connection', secondSocket, { url: '/api/global/event/ws?lastEventId=evt-1' });

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(secondSocket.sent).toContainEqual({ type: 'ready', scope: 'global' });
    expect(secondSocket.sent).toContainEqual({
      type: 'event',
      payload: { type: 'session.updated', properties: { directory: '/tmp/project' } },
      eventId: 'evt-2',
      directory: '/tmp/project',
    });

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
            'id: evt-1\ndata: {"type":"server.connected","properties":{}}\n\n',
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
              'id: evt-1\ndata: {"type":"server.connected","properties":{}}\n\n',
            ],
          });
        }

        return createSseResponse({
          signal: options.signal,
          holdOpen: true,
          blocks: [
            'id: evt-2\ndata: {"type":"server.connected","properties":{}}\n\n',
          ],
        });
      },
    });

    const socket = new FakeSocket();
    runtime.wsServer.emit('connection', socket, { url: '/api/global/event/ws' });

    await new Promise((resolve) => setTimeout(resolve, 35));

    const readyFrames = socket.sent.filter((frame) => frame.type === 'ready');
    const eventFrames = socket.sent.filter((frame) => frame.type === 'event' && frame.payload?.type === 'server.connected');

    expect(readyFrames.length).toBeGreaterThanOrEqual(2);
    expect(eventFrames.length).toBeGreaterThanOrEqual(2);
    expect(fetchCalls.slice(0, 2)).toEqual([null, 'evt-1']);
    expect(triggerHealthCheckCalls).toBe(0);

    socket.close();
    await runtime.close();
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
        if (payload.type === 'session.updated') {
          emitSynthetic({ type: 'openchamber:session-status', sessionID: 'ses_1' });
        }
      },
      wsClients,
      upstreamReconnectDelayMs: 0,
      fetchImpl: async (_url, options) => createSseResponse({
        signal: options.signal,
        holdOpen: true,
        blocks: [
          'id: evt-1\ndata: {"type":"session.updated","properties":{"directory":"/tmp/project"}}\n\n',
        ],
      }),
    });

    const socket = new FakeSocket();
    runtime.wsServer.emit('connection', socket, { url: '/api/global/event/ws' });

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(socket.sent).toContainEqual({
      type: 'event',
      payload: { type: 'session.updated', properties: { directory: '/tmp/project' } },
      eventId: 'evt-1',
      directory: '/tmp/project',
    });
    expect(socket.sent).toContainEqual({
      type: 'event',
      payload: { type: 'openchamber:session-status', sessionID: 'ses_1' },
      directory: 'global',
    });

    socket.close();
    await runtime.close();
  });

  it('recovers upstream connection and resumes WS event delivery after buildUrl recovers (shared hub, production scenario)', async () => {
    const server = new EventEmitter();
    const wsClients = new Set();
    let buildUrlCalls = 0;

    // Phase 1: buildUrl succeeds, fetch returns a short SSE stream
    // Phase 2: buildUrl fails repeatedly (OpenCode port gone)
    // Phase 3: buildUrl recovers, fetch succeeds again
    const buildOpenCodeUrl = vi.fn().mockImplementation(() => {
      buildUrlCalls += 1;
      if (buildUrlCalls === 1) {
        return 'http://127.0.0.1:4096/global/event';
      }
      // Simulate OpenCode port being unavailable
      if (buildUrlCalls <= 5) {
        throw new Error('OpenCode service unavailable');
      }
      // Service recovers after 5 failed attempts
      return 'http://127.0.0.1:4096/global/event';
    });

    let fetchCalls = 0;
    const fetchImpl = vi.fn().mockImplementation(async (_url, options) => {
      fetchCalls += 1;
      // First response ends immediately so the reader loops back to buildUrl
      if (fetchCalls === 1) {
        return createSseResponse({
          signal: options.signal,
          holdOpen: false,
          blocks: [
            'id: evt-1\ndata: {"type":"server.connected","properties":{}}\n\n',
          ],
        });
      }
      // Subsequent responses hold open indefinitely
      return createSseResponse({
        signal: options.signal,
        holdOpen: true,
        blocks: [
          `id: evt-${fetchCalls + 100}\ndata: {"type":"server.connected","properties":{}}\n\n`,
        ],
      });
    });

    // Shared hub — exactly how production index.js creates and passes it
    const globalHub = createGlobalMessageStreamHub({
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl,
      upstreamReconnectDelayMs: 0,
    });

    const runtime = createMessageStreamWsRuntime({
      server,
      uiAuthController: null,
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade() {
        throw new Error('upgrade should not be used in this test');
      },
      globalEventHub: globalHub,  // shared hub, ownsGlobalHub=false
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders: () => ({}),
      processForwardedEventPayload() {},
      wsClients,
      heartbeatIntervalMs: 5000,
      upstreamReconnectDelayMs: 0,
      fetchImpl,
    });

    const socket = new FakeSocket();
    runtime.wsServer.emit('connection', socket, { url: '/api/global/event/ws' });
    await new Promise((resolve) => setTimeout(resolve, 15));

    // First SSE stream ended → reader reconnects → buildUrl fails
    // Reader keeps retrying with buildUrl failures
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify buildUrl was called for initial success + retries during failure period
    expect(buildUrlCalls).toBeGreaterThanOrEqual(6);

    // Client stays connected — WS bridge does NOT close on 'error' status
    // (only on 'initial-error', which only fires before everConnected)
    expect(socket.readyState).toBe(1);

    // buildUrl recovered on call 6 → reader reconnected
    // Hub notified {type:'connect', wasReady:true}
    // WS bridge should have sent a fresh ready frame
    const readyFrames = socket.sent.filter((f) => f.type === 'ready');
    expect(readyFrames.length).toBeGreaterThanOrEqual(2);

    // Events flowed after reconnection
    const eventFrames = socket.sent.filter((f) => f.type === 'event');
    expect(eventFrames.length).toBeGreaterThanOrEqual(2);

    socket.close();
    await runtime.close();
  });

  // --- Reproduction of the exact scenario from issue #2380 ---
  // The issue reports that after an event stream disconnection:
  //   Message stream WS proxy error: terminated
  //   [PushWatcher] disconnected terminated
  //   Message stream WS proxy error: Error: OpenCode service unavailable
  //   [PushWatcher] disconnected OpenCode service unavailable
  // OpenCode recovers but the UI never gets streamed output.
  //
  // This test reproduces the event flow: connected → stream error →
  // buildUrl failure → buildUrl recovery → verify events resume.
  it('reproduces issue #2380 event flow: connected → terminated → service unavailable → recovery → events resume', async () => {
    const server = new EventEmitter();
    const wsClients = new Set();
    const capturedWarns = [];

    // The exact sequence from the bug:
    // 1. Stream is working, events flow
    // 2. Stream gets "terminated" error (fetch error)
    // 3. On retry, buildUrl throws "OpenCode service unavailable" (port gone)
    // 4. After several failures, buildUrl recovers and the stream reconnects
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args) => {
      capturedWarns.push(args.join(' '));
    });

    let attemptNum = 0;
    const buildOpenCodeUrl = vi.fn().mockImplementation(() => {
      attemptNum += 1;
      // First call: service is up
      if (attemptNum === 1) {
        return 'http://127.0.0.1:4096/global/event';
      }
      // Calls 2-3: port is gone (simulating managed restart)
      if (attemptNum <= 3) {
        throw new Error('OpenCode service unavailable');
      }
      // Call 4+: service is back with a new port
      return 'http://127.0.0.1:4097/global/event';
    });

    let fetchCount = 0;
    const fetchImpl = vi.fn().mockImplementation(async (_url, options) => {
      fetchCount += 1;
      if (fetchCount === 1) {
        // First fetch: return a response that simulates a "terminated" error
        // We abort the signal to simulate the stream being terminated
        const controller = new AbortController();
        const signal = controller.signal;
        // Link to the reader's abort signal
        options.signal.addEventListener('abort', () => controller.abort());
        // Schedule an abort to simulate "terminated"
        setTimeout(() => controller.abort(), 5);
        return createSseResponse({
          signal,
          holdOpen: true,
          blocks: [
            'id: evt-1\ndata: {"type":"server.connected","properties":{}}\n\n',
          ],
        });
      }
      // Second+ fetch: normal response that holds open
      return createSseResponse({
        signal: options.signal,
        holdOpen: true,
        blocks: [
          `id: evt-${fetchCount + 100}\ndata: {"type":"server.connected","properties":{}}\n\n`,
        ],
      });
    });

    // Shared hub (production scenario)
    const globalHub = createGlobalMessageStreamHub({
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl,
      upstreamReconnectDelayMs: 0,
    });

    const runtime = createMessageStreamWsRuntime({
      server,
      uiAuthController: null,
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade() {
        throw new Error('upgrade should not be used in this test');
      },
      globalEventHub: globalHub,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders: () => ({}),
      processForwardedEventPayload() {},
      wsClients,
      heartbeatIntervalMs: 5000,
      upstreamReconnectDelayMs: 0,
      fetchImpl,
    });

    const socket = new FakeSocket();
    runtime.wsServer.emit('connection', socket, { url: '/api/global/event/ws' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    // First fetch was aborted (simulating "terminated").
    // Reader reconnects → buildUrl throws → onError with "OpenCode service unavailable"
    // Then on retry, buildUrl recovers → fetch succeeds → events flow
    await new Promise((resolve) => setTimeout(resolve, 40));

    // Verify the WS proxy error was logged (matching user's log)
    const terminatedErrors = capturedWarns.filter(
      (w) => w.includes('Message stream WS proxy error:')
    );
    expect(terminatedErrors.length).toBeGreaterThanOrEqual(1);

    // BuildUrl was called multiple times (initial + failures + recovery)
    expect(attemptNum).toBeGreaterThanOrEqual(4);

    // Events flowed after recovery
    const eventFrames = socket.sent.filter((f) => f.type === 'event');
    expect(eventFrames.length).toBeGreaterThanOrEqual(2);

    // Ready frames: initial + recovery
    const readyFrames = socket.sent.filter((f) => f.type === 'ready');
    expect(readyFrames.length).toBeGreaterThanOrEqual(2);

    warnSpy.mockRestore();
    socket.close();
    await runtime.close();
  });
});
