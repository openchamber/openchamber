import { describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { OpenCodeManager } from './opencode';
import { openSseProxy } from './sseProxy';

const createManager = (): OpenCodeManager => ({
  start: async () => {},
  stop: async () => {},
  restart: async () => {},
  refreshPluginSwitches: async () => ({ updated: true, requiresManualRestart: false }),
  upgradeCli: async () => {},
  installV2: async () => {},
  getCompatibility: async () => ({ state: 'compatible', version: '2.0.15', installation: 'managed', binary: null, minimumVersion: '2.0.15', canInstall: false }),
  setWorkingDirectory: async (path) => ({ success: true, path }),
  getStatus: () => 'connected',
  getApiUrl: () => 'http://127.0.0.1:3902',
  getOpenCodeAuthHeaders: () => ({}),
  getManagedLaunchEnvironment: () => null,
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
    mock.timers.enable({ apis: ['setTimeout'] });
    let cancelled = false;

    try {
      globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
        cancel() { cancelled = true; },
      }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as typeof fetch;

      const controller = new AbortController();
      const proxy = await openSseProxy({
        manager: createManager(),
        path: '/api/event',
        signal: controller.signal,
        stallTimeoutMs: 20,
        onChunk: () => assert.fail('quiet stream should not emit chunks'),
      });

      mock.timers.tick(19);
      assert.equal(cancelled, false);
      mock.timers.tick(1);
      assert.equal(cancelled, true);
      await assert.doesNotReject(proxy.run);
    } finally {
      globalThis.fetch = originalFetch;
      mock.timers.reset();
    }
  });

  test('resets the stall timeout when upstream bytes arrive', async () => {
    const originalFetch = globalThis.fetch;
    mock.timers.enable({ apis: ['setTimeout'] });
    let cancelled = false;
    let upstream: ReadableStreamDefaultController<Uint8Array>;
    let delivered = () => {};

    try {
      globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          upstream = controller;
        },
        cancel() { cancelled = true; },
      }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as typeof fetch;

      const chunks: string[] = [];
      const controller = new AbortController();
      const proxy = await openSseProxy({
        manager: createManager(),
        path: '/api/event',
        signal: controller.signal,
        stallTimeoutMs: 18,
        onChunk: (chunk) => { chunks.push(chunk); delivered(); },
      });

      const send = (chunk: string) => new Promise<void>((resolve) => {
        delivered = resolve;
        upstream.enqueue(new TextEncoder().encode(chunk));
      });
      mock.timers.tick(5);
      await send(':first\n\n');
      mock.timers.tick(14);
      assert.equal(cancelled, false);
      await send('data: second\n\n');
      mock.timers.tick(17);
      assert.equal(cancelled, false);
      mock.timers.tick(1);
      assert.equal(cancelled, true);
      await assert.doesNotReject(proxy.run);
      assert.deepEqual(chunks, [':first\n\n', 'data: second\n\n']);
    } finally {
      globalThis.fetch = originalFetch;
      mock.timers.reset();
    }
  });
});
