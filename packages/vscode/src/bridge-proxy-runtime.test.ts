import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { BridgeContext } from './bridge';
import { handleProxyBridgeMessage } from './bridge-proxy-runtime';
import { API_PROXY_RESPONSE_MAX_BYTES } from './bounded-response-body';

const deps = {
  tryHandleLocalFsProxy: async () => null,
  waitForWorktreeRemoval: async () => {},
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

const connectedManager = {
  getStatus: () => 'connected',
  getApiUrl: () => 'http://127.0.0.1:3902',
  getOpenCodeAuthHeaders: () => ({}),
  onStatusChange: (cb: (status: string) => void) => {
    cb('connected');
    return { dispose: () => {} };
  },
};

// SAFETY: the proxy runtime only reads the manager members stubbed above.
const asBridgeContext = (manager: typeof connectedManager): BridgeContext => ({ manager } as unknown as BridgeContext);

const ctx = asBridgeContext(connectedManager);

describe('VS Code API proxy aborts', () => {
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
        { id: 'req_1', type: 'api:proxy', payload: { method: 'POST', path: '/api/session/abc/prompt', bodyBase64: Buffer.from('{}').toString('base64') } },
        ctx,
        deps,
      );

      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(capturedSignal?.aborted, false);

      await handleProxyBridgeMessage({ id: 'abort_req_1', type: 'api:proxy:abort', payload: { requestID: 'req_1' } }, ctx, deps);
      assert.equal(capturedSignal?.aborted, true);

      const response = await pending;
      assert.equal(response?.success, true);
      assert.equal((response?.data as { status?: number } | undefined)?.status, 502);
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
        { id: 'r1', type: 'api:proxy', payload: { method: 'GET', path: '/api/config', headers: { 'x-opencode-directory': '/x' } } },
        ctx,
        deps,
      );
      const second = handleProxyBridgeMessage(
        { id: 'r2', type: 'api:proxy', payload: { method: 'GET', path: '/api/config', headers: { 'X-OpenCode-Directory': '/x' } } },
        ctx,
        deps,
      );

      await new Promise((resolve) => setTimeout(resolve, 0));
      release();

      const [a, b] = await Promise.all([first, second]);
      assert.equal(fetchCount, 1);
      assert.equal((a?.data as { bodyText?: string } | undefined)?.bodyText, '{"ok":true}');
      assert.equal((b?.data as { bodyText?: string } | undefined)?.bodyText, '{"ok":true}');
      assert.notStrictEqual((a?.data as { headers: unknown } | undefined)?.headers, (b?.data as { headers: unknown } | undefined)?.headers);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('keeps reads for different directories apart even when the URL is identical', async () => {
    const originalFetch = globalThis.fetch;
    const releases: Array<() => void> = [];
    const seenDirectories: string[] = [];

    try {
      // SAFETY: test double for the global fetch; the proxy only reads the headers and response.
      globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const directory = new Headers(init?.headers).get('x-opencode-directory') ?? '';
        seenDirectories.push(directory);
        await new Promise<void>((resolve) => { releases.push(resolve); });
        return new Response(JSON.stringify({ directory }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      const forA = handleProxyBridgeMessage(
        { id: 'a', type: 'api:proxy', payload: { method: 'GET', path: '/api/config', headers: { 'x-opencode-directory': '/project-a' } } },
        ctx,
        deps,
      );
      const forB = handleProxyBridgeMessage(
        { id: 'b', type: 'api:proxy', payload: { method: 'GET', path: '/api/config', headers: { 'x-opencode-directory': '/project-b' } } },
        ctx,
        deps,
      );

      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(seenDirectories, ['/project-a', '/project-b']);
      for (const release of releases) release();

      const [a, b] = await Promise.all([forA, forB]);
      // SAFETY: api:proxy always answers with an ApiProxyResponsePayload; only bodyText is read.
      assert.equal((a?.data as { bodyText?: string } | undefined)?.bodyText, JSON.stringify({ directory: '/project-a' }));
      // SAFETY: same payload contract as the line above.
      assert.equal((b?.data as { bodyText?: string } | undefined)?.bodyText, JSON.stringify({ directory: '/project-b' }));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('keeps reads with different auth scopes apart', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;

    try {
      // SAFETY: test double for the global fetch; only the call count matters here.
      globalThis.fetch = (async () => {
        fetchCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 0));
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      let authCalls = 0;
      const scopedCtx = asBridgeContext({
        ...connectedManager,
        getOpenCodeAuthHeaders: () => ({ authorization: `Bearer scope-${(authCalls += 1)}` }),
      });

      await Promise.all([
        handleProxyBridgeMessage({ id: 'x1', type: 'api:proxy', payload: { method: 'GET', path: '/api/provider' } }, scopedCtx, deps),
        handleProxyBridgeMessage({ id: 'x2', type: 'api:proxy', payload: { method: 'GET', path: '/api/provider' } }, scopedCtx, deps),
      ]);
      assert.equal(fetchCount, 2);
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
        handleProxyBridgeMessage({ id: 'w1', type: 'api:proxy', payload: { method: 'GET', path: '/api/session?directory=/x' } }, ctx, deps),
        handleProxyBridgeMessage({ id: 'w2', type: 'api:proxy', payload: { method: 'GET', path: '/api/session?directory=/x' } }, ctx, deps),
      ]);
      assert.equal(fetchCount, 0); // sanity: counter only bumps in the slow mock above

      globalThis.fetch = (async () => {
        fetchCount += 1;
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      await Promise.all([
        handleProxyBridgeMessage({ id: 's1', type: 'api:proxy', payload: { method: 'GET', path: '/api/session?directory=/x' } }, ctx, deps),
        handleProxyBridgeMessage({ id: 's2', type: 'api:proxy', payload: { method: 'GET', path: '/api/session?directory=/x' } }, ctx, deps),
      ]);
      assert.equal(fetchCount, 2); // /api/session is not in the read allowlist
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('bounded proxy reads still overlay owned session state', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('{"data":{"id":"ses_a","time":{}}}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    const response = await handleProxyBridgeMessage(
      { id: 'owned_session', type: 'api:proxy', payload: { method: 'GET', path: '/api/session/ses_a' } },
      ctx,
      {
        ...deps,
        sessionState: {
          readArchived: async () => ({ ses_a: 1234 }),
          readMetadata: async () => ({ ses_a: { openchamber: { pinned: true } } }),
        },
      },
    );

    // SAFETY: This request takes the API proxy route, whose response data has this payload shape.
    const data = response?.data as { bodyText?: string } | undefined;
    assert.deepEqual(JSON.parse(data?.bodyText ?? '{}'), {
      data: { id: 'ses_a', time: { archived: 1234 }, metadata: { openchamber: { pinned: true } } },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

describe('VS Code API proxy Git initialization', () => {
  test('refuses to initialize Git in the home directory without reaching OpenCode', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    try {
      globalThis.fetch = (async () => {
        fetchCount += 1;
        return new Response(null, { status: 204 });
      }) as typeof fetch;
      const home = (await import('node:os')).homedir();
      const response = await handleProxyBridgeMessage(
        { id: 'init_home', type: 'api:proxy', payload: { method: 'POST', path: '/api/vcs/init', headers: { 'X-OpenCode-Directory': encodeURIComponent(home) } } },
        ctx,
        deps,
      );
      const data = response?.data as { status?: number; bodyText?: string };
      assert.equal(data.status, 400);
      assert.equal(JSON.parse(data.bodyText ?? '{}')._tag, 'InvalidRequestError');
      assert.equal(fetchCount, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('forwards Git initialization for a project directory', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    try {
      globalThis.fetch = (async () => {
        fetchCount += 1;
        return new Response(null, { status: 204 });
      }) as typeof fetch;
      const response = await handleProxyBridgeMessage(
        { id: 'init_project', type: 'api:proxy', payload: { method: 'POST', path: '/api/vcs/init', headers: { 'x-opencode-directory': encodeURIComponent('/tmp/some-project') } } },
        ctx,
        deps,
      );
      assert.equal((response?.data as { status?: number } | undefined)?.status, 204);
      assert.equal(fetchCount, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('VS Code API proxy during a worktree removal', () => {
  test('holds a request for a folder of the worktree being removed until the removal settles', async () => {
    const originalFetch = globalThis.fetch;
    const fetched: string[] = [];
    const asked: string[] = [];
    let settle: () => void = () => {};
    const removal = new Promise<void>((resolve) => { settle = resolve; });
    const worktree = '/repo/worktrees/removal hold';

    try {
      // SAFETY: test double for the global fetch; the proxy only reads the response.
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
        fetched.push(new URL(String(input)).pathname);
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;
      const holdingDeps = {
        ...deps,
        waitForWorktreeRemoval: async (directory: string) => {
          asked.push(directory);
          if (directory.startsWith(worktree)) await removal;
        },
      };

      // The UI sends the header encoded without the marker; OpenCode decodes it.
      const held = handleProxyBridgeMessage(
        { id: 'h1', type: 'api:proxy', payload: { method: 'GET', path: '/api/mcp', headers: { 'x-opencode-directory': encodeURIComponent(`${worktree}/sub`) } } },
        ctx,
        holdingDeps,
      );
      const other = await handleProxyBridgeMessage(
        { id: 'h2', type: 'api:proxy', payload: { method: 'GET', path: '/api/mcp', headers: { 'x-opencode-directory': '/repo' } } },
        ctx,
        holdingDeps,
      );

      // SAFETY: api:proxy always answers with an ApiProxyResponsePayload; only status is read.
      assert.equal((other?.data as { status?: number } | undefined)?.status, 200);
      assert.deepEqual(asked, [`${worktree}/sub`, '/repo']);
      assert.deepEqual(fetched, ['/api/mcp']);

      settle();
      await held;
      assert.deepEqual(fetched, ['/api/mcp', '/api/mcp']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('VS Code API proxy deadline (#788)', () => {
  // SAFETY: in these tests the bridge response data is the proxy's own
  // ApiProxyResponsePayload, whose status/bodyText fields are what is pinned.
  const payloadOf = (response: { data?: unknown } | null) => response?.data as { status?: number; bodyText?: string } | undefined;

  const stalledFetch = (counter: { count: number }): typeof fetch => async (_input, init) => {
    counter.count += 1;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  };

  test('fails a plain api:proxy forward whose upstream never answers, within the deadline', async () => {
    const originalFetch = globalThis.fetch;
    const counter = { count: 0 };
    try {
      globalThis.fetch = stalledFetch(counter);
      const started = Date.now();
      const response = await handleProxyBridgeMessage(
        { id: 'stall_1', type: 'api:proxy', payload: { method: 'POST', path: '/api/session/abc/prompt', bodyBase64: Buffer.from('{}').toString('base64') } },
        ctx,
        { ...deps, proxyDeadlineMs: 50 },
      );
      assert.ok(Date.now() - started < 5_000, 'forward must settle near the deadline, not hang');
      assert.equal(response?.success, true);
      assert.equal(payloadOf(response)?.status, 502);
      assert.equal(counter.count, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Runs `run` with AbortSignal.any removed, simulating the oldest
  // supported extension host (VS Code 1.85 / Node 18.15), and restores it.
  const withoutAbortSignalAny = async (run: () => Promise<void>) => {
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
    Reflect.deleteProperty(AbortSignal, 'any');
    try {
      await run();
    } finally {
      if (descriptor) Object.defineProperty(AbortSignal, 'any', descriptor);
    }
  };

  test('still bounds a plain forward on hosts without AbortSignal.any', async () => {
    const originalFetch = globalThis.fetch;
    const counter = { count: 0 };
    try {
      await withoutAbortSignalAny(async () => {
        globalThis.fetch = stalledFetch(counter);
        const started = Date.now();
        const response = await handleProxyBridgeMessage(
          { id: 'stall_no_any', type: 'api:proxy', payload: { method: 'POST', path: '/api/session/abc/prompt', bodyBase64: Buffer.from('{}').toString('base64') } },
          ctx,
          { ...deps, proxyDeadlineMs: 50 },
        );
        assert.ok(Date.now() - started < 5_000, 'forward must settle near the deadline, not hang');
        assert.equal(response?.success, true);
        assert.equal(payloadOf(response)?.status, 502);
        assert.equal(counter.count, 1);
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('still propagates caller aborts on hosts without AbortSignal.any', async () => {
    const originalFetch = globalThis.fetch;
    let capturedSignal: AbortSignal | undefined;
    try {
      await withoutAbortSignalAny(async () => {
        // SAFETY: test double for the global fetch; only the captured signal is read.
        globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          capturedSignal = init?.signal ?? undefined;
          return new Promise<Response>((_resolve, reject) => {
            capturedSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
          });
        }) as typeof fetch;

        const pending = handleProxyBridgeMessage(
          { id: 'req_no_any', type: 'api:proxy', payload: { method: 'POST', path: '/api/session/abc/prompt', bodyBase64: Buffer.from('{}').toString('base64') } },
          ctx,
          deps,
        );

        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(capturedSignal?.aborted, false);

        await handleProxyBridgeMessage({ id: 'abort_no_any', type: 'api:proxy:abort', payload: { requestID: 'req_no_any' } }, ctx, deps);
        assert.equal(capturedSignal?.aborted, true);

        const response = await pending;
        assert.equal(response?.success, true);
        assert.equal(payloadOf(response)?.status, 502);
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('evicts a stalled coalesced read so joined callers fail and a later read retries', async () => {
    const originalFetch = globalThis.fetch;
    const counter = { count: 0 };
    try {
      globalThis.fetch = stalledFetch(counter);
      const request = (id: string) => handleProxyBridgeMessage(
        { id, type: 'api:proxy', payload: { method: 'GET', path: '/api/config', headers: { 'x-opencode-directory': '/x' } } },
        ctx,
        { ...deps, proxyDeadlineMs: 50 },
      );
      const [a, b] = await Promise.all([request('c1'), request('c2')]);
      assert.equal(counter.count, 1);
      assert.equal(payloadOf(a)?.status, 502);
      assert.equal(payloadOf(b)?.status, 502);

      globalThis.fetch = async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
      const retry = await request('c3');
      assert.equal(payloadOf(retry)?.status, 200);
      assert.equal(payloadOf(retry)?.bodyText, '{"ok":true}');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('VS Code API proxy response byte cap', () => {
  const routes = [
    {
      name: 'api:proxy',
      send: (id: string) => handleProxyBridgeMessage(
        { id, type: 'api:proxy', payload: { method: 'GET', path: '/api/proxy-cap-test' } },
        ctx,
        deps,
      ),
    },
    {
      name: 'api:session:message',
      send: (id: string) => handleProxyBridgeMessage(
        { id, type: 'api:session:message', payload: { path: '/api/session/ses_a/prompt', bodyText: '{}' } },
        ctx,
        deps,
      ),
    },
  ] as const;
  const mediaTypes = [
    { name: 'text', contentType: 'text/plain' },
    { name: 'binary', contentType: 'application/octet-stream' },
  ] as const;
  // SAFETY: Both route fixtures return ApiProxyResponsePayload under BridgeResponse.data.
  const responseData = (response: Awaited<ReturnType<(typeof routes)[number]['send']>>) =>
    response?.data as { status?: number; headers?: Record<string, string>; bodyText?: string; bodyBase64?: string } | undefined;

  for (const route of routes) {
    for (const mediaType of mediaTypes) {
      test(`${route.name} rejects declared over-cap ${mediaType.name} bodies before reading and cancels upstream`, async () => {
        const originalFetch = globalThis.fetch;
        let pulls = 0;
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            controller.enqueue(Uint8Array.of(1));
          },
          cancel() {
            cancelled = true;
          },
        }, { highWaterMark: 0 });

        try {
          globalThis.fetch = async () => new Response(body, {
            status: 200,
            headers: {
              'content-type': mediaType.contentType,
              'content-length': String(API_PROXY_RESPONSE_MAX_BYTES + 1),
            },
          });

          const data = responseData(await route.send(`declared_${route.name}_${mediaType.name}`));
          assert.equal(data?.status, 502);
          assert.equal(JSON.parse(data?.bodyText ?? '{}').error, 'OpenCode API response exceeded the 16 MiB limit');
          assert.equal(pulls, 0);
          assert.equal(cancelled, true);
        } finally {
          globalThis.fetch = originalFetch;
        }
      });

      test(`${route.name} cancels streamed over-cap ${mediaType.name} bodies`, async () => {
        const originalFetch = globalThis.fetch;
        let pulls = 0;
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            controller.enqueue(new Uint8Array(API_PROXY_RESPONSE_MAX_BYTES + 1));
          },
          cancel() {
            cancelled = true;
          },
        }, { highWaterMark: 0 });

        try {
          globalThis.fetch = async () => new Response(body, {
            status: 200,
            headers: { 'content-type': mediaType.contentType },
          });

          const data = responseData(await route.send(`streamed_${route.name}_${mediaType.name}`));
          assert.equal(data?.status, 502);
          assert.equal(JSON.parse(data?.bodyText ?? '{}').error, 'OpenCode API response exceeded the 16 MiB limit');
          assert.equal(pulls, 1);
          assert.equal(cancelled, true);
        } finally {
          globalThis.fetch = originalFetch;
        }
      });

      test(`${route.name} accepts exactly 16 MiB of ${mediaType.name} response bytes`, async () => {
        const originalFetch = globalThis.fetch;
        const fill = mediaType.name === 'text' ? 0x61 : 0x5a;
        const bytes = new Uint8Array(API_PROXY_RESPONSE_MAX_BYTES).fill(fill);
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }, { highWaterMark: 0 });

        try {
          globalThis.fetch = async () => new Response(body, {
            status: 200,
            headers: {
              'content-type': mediaType.contentType,
              'content-length': String(API_PROXY_RESPONSE_MAX_BYTES),
              'x-upstream': 'preserved',
            },
          });

          const data = responseData(await route.send(`exact_${route.name}_${mediaType.name}`));
          assert.equal(data?.status, 200);
          assert.equal(data?.headers?.['x-upstream'], 'preserved');
          assert.equal(data?.headers?.['content-type'], mediaType.contentType);
          assert.equal(data?.headers?.['content-length'], undefined);
          if (mediaType.name === 'text') {
            assert.equal(data?.bodyText?.length, API_PROXY_RESPONSE_MAX_BYTES);
            assert.equal(data?.bodyText?.[0], 'a');
            assert.equal(data?.bodyText?.at(-1), 'a');
            assert.equal(data?.bodyBase64, undefined);
          } else {
            assert.equal(data?.bodyBase64?.length, Math.ceil(API_PROXY_RESPONSE_MAX_BYTES / 3) * 4);
            assert.equal(data?.bodyBase64?.startsWith('Wlpa'), true);
            assert.equal(data?.bodyBase64?.endsWith('Wg=='), true);
            assert.equal(data?.bodyText, undefined);
          }
        } finally {
          globalThis.fetch = originalFetch;
        }
      });
    }
  }
});
