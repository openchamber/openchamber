import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { PersistStorage, StorageValue } from 'zustand/middleware';

const DIRECTORY = '/workspace/project';
const OTHER_DIRECTORY = '/workspace/other';

let storage = new Map<string, string>();
let providerRequests: Array<string | null> = [];
let agentRequests: Array<string | null> = [];

const makeStorage = (): Storage => ({
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
});

const makeJSONStorage = <S,>(): PersistStorage<S> => {
  const testStorage = makeStorage();
  return {
    getItem: (name: string) => {
      const raw = testStorage.getItem(name);
      return raw === null ? null : JSON.parse(raw);
    },
    setItem: (name: string, value: StorageValue<S>) => {
      testStorage.setItem(name, JSON.stringify(value));
    },
    removeItem: (name: string) => {
      testStorage.removeItem(name);
    },
  };
};

const providerResponse = (id: string) => ({
  id,
  name: id,
  source: 'config' as const,
  env: [],
  options: {},
  models: {
    [`${id}-model`]: {
      id: `${id}-model`,
      name: `${id}-model`,
      providerID: id,
      api: { id: 'chat', url: '', npm: '' },
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 0, output: 0 },
      options: {},
      release_date: '',
      status: 'active' as const,
      headers: {},
      attachment: false,
      reasoning: false,
      temperature: true,
      tool_call: true,
    },
  },
});

const providerIdForDirectory = (directory: string | null | undefined): string =>
  directory === OTHER_DIRECTORY ? 'other-live' : 'active-live';

const agentNameForDirectory = (directory: string | null | undefined): string =>
  directory === OTHER_DIRECTORY ? 'other-agent' : 'active-agent';

mock.module('@/stores/utils/safeStorage', () => ({
  getDeferredSafeStorage: () => makeStorage(),
  getSafeStorage: () => makeStorage(),
  createDeferredSafeJSONStorage: () => makeJSONStorage(),
}));

mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: {
    getState: () => ({
      activeProjectId: 'project',
      projects: [
        { id: 'project', path: DIRECTORY, label: 'Project' },
        { id: 'other', path: OTHER_DIRECTORY, label: 'Other' },
      ],
    }),
  },
}));

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    setDirectory: mock(() => undefined),
    getDirectory: mock(() => DIRECTORY),
    checkHealth: mock(async () => true),
    getProvidersForConfig: mock(async (directory?: string | null) => {
      providerRequests.push(directory ?? null);
      const id = providerIdForDirectory(directory);
      return { providers: [providerResponse(id)], default: { default: id } };
    }),
    listAgents: mock(async (directory?: string | null) => {
      agentRequests.push(directory ?? null);
      return [{ name: agentNameForDirectory(directory), mode: 'primary' }];
    }),
    getConfig: mock(async () => ({})),
    clearConfigCache: mock(() => undefined),
  },
}));

mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: mock(() => null),
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async () => new Response(JSON.stringify({}), {
    headers: { 'Content-Type': 'application/json' },
  })),
}));

mock.module('@/lib/persistence', () => ({
  updateDesktopSettings: mock(async () => undefined),
}));

mock.module('@/lib/startupTrace', () => ({
  markStartupTrace: mock(() => undefined),
  measureStartupTrace: async <T,>(_name: string, callback: () => Promise<T>) => callback(),
}));

mock.module('@/lib/configSync', () => ({
  emitConfigChange: mock(() => undefined),
  scopeMatches: mock((event: { scopes: string[] }, scope: string) => event.scopes.includes('all') || event.scopes.includes(scope)),
  subscribeToConfigChanges: mock(() => () => undefined),
}));

const { useConfigStore } = await import('./useConfigStore');
const { useSessionUIStore } = await import('@/sync/session-ui-store');

type RuntimeWindow = { __OPENCHAMBER_ELECTRON__?: { runtime: string } } | undefined;

const setRuntimeWindow = (value: RuntimeWindow): void => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value });
};

const desktopWindow: RuntimeWindow = { __OPENCHAMBER_ELECTRON__: { runtime: 'electron' } };

describe('useConfigStore project config prewarm', () => {
  beforeEach(() => {
    storage = new Map<string, string>();
    providerRequests = [];
    agentRequests = [];
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: makeStorage(),
    });
    useSessionUIStore.setState({ availableWorktreesByProject: new Map(), currentSessionId: null });
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      directoryScoped: {},
      providers: [],
      defaultProviders: {},
      currentProviderId: '',
      currentModelId: '',
      selectedProviderId: '',
      currentAgentName: undefined,
      agents: [],
      agentModelSelections: {},
      isConnected: true,
      isInitialized: false,
    });
  });

  afterEach(() => {
    setRuntimeWindow(undefined);
  });

  test('desktop startup loads the active project config and never reaches inactive projects', async () => {
    setRuntimeWindow(desktopWindow);

    await useConfigStore.getState().initializeApp();
    // initializeApp fires the prewarm without awaiting it, so drive it directly:
    // the assertion has to observe a settled prewarm, not a race with one.
    await useConfigStore.getState().prewarmProjectConfigs(DIRECTORY);

    expect(providerRequests).toEqual([DIRECTORY]);
    expect(agentRequests).toEqual([DIRECTORY]);

    const state = useConfigStore.getState();
    expect(state.isInitialized).toBe(true);
    expect(state.providers.map((entry) => entry.id)).toEqual(['active-live']);
    expect(state.agents.map((entry) => entry.name)).toEqual(['active-agent']);
    expect(Object.keys(state.directoryScoped)).toEqual([DIRECTORY]);
  });

  test('desktop still serves an explicit load for another project directory', async () => {
    setRuntimeWindow(desktopWindow);

    await useConfigStore.getState().initializeApp();
    await useConfigStore.getState().prewarmProjectConfigs(DIRECTORY);
    providerRequests = [];
    agentRequests = [];

    await Promise.all([
      useConfigStore.getState().loadProviders({ directory: OTHER_DIRECTORY, source: 'test:settingsDirectory' }),
      useConfigStore.getState().loadAgents({ directory: OTHER_DIRECTORY, source: 'test:settingsDirectory' }),
    ]);

    expect(providerRequests).toEqual([OTHER_DIRECTORY]);
    expect(agentRequests).toEqual([OTHER_DIRECTORY]);

    const state = useConfigStore.getState();
    expect(state.directoryScoped[OTHER_DIRECTORY]?.providers.map((entry) => entry.id)).toEqual(['other-live']);
    expect(state.directoryScoped[OTHER_DIRECTORY]?.agents.map((entry) => entry.name)).toEqual(['other-agent']);
    // The flat mirror tracks the active project only: browsing another project
    // in Settings must not relocate what chat sees.
    expect(state.providers.map((entry) => entry.id)).toEqual(['active-live']);
    expect(state.agents.map((entry) => entry.name)).toEqual(['active-agent']);
  });

  test('a runtime that does not own the opencode server keeps prewarming inactive projects', async () => {
    setRuntimeWindow({});

    await useConfigStore.getState().initializeApp();
    await useConfigStore.getState().prewarmProjectConfigs(DIRECTORY);

    expect(providerRequests).toEqual([DIRECTORY, OTHER_DIRECTORY]);
    expect(agentRequests).toEqual([DIRECTORY, OTHER_DIRECTORY]);
    expect(useConfigStore.getState().directoryScoped[OTHER_DIRECTORY]?.providers.map((entry) => entry.id))
      .toEqual(['other-live']);
  });
});
