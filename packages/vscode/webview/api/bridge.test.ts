import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

describe('VS Code webview bridge requests', () => {
  test('rejects immediately when signal is already aborted', async () => {
    const originalWindow = globalThis.window;
    const originalAcquire = (globalThis as typeof globalThis & { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
    const messages: unknown[] = [];

    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: new EventTarget(),
      });
      Object.defineProperty(globalThis, 'acquireVsCodeApi', {
        configurable: true,
        value: () => ({
          postMessage: (message: unknown) => messages.push(message),
          getState: () => undefined,
          setState: () => undefined,
        }),
      });

      const { sendBridgeMessageWithOptions } = await import('./bridge');
      const controller = new AbortController();
      controller.abort();

      const result = await Promise.race([
        sendBridgeMessageWithOptions('api:proxy', undefined, { signal: controller.signal }).then(
          () => 'resolved',
          (error: unknown) => error,
        ),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 20)),
      ]);

      assert.ok(result instanceof DOMException);
      assert.equal(result.name, 'AbortError');
      assert.equal(messages.length, 0);
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      Object.defineProperty(globalThis, 'acquireVsCodeApi', { configurable: true, value: originalAcquire });
    }
  });
});
