import { afterEach, describe, expect, it } from 'bun:test';
import { createEventPipeline } from '../event-pipeline';

const savedDocument = globalThis.document;
const savedWindow = globalThis.window;

afterEach(() => {
  globalThis.document = savedDocument;
  globalThis.window = savedWindow;
});

describe('createEventPipeline — system resume reconnect', () => {
  it('reconnects immediately on openchamber:system-resume event', async () => {
    const winListeners = {};
    globalThis.document = {
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
    };
    globalThis.window = {
      location: {
        href: 'http://127.0.0.1:3000/',
        origin: 'http://127.0.0.1:3000',
      },
      addEventListener(event, handler) { winListeners[event] = handler; },
      removeEventListener(event) { delete winListeners[event]; },
    };

    const disconnectReasons = [];
    let reconnectCount = 0;
    const eventCalls = [];

    let sdkCallIndex = 0;
    let releaseFirstStream;
    const firstHold = new Promise((resolve) => { releaseFirstStream = resolve; });

    const sdk = {
      global: {
        // Accept options with signal so the mock generator can abort.
        event: async (options) => {
          const callIndex = sdkCallIndex++;
          eventCalls.push(callIndex);
          const signal = options?.signal;
          if (callIndex === 0) {
            return {
              stream: (async function* () {
                yield {
                  payload: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } },
                };
                // Wait for either the hold promise or abort signal.
                await Promise.race([
                  firstHold,
                  new Promise((_, reject) => {
                    if (signal?.aborted) { reject(signal.reason || new DOMException('Aborted', 'AbortError')); return; }
                    signal?.addEventListener('abort', () => {
                      reject(signal.reason || new DOMException('Aborted', 'AbortError'));
                    });
                  }),
                ]);
              })(),
            };
          }
          return {
            stream: (async function* () {
              yield {
                payload: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } },
              };
              await new Promise(() => {});
            })(),
          };
        },
      },
    };

    const recovered = new Promise((resolve) => {
      const { cleanup } = createEventPipeline({
        sdk,
        transport: 'sse',
        heartbeatTimeoutMs: 60_000,
        reconnectDelayMs: 60_000,
        onEvent: () => {},
        onDisconnect: (reason) => {
          disconnectReasons.push(reason);
        },
        onReconnect: () => {
          reconnectCount += 1;
          // onReconnect fires on the initial connect too (count=1),
          // so wait for the second reconnect (count=2) triggered by resume.
          if (reconnectCount === 2) {
            cleanup();
            resolve();
          }
        },
      });

      // Wait for first SSE attempt to start and deliver the event, then
      // simulate OS resume by invoking the registered handler directly.
      setTimeout(() => {
        const handler = winListeners['openchamber:system-resume'];
        if (handler) handler();
      }, 80);
    });

    await recovered;
    releaseFirstStream();

    // Should have made two SDK calls: initial connect + reconnect after resume.
    expect(eventCalls.length).toBe(2);
    // Disconnect reason should include system_resume.
    expect(disconnectReasons.some((r) => r.includes('system_resume'))).toBe(true);
  });
});
