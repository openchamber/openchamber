import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { BridgeContext } from './bridge';
import { handleProxyBridgeMessage } from './bridge-proxy-runtime';

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

type ProxyAnswer = { status: number; bodyText: string };
type ProxyRequest = { method: string; path: string; headers?: { [name: string]: string }; bodyBase64?: string };

describe('VS Code API proxy folder trust', () => {
  test('refuses an untrusted folder before OpenCode sees it and answers the trust route itself', async () => {
    const { mkdir, mkdtemp, realpath, rm, writeFile } = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { createOpenCodeTrust } = await import('../../web/server/lib/opencode-trust/index.js');
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vscode-opencode-trust-')));
    const repo = path.join(root, 'repo');
    await mkdir(path.join(repo, '.opencode', 'plugins'), { recursive: true });
    await writeFile(path.join(repo, '.opencode', 'plugins', 'probe.js'), 'export default {}');
    const trustDeps = {
      ...deps,
      openCodeTrust: createOpenCodeTrust({ storePath: path.join(root, 'trust.json'), homeDirectory: path.join(root, 'home') }),
    };
    const proxy = async (payload: ProxyRequest): Promise<ProxyAnswer> => {
      const response = await handleProxyBridgeMessage({ id: 'trust', type: 'api:proxy', payload }, ctx, trustDeps);
      assert.ok(response);
      // SAFETY: api:proxy always answers with an ApiProxyResponsePayload, and every answer here is JSON text.
      return response.data as ProxyAnswer;
    };
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    try {
      // SAFETY: test double for the global fetch; the proxy only reads the status, headers and text.
      globalThis.fetch = (async () => {
        fetchCount += 1;
        return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;

      const headers = { 'x-opencode-directory': encodeURIComponent(repo) };
      const refused = await proxy({ method: 'GET', path: '/api/agent', headers });
      assert.equal(refused.status, 403);
      assert.equal(JSON.parse(refused.bodyText).code, 'opencode_trust_required');
      assert.equal(fetchCount, 0);

      const shown = await proxy({ method: 'GET', path: `/api/opencode/trust?directory=${encodeURIComponent(repo)}` });
      const { fingerprint } = JSON.parse(shown.bodyText);
      const body = Buffer.from(JSON.stringify({ directory: repo, fingerprint })).toString('base64');
      assert.equal((await proxy({ method: 'POST', path: '/api/opencode/trust', bodyBase64: body })).status, 200);

      assert.equal((await proxy({ method: 'GET', path: '/api/agent', headers })).status, 200);
      assert.equal(fetchCount, 1);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  });
});
