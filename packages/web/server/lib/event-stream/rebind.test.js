import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { createGlobalMessageStreamHub } from './global-hub.js';
import { createMessageStreamWsRuntime } from './runtime.js';

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

describe('rebindUpstream (#2638)', () => {
  it('restarts the shared hub upstream so a connected client resumes receiving events on the new port', async () => {
    const server = new EventEmitter();
    const wsClients = new Set();
    let port = 4096;
    let fetchCalls = 0;

    // Port changes after a managed restart: buildOpenCodeUrl resolves the
    // CURRENT port on every attempt, exactly like production network-runtime.
    const buildOpenCodeUrl = vi.fn(() => `http://127.0.0.1:${port}/global/event`);
    const fetchImpl = vi.fn(async (_url, options) => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return createSseResponse({
          signal: options.signal,
          holdOpen: true,
          blocks: ['id: evt-1\ndata: {"type":"server.connected","properties":{}}\n\n'],
        });
      }
      return createSseResponse({
        signal: options.signal,
        holdOpen: true,
        blocks: ['id: evt-2\ndata: {"type":"session.updated","properties":{"sessionID":"ses_1"}}\n\n'],
      });
    });

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
    expect(fetchCalls).toBe(1);
    expect(socket.sent.some((frame) => frame.type === 'event' && frame.eventId === 'evt-1')).toBe(true);

    // The managed process was restarted onto a new port while the old
    // process's SSE stream stays open (orphaned survivor).
    port = 5000;
    runtime.rebindUpstream();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The hub dialed the new port and the connected client received events
    // from the new upstream without reconnecting its own socket.
    expect(fetchCalls).toBe(2);
    expect(fetchImpl.mock.calls[1][0]).toContain(':5000/global/event');
    expect(socket.sent.some((frame) => frame.type === 'event' && frame.eventId === 'evt-2')).toBe(true);

    socket.close();
    await runtime.close();
  });

  it('closes directory-scoped sockets so their pinned readers reconnect to the new port', async () => {
    const server = new EventEmitter();
    const wsClients = new Set();
    let port = 4096;
    let fetchCalls = 0;

    const buildOpenCodeUrl = vi.fn(() => `http://127.0.0.1:${port}/event`);
    const fetchImpl = vi.fn(async (_url, options) => {
      fetchCalls += 1;
      return createSseResponse({
        signal: options.signal,
        holdOpen: true,
        blocks: ['id: evt-1\ndata: {"type":"server.connected","properties":{}}\n\n'],
      });
    });

    const runtime = createMessageStreamWsRuntime({
      server,
      uiAuthController: null,
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade() {
        throw new Error('upgrade should not be used in this test');
      },
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders: () => ({}),
      processForwardedEventPayload() {},
      wsClients,
      heartbeatIntervalMs: 5000,
      upstreamReconnectDelayMs: 0,
      fetchImpl,
    });

    const directorySocket = new FakeSocket();
    runtime.wsServer.emit('connection', directorySocket, { url: '/api/event/ws?directory=%2Fproj' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchCalls).toBe(1);

    port = 5000;
    runtime.rebindUpstream();

    expect(directorySocket.readyState).toBe(3);
    expect(directorySocket.closeCalls.length).toBeGreaterThan(0);

    directorySocket.close();
    await runtime.close();
  });
});
