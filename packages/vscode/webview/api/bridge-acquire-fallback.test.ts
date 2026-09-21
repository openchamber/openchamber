import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * When acquireVsCodeApi() returns undefined (broken Cursor/VSCodium webview slot),
 * getVSCodeAPI().postMessage used to throw:
 * TypeError: Cannot read properties of undefined (reading 'postMessage')
 *
 * The bridge must fall back to a noop API and fail via normal request timeout instead.
 */
describe('VS Code webview bridge acquireVsCodeApi fallback', () => {
  test('does not throw TypeError when acquireVsCodeApi returns undefined', async () => {
    const originalWindow = globalThis.window;
    const originalAcquire = (globalThis as typeof globalThis & { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];

    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: new EventTarget(),
      });
      Object.defineProperty(globalThis, 'acquireVsCodeApi', {
        configurable: true,
        value: () => undefined,
      });
      console.warn = (...args: unknown[]) => {
        warnings.push(args);
      };

      const { sendBridgeMessageWithOptions } = await import(`./bridge?acquire-fallback-${Date.now()}`);

      const result = await sendBridgeMessageWithOptions('api:proxy', { path: '/health' }, { timeoutMs: 20 }).then(
        () => 'resolved' as const,
        (error: unknown) => error,
      );

      assert.ok(result instanceof Error, `expected Error, got ${String(result)}`);
      assert.notEqual((result as Error).name, 'TypeError');
      assert.match((result as Error).message, /timed out/i);
      assert.ok(
        warnings.some((entry) => String(entry[0] ?? '').includes('VS Code API unavailable')),
        'expected a one-time warning that the VS Code API was unavailable',
      );
    } finally {
      console.warn = originalWarn;
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      Object.defineProperty(globalThis, 'acquireVsCodeApi', { configurable: true, value: originalAcquire });
    }
  });
});
