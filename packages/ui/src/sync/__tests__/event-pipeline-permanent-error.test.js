import { afterEach, describe, expect, it, jest } from 'bun:test';
import { createEventPipeline } from '../event-pipeline';

const savedDocument = globalThis.document;
const savedWindow = globalThis.window;
const savedNavigator = globalThis.navigator;

afterEach(() => {
  globalThis.document = savedDocument;
  globalThis.window = savedWindow;
  globalThis.navigator = savedNavigator;
});

function createEventTarget(extras = {}) {
  const listeners = new Map();
  return {
    ...extras,
    addEventListener(event, handler) {
      const list = listeners.get(event);
      if (list) list.add(handler);
      else listeners.set(event, new Set([handler]));
    },
    removeEventListener(event, handler) {
      listeners.get(event)?.delete(handler);
    },
    dispatch(event) {
      const list = listeners.get(event);
      if (!list) return;
      for (const handler of Array.from(list)) {
        handler();
      }
    },
  };
}

describe('createEventPipeline — permanent server errors', () => {
  it('uses the long backoff cap for 4xx so we do not hammer at 5s intervals', async () => {
    globalThis.document = createEventTarget({ visibilityState: 'visible' });
    globalThis.window = createEventTarget({
      location: { href: 'http://127.0.0.1:3000/', origin: 'http://127.0.0.1:3000' },
    });
    globalThis.navigator = { onLine: true };

    let sdkCallIndex = 0;
    const sdk = {
      event: {
        subscribe: () => {
          const idx = sdkCallIndex++;
          if (idx <= 1) {
            // Both failures must wait for the permanent-error cap unless an
            // online event interrupts them.
            const error = new Error('Not Found');
            error.status = 404;
            throw error;
          }
          return (async function* () {
              yield { id: 'evt_1', created: 1000, location: { directory: '/repo' }, type: 'session.status', data: { sessionID: 's1', status: { type: 'idle' } } };
              await new Promise(() => {});
            })();
        },
      },
    };

    const disconnected = Promise.withResolvers();
    const recovered = Promise.withResolvers();
    jest.useFakeTimers();
    const { cleanup } = createEventPipeline({
      sdk,
      transport: 'sse',
      heartbeatTimeoutMs: 60_000,
      reconnectDelayMs: 60_000,
      onEvent: () => {},
      onDisconnect: () => disconnected.resolve(),
      onReconnect: () => recovered.resolve(),
    });

    try {
      await disconnected.promise;
      // RETRY_BACKOFF_CAP_HIDDEN_OR_OFFLINE_MS is 60 s. Drain the timer's
      // promise continuations before checking that no retry ran before it.
      jest.advanceTimersByTime(59_999);
      await new Promise((resolve) => setImmediate(resolve));
      expect(sdkCallIndex).toBe(1);

      const startedAt = Date.now();
      globalThis.window.dispatch('online');
      // Complete the failed second attempt and its retry setup.
      await new Promise((resolve) => setImmediate(resolve));
      expect(sdkCallIndex).toBe(2);
      globalThis.window.dispatch('online');
      await recovered.promise;

      expect(sdkCallIndex).toBeGreaterThanOrEqual(3);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      cleanup();
      jest.useRealTimers();
    }
  });

  it('retries 408 and 429 on the normal exponential path (not the permanent cap)', async () => {
    globalThis.document = createEventTarget({ visibilityState: 'visible' });
    globalThis.window = createEventTarget({
      location: { href: 'http://127.0.0.1:3000/', origin: 'http://127.0.0.1:3000' },
    });
    globalThis.navigator = { onLine: true };

    let sdkCallIndex = 0;
    const sdk = {
      event: {
        subscribe: () => {
          const idx = sdkCallIndex++;
          if (idx === 0) {
            const error = new Error('Rate limited');
            error.status = 429;
            throw error;
          }
          return (async function* () {
              yield { id: 'evt_1', created: 1000, location: { directory: '/repo' }, type: 'session.status', data: { sessionID: 's1', status: { type: 'idle' } } };
              await new Promise(() => {});
            })();
        },
      },
    };

    const startedAt = Date.now();
    const elapsed = await new Promise((resolve) => {
      let connects = 0;
      const { cleanup } = createEventPipeline({
        sdk,
        transport: 'sse',
        heartbeatTimeoutMs: 60_000,
        reconnectDelayMs: 60_000,
        onEvent: () => {},
        onReconnect: () => {
          connects += 1;
          if (connects === 1) {
            cleanup();
            resolve(Date.now() - startedAt);
          }
        },
      });
    });

    // 429 went through computeRetryDelay (consecutiveFailures=1) -> 250ms,
    // not the 60s permanent cap. Recovery should be sub-second.
    expect(sdkCallIndex).toBe(2);
    expect(elapsed).toBeLessThan(2_000);
  });
});
