import { describe, expect, mock, test } from 'bun:test';

import type { MarkdownWorkerRequest } from './markdown-worker-protocol';

mock.module('./markdown-shiki.worker.ts?worker&url', () => ({ default: 'blob:test-shiki-worker' }));

/** A worker that answers every highlight request and counts them. */
class CountingWorker {
  static highlightRequests = 0;

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;

  postMessage(message: MarkdownWorkerRequest): void {
    if (message.type !== 'highlight') return;
    CountingWorker.highlightRequests += 1;
    setTimeout(() => {
      this.onmessage?.(new MessageEvent('message', {
        data: { type: 'highlight', id: message.id, html: `<pre>${message.code}</pre>` },
      }));
    }, 0);
  }

  terminate(): void {}
}

describe('markdown-worker transient highlights', () => {
  test('a fence that closes on the code of its last open step is not highlighted again', async () => {
    // bun test has no `window` or `Worker`; CountingWorker implements the
    // members markdown-worker uses.
    Object.defineProperty(globalThis, 'window', { value: {}, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'Worker', { value: CountingWorker, configurable: true, writable: true });
    const { highlightCodeInWorker, resetMarkdownWorkerClientCacheForTests } = await import('./markdown-worker');
    resetMarkdownWorkerClientCacheForTests();

    expect(await highlightCodeInWorker('const a = 1;', 'ts', { transient: true })).toBe('<pre>const a = 1;</pre>');
    expect(await highlightCodeInWorker('const a = 1;\nconst b = 2;', 'ts', { transient: true })).toBe('<pre>const a = 1;\nconst b = 2;</pre>');
    expect(CountingWorker.highlightRequests).toBe(2);

    // The fence closes: the settled request reuses the last open step and
    // keeps it from then on.
    expect(await highlightCodeInWorker('const a = 1;\nconst b = 2;', 'ts')).toBe('<pre>const a = 1;\nconst b = 2;</pre>');
    expect(await highlightCodeInWorker('const a = 1;\nconst b = 2;', 'ts')).toBe('<pre>const a = 1;\nconst b = 2;</pre>');
    expect(CountingWorker.highlightRequests).toBe(2);

    // Other code still goes to the worker.
    await highlightCodeInWorker('const c = 3;', 'ts');
    expect(CountingWorker.highlightRequests).toBe(3);
  });
});
