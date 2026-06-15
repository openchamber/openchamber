import { beforeEach, describe, expect, mock, test } from 'bun:test';

const DIRECTORY = '/workspace/project';
const OTHER_DIRECTORY = '/workspace/other';
const STORAGE_KEY = 'config-store';

let storage = new Map<string, string>();
let liveProviderId = 'live';
let liveProviderIdsByDirectory = new Map<string, string>();
let liveProviderVariants: Record<string, Record<string, unknown>> | undefined;
let getProvidersCalls = 0;
let withDirectoryCalls: Array<string | null> = [];
let currentFetchDirectory: string | null = DIRECTORY;
let configListener: ((event: { scopes: string[]; source?: string; timestamp: number }) => void | Promise<void>) | null = null;

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
}) as Storage;

const provider = (id: string, modelId = `${id}-model`, variants?: Record<string, Record<string, unknown>>) => ({
  id,
  name: id,
  source: 'config' as const,
  env: [],
  options: {},
  models: [
    {
      id: modelId,
      name: modelId,
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
      ...(variants ? { variants } : {}),
    },
  ],
});

const providerResponse = (id: string, modelId = `${id}-model`, variants?: Record<string, Record<string, unknown>>) => ({
  id,
  name: id,
  source: 'config' as const,
  env: [],
  options: {},
  models: {
    [modelId]: {
      id: modelId,
      name: modelId,
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
      ...(variants ? { variants } : {}),
    },
  },
});

mock.module('@/stores/utils/safeStorage', () => ({
  getSafeStorage: () => makeStorage(),
}));

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    setDirectory: mock(() => undefined),
    getDirectory: mock(() => DIRECTORY),
    checkHealth: mock(async () => true),
    withDirectory: mock(async (directory: string | null, callback: () => Promise<unknown>) => {
      withDirectoryCalls.push(directory);
      const previous = currentFetchDirectory;
      currentFetchDirectory = directory;
      try {
        return await callback();
      } finally {
        currentFetchDirectory = previous;
      }
    }),
    getProviders: mock(async () => {
      getProvidersCalls += 1;
      const id = liveProviderIdsByDirectory.get(currentFetchDirectory ?? '') ?? liveProviderId;
      return { providers: [providerResponse(id, `${id}-model`, liveProviderVariants)], default: { default: id } };
    }),
    listAgents: mock(async () => []),
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
  measureStartupTrace: mock(async (_name: string, callback: () => Promise<unknown>) => callback()),
}));

mock.module('@/lib/configSync', () => ({
  emitConfigChange: mock(() => undefined),
  scopeMatches: mock((event: { scopes: string[] }, scope: string) => event.scopes.includes('all') || event.scopes.includes(scope)),
  subscribeToConfigChanges: mock((listener: typeof configListener) => {
    configListener = listener;
    return () => {
      if (configListener === listener) {
        configListener = null;
      }
    };
  }),
}));

const { useConfigStore } = await import('./useConfigStore');

describe('useConfigStore provider persistence', () => {
  beforeEach(() => {
    storage = new Map<string, string>();
    liveProviderId = 'live';
    liveProviderIdsByDirectory = new Map<string, string>();
    liveProviderVariants = undefined;
    getProvidersCalls = 0;
    withDirectoryCalls = [];
    currentFetchDirectory = DIRECTORY;
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      directoryScoped: {},
      providers: [],
      defaultProviders: {},
      currentProviderId: '',
      currentModelId: '',
      currentVariant: undefined,
      selectedProviderId: '',
      isConnected: true,
      isInitialized: false,
    });
  });

  test('hydrates persisted provider snapshots for instant paint, then refreshes to live data', async () => {
    storage.set(STORAGE_KEY, JSON.stringify({
      state: {
        activeDirectoryKey: DIRECTORY,
        directoryScoped: {
          [DIRECTORY]: {
            providers: [provider('stale')],
            agents: [{ name: 'build', mode: 'primary' }],
            currentProviderId: 'stale',
            currentModelId: 'stale-model',
            currentAgentName: 'build',
            selectedProviderId: 'stale',
            agentModelSelections: { build: { providerId: 'stale', modelId: 'stale-model' } },
            defaultProviders: { default: 'stale' },
          },
          [OTHER_DIRECTORY]: {
            providers: [provider('other-stale')],
            agents: [{ name: 'review', mode: 'primary' }],
            currentProviderId: 'other-stale',
            currentModelId: 'other-stale-model',
            currentAgentName: 'review',
            selectedProviderId: 'other-stale',
            agentModelSelections: {},
            defaultProviders: { default: 'other-stale' },
          },
        },
        currentProviderId: 'stale',
        currentModelId: 'stale-model',
        selectedProviderId: 'stale',
        defaultProviders: { default: 'stale' },
      },
      version: 0,
    }));

    await useConfigStore.persist.rehydrate();

    // Stale-while-revalidate: the persisted snapshot is hydrated as-is so the
    // pickers can paint instantly on cold start, instead of being stripped to empty.
    const hydrated = useConfigStore.getState();
    expect(hydrated.providers.map((entry) => entry.id)).toEqual(['stale']);
    expect(hydrated.defaultProviders).toEqual({ default: 'stale' });
    expect(hydrated.directoryScoped[DIRECTORY]?.providers.map((entry) => entry.id)).toEqual(['stale']);
    expect(hydrated.directoryScoped[DIRECTORY]?.defaultProviders).toEqual({ default: 'stale' });
    expect(hydrated.directoryScoped[DIRECTORY]?.agents).toEqual([{ name: 'build', mode: 'primary' }]);
    expect(hydrated.directoryScoped[DIRECTORY]?.currentAgentName).toBe('build');
    expect(hydrated.directoryScoped[OTHER_DIRECTORY]?.providers.map((entry) => entry.id)).toEqual(['other-stale']);

    liveProviderId = 'fresh';
    await hydrated.initializeApp();

    const reloaded = useConfigStore.getState();
    expect(getProvidersCalls).toBe(1);
    expect(reloaded.providers.map((entry) => entry.id)).toEqual(['fresh']);
    expect(reloaded.directoryScoped[DIRECTORY]?.providers.map((entry) => entry.id)).toEqual(['fresh']);
    expect(reloaded.currentProviderId).toBe('fresh');
    expect(reloaded.currentModelId).toBe('fresh-model');
  });

  test('provider config events refresh all known directory provider caches immediately', async () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('active-stale')],
      defaultProviders: { default: 'active-stale' },
      currentProviderId: 'active-stale',
      currentModelId: 'active-stale-model',
      selectedProviderId: 'active-stale',
      directoryScoped: {
        [DIRECTORY]: {
          providers: [provider('active-stale')],
          agents: [],
          currentProviderId: 'active-stale',
          currentModelId: 'active-stale-model',
          currentAgentName: undefined,
          selectedProviderId: 'active-stale',
          agentModelSelections: {},
          defaultProviders: { default: 'active-stale' },
        },
        [OTHER_DIRECTORY]: {
          providers: [provider('inactive-cached')],
          agents: [],
          currentProviderId: 'inactive-cached',
          currentModelId: 'inactive-cached-model',
          currentAgentName: undefined,
          selectedProviderId: 'inactive-cached',
          agentModelSelections: {},
          defaultProviders: { default: 'inactive-cached' },
        },
      },
    });

    liveProviderIdsByDirectory = new Map([
      [DIRECTORY, 'active-live'],
      [OTHER_DIRECTORY, 'inactive-live'],
    ]);
    expect(configListener).not.toBeNull();
    await configListener?.({ scopes: ['providers'], timestamp: Date.now() });

    const state = useConfigStore.getState();
    expect(getProvidersCalls).toBe(2);
    expect(new Set(withDirectoryCalls)).toEqual(new Set([DIRECTORY, OTHER_DIRECTORY]));
    expect(state.directoryScoped[DIRECTORY]?.providers.map((entry) => entry.id)).toEqual(['active-live']);
    expect(state.directoryScoped[OTHER_DIRECTORY]?.providers.map((entry) => entry.id)).toEqual(['inactive-live']);
    expect(state.directoryScoped[OTHER_DIRECTORY]?.defaultProviders).toEqual({ default: 'inactive-live' });
  });

  test('provider reload preserves a valid current variant', async () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      currentProviderId: 'live',
      currentModelId: 'live-model',
      currentVariant: 'fast',
      selectedProviderId: 'live',
      settingsDefaultVariant: 'slow',
      directoryScoped: {},
    });

    liveProviderId = 'live';
    liveProviderVariants = { fast: {}, slow: {} };
    await useConfigStore.getState().loadProviders({ source: 'test:variant' });

    const state = useConfigStore.getState();
    expect(state.currentProviderId).toBe('live');
    expect(state.currentModelId).toBe('live-model');
    expect(state.currentVariant).toBe('fast');
  });
});
