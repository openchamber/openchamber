import { beforeEach, describe, expect, mock, test } from 'bun:test';

let runtimeFetchImpl: (_input?: unknown, _init?: { signal?: AbortSignal }) => Promise<Response> = async () =>
  new Response(JSON.stringify([]), {
    headers: { 'Content-Type': 'application/json' },
  });

const runtimeFetchMock = async (input: unknown, init?: { signal?: AbortSignal }) => runtimeFetchImpl(input, init);

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getDirectory: () => '/workspace/project',
  },
}));

mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: {
    getState: () => ({
      getActiveProject: () => ({ path: '/workspace/project' }),
    }),
  },
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: runtimeFetchMock,
}));

mock.module('@/lib/configUpdate', () => ({
  startConfigUpdate: mock(() => undefined),
  finishConfigUpdate: mock(() => undefined),
}));

mock.module('@/stores/useAgentsStore', () => ({
  refreshAfterOpenCodeRestart: mock(() => Promise.resolve()),
}));

let storage = new Map<string, string>();
const makeStorage = (): Storage =>
  ({
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => {
      storage.clear();
    },
    key: (index: number) => Array.from(storage.keys())[index] ?? null,
    get length() {
      return storage.size;
    },
  }) as Storage;

mock.module('@/stores/utils/safeStorage', () => ({
  getSafeStorage: () => makeStorage(),
}));

const { useMcpConfigStore } = await import('./useMcpConfigStore');

describe('useMcpConfigStore.loadMcpConfigs — timeout safety', () => {
  beforeEach(() => {
    storage = new Map<string, string>();
    runtimeFetchImpl = async () =>
      new Response(JSON.stringify([]), {
        headers: { 'Content-Type': 'application/json' },
      });

    useMcpConfigStore.setState({
      mcpServers: [],
      selectedMcpName: null,
      isLoading: false,
      mcpDraft: null,
    });
  });

  test('when fetch hangs and AbortSignal provided, loadMcpConfigs() settles within bounded time and returns false', async () => {
    // Simulate a hung server: runtimeFetch returns a promise that only settles
    // when the AbortSignal fires (our fix passes it via init.signal).
    runtimeFetchImpl = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal) {
          const onAbort = () => {
            init.signal!.removeEventListener('abort', onAbort);
            reject(new DOMException('Aborted', 'AbortError'));
          };
          if (init.signal.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
          } else {
            init.signal.addEventListener('abort', onAbort);
          }
        }
        // No signal: never settle (simulates unfixed code).
      });

    const raceTimeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('loadMcpConfigs() did not settle — no timeout in implementation')),
        300,
      ),
    );

    // Pass timeoutMs so the fix fires its AbortController at 100ms. Without
    // the fix, raceTimeout wins and the test fails.
    const result = await Promise.race([
      useMcpConfigStore.getState().loadMcpConfigs({ force: true, timeoutMs: 100 }),
      raceTimeout,
    ]);

    expect(result).toBe(false);
    expect(useMcpConfigStore.getState().isLoading).toBe(false);
    expect(useMcpConfigStore.getState().mcpServers).toEqual([]);
  });

  test('successful fetch populates mcpServers and returns true', async () => {
    runtimeFetchImpl = async () =>
      new Response(
        JSON.stringify([
          { name: 'server-a', type: 'local', command: ['echo'], enabled: true, scope: 'user' },
          { name: 'server-b', type: 'remote', url: 'https://example.com', enabled: true, scope: 'user' },
        ]),
        { headers: { 'Content-Type': 'application/json' } },
      );

    const result = await useMcpConfigStore.getState().loadMcpConfigs({ force: true });

    expect(result).toBe(true);
    const servers = useMcpConfigStore.getState().mcpServers;
    expect(servers).toHaveLength(2);
    expect(servers.map((s) => s.name)).toEqual(['server-a', 'server-b']);
  });
});