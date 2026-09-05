import { describe, expect, it } from 'vitest';

import { createUpstreamSseReader } from './upstream-reader.js';

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

function createTrackedSignal() {
  const listeners = new Set();
  return {
    signal: {
      aborted: false,
      addEventListener(type, listener) {
        if (type === 'abort') {
          listeners.add(listener);
        }
      },
      removeEventListener(type, listener) {
        if (type === 'abort') {
          listeners.delete(listener);
        }
      },
    },
    getListenerCount() {
      return listeners.size;
    },
  };
}

describe('createUpstreamSseReader', () => {
  it('emits parsed events and tracks the latest event id', async () => {
    const events = [];
    let reader;

    reader = createUpstreamSseReader({
      buildUrl: () => 'http://127.0.0.1:4096/global/event',
      reconnectDelayMs: 0,
      fetchImpl: async (_url, options) => createSseResponse({
        signal: options.signal,
        blocks: [
          'id: evt-1\r\ndata: {"type":"server.connected","properties":{"directory":"/tmp/project"}}\r\n\r\n',
        ],
      }),
      onEvent(event) {
        events.push(event);
        reader.stop();
      },
    });

    await reader.start();

    expect(events).toHaveLength(1);
    expect(events[0].eventId).toBe('evt-1');
    expect(events[0].directory).toBe('/tmp/project');
    expect(events[0].payload).toEqual({
      type: 'server.connected',
      properties: {
        directory: '/tmp/project',
      },
    });
    expect(reader.getLastEventId()).toBe('evt-1');
  });

  it('reconnects a stalled stream with Last-Event-ID', async () => {
    const fetchLastEventIds = [];
    const events = [];
    let attempt = 0;
    let reader;

    reader = createUpstreamSseReader({
      buildUrl: () => 'http://127.0.0.1:4096/global/event',
      stallTimeoutMs: 10,
      reconnectDelayMs: 0,
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
      onEvent(event) {
        events.push(event.eventId);
        if (event.eventId === 'evt-2') {
          reader.stop();
        }
      },
    });

    await reader.start();

    expect(events).toEqual(['evt-1', 'evt-2']);
    expect(fetchLastEventIds.slice(0, 2)).toEqual([null, 'evt-1']);
    expect(reader.getLastEventId()).toBe('evt-2');
  });

  it('resolves the stall timeout for each upstream read window', async () => {
    const events = [];
    let attempt = 0;
    let currentTimeout = 10;
    let reader;

    reader = createUpstreamSseReader({
      buildUrl: () => 'http://127.0.0.1:4096/global/event',
      stallTimeoutMs: () => currentTimeout,
      reconnectDelayMs: 0,
      fetchImpl: async (_url, options) => {
        attempt += 1;

        if (attempt === 1) {
          currentTimeout = 60;
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
      onEvent(event) {
        events.push(event.eventId);
        if (event.eventId === 'evt-2') {
          reader.stop();
        }
      },
    });

    await reader.start();

    expect(events).toEqual(['evt-1', 'evt-2']);
    expect(attempt).toBe(2);
  });

  it('reports unavailable upstream responses and continues reconnecting until stopped', async () => {
    const errors = [];
    let attempt = 0;
    let unavailableBodyCanceled = false;
    let reader;

    reader = createUpstreamSseReader({
      buildUrl: () => 'http://127.0.0.1:4096/global/event',
      reconnectDelayMs: 0,
      fetchImpl: async (_url, options) => {
        attempt += 1;
        if (attempt === 1) {
          return {
            ok: false,
            status: 503,
            body: {
              cancel: async () => {
                unavailableBodyCanceled = true;
              },
            },
          };
        }

        return createSseResponse({
          signal: options.signal,
          blocks: [
            'id: evt-1\ndata: {"type":"server.connected","properties":{}}\n\n',
          ],
        });
      },
      onError(error) {
        errors.push(error);
      },
      onEvent() {
        reader.stop();
      },
    });

    await reader.start();

    expect(errors).toEqual([
      expect.objectContaining({
        type: 'upstream_unavailable',
        status: 503,
      }),
    ]);
    expect(unavailableBodyCanceled).toBe(true);
    expect(attempt).toBe(2);
  });

  it('removes abort listeners after stop', async () => {
    const tracked = createTrackedSignal();
    let attempt = 0;
    let reader;

    reader = createUpstreamSseReader({
      buildUrl: () => 'http://127.0.0.1:4096/global/event',
      reconnectDelayMs: 1,
      signal: tracked.signal,
      fetchImpl: async (_url, options) => {
        attempt += 1;
        if (attempt === 1) {
          return {
            ok: false,
            status: 503,
            body: {
              cancel: async () => {},
            },
          };
        }

        return createSseResponse({
          signal: options.signal,
          blocks: [
            'id: evt-1\ndata: {"type":"server.connected","properties":{}}\n\n',
          ],
        });
      },
      onEvent() {
        reader.stop();
      },
    });

    await reader.start();

    expect(attempt).toBe(2);
    expect(tracked.getListenerCount()).toBe(0);
  });

  it('backs off reconnect delay after consecutive upstream failures', async () => {
    const errors = [];
    const recordedDelays = [];
    let attempt = 0;
    let reader;

    // Capture the requested reconnect delays instead of measuring wall-clock
    // time. Each captured entry corresponds to one `waitForReconnectDelay` call.
    const setTimeoutImpl = (handler, ms) => {
      recordedDelays.push(ms);
      // Fire immediately so the connection loop proceeds to the next attempt.
      return globalThis.setTimeout(handler, 0);
    };

    reader = createUpstreamSseReader({
      buildUrl: () => 'http://127.0.0.1:4096/global/event',
      reconnectDelayMs: 10,
      reconnectMaxDelayMs: 40,
      reconnectBackoffMultiplier: 2,
      setTimeoutImpl,
      fetchImpl: async (_url, options) => {
        attempt += 1;
        if (attempt <= 4) {
          return {
            ok: false,
            status: 503,
            body: {
              cancel: async () => {},
            },
          };
        }

        return createSseResponse({
          signal: options.signal,
          blocks: [
            'id: evt-1\ndata: {"type":"server.connected","properties":{}}\n\n',
          ],
        });
      },
      onError(error) {
        errors.push(error);
      },
      onEvent() {
        reader.stop();
      },
    });

    await reader.start();

    expect(errors).toHaveLength(4);
    expect(attempt).toBe(5);
    // Conventional backoff: failures 1..4 ask for base*multiplier^(n-1) capped at max,
    // so the schedule is 10, 20, 40, 40 (the last one already hit the cap).
    expect(recordedDelays).toEqual([10, 20, 40, 40]);
  });

  it('resets the consecutive failure counter after a successful connect', async () => {
    const events = [];
    const recordedDelays = [];
    let attempt = 0;
    let reader;

    const setTimeoutImpl = (handler, ms) => {
      recordedDelays.push(ms);
      return globalThis.setTimeout(handler, 0);
    };

    reader = createUpstreamSseReader({
      buildUrl: () => 'http://127.0.0.1:4096/global/event',
      reconnectDelayMs: 5,
      reconnectMaxDelayMs: 20,
      reconnectBackoffMultiplier: 2,
      setTimeoutImpl,
      fetchImpl: async (_url, options) => {
        attempt += 1;
        if (attempt === 1 || attempt === 2) {
          return {
            ok: false,
            status: 503,
            body: { cancel: async () => {} },
          };
        }
        if (attempt === 3) {
          return createSseResponse({
            signal: options.signal,
            blocks: [
              'id: evt-1\ndata: {"type":"server.connected","properties":{}}\n\n',
            ],
          });
        }
        if (attempt === 4) {
          return {
            ok: false,
            status: 503,
            body: { cancel: async () => {} },
          };
        }
        return createSseResponse({
          signal: options.signal,
          blocks: [
            'id: evt-2\ndata: {"type":"session.updated","properties":{}}\n\n',
          ],
        });
      },
      onError() {},
      onEvent(event) {
        events.push(event.eventId);
        if (event.eventId === 'evt-2') {
          reader.stop();
        }
      },
    });

    await reader.start();

    expect(events).toEqual(['evt-1', 'evt-2']);
    expect(attempt).toBe(5);
    // Schedule: failures 1..2 escalate 5 -> 10; healthy connect (attempt 3)
    // resets the counter, so the next failure (attempt 4) waits the base
    // value again, not the escalated one. The trailing entry is the post-stop
    // cleanup waitForReconnectDelay that fires before the abort short-circuit.
    expect(recordedDelays.slice(0, 3)).toEqual([5, 10, 5]);
  });

  it('keeps immediate reconnect when reconnectDelayMs is zero', async () => {
    const recordedDelays = [];
    let attempt = 0;
    let reader;

    const setTimeoutImpl = (handler, ms) => {
      recordedDelays.push(ms);
      return globalThis.setTimeout(handler, 0);
    };

    reader = createUpstreamSseReader({
      buildUrl: () => 'http://127.0.0.1:4096/global/event',
      reconnectDelayMs: 0,
      reconnectMaxDelayMs: 50,
      reconnectBackoffMultiplier: 10,
      setTimeoutImpl,
      fetchImpl: async (_url, options) => {
        attempt += 1;
        if (attempt <= 3) {
          return {
            ok: false,
            status: 503,
            body: { cancel: async () => {} },
          };
        }
        return createSseResponse({
          signal: options.signal,
          blocks: [
            'id: evt-1\ndata: {"type":"server.connected","properties":{}}\n\n',
          ],
        });
      },
      onEvent() {
        reader.stop();
      },
    });

    await reader.start();

    expect(attempt).toBe(4);
    // Zero base delay short-circuits the backoff schedule entirely, regardless
    // of the multiplier/cap. The reset on a healthy connect is also free in
    // this configuration.
    expect(recordedDelays).toEqual([0, 0, 0]);
  });
});
