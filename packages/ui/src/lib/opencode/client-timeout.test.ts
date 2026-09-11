import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Regression tests for issue #2470: sessions stuck on "loading sessions"
// forever after managed OpenCode connection goes half-open.
//
// The SDK client fetch wrapper must bound read requests so a socket that
// neither resolves nor rejects fails after `requestTimeoutMs`, releasing the
// directory bootstrap concurrency slot. Long-lived streams must be excluded:
// POST (prompt/shell/summarize/command) and the `/event` SSE stream.

type CapturedFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type RuntimeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

// `mock(...)` returns a Mock that exposes mockImplementation; keep a typed
// reference so per-test overrides stay type-safe without re-importing.
const runtimeFetchMock = mock<RuntimeFetch>(async () => new Response('', { status: 200 }));

let capturedFetch: CapturedFetch | null = null;

(mock as unknown as { restore?: () => void }).restore?.();

mock.module('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: mock((opts: { fetch: CapturedFetch }) => {
    capturedFetch = opts.fetch;
    return {};
  }),
}));

mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: mock(() => null),
}));

mock.module('@/lib/runtime-url', () => ({
  getRuntimeUrlResolver: mock(() => ({ api: (path: string) => path })),
}));

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeApiBaseUrl: mock(() => ''),
  getRuntimeKey: mock(() => 'test-runtime'),
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: runtimeFetchMock,
}));

mock.module('@/lib/startupTrace', () => ({
  markStartupTrace: mock(() => undefined),
}));

const { createRuntimeOpencodeClient } = await import(
  `./client?timeout-final=${Date.now()}`
);

beforeEach(() => {
  capturedFetch = null;
  runtimeFetchMock.mockImplementation(async () => new Response('', { status: 200 }));
});

describe('createRuntimeOpencodeClient fetch wrapper (#2470)', () => {
  test('AbortSignal.timeout fires inside a test environment (sanity)', async () => {
    const sig = AbortSignal.timeout(20);
    const fired = await new Promise<boolean>((resolve) => {
      sig.addEventListener('abort', () => resolve(true));
      setTimeout(() => resolve(false), 200);
    });
    expect(fired).toBe(true);
  });

  test('createRuntimeOpencodeClient is exported', () => {
    expect(typeof createRuntimeOpencodeClient).toBe('function');
  });

  test('a GET whose socket never settles rejects with normalized "request timed out" error', async () => {
    let firedAt = 0;
    let calledAt = Date.now();
    runtimeFetchMock.mockImplementation(async (_input: string | URL | Request, init?: RequestInit) => {
      calledAt = Date.now();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          firedAt = Date.now();
          reject(new DOMException('Aborted', 'AbortError'));
        });
        setTimeout(
          () => reject(new Error('TIMEOUT_TEST_FAIL: signal never fired')),
          1000,
        );
      });
    });

    createRuntimeOpencodeClient({ baseUrl: '', requestTimeoutMs: 25 });
    expect(capturedFetch).not.toBeNull();

    const start = Date.now();
    await expect(
      capturedFetch!('http://opencode.test/api/session'),
    ).rejects.toThrow(/request timed out/);
    const elapsed = Date.now() - start;
    expect(firedAt).toBeGreaterThanOrEqual(calledAt);
    expect(elapsed).toBeLessThan(500);
  });

  test('POST requests (long-running prompt/shell/summarize) are NOT timed out', async () => {
    runtimeFetchMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return new Response('ok', { status: 200 });
    });

    createRuntimeOpencodeClient({ baseUrl: '', requestTimeoutMs: 25 });
    expect(capturedFetch).not.toBeNull();

    const response = await capturedFetch!(
      'http://opencode.test/session/prompt',
      { method: 'POST' },
    );
    expect(await response.text()).toBe('ok');
  });

  test('the /event SSE stream is NOT timed out', async () => {
    runtimeFetchMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return new Response('event: ping\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    createRuntimeOpencodeClient({ baseUrl: '', requestTimeoutMs: 25 });
    expect(capturedFetch).not.toBeNull();

    const response = await capturedFetch!(
      'http://opencode.test/api/global/event',
    );
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
  });

  test('caller-provided abort signal still wins (no normalized timeout error)', async () => {
    runtimeFetchMock.mockImplementation(async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      }),
    );

    createRuntimeOpencodeClient({ baseUrl: '', requestTimeoutMs: 25 });
    expect(capturedFetch).not.toBeNull();

    const callerController = new AbortController();
    setTimeout(() => callerController.abort(), 5);

    await expect(
      capturedFetch!('http://opencode.test/api/session', {
        signal: callerController.signal,
      }),
    ).rejects.toThrow('Aborted');
  });
});
