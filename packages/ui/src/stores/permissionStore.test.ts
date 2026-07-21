import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

let fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
let runtimeKey = 'runtime-a';
let apiBaseUrl = 'https://runtime-a.example';
const globalRuntime = globalThis as Record<string, unknown>;
const originalWindow = globalRuntime.window;
const runtimeChangedListeners = new Set<(detail: { runtimeKey: string; previousRuntimeKey: string; apiBaseUrl: string; previousApiBaseUrl: string }) => void>();
mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: (input: string, init?: RequestInit) => fetchImpl(`${apiBaseUrl}${input}`, init),
}));
mock.module('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => runtimeKey,
  getRuntimeApiBaseUrl: () => apiBaseUrl,
  initializeRuntimeEndpoint: () => undefined,
  subscribeRuntimeEndpointChanged: (callback: (detail: { runtimeKey: string; previousRuntimeKey: string; apiBaseUrl: string; previousApiBaseUrl: string }) => void) => {
    runtimeChangedListeners.add(callback);
    return () => runtimeChangedListeners.delete(callback);
  },
  subscribeRuntimeEndpointWillChange: () => () => undefined,
  switchRuntimeEndpoint: () => undefined,
}));
mock.module('@/sync/sync-refs', () => ({
  emitSyncConfigChanged: () => undefined,
  getAllSyncSessionMap: () => new Map(),
  getAllSyncSessions: () => [],
  getDirectoryState: () => undefined,
  getSyncChildStores: () => ({ children: new Map() }),
  getSyncConfig: () => undefined,
  getSyncMessages: () => [],
  getSyncParts: () => [],
  getSyncSessionMaterializationStatus: () => ({ hasMessages: false, renderable: false, missingPartMessageIDs: [] }),
  getSyncSessionStatus: () => undefined,
  getSyncSessions: () => [],
  registerSessionDirectory: () => undefined,
  setSyncRefs: () => undefined,
  subscribeToSyncConfigChanges: () => () => undefined,
}));
mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: { getState: () => ({ getDirectoryForSession: () => '/project' }) },
}));
mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getDirectory: () => '/fallback',
    getScopedSdkClient: () => ({}),
    listPendingPermissions: async () => [],
    listPendingQuestions: async () => [],
    setDirectory: () => undefined,
  },
}));

const { usePermissionStore } = await import('./permissionStore');
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const emitRuntimeChanged = (next: { runtimeKey?: string; apiBaseUrl?: string }) => {
  const previousRuntimeKey = runtimeKey;
  const previousApiBaseUrl = apiBaseUrl;
  runtimeKey = next.runtimeKey ?? runtimeKey;
  apiBaseUrl = next.apiBaseUrl ?? apiBaseUrl;
  for (const listener of runtimeChangedListeners) {
    listener({
      runtimeKey,
      previousRuntimeKey,
      apiBaseUrl,
      previousApiBaseUrl,
    });
  }
};
const flushMicrotasks = async (count = 6) => {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
};

describe('permission store server policy', () => {
  beforeEach(() => {
    runtimeKey = 'runtime-a';
    apiBaseUrl = 'https://runtime-a.example';
    globalRuntime.window = {};
    usePermissionStore.getState().reset();
    fetchImpl = async () => json({ default: false, sessions: {} });
  });

  afterEach(() => {
    globalRuntime.window = originalWindow;
  });

  test('hydrates the authoritative server snapshot', async () => {
    fetchImpl = async () => json({ default: true, sessions: { root: true } });
    await usePermissionStore.getState().hydrate();
    expect(usePermissionStore.getState().autoAccept).toEqual({ root: true });
    expect(usePermissionStore.getState().defaultEnabled).toBe(true);
  });

  test('hydrates the authoritative server snapshot through runtimeFetch when api base is same-origin', async () => {
    apiBaseUrl = '';
    const requests: string[] = [];
    fetchImpl = async (input) => {
      requests.push(input);
      return json({ default: true, sessions: { root: true } });
    };

    await usePermissionStore.getState().hydrate();

    expect(requests).toEqual(['/api/permission-auto-accept']);
    expect(usePermissionStore.getState().autoAccept).toEqual({ root: true });
    expect(usePermissionStore.getState().defaultEnabled).toBe(true);
  });

  test('fails closed to a false default when the server response omits or malforms it', async () => {
    fetchImpl = async () => json({ sessions: { root: true } });
    await usePermissionStore.getState().hydrate();
    expect(usePermissionStore.getState().defaultEnabled).toBe(false);

    usePermissionStore.getState().reset();
    fetchImpl = async () => json({ default: 'yes', sessions: {} });
    await usePermissionStore.getState().hydrate();
    expect(usePermissionStore.getState().defaultEnabled).toBe(false);
  });

  test('preserves previous state when hydration fails', async () => {
    usePermissionStore.setState({ autoAccept: { root: true }, defaultEnabled: true, loaded: true });
    fetchImpl = async () => json({}, 503);
    await expect(usePermissionStore.getState().hydrate()).rejects.toThrow();
    expect(usePermissionStore.getState().autoAccept).toEqual({ root: true });
    expect(usePermissionStore.getState().defaultEnabled).toBe(true);
  });

  test('updates local state only after server persistence succeeds', async () => {
    fetchImpl = async () => json({}, 500);
    await expect(usePermissionStore.getState().setSessionAutoAccept('root', true)).rejects.toThrow();
    expect(usePermissionStore.getState().autoAccept).toEqual({});
  });

  test('sends the session directory for immediate pending reconciliation', async () => {
    let body: unknown;
    fetchImpl = async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return json({ sessions: { root: true } });
    };
    await usePermissionStore.getState().setSessionAutoAccept('root', true);
    expect(body).toEqual({ enabled: true, directory: '/project' });
  });

  test('persists the authoritative global default through the dedicated runtime route', async () => {
    const requests: Array<{ input: string; body?: unknown }> = [];
    fetchImpl = async (input, init) => {
      requests.push({ input, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return json({ default: true, sessions: { root: false } });
    };

    await usePermissionStore.getState().setDefaultAutoAccept(true);

    expect(requests).toEqual([{ input: 'https://runtime-a.example/api/permission-auto-accept/default', body: { enabled: true } }]);
    expect(usePermissionStore.getState().defaultEnabled).toBe(true);
    expect(usePermissionStore.getState().autoAccept).toEqual({ root: false });
  });

  test('migrates a legacy local policy when the server has no policy yet', async () => {
    usePermissionStore.setState({ autoAccept: { root: true } });
    const requests: string[] = [];
    fetchImpl = async (input) => {
      requests.push(input);
      return input.includes('/sessions/')
        ? json({ default: false, sessions: { root: true } })
        : json({ default: false, sessions: {} });
    };
    await usePermissionStore.getState().hydrate();
    expect(requests).toEqual([
      'https://runtime-a.example/api/permission-auto-accept',
      'https://runtime-a.example/api/permission-auto-accept/sessions/root',
    ]);
    expect(usePermissionStore.getState().autoAccept).toEqual({ root: true });
    expect(usePermissionStore.getState().defaultEnabled).toBe(false);
  });

  test('stops legacy migration after a runtime switch before later PUTs can target the new runtime', async () => {
    usePermissionStore.setState({ autoAccept: { root: true, child: false } });
    const requests: string[] = [];
    let resolveFirstPut!: (response: Response) => void;
    fetchImpl = (input) => {
      requests.push(input);
      if (input === 'https://runtime-a.example/api/permission-auto-accept') {
        return Promise.resolve(json({ default: false, sessions: {} }));
      }
      if (input === 'https://runtime-a.example/api/permission-auto-accept/sessions/root') {
        return new Promise((resolve) => {
          resolveFirstPut = resolve;
        });
      }
      return Promise.resolve(json({ default: false, sessions: {} }));
    };

    const hydratePromise = usePermissionStore.getState().hydrate();
    await flushMicrotasks();
    emitRuntimeChanged({ runtimeKey: 'runtime-a', apiBaseUrl: 'https://relay-a.example' });
    resolveFirstPut(json({ default: false, sessions: { root: true } }));
    await hydratePromise;

    expect(requests).toEqual([
      'https://runtime-a.example/api/permission-auto-accept',
      'https://runtime-a.example/api/permission-auto-accept/sessions/root',
    ]);
    expect(requests.some((request) => request.includes('relay-a'))).toBe(false);
  });

  test('reset clears the authoritative global default so runtime switches cannot keep a stale true value', () => {
    usePermissionStore.setState({ autoAccept: { root: true }, defaultEnabled: true, loaded: true, saving: false });

    usePermissionStore.getState().reset();

    expect(usePermissionStore.getState().defaultEnabled).toBe(false);
    expect(usePermissionStore.getState().autoAccept).toEqual({});
    expect(usePermissionStore.getState().loaded).toBe(false);
  });

  test('fails closed until the authoritative runtime snapshot has loaded', () => {
    usePermissionStore.setState({ autoAccept: { root: true }, defaultEnabled: true, loaded: false, saving: false });

    expect(usePermissionStore.getState().isSessionAutoAccepting('root')).toBe(false);
  });

  test('ignores a stale hydration result that resolves after a runtime switch reset', async () => {
    let resolveFetch!: (response: Response) => void;
    fetchImpl = () => new Promise((resolve) => {
      resolveFetch = resolve;
    });

    const hydratePromise = usePermissionStore.getState().hydrate();
    await flushMicrotasks();
    emitRuntimeChanged({ runtimeKey: 'runtime-b', apiBaseUrl: 'https://runtime-b.example' });
    usePermissionStore.getState().reset();
    resolveFetch(json({ default: true, sessions: { root: true } }));

    await hydratePromise;

    expect(usePermissionStore.getState().defaultEnabled).toBe(false);
    expect(usePermissionStore.getState().autoAccept).toEqual({});
    expect(usePermissionStore.getState().loaded).toBe(false);
  });

  test('ignores a stale hydration result even if the runtime key switches away and back', async () => {
    let resolveFetch!: (response: Response) => void;
    fetchImpl = () => new Promise((resolve) => {
      resolveFetch = resolve;
    });

    const hydratePromise = usePermissionStore.getState().hydrate();
    await flushMicrotasks();
    emitRuntimeChanged({ runtimeKey: 'runtime-b', apiBaseUrl: 'https://runtime-b.example' });
    emitRuntimeChanged({ runtimeKey: 'runtime-a', apiBaseUrl: 'https://runtime-a.example' });
    resolveFetch(json({ default: true, sessions: { root: true } }));
    await hydratePromise;

    expect(usePermissionStore.getState().defaultEnabled).toBe(false);
    expect(usePermissionStore.getState().autoAccept).toEqual({});
    expect(usePermissionStore.getState().loaded).toBe(false);
  });

  test('ignores a stale hydration result when only the transport endpoint changes under the same runtime key', async () => {
    let resolveFetch!: (response: Response) => void;
    fetchImpl = () => new Promise((resolve) => {
      resolveFetch = resolve;
    });

    const hydratePromise = usePermissionStore.getState().hydrate();
    await flushMicrotasks();
    emitRuntimeChanged({ runtimeKey: 'runtime-a', apiBaseUrl: 'https://relay-a.example' });
    resolveFetch(json({ default: true, sessions: { root: true } }));
    await hydratePromise;

    expect(usePermissionStore.getState().defaultEnabled).toBe(false);
    expect(usePermissionStore.getState().autoAccept).toEqual({});
    expect(usePermissionStore.getState().loaded).toBe(false);
  });
});
