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
  getProtocol: () => 'legacy',
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
    protocol: 'legacy',
  }),
  onStatusChange: (callback) => {
    callback('connected');
    return { dispose: () => {} };
  },
});

describe('VS Code SSE proxy', () => {
  test('maps exact webview SSE paths without changing legacy routes', async () => {
    const originalFetch = globalThis.fetch;
    const fetchedUrls: string[] = [];

    try {
      globalThis.fetch = async (input) => {
        fetchedUrls.push(String(input));
        return new Response(new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      };

      for (const path of ['/api/api/event?cursor=v2', '/api/global/event?cursor=global', '/api/event?cursor=legacy']) {
        const proxy = await openSseProxy({
          manager: createManager(),
          path,
          signal: new AbortController().signal,
          onChunk: () => {},
        });
        await proxy.run;
      }

      assert.deepEqual(fetchedUrls, [
        'http://127.0.0.1:3902/api/event?cursor=v2&directory=%2Fworkspace',
        'http://127.0.0.1:3902/global/event?cursor=global',
        'http://127.0.0.1:3902/event?cursor=legacy&directory=%2Fworkspace',
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects protocol-relative SSE paths', async () => {
    await assert.rejects(openSseProxy({
      manager: createManager(),
      path: '//example.com/api/event',
      signal: new AbortController().signal,
      onChunk: () => {},
    }), /Invalid OpenCode SSE path/);
  });

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
