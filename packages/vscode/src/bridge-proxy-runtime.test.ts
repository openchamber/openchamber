import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { BridgeContext } from './bridge';
import { handleProxyBridgeMessage } from './bridge-proxy-runtime';

const deps = {
  tryHandleLocalFsProxy: async () => null,
  buildUnavailableApiResponse: () => ({ status: 503, headers: {}, bodyText: '' }),
  sanitizeForwardHeaders: (input: Record<string, string> | undefined) => input ?? {},
  collectHeaders: (headers: Headers) => {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  },
  base64EncodeUtf8: (text: string) => Buffer.from(text, 'utf8').toString('base64'),
};

const ctx = {
  manager: {
    getStatus: () => 'connected',
    getApiUrl: () => 'http://127.0.0.1:3902',
    getOpenCodeAuthHeaders: () => ({}),
    onStatusChange: (cb: (status: string) => void) => {
      cb('connected');
      return { dispose: () => {} };
    },
  },
} as unknown as BridgeContext;

describe('VS Code API proxy aborts', () => {
  test('forwards durable prompt requests to the upstream /api route', async () => {
    const originalFetch = globalThis.fetch;
    let upstreamUrl = '';
    try {
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
        upstreamUrl = String(input);
        return Response.json({ ok: true });
      }) as typeof fetch;

      const response = await handleProxyBridgeMessage(
        { id: 'prompt_1', type: 'api:session:prompt', payload: {
          path: '/api/session/ses-1/prompt', bodyBase64: Buffer.from('{"id":"msg-1"}').toString('base64'),
        } },
        ctx,
        deps,
      );

      assert.equal(new URL(upstreamUrl).pathname, '/api/session/ses-1/prompt');
      assert.equal(response?.success, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('forwards durable history requests with the exact v2 path and query', async () => {
    const originalFetch = globalThis.fetch;
    let upstreamUrl = '';
    try {
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
        upstreamUrl = String(input);
        return Response.json({ data: [], hasMore: false });
      }) as typeof fetch;

      const response = await handleProxyBridgeMessage(
        { id: 'history_1', type: 'api:session:history', payload: {
          path: '/api/session/ses-1/history?directory=%2Frepo&after=7&limit=20',
        } },
        ctx,
        deps,
      );

      const upstream = new URL(upstreamUrl);
      assert.equal(upstream.pathname, '/api/session/ses-1/history');
      assert.deepEqual([...upstream.searchParams.entries()], [
        ['directory', '/repo'], ['after', '7'], ['limit', '20'],
      ]);
      assert.equal(response?.success, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('aborts non-SSE api:proxy fetches by bridge request id', async () => {
    const originalFetch = globalThis.fetch;
    let capturedSignal: AbortSignal | undefined;

    try {
      globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        capturedSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          capturedSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }) as typeof fetch;

      const pending = handleProxyBridgeMessage(
        { id: 'req_1', type: 'api:proxy', payload: { method: 'POST', path: '/session/abc/prompt_async', bodyBase64: Buffer.from('{}').toString('base64') } },
        ctx,
        deps,
      );

      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(capturedSignal?.aborted, false);

      await handleProxyBridgeMessage({ id: 'abort_req_1', type: 'api:proxy:abort', payload: { requestID: 'req_1' } }, ctx, deps);
      assert.equal(capturedSignal?.aborted, true);

      const response = await pending;
      assert.equal(response?.success, true);
      assert.equal((response?.data as { status?: number }).status, 502);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('VS Code API proxy read coalescing', () => {
  test('shares one upstream fetch across concurrent identical GET reads', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    let release: () => void = () => {};

    try {
      globalThis.fetch = (async () => {
        fetchCount += 1;
        await new Promise<void>((resolve) => { release = resolve; });
        return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      const first = handleProxyBridgeMessage(
        { id: 'r1', type: 'api:proxy', payload: { method: 'GET', path: '/config?directory=/x' } },
        ctx,
        deps,
      );
      const second = handleProxyBridgeMessage(
        { id: 'r2', type: 'api:proxy', payload: { method: 'GET', path: '/config?directory=/x' } },
        ctx,
        deps,
      );

      await new Promise((resolve) => setTimeout(resolve, 0));
      release();

      const [a, b] = await Promise.all([first, second]);
      assert.equal(fetchCount, 1);
      assert.equal((a?.data as { bodyText?: string }).bodyText, '{"ok":true}');
      assert.equal((b?.data as { bodyText?: string }).bodyText, '{"ok":true}');
      assert.notStrictEqual((a?.data as { headers: unknown }).headers, (b?.data as { headers: unknown }).headers);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('does not coalesce POST writes or non-allowlisted reads', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;

    try {
      globalThis.fetch = (async () =>
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

      await Promise.all([
        handleProxyBridgeMessage({ id: 'w1', type: 'api:proxy', payload: { method: 'GET', path: '/session?directory=/x' } }, ctx, deps),
        handleProxyBridgeMessage({ id: 'w2', type: 'api:proxy', payload: { method: 'GET', path: '/session?directory=/x' } }, ctx, deps),
      ]);
      assert.equal(fetchCount, 0); // sanity: counter only bumps in the slow mock above

      globalThis.fetch = (async () => {
        fetchCount += 1;
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      await Promise.all([
        handleProxyBridgeMessage({ id: 's1', type: 'api:proxy', payload: { method: 'GET', path: '/session?directory=/x' } }, ctx, deps),
        handleProxyBridgeMessage({ id: 's2', type: 'api:proxy', payload: { method: 'GET', path: '/session?directory=/x' } }, ctx, deps),
      ]);
      assert.equal(fetchCount, 2); // /session is not in the read allowlist
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
