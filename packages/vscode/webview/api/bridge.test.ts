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

  test('preserves structured worktree failure codes from the extension host', async () => {
    const originalWindow = globalThis.window;
    const originalAcquire = (globalThis as typeof globalThis & { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
    const messages: Array<{ id?: string; type?: string }> = [];
    const windowTarget = new EventTarget();

    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: windowTarget,
      });
      Object.defineProperty(globalThis, 'acquireVsCodeApi', {
        configurable: true,
        value: () => ({
          postMessage: (message: { id?: string; type?: string }) => messages.push(message),
          getState: () => undefined,
          setState: () => undefined,
        }),
      });

      const { sendBridgeMessage } = await import(`./bridge?structured-worktree-error-${Date.now()}`);
      const pending = sendBridgeMessage('api:git/worktrees', {
        directory: '/repo',
        method: 'POST',
      }).then(
        () => null,
        (error: unknown) => error,
      );

      const request = messages[0];
      assert.ok(request?.id);
      windowTarget.dispatchEvent(new MessageEvent('message', {
        data: {
          id: request.id,
          type: 'api:git/worktrees',
          success: false,
          error: 'pull_request_unavailable',
          code: 'pull_request_unavailable',
        },
      }));

      const error = await pending;
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code?: string }).code, 'pull_request_unavailable');
      assert.equal(error.message, 'pull_request_unavailable');
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      Object.defineProperty(globalThis, 'acquireVsCodeApi', { configurable: true, value: originalAcquire });
    }
  });
});
