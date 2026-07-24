import { afterEach, describe, expect, it } from 'bun:test';
import { createEventPipeline } from '../event-pipeline';
import { createBrowserGlobalStubScope } from './browser-global-stubs';

const browserGlobals = createBrowserGlobalStubScope();

afterEach(() => {
  browserGlobals.restore();
});

// Multi-listener event-target stub. The simpler single-slot stub used in
// event-pipeline-resume.test.js would break here because waitForRetry and the
// top-level onOnline handler both register for `online`.
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

describe('createEventPipeline — online event', () => {
  it('cuts the inter-attempt wait short when `online` fires after disconnect', async () => {
    browserGlobals.install('document', createEventTarget({ visibilityState: 'visible' }));
    browserGlobals.install('window', createEventTarget({
      location: { href: 'http://127.0.0.1:3000/', origin: 'http://127.0.0.1:3000' },
    }));
    browserGlobals.install('navigator', { onLine: false });

    let sdkCallIndex = 0;
    const sdk = {
      global: {
        event: async () => {
          const idx = sdkCallIndex++;
          if (idx === 0) {
            // Force a real failure so the loop enters the offline backoff path
            // (computeRetryDelay returns the long cap because navigator.onLine
            // is false). Without our `online` interrupt this would wait the
            // full hidden/offline cap of 60s and the test would time out.
            throw new Error('simulated network error');
          }
          return {
            stream: (async function* () {
              yield {
                payload: {
                  type: 'session.status',
                  properties: { sessionID: 's1', status: { type: 'idle' } },
                },
              };
              await new Promise(() => {});
            })(),
          };
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
        onDisconnect: () => {
          // We're now inside waitForRetry on the long offline cap.
          // Flip the browser back online and fire the event; waitForRetry
          // should resolve early and the next attempt should fire.
          setTimeout(() => {
            browserGlobals.install('navigator', { onLine: true });
            globalThis.window.dispatch('online');
          }, 30);
        },
        onReconnect: () => {
          connects += 1;
          if (connects === 1) {
            cleanup();
            resolve(Date.now() - startedAt);
          }
        },
      });
    });

    // Two attempts: the failed one + the recovery one. If the `online`
    // interrupt didn't fire, the test would have hung on the 60s offline cap.
    expect(sdkCallIndex).toBe(2);
    expect(elapsed).toBeLessThan(2_000);
  });
});
