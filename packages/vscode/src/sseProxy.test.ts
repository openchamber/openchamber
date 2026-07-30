import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenCodeManager } from './opencode';
import { openSseProxy } from './sseProxy';

const createManager = (): OpenCodeManager => ({
  start: async () => {},
  stop: async () => {},
  restart: async () => {},
  setWorkingDirectory: async (path) => ({ success: true, path }),
  getStatus: () => 'connected',
  getApiUrl: () => 'http://127.0.0.1:3902',
  getOpenCodeAuthHeaders: () => ({}),
  getWorkingDirectory: () => '/workspace',
  isCliAvailable: () => true,
  getDebugInfo: () => ({
    mode: 'managed',
    status: 'connected',
    workingDirectory: '/workspace',
    cliAvailable: true,
    cliPath: null,
    configuredApiUrl: null,
    configuredPort: null,
    detectedPort: 3902,
    apiPrefix: '',
    apiPrefixDetected: true,
    startCount: 1,
    restartCount: 0,
    lastStartAt: null,
    lastConnectedAt: null,
    lastExitCode: null,
    serverUrl: 'http://127.0.0.1:3902',
    lastReadyElapsedMs: null,
    lastReadyAttempts: null,
    lastStartAttempts: null,
    version: null,
    secureConnection: false,
    authSource: null,
  }),
  onStatusChange: (callback) => {
    callback('connected');
    return { dispose: () => {} };
  },
});

describe('VS Code SSE proxy', () => {
  test('closes a quiet upstream SSE stream after the stall timeout', async () => {
    const originalFetch = globalThis.fetch;

    try {
      globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({}), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as typeof fetch;

      const controller = new AbortController();
      const proxy = await openSseProxy({
        manager: createManager(),
        path: '/global/event',
        signal: controller.signal,
        stallTimeoutMs: 20,
        onChunk: () => assert.fail('quiet stream should not emit chunks'),
      });

      await assert.doesNotReject(proxy.run);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('resets the stall timeout when upstream bytes arrive', async () => {
    const originalFetch = globalThis.fetch;

    try {
      globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => controller.enqueue(new TextEncoder().encode(':first\n\n')), 5);
          setTimeout(() => controller.enqueue(new TextEncoder().encode('data: second\n\n')), 15);
        },
      }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as typeof fetch;

      const chunks: string[] = [];
      const controller = new AbortController();
      const proxy = await openSseProxy({
        manager: createManager(),
        path: '/global/event',
        signal: controller.signal,
        stallTimeoutMs: 18,
        onChunk: (chunk) => chunks.push(chunk),
      });

      await assert.doesNotReject(proxy.run);
      assert.deepEqual(chunks, [':first\n\n', 'data: second\n\n']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
