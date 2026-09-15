import { afterEach, describe, expect, it, vi } from 'vitest';

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
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it('backs off failed attempts, caps the wait, and resets after upstream bytes', async () => {
    vi.useFakeTimers();
    const attemptTimes = [];
    let attempt = 0;
    let reader;

    reader = createUpstreamSseReader({
      buildUrl: () => 'http://127.0.0.1:4096/global/event',
      reconnectDelayMs: 100,
      reconnectDelayMaxMs: 250,
      fetchImpl: async (_url, options) => {
        attemptTimes.push(Date.now());
        attempt += 1;

        if (attempt <= 3) {
          return {
            ok: false,
            status: 503,
            body: {
              cancel: async () => {},
            },
          };
        }

        if (attempt === 4) {
          return createSseResponse({
            signal: options.signal,
            blocks: [
              'id: evt-1\ndata: {"type":"server.connected","properties":{}}\n\n',
            ],
          });
        }

        throw new Error('upstream down');
      },
    });

    const running = reader.start();

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);

    // 100 base, 200 doubled, 250 capped, then 100 again after the successful
    // read reset the counter, then 200 as failures accumulate from scratch.
    const offsets = attemptTimes.map((time) => time - attemptTimes[0]);
    expect(offsets).toEqual([0, 100, 300, 550, 650, 850]);

    reader.stop();
    // Without an abort signal the pending fake-timer wait must be advanced
    // before the loop can observe `stopped`.
    await vi.advanceTimersByTimeAsync(1000);
    await running;
  });

  it('parks after consecutive build URL failures and only retries after an explicit restart', async () => {
    const errors = [];
    const parked = [];
    let buildAttempts = 0;
    let fetchAttempts = 0;
    let reader;

    reader = createUpstreamSseReader({
      buildUrl() {
        buildAttempts += 1;
        throw new Error('OpenCode port is not available');
      },
      reconnectDelayMs: 0,
      buildUrlFailureLimit: 3,
      fetchImpl: async () => {
        fetchAttempts += 1;
        throw new Error('fetch should not run while the URL cannot be built');
      },
      onError(error) {
        errors.push(error.type);
      },
      onParked(error) {
        parked.push(error.type);
      },
    });

    await reader.start();

    expect(buildAttempts).toBe(3);
    expect(fetchAttempts).toBe(0);
    expect(errors).toEqual(['build_url_failed', 'build_url_failed']);
    expect(parked).toEqual(['build_url_failed']);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(buildAttempts).toBe(3);

    // A fresh start is an explicit restart: the parked state must clear and
    // the reader must dial again.
    reader.stop();
    await reader.start();

    expect(buildAttempts).toBe(6);
    expect(parked).toEqual(['build_url_failed', 'build_url_failed']);
  });

  it('keeps retrying capped build URL failures through onError when no onParked handler is provided', async () => {
    vi.useFakeTimers();
    const attemptTimes = [];
    const errors = [];
    let reader;

    reader = createUpstreamSseReader({
      buildUrl() {
        attemptTimes.push(Date.now());
        throw new Error('OpenCode port is not available');
      },
      reconnectDelayMs: 100,
      reconnectDelayMaxMs: 250,
      buildUrlFailureLimit: 3,
      fetchImpl: async () => {
        throw new Error('fetch should not run while the URL cannot be built');
      },
      onError(error) {
        errors.push(error.type);
        if (errors.length >= 6) {
          reader.stop();
        }
      },
    });

    const running = reader.start();

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(250);

    // 100 base, 200 doubled, then the 250 cap for every failure past the
    // parking limit: the reader never parks and never spins at a shorter wait.
    expect(attemptTimes.map((time) => time - attemptTimes[0])).toEqual([0, 100, 300, 550, 800, 1050]);
    expect(errors).toEqual([
      'build_url_failed',
      'build_url_failed',
      'build_url_failed',
      'build_url_failed',
      'build_url_failed',
      'build_url_failed',
    ]);

    await running;
  });

  it('keeps retrying transient upstream failures instead of parking', async () => {
    const errors = [];
    const parked = [];
    let reader;

    reader = createUpstreamSseReader({
      buildUrl: () => 'http://127.0.0.1:4096/global/event',
      reconnectDelayMs: 0,
      buildUrlFailureLimit: 2,
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        body: {
          cancel: async () => {},
        },
      }),
      onError(error) {
        errors.push(error.type);
        if (errors.length >= 4) {
          reader.stop();
        }
      },
      onParked(error) {
        parked.push(error.type);
      },
    });

    await reader.start();

    expect(errors).toEqual([
      'upstream_unavailable',
      'upstream_unavailable',
      'upstream_unavailable',
      'upstream_unavailable',
    ]);
    expect(parked).toEqual([]);
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
});
