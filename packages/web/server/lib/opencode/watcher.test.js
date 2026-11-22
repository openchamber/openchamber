import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGlobalMessageStreamHub } from '../event-stream/global-hub.js';
import { createOpenCodeWatcherRuntime } from './watcher.js';

function createSseResponse({ blocks = [], signal, holdOpen = false }) {
  const encoder = new TextEncoder();
  let index = 0;

  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            if (index < blocks.length) {
              return { value: encoder.encode(blocks[index++]), done: false };
            }

            if (!holdOpen) {
              return { value: undefined, done: true };
            }

            return new Promise((_resolve, reject) => {
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

describe('createOpenCodeWatcherRuntime', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('waits for OpenCode readiness and forwards unwrapped global SSE payloads', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const payloads = [];
    const fetchCalls = [];

    const watcher = createOpenCodeWatcherRuntime({
      waitForOpenCodePort: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test-token' }),
      onPayload(payload) {
        payloads.push(payload);
        watcher.stop();
      },
      fetchImpl: async (url, options) => {
        fetchCalls.push({ url, headers: options.headers });
        return createSseResponse({
          signal: options.signal,
          blocks: [
            'data: {"directory":"/tmp/project","payload":{"id":"evt-1","type":"session.renamed","location":{"directory":"/tmp/project"},"data":{"sessionID":"ses_1","title":"New"}}}\n\n',
          ],
        });
      },
    });

    await watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fetchCalls).toEqual([
      {
        url: 'http://127.0.0.1:4096/api/event',
        headers: {
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          Authorization: 'Bearer test-token',
        },
      },
    ]);
    // The watcher hands its consumers the server's own vocabulary, translated
    // from the v2 wire event.
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      type: 'session.updated',
      properties: { sessionID: 'ses_1', info: { id: 'ses_1', title: 'New' } },
    });
  });

  it('resumes watcher reconnects with Last-Event-ID after a stalled upstream stream', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchLastEventIds = [];
    const payloads = [];
    let attempt = 0;

    const watcher = createOpenCodeWatcherRuntime({
      waitForOpenCodePort: async () => {},
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      onPayload(payload) {
        payloads.push(payload.type);
        if (payload.type === 'session.updated') {
          watcher.stop();
        }
      },
      fetchImpl: async (_url, options) => {
        fetchLastEventIds.push(options.headers['Last-Event-ID'] ?? null);
        attempt += 1;

        if (attempt === 1) {
          return createSseResponse({
            signal: options.signal,
            holdOpen: true,
            blocks: [
              'data: {"id":"evt-1","type":"server.connected","data":{}}\n\n',
            ],
          });
        }

        return createSseResponse({
          signal: options.signal,
          blocks: [
            'data: {"id":"evt-2","type":"session.renamed","location":{"directory":"/tmp/project"},"data":{"sessionID":"ses_1","title":"New"}}\n\n',
          ],
        });
      },
      upstreamStallTimeoutMs: 10,
      upstreamReconnectDelayMs: 0,
    });

    await watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(payloads).toEqual(['server.connected', 'session.updated']);
    expect(fetchLastEventIds.slice(0, 2)).toEqual([null, 'evt-1']);
  });

  it('subscribes to a shared global event hub instead of opening its own upstream stream', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const payloads = [];
    let hubFetchCalls = 0;
    let watcherFetchCalls = 0;

    const globalEventHub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 0,
      fetchImpl: async (_url, options) => {
        hubFetchCalls += 1;
        return createSseResponse({
          signal: options.signal,
          holdOpen: true,
          blocks: [
            'data: {"payload":{"id":"evt-1","type":"session.renamed","location":{"directory":"/tmp/project"},"data":{"sessionID":"ses_1","title":"New"}}}\n\n',
          ],
        });
      },
    });

    const watcher = createOpenCodeWatcherRuntime({
      waitForOpenCodePort: async () => {},
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      globalEventHub,
      onPayload(payload) {
        payloads.push(payload);
        watcher.stop();
      },
      fetchImpl: async () => {
        watcherFetchCalls += 1;
        throw new Error('watcher fetch should not be called');
      },
    });

    await watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(hubFetchCalls).toBe(1);
    expect(watcherFetchCalls).toBe(0);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      type: 'session.updated',
      properties: { sessionID: 'ses_1', info: { id: 'ses_1', title: 'New' } },
    });
  });

  it('hands an event of an isolated space on with the space\'s id, and the host\'s without one', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const received = [];

    const globalEventHub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 0,
      fetchImpl: async (_url, options) => createSseResponse({
        signal: options.signal,
        holdOpen: true,
        blocks: [
          'data: {"payload":{"id":"evt-1","type":"session.renamed","location":{"directory":"/tmp/project"},"data":{"sessionID":"ses_host","title":"Host"}}}\n\n',
        ],
      }),
    });

    const watcher = createOpenCodeWatcherRuntime({
      waitForOpenCodePort: async () => {},
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      globalEventHub,
      onPayload(payload, context) {
        received.push({ sessionID: payload.properties?.sessionID, spaceId: context.spaceId });
      },
    });

    await watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    globalEventHub.injectEvent({
      payload: { id: 'evt-2', type: 'session.renamed', location: { directory: '/spaces/abc/project' }, data: { sessionID: 'ses_space', title: 'Space' } },
      directory: '/spaces/abc/project',
      spaceId: 'abc',
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    watcher.stop();
    globalEventHub.stop();

    expect(received).toEqual([
      { sessionID: 'ses_host', spaceId: null },
      { sessionID: 'ses_space', spaceId: 'abc' },
    ]);
  });

  it('logs connected once per outage, not on every reconnect of a stalled stream (dezren39/nix#668)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let attempt = 0;
    let hubConnects = 0;

    const globalEventHub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      // A tiny stall window makes every silent connection reconnect, as a 10 s window did against
      // OpenCode's 15 s idle heartbeat.
      upstreamStallTimeoutMs: 5,
      upstreamReconnectDelayMs: 0,
      fetchImpl: async (_url, options) => {
        attempt += 1;
        if (attempt === 4) {
          throw new Error('fetch failed');
        }
        return createSseResponse({ signal: options.signal, holdOpen: true });
      },
    });
    const unsubscribe = globalEventHub.subscribeStatus((status) => {
      if (status.type === 'connect') hubConnects += 1;
    });

    const watcher = createOpenCodeWatcherRuntime({
      waitForOpenCodePort: async () => {},
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      globalEventHub,
      onPayload() {},
    });

    await watcher.start();
    await vi.waitFor(() => expect(attempt).toBeGreaterThanOrEqual(8), { timeout: 2_000, interval: 5 });
    watcher.stop();
    unsubscribe();
    globalEventHub.stop();

    const lines = (spy, prefix) => spy.mock.calls.filter((call) => call[0] === prefix);
    // Positive control: the stream really was torn down and reopened several times, on both sides
    // of the failed fetch.
    expect(hubConnects).toBeGreaterThanOrEqual(6);
    expect(lines(log, '[PushWatcher] connected')).toHaveLength(2);
    expect(lines(warn, '[PushWatcher] disconnected')).toEqual([['[PushWatcher] disconnected', 'fetch failed']]);
  });

  it('logs connected once per outage on its own upstream reader too', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let attempt = 0;

    const watcher = createOpenCodeWatcherRuntime({
      waitForOpenCodePort: async () => {},
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      onPayload() {},
      upstreamStallTimeoutMs: 5,
      upstreamReconnectDelayMs: 0,
      fetchImpl: async (_url, options) => {
        attempt += 1;
        if (attempt === 4) {
          throw new Error('fetch failed');
        }
        return createSseResponse({ signal: options.signal, holdOpen: true });
      },
    });

    await watcher.start();
    await vi.waitFor(() => expect(attempt).toBeGreaterThanOrEqual(8), { timeout: 2_000, interval: 5 });
    watcher.stop();

    const lines = (spy, prefix) => spy.mock.calls.filter((call) => call[0] === prefix);
    // Positive control: seven successful connections, one failed fetch between them.
    expect(attempt).toBeGreaterThanOrEqual(8);
    expect(lines(log, '[PushWatcher] connected')).toHaveLength(2);
    expect(lines(warn, '[PushWatcher] disconnected')).toEqual([['[PushWatcher] disconnected', 'fetch failed']]);
  });

  it('logs connected again after the watcher is stopped and started', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let attempt = 0;

    const watcher = createOpenCodeWatcherRuntime({
      waitForOpenCodePort: async () => {},
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      onPayload() {},
      upstreamReconnectDelayMs: 0,
      fetchImpl: async (_url, options) => {
        attempt += 1;
        return createSseResponse({ signal: options.signal, holdOpen: true });
      },
    });
    const connectedLines = () => log.mock.calls.filter((call) => call[0] === '[PushWatcher] connected').length;

    await watcher.start();
    await vi.waitFor(() => expect(connectedLines()).toBe(1), { timeout: 2_000, interval: 5 });
    watcher.stop();
    await watcher.start();
    await vi.waitFor(() => expect(attempt).toBe(2), { timeout: 2_000, interval: 5 });
    await vi.waitFor(() => expect(connectedLines()).toBe(2), { timeout: 2_000, interval: 5 });
    watcher.stop();
  });

  it('does not stop a shared global event hub when the watcher stops', async () => {
    const events = new Set();
    const statuses = new Set();
    let startCalls = 0;
    let stopCalls = 0;

    const globalEventHub = {
      start() {
        startCalls += 1;
      },
      stop() {
        stopCalls += 1;
      },
      subscribeEvent(subscriber) {
        events.add(subscriber);
        return () => {
          events.delete(subscriber);
        };
      },
      subscribeStatus(subscriber) {
        statuses.add(subscriber);
        return () => {
          statuses.delete(subscriber);
        };
      },
    };

    const watcher = createOpenCodeWatcherRuntime({
      waitForOpenCodePort: async () => {},
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      globalEventHub,
      onPayload() {},
    });

    await watcher.start();
    watcher.stop();

    expect(startCalls).toBe(1);
    expect(stopCalls).toBe(0);
    expect(events.size).toBe(0);
    expect(statuses.size).toBe(0);
  });
});
