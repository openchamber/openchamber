import { describe, expect, mock, test } from 'bun:test';

import type { MarkdownWorkerRequest } from './markdown-worker-protocol';

/**
 * Hang safety for the markdown Shiki worker client
 * (openchamber/openchamber#2587, follow-up on #2618).
 *
 * Catastrophic Oniguruma backtracking is synchronous inside the worker, so the
 * only recovery is terminating it from this thread. Two properties matter and
 * neither is observable from the timeout constant alone: the hung request must
 * resolve `null` after the worker is terminated, and the block that caused it
 * must not be retried — a retry respawns a worker (Shiki + Oniguruma init) and
 * burns another full budget of a core on every render and every scroll past it.
 */

const TEST_TIMEOUT_MS = 50;

mock.module('./markdown-shiki.worker.ts?worker&url', () => ({ default: 'blob:test-shiki-worker' }));
mock.module('./markdown-worker-timeout', () => ({ HIGHLIGHT_REQUEST_TIMEOUT_MS: TEST_TIMEOUT_MS }));

/** A worker that accepts everything and answers nothing. */
class SilentWorker {
  static created = 0;
  static terminated = 0;
  static messages: MarkdownWorkerRequest[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;

  constructor() {
    SilentWorker.created += 1;
  }

  postMessage(message: MarkdownWorkerRequest): void {
    SilentWorker.messages.push(message);
  }

  terminate(): void {
    SilentWorker.terminated += 1;
  }
}

/**
 * bun test has no `window` or `Worker`; defining the properties directly
 * installs the stubs without asserting they are the platform globals.
 * `SilentWorker` implements exactly the members `markdown-worker` uses:
 * postMessage, terminate, and the three handler slots.
 */
const installWorkerStub = (): void => {
  Object.defineProperty(globalThis, 'window', { value: {}, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'Worker', { value: SilentWorker, configurable: true, writable: true });
};

/**
 * Silent on the first instance, answering on every later one — so a request
 * that was only queued behind the hung one can be observed being replayed
 * against the replacement worker.
 */
class ReplayWorker {
  static created = 0;
  static terminated = 0;

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;

  private readonly answers: boolean;

  constructor() {
    ReplayWorker.created += 1;
    this.answers = ReplayWorker.created > 1;
  }

  postMessage(message: MarkdownWorkerRequest): void {
    if (!this.answers || message.type !== 'highlight') return;
    setTimeout(() => {
      this.onmessage?.(new MessageEvent('message', {
        data: { type: 'highlight', id: message.id, html: '<pre>ok</pre>' },
      }));
    }, 0);
  }

  terminate(): void {
    ReplayWorker.terminated += 1;
  }
}

/** Same reasoning as installWorkerStub. */
const installReplayWorkerStub = (): void => {
  Object.defineProperty(globalThis, 'window', { value: {}, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'Worker', { value: ReplayWorker, configurable: true, writable: true });
};

describe('markdown-worker hang safety', () => {
  test('a hung block resolves null, terminates the worker, and is not retried', async () => {
    installWorkerStub();
    const { highlightCodeInWorker, resetMarkdownWorkerClientCacheForTests } = await import('./markdown-worker');
    resetMarkdownWorkerClientCacheForTests();

    const code = 'const label = `Account ${index + 1}`;';

    const first = await highlightCodeInWorker(code, 'javascript');
    expect(first).toBeNull();
    expect(SilentWorker.terminated).toBe(1);

    const createdAfterFirst = SilentWorker.created;
    const messagesAfterFirst = SilentWorker.messages.length;

    // Same content again: the timed-out key is memoized as failed, so nothing
    // reaches a worker and none is spawned.
    const second = await highlightCodeInWorker(code, 'javascript');
    expect(second).toBeNull();
    expect(SilentWorker.created).toBe(createdAfterFirst);
    expect(SilentWorker.messages.length).toBe(messagesAfterFirst);
  });

  test('a timeout fails only the offending request and replays the queued one', async () => {
    installReplayWorkerStub();
    const { highlightCodeInWorker, resetMarkdownWorkerClientCacheForTests } = await import('./markdown-worker');
    resetMarkdownWorkerClientCacheForTests();

    const results = await Promise.all([
      highlightCodeInWorker('const a = `one`;', 'javascript'),
      highlightCodeInWorker('const b = `two`;', 'javascript'),
    ]);

    // Whichever request owns the first timer is the offender; the other was
    // merely queued behind it and must survive on the replacement worker
    // rather than being cancelled with it.
    expect(results.filter((value) => value === null)).toHaveLength(1);
    expect(results.filter((value) => value === '<pre>ok</pre>')).toHaveLength(1);
    expect(ReplayWorker.terminated).toBe(1);
    expect(ReplayWorker.created).toBe(2);
  });
});
