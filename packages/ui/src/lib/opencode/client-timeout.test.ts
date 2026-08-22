/**
 * Regression tests for issue #2470: sessions stuck on "loading sessions"
 * forever after the managed OpenCode connection goes half-open.
 *
 * The SDK client fetch wrapper must bound read requests so a socket that
 * neither resolves nor rejects fails after `requestTimeoutMs`, releasing the
 * directory bootstrap concurrency slot. Long-lived streams must be excluded:
 * POST (prompt/shell/summarize/command) and the `/event` SSE stream.
 */
import { describe, expect, mock, test } from 'bun:test';

(mock as unknown as { restore?: () => void }).restore?.();

type CapturedFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const capturedConfigs: Array<{ fetch?: CapturedFetch }> = [];
const sdkCreateMock = mock((config: { fetch?: CapturedFetch }) => {
  capturedConfigs.push(config);
  return {};
});

mock.module('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: sdkCreateMock,
}));

mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: mock(() => null),
}));

mock.module('@/lib/runtime-url', () => ({
  getRuntimeUrlResolver: mock(() => ({
    api: (path: string) => path,
  })),
}));

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeApiBaseUrl: mock(() => ''),
  getRuntimeKey: mock(() => 'test-runtime'),
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async () => new Response('{}', {
    headers: { 'Content-Type': 'application/json' },
  })),
}));

mock.module('@/lib/startupTrace', () => ({
  markStartupTrace: mock(() => undefined),
}));

const { createRuntimeOpencodeClient } = await import(`./client?timeout-test=${Date.now()}`);

const neverSettles = (_input: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    // Mimic real fetch: an aborted signal rejects the pending request.
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });

describe('createRuntimeOpencodeClient read timeout (#2470)', () => {
  test('a GET whose socket never settles rejects with a normalized "request timed out" error', async () => {
    capturedConfigs.length = 0;
    const client = createRuntimeOpencodeClient({ baseUrl: '/api', requestTimeoutMs: 50 });
    const fetchImpl = capturedConfigs[0]?.fetch;
    expect(typeof fetchImpl).toBe('function');
    expect(client).toBeDefined();

    const { runtimeFetch } = await import('@/lib/runtime-fetch');
    (runtimeFetch as unknown as { mockImplementation: (impl: unknown) => void }).mockImplementation(neverSettles);

    const error = await fetchImpl!(new Request('http://127.0.0.1/api/session', { method: 'GET' })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('request timed out');
  });

  test('POST requests (long-running prompt/shell/summarize) are NOT timed out', async () => {
    capturedConfigs.length = 0;
    createRuntimeOpencodeClient({ baseUrl: '/api', requestTimeoutMs: 30 });

    const { runtimeFetch } = await import('@/lib/runtime-fetch');
    (runtimeFetch as unknown as { mockImplementation: (impl: unknown) => void }).mockImplementation(neverSettles);

    const fetchImpl = capturedConfigs[0]?.fetch as CapturedFetch;
    const result = await Promise.race([
      fetchImpl(new Request('http://127.0.0.1/api/session/ses_1/message', { method: 'POST' }))
        .then(() => 'resolved'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 200)),
    ]);
    // The promise must still be pending after the timeout window: POST is excluded.
    expect(result).toBe('timed-out');
  });

  test('the /event SSE stream is NOT timed out', async () => {
    capturedConfigs.length = 0;
    createRuntimeOpencodeClient({ baseUrl: '/api', requestTimeoutMs: 30 });

    const { runtimeFetch } = await import('@/lib/runtime-fetch');
    (runtimeFetch as unknown as { mockImplementation: (impl: unknown) => void }).mockImplementation(neverSettles);

    const fetchImpl = capturedConfigs[0]?.fetch as CapturedFetch;
    const result = await Promise.race([
      fetchImpl(new Request('http://127.0.0.1/api/global/event', { method: 'GET' }))
        .then(() => 'resolved'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 200)),
    ]);
    expect(result).toBe('timed-out');
  });

  test('a caller-provided abort signal still wins (no normalized timeout error)', async () => {
    capturedConfigs.length = 0;
    createRuntimeOpencodeClient({ baseUrl: '/api', requestTimeoutMs: 50 });

    const { runtimeFetch } = await import('@/lib/runtime-fetch');
    (runtimeFetch as unknown as { mockImplementation: (impl: unknown) => void }).mockImplementation(neverSettles);

    const fetchImpl = capturedConfigs[0]?.fetch as CapturedFetch;
    const controller = new AbortController();
    const pending = fetchImpl(new Request('http://127.0.0.1/api/session', { method: 'GET' }), { signal: controller.signal })
      .then(() => null, (e: unknown) => e);
    controller.abort();
    const error = await pending;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('request timed out');
  });
});
