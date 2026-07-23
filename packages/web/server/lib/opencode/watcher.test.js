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
            'id: evt-1\ndata: {"directory":"/tmp/project","payload":{"type":"session.updated","properties":{"sessionID":"ses_1"}}}\n\n',
          ],
        });
      },
    });

    await watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fetchCalls).toEqual([
      {
        url: 'http://127.0.0.1:4096/global/event',
        headers: {
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          Authorization: 'Bearer test-token',
        },
      },
    ]);
    expect(payloads).toEqual([
      {
        type: 'session.updated',
        properties: {
          sessionID: 'ses_1',
        },
      },
    ]);
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
              'id: evt-1\ndata: {"type":"server.connected","properties":{}}\n\n',
            ],
          });
        }

        return createSseResponse({
          signal: options.signal,
          blocks: [
            'id: evt-2\ndata: {"type":"session.updated","properties":{}}\n\n',
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
            'id: evt-1\ndata: {"payload":{"type":"session.updated","properties":{"sessionID":"ses_1"}}}\n\n',
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
    expect(payloads).toEqual([
      {
        type: 'session.updated',
        properties: {
          sessionID: 'ses_1',
        },
      },
    ]);
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

  // Reproduction test for issue #2380:
  // The PushWatcher subscribes to a shared hub. When the upstream fails
  // and then recovers, the hub should notify 'connect' and the watcher
  // should see the reconnection (logging [PushWatcher] connected).
  it('detects reconnect through shared hub after buildUrl fails then recovers', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const payloads = [];

    let buildUrlCalls = 0;
    const buildOpenCodeUrl = () => {
      buildUrlCalls += 1;
      if (buildUrlCalls === 1) return 'http://127.0.0.1:4096/global/event';
      if (buildUrlCalls <= 3) throw new Error('OpenCode service unavailable');
      return 'http://127.0.0.1:4097/global/event';
    };

    let fetchCount = 0;
    const fetchImpl = (_url, options) => {
      fetchCount += 1;
      if (fetchCount === 1) {
        // End the stream immediately so the reader reconnects
        return createSseResponse({
          signal: options.signal,
          holdOpen: false,
          blocks: [
            'id: evt-1\ndata: {"payload":{"type":"session.updated","properties":{"sessionID":"ses_1"}}}\n\n',
          ],
        });
      }
      return createSseResponse({
        signal: options.signal,
        holdOpen: true,
        blocks: [
          `id: evt-${fetchCount + 10}\ndata: {"payload":{"type":"session.updated","properties":{"sessionID":"ses_${fetchCount}"}}}\n\n`,
        ],
      });
    };

    const globalEventHub = createGlobalMessageStreamHub({
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl,
      upstreamReconnectDelayMs: 0,
    });

    const watcher = createOpenCodeWatcherRuntime({
      waitForOpenCodePort: async () => {},
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders: () => ({}),
      globalEventHub,
      onPayload(payload) {
        payloads.push(payload);
      },
      upstreamReconnectDelayMs: 0,
    });

    await watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 30));

    // The first SSE stream ended → reader retried → buildUrl failed →
    // buildUrl recovered → reader reconnected → events flowed
    // After reconnection, the hub notifies 'connect' and PushWatcher
    // logs '[PushWatcher] connected' (matching the user's expected recovery).
    const connectedLogs = logSpy.mock.calls.filter(
      (call) => call[0] === '[PushWatcher] connected'
    );
    // Should have at least 2 connected events: initial + recovery
    expect(connectedLogs.length).toBeGreaterThanOrEqual(2);

    // Payloads should include events from both before and after recovery
    expect(payloads.length).toBeGreaterThanOrEqual(2);

    // buildUrl was called for initial success + failures + recovery
    expect(buildUrlCalls).toBeGreaterThanOrEqual(4);

    warnSpy.mockRestore();
    logSpy.mockRestore();
    watcher.stop();
  });
});
