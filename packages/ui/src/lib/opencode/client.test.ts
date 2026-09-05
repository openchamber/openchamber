import { beforeEach, describe, expect, mock, test } from 'bun:test';

type ConfigResponse = { data: Record<string, unknown> };

(mock as unknown as { restore?: () => void }).restore?.();

const configResolvers: Array<(response: ConfigResponse) => void> = [];
let configCalls = 0;
let runtimeKey = 'test-runtime';
const promptAsyncCalls: unknown[][] = [];
const promptAsyncResults: Array<unknown> = [];
const pathGetResults: Array<unknown> = [];

const promptAsyncMock = mock(async (...args: unknown[]) => {
  promptAsyncCalls.push(args);
  const next = promptAsyncResults.shift();
  if (next instanceof Error) throw next;
  return next ?? { response: new Response(null, { status: 200 }) };
});

let pathGetCalls = 0;
const pathGetMock = mock(async () => {
  pathGetCalls += 1;
  const next = pathGetResults.shift();
  if (next instanceof Error) throw next;
  return next ?? { data: { directory: '/workspace/project' } };
});

mock.module('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: mock(() => ({
    config: {
      get: mock(() => {
        configCalls += 1;
        return new Promise<ConfigResponse>((resolve) => {
          configResolvers.push(resolve);
        });
      }),
    },
    session: {
      promptAsync: promptAsyncMock,
    },
    path: {
      get: pathGetMock,
    },
  })),
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
  getRuntimeKey: mock(() => runtimeKey),
}));

type DirectoryProbeQuery = { path?: string };
const runtimeFetchCalls: Array<{ path: string; query: DirectoryProbeQuery | undefined }> = [];
const runtimeFetchResults: Array<Response | Error> = [];
const fsHomeResponses: Array<Response | Error> = [];

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async (input: string | URL | Request, init?: { query?: DirectoryProbeQuery }) => {
    if (typeof input === 'string' && input.includes('/fs/home')) {
      const next = fsHomeResponses.shift();
      if (next instanceof Error) throw next;
      if (next) return next;
    }
    if (typeof input === 'string') runtimeFetchCalls.push({ path: input, query: init?.query });
    const next = runtimeFetchResults.shift();
    if (next instanceof Error) throw next;
    return next ?? new Response(JSON.stringify([]), {
      headers: { 'Content-Type': 'application/json' },
    });
  }),
}));

mock.module('@/lib/startupTrace', () => ({
  markStartupTrace: mock(() => undefined),
}));

const { opencodeClient } = await import(`./client?cache-test=${Date.now()}`);

beforeEach(() => {
  runtimeKey = 'test-runtime';
  promptAsyncCalls.length = 0;
  promptAsyncResults.length = 0;
  pathGetResults.length = 0;
  pathGetCalls = 0;
  runtimeFetchCalls.length = 0;
  runtimeFetchResults.length = 0;
  fsHomeResponses.length = 0;
});

describe('opencodeClient directory availability', () => {
  type ProbeBody = { error?: string; reason?: string; entries?: never[] };
  const json = (status: number, body: ProbeBody): Response => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

  test('stats the directory through the OpenChamber filesystem route, never through OpenCode path resolution', async () => {
    runtimeFetchResults.push(json(200, { entries: [] }));
    expect(await opencodeClient.getDirectoryAvailability('/private/deleted-worktree')).toBe('available');
    expect(runtimeFetchCalls).toEqual([{ path: '/api/fs/list', query: { path: '/private/deleted-worktree' } }]);
    expect(pathGetCalls).toBe(0);
  });

  test('distinguishes a missing directory from an unavailable probe', async () => {
    runtimeFetchResults.push(json(404, { error: 'Directory not found', reason: 'not-found' }));
    expect(await opencodeClient.getDirectoryAvailability('/private/deleted-worktree')).toBe('missing');

    runtimeFetchResults.push(json(400, { error: 'Specified path is not a directory', reason: 'not-directory' }));
    expect(await opencodeClient.getDirectoryAvailability('/private/deleted-worktree')).toBe('missing');

    runtimeFetchResults.push(json(404, { error: 'Not Found' }));
    expect(await opencodeClient.getDirectoryAvailability('/private/deleted-worktree')).toBe('unknown');

    runtimeFetchResults.push(json(500, { error: 'Failed to list directory' }));
    expect(await opencodeClient.getDirectoryAvailability('/private/deleted-worktree')).toBe('unknown');

    runtimeFetchResults.push(new Error('offline'));
    expect(await opencodeClient.getDirectoryAvailability('/private/deleted-worktree')).toBe('unknown');
  });
});

describe('opencodeClient getFilesystemHomeInfo', () => {
  type HomePayload = { home?: string; chatsRoot?: string | number };
  const fsHomeResponse = (body: HomePayload) => new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });

  test('returns the server-provided chats root', async () => {
    fsHomeResponses.push(fsHomeResponse({ home: '/Users/tester', chatsRoot: '/srv/openchamber-chats' }));
    expect(await opencodeClient.getFilesystemHomeInfo()).toEqual({ home: '/Users/tester', chatsRoot: '/srv/openchamber-chats' });
  });

  test('returns the home for an older server that answers without chatsRoot', async () => {
    fsHomeResponses.push(fsHomeResponse({ home: '/Users/tester' }));
    expect(await opencodeClient.getFilesystemHomeInfo()).toEqual({ home: '/Users/tester' });
  });

  test('throws on a failed fetch', async () => {
    fsHomeResponses.push(new Error('transient network failure'));
    await expect(opencodeClient.getFilesystemHomeInfo()).rejects.toThrow('transient network failure');
  });

  test('throws on a non-ok response', async () => {
    fsHomeResponses.push(new Response('unavailable', { status: 503 }));
    await expect(opencodeClient.getFilesystemHomeInfo()).rejects.toThrow('503');
  });

  test('rejects missing home and relative roots rather than caching a fallback', async () => {
    fsHomeResponses.push(fsHomeResponse({}));
    await expect(opencodeClient.getFilesystemHomeInfo()).rejects.toThrow();
    fsHomeResponses.push(fsHomeResponse({ home: '/home/user', chatsRoot: 'relative' }));
    await expect(opencodeClient.getFilesystemHomeInfo()).rejects.toThrow();
  });

  test('throws on a malformed payload', async () => {
    fsHomeResponses.push(fsHomeResponse({ chatsRoot: 42 }));
    await expect(opencodeClient.getFilesystemHomeInfo()).rejects.toThrow();
  });
});

describe('opencodeClient getConfig cache', () => {
  test('cleared stale in-flight requests do not repopulate cache or delete newer in-flight requests', async () => {
    const first = opencodeClient.getConfig('/workspace/project');
    expect(configCalls).toBe(1);

    opencodeClient.clearConfigCache();

    const second = opencodeClient.getConfig('/workspace/project');
    expect(configCalls).toBe(2);

    configResolvers[0]?.({ data: { model: 'old/model' } });
    expect(await first).toEqual({ model: 'old/model' });

    const third = opencodeClient.getConfig('/workspace/project');
    expect(configCalls).toBe(2);

    configResolvers[1]?.({ data: { model: 'new/model' } });
    expect(await second).toEqual({ model: 'new/model' });
    expect(await third).toEqual({ model: 'new/model' });

    const cached = await opencodeClient.getConfig('/workspace/project');
    expect(cached).toEqual({ model: 'new/model' });
    expect(configCalls).toBe(2);
  });
});

describe('opencodeClient prompt retry behavior', () => {
  const sendPrompt = (providerID = 'anthropic') => opencodeClient.sendMessage({
    id: 'ses_1',
    providerID,
    modelID: 'claude-sonnet',
    text: 'hello',
  });

  test('does not retry 504 prompt responses because the POST may already be accepted', async () => {
    promptAsyncResults.push({ response: new Response('gateway timeout', { status: 504 }) });

    let error: unknown = null;
    try {
      await sendPrompt('anthropic-504');
    } catch (caught) {
      error = caught;
    }

    expect(promptAsyncCalls.length).toBe(1);
    expect(error instanceof Error ? error.message : String(error)).toContain('Failed to send message (504)');
  });

  test('does not retry transport failures because the tunnel may have lost only the response', async () => {
    promptAsyncResults.push(new TypeError('Failed to fetch'));

    let error: unknown = null;
    try {
      await sendPrompt('anthropic-network');
    } catch (caught) {
      error = caught;
    }

    expect(promptAsyncCalls.length).toBe(1);
    expect(error instanceof Error ? error.message : String(error)).toContain('Failed to fetch');
  });

  test('does not fabricate an HTTP 500 when the SDK swallows a transport failure into result.error', async () => {
    // The SDK catches thrown fetch errors and returns { error, response: undefined }.
    // That is a transport failure, not a server 500 — it must surface as a
    // descriptive transport error, never as "Failed to send message (500): {}".
    promptAsyncResults.push({ error: new TypeError('relay tunnel reset: plaintext frame on established channel'), response: undefined });

    let error: unknown = null;
    try {
      await sendPrompt('anthropic-transport');
    } catch (caught) {
      error = caught;
    }

    expect(promptAsyncCalls.length).toBe(1);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).not.toContain('Failed to send message (500)');
    expect(message).toContain('transport failure');
    expect(message).toContain('relay tunnel reset');
    expect((error as Error & { status?: number }).status).toBe(undefined);
  });

  test('does not retry 503 prompt responses because proxy errors can be ambiguous too', async () => {
    promptAsyncResults.push({ response: new Response('starting', { status: 503 }) });

    let error: unknown = null;
    try {
      await sendPrompt('anthropic-503');
    } catch (caught) {
      error = caught;
    }

    expect(promptAsyncCalls.length).toBe(1);
    expect(error instanceof Error ? error.message : String(error)).toContain('Failed to send message (503)');
  });

  test('does not dispatch after the runtime changes while preparing attachments', async () => {
    runtimeKey = 'runtime-a';
    const pending = opencodeClient.sendMessage({
      id: 'ses_runtime_race',
      providerID: 'runtime-race-provider',
      modelID: 'model-a',
      text: 'hello',
      runtimeKey: 'runtime-a',
      files: [{
        type: 'file',
        mime: 'text/markdown',
        filename: 'notes.md',
        url: 'data:text/markdown,hello',
      }],
    });

    runtimeKey = 'runtime-b';

    let error: unknown = null;
    try {
      await pending;
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : String(error)).toContain('runtime changed');
    expect(promptAsyncCalls).toHaveLength(0);
  });
});
