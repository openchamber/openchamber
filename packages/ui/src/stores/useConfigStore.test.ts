import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Agent } from '@opencode-ai/sdk/v2';

const DIRECTORY = '/workspace/project';
const OTHER_DIRECTORY = '/workspace/other';
const STORAGE_KEY = 'config-store';
type TestAgent = { name: string; mode?: string; hidden?: boolean; model?: { providerID?: string; modelID?: string }; variant?: string };

let storage = new Map<string, string>();
let liveProviderId = 'live';
let liveProviderIdsByDirectory = new Map<string, string>();
let liveProviderVariants: Record<string, Record<string, unknown>> | undefined;
let getProvidersCalls = 0;
let getConfigCalls = 0;
let listAgentsCalls = 0;
let liveAgents: TestAgent[] = [];
let listAgentsImpl: ((directory?: string | null) => Promise<TestAgent[]>) | null = null;
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

const testAgent = (name: string, options?: Partial<TestAgent>): Agent => ({
  name,
  mode: options?.mode ?? 'primary',
  hidden: options?.hidden,
  model: options?.model,
  variant: options?.variant,
  permission: {},
  options: {},
}) as Agent;

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

mock.module('@/stores/utils/safeStorage', () => ({
  getSafeStorage: () => makeStorage(),
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
    getProvidersForConfig: mock(async (directory?: string | null) => {
      getProvidersCalls += 1;
      const id = liveProviderIdsByDirectory.get(directory ?? '') ?? liveProviderId;
      return { providers: [providerResponse(id, `${id}-model`, liveProviderVariants)], default: { default: id } };
    }),
    listAgents: mock(async (directory?: string | null) => {
      listAgentsCalls += 1;
      const impl = listAgentsImpl as ((directory?: string | null) => Promise<TestAgent[]>) | null;
      return impl ? impl(directory) : liveAgents;
    }),
    getConfig: mock(async () => {
      getConfigCalls += 1;
      return {};
    }),
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
const { emitSyncConfigChanged, setSyncRefs } = await import('@/sync/sync-refs');

describe('useConfigStore provider persistence', () => {
  beforeEach(() => {
    storage = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: makeStorage(),
    });
    liveProviderId = 'live';
    liveProviderIdsByDirectory = new Map<string, string>();
    liveProviderVariants = undefined;
    getProvidersCalls = 0;
    getConfigCalls = 0;
    listAgentsCalls = 0;
    liveAgents = [];
    listAgentsImpl = null;
    withDirectoryCalls = [];
    currentFetchDirectory = DIRECTORY;
    setSyncRefs({} as never, { children: new Map(), getState: () => undefined } as never, DIRECTORY);
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      directoryScoped: {},
      providers: [],
      defaultProviders: {},
      currentProviderId: '',
      currentModelId: '',
      currentVariant: undefined,
      selectedProviderId: '',
      currentAgentName: undefined,
      agents: [],
      agentModelSelections: {},
      opencodeDefaultAgent: undefined,
      opencodeDefaultModel: undefined,
      selectionSource: 'auto',
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

  test('loadAgents does not fetch OpenCode config directly', async () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5')],
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.5',
      directoryScoped: {
        [DIRECTORY]: {
          providers: [provider('openai', 'gpt-5.5')],
          agents: [],
          currentProviderId: 'openai',
          currentModelId: 'gpt-5.5',
          currentAgentName: undefined,
          selectedProviderId: 'openai',
          agentModelSelections: {},
          defaultProviders: {},
          selectionSource: 'auto',
        },
      },
    });
    liveAgents = [testAgent('build')];

    await useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:noConfigFetch' });

    expect(listAgentsCalls).toBe(1);
    expect(getConfigCalls).toBe(0);
  });

  test('manual selection survives an in-flight loadAgents refresh', async () => {
    const pendingAgents = deferred<TestAgent[]>();
    listAgentsImpl = async () => pendingAgents.promise;
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('manual'), provider('default')],
      agents: [testAgent('build')],
      currentProviderId: 'default',
      currentModelId: 'default-model',
      currentAgentName: 'build',
      selectedProviderId: 'default',
      selectionSource: 'auto',
      directoryScoped: {
        [DIRECTORY]: {
          providers: [provider('manual'), provider('default')],
          agents: [testAgent('build')],
          currentProviderId: 'default',
          currentModelId: 'default-model',
          currentAgentName: 'build',
          selectedProviderId: 'default',
          agentModelSelections: {},
          defaultProviders: {},
          selectionSource: 'auto',
        },
      },
    });

    const load = useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:manualRace' });
    useConfigStore.setState((state) => ({
      currentProviderId: 'manual',
      currentModelId: 'manual-model',
      currentAgentName: 'manual-agent',
      selectedProviderId: 'manual',
      selectionSource: 'manual',
      directoryScoped: {
        ...state.directoryScoped,
        [DIRECTORY]: {
          ...state.directoryScoped[DIRECTORY],
          currentProviderId: 'manual',
          currentModelId: 'manual-model',
          currentAgentName: 'manual-agent',
          selectedProviderId: 'manual',
          selectionSource: 'manual',
        },
      },
    }));
    pendingAgents.resolve([
      testAgent('build', { model: { providerID: 'default', modelID: 'default-model' } }),
      testAgent('manual-agent'),
    ]);
    await load;

    const state = useConfigStore.getState();
    expect(state.currentAgentName).toBe('manual-agent');
    expect(state.currentProviderId).toBe('manual');
    expect(state.currentModelId).toBe('manual-model');
    expect(state.selectionSource).toBe('manual');
  });

  test('worktree sync config applies to the project-scoped snapshot', () => {
    const worktree = '/workspace/project-worktree';
    storage.set('oc.worktreeProjectMap', JSON.stringify({ [worktree]: DIRECTORY }));
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5')],
      agents: [testAgent('build'), testAgent('review')],
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.5',
      currentAgentName: 'build',
      selectedProviderId: 'openai',
      selectionSource: 'auto',
      directoryScoped: {
        [DIRECTORY]: {
          providers: [provider('openai', 'gpt-5.5')],
          agents: [testAgent('build'), testAgent('review')],
          currentProviderId: 'openai',
          currentModelId: 'gpt-5.5',
          currentAgentName: 'build',
          selectedProviderId: 'openai',
          agentModelSelections: {},
          defaultProviders: {},
          selectionSource: 'auto',
        },
      },
    });

    emitSyncConfigChanged(worktree, { default_agent: 'review', model: 'openai/gpt-5.5' });

    const state = useConfigStore.getState();
    expect(state.directoryScoped[DIRECTORY]?.opencodeDefaultAgent).toBe('review');
    expect(state.directoryScoped[worktree]).toBe(undefined);
    expect(state.currentAgentName).toBe('review');
  });

  test('duplicate sync config event is a no-op when defaults and selection are unchanged', () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5')],
      agents: [testAgent('build'), testAgent('review')],
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.5',
      currentAgentName: 'review',
      selectedProviderId: 'openai',
      opencodeDefaultAgent: 'review',
      opencodeDefaultModel: 'openai/gpt-5.5',
      selectionSource: 'auto',
      directoryScoped: {
        [DIRECTORY]: {
          providers: [provider('openai', 'gpt-5.5')],
          agents: [testAgent('build'), testAgent('review')],
          currentProviderId: 'openai',
          currentModelId: 'gpt-5.5',
          currentAgentName: 'review',
          selectedProviderId: 'openai',
          agentModelSelections: {},
          defaultProviders: {},
          opencodeDefaultAgent: 'review',
          opencodeDefaultModel: 'openai/gpt-5.5',
          selectionSource: 'auto',
        },
      },
    });

    let updates = 0;
    const unsubscribe = useConfigStore.subscribe(() => {
      updates += 1;
    });
    emitSyncConfigChanged(DIRECTORY, { default_agent: 'review', model: 'openai/gpt-5.5' });
    unsubscribe();

    expect(updates).toBe(0);
  });

  test('project loadAgents preserves defaults previously applied from a worktree config event', async () => {
    const worktree = '/workspace/project-worktree';
    storage.set('oc.worktreeProjectMap', JSON.stringify({ [worktree]: DIRECTORY }));
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5')],
      agents: [testAgent('build'), testAgent('review')],
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.5',
      currentAgentName: 'build',
      selectedProviderId: 'openai',
      selectionSource: 'auto',
      directoryScoped: {
        [DIRECTORY]: {
          providers: [provider('openai', 'gpt-5.5')],
          agents: [testAgent('build'), testAgent('review')],
          currentProviderId: 'openai',
          currentModelId: 'gpt-5.5',
          currentAgentName: 'build',
          selectedProviderId: 'openai',
          agentModelSelections: {},
          defaultProviders: {},
          selectionSource: 'auto',
        },
      },
    });
    liveAgents = [testAgent('build'), testAgent('review')];

    emitSyncConfigChanged(worktree, { default_agent: 'review', model: 'openai/gpt-5.5' });
    await useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:preserveWorktreeDefaults' });

    const state = useConfigStore.getState();
    expect(state.directoryScoped[DIRECTORY]?.opencodeDefaultAgent).toBe('review');
    expect(state.directoryScoped[DIRECTORY]?.opencodeDefaultModel).toBe('openai/gpt-5.5');
    expect(state.opencodeDefaultAgent).toBe('review');
    expect(state.opencodeDefaultModel).toBe('openai/gpt-5.5');
  });

  test('in-flight loadAgents does not restore defaults cleared by a sync config event', async () => {
    const pendingAgents = deferred<TestAgent[]>();
    listAgentsImpl = async () => pendingAgents.promise;
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5')],
      agents: [testAgent('build'), testAgent('review')],
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.5',
      currentAgentName: 'review',
      selectedProviderId: 'openai',
      selectionSource: 'auto',
      opencodeDefaultAgent: 'review',
      opencodeDefaultModel: 'openai/gpt-5.5',
      directoryScoped: {
        [DIRECTORY]: {
          providers: [provider('openai', 'gpt-5.5')],
          agents: [testAgent('build'), testAgent('review')],
          currentProviderId: 'openai',
          currentModelId: 'gpt-5.5',
          currentAgentName: 'review',
          selectedProviderId: 'openai',
          agentModelSelections: {},
          defaultProviders: {},
          opencodeDefaultAgent: 'review',
          opencodeDefaultModel: 'openai/gpt-5.5',
          selectionSource: 'auto',
        },
      },
    });

    const load = useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:staleDefaultsRace' });
    emitSyncConfigChanged(DIRECTORY, {});
    pendingAgents.resolve([testAgent('build'), testAgent('review')]);
    await load;

    const state = useConfigStore.getState();
    expect(state.opencodeDefaultAgent).toBe(undefined);
    expect(state.opencodeDefaultModel).toBe(undefined);
    expect(state.directoryScoped[DIRECTORY]?.opencodeDefaultAgent).toBe(undefined);
    expect(state.directoryScoped[DIRECTORY]?.opencodeDefaultModel).toBe(undefined);
  });

  test('in-flight loadAgents does not restore pre-await sync config defaults after a clearing event', async () => {
    const pendingAgents = deferred<TestAgent[]>();
    const syncConfigs = new Map<string, Record<string, unknown>>([
      [DIRECTORY, { default_agent: 'review', model: 'openai/gpt-5.5' }],
    ]);
    setSyncRefs(
      {} as never,
      {
        children: new Map(),
        getState: (directory: string) => ({ config: syncConfigs.get(directory) ?? {} }),
      } as never,
      DIRECTORY,
    );
    listAgentsImpl = async () => pendingAgents.promise;
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5')],
      agents: [testAgent('build'), testAgent('review')],
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.5',
      currentAgentName: 'review',
      selectedProviderId: 'openai',
      selectionSource: 'auto',
      opencodeDefaultAgent: 'review',
      opencodeDefaultModel: 'openai/gpt-5.5',
      directoryScoped: {
        [DIRECTORY]: {
          providers: [provider('openai', 'gpt-5.5')],
          agents: [testAgent('build'), testAgent('review')],
          currentProviderId: 'openai',
          currentModelId: 'gpt-5.5',
          currentAgentName: 'review',
          selectedProviderId: 'openai',
          agentModelSelections: {},
          defaultProviders: {},
          opencodeDefaultAgent: 'review',
          opencodeDefaultModel: 'openai/gpt-5.5',
          selectionSource: 'auto',
        },
      },
    });

    const load = useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:preAwaitSyncConfigRace' });
    syncConfigs.set(DIRECTORY, {});
    emitSyncConfigChanged(DIRECTORY, {});
    pendingAgents.resolve([testAgent('build'), testAgent('review')]);
    await load;

    const state = useConfigStore.getState();
    expect(state.opencodeDefaultAgent).toBe(undefined);
    expect(state.opencodeDefaultModel).toBe(undefined);
    expect(state.directoryScoped[DIRECTORY]?.opencodeDefaultAgent).toBe(undefined);
    expect(state.directoryScoped[DIRECTORY]?.opencodeDefaultModel).toBe(undefined);
  });

  test('directory activation isolates selection source and OpenCode defaults', async () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      selectionSource: 'manual',
      opencodeDefaultAgent: 'active-default',
      opencodeDefaultModel: 'active/model',
      directoryScoped: {
        [DIRECTORY]: {
          providers: [provider('active')],
          agents: [testAgent('active-agent')],
          currentProviderId: 'active',
          currentModelId: 'active-model',
          currentAgentName: 'active-agent',
          selectedProviderId: 'active',
          agentModelSelections: {},
          defaultProviders: {},
          opencodeDefaultAgent: 'active-default',
          opencodeDefaultModel: 'active/model',
          selectionSource: 'manual',
        },
        [OTHER_DIRECTORY]: {
          providers: [provider('other')],
          agents: [testAgent('other-agent')],
          currentProviderId: 'other',
          currentModelId: 'other-model',
          currentAgentName: 'other-agent',
          selectedProviderId: 'other',
          agentModelSelections: {},
          defaultProviders: {},
          opencodeDefaultAgent: 'other-default',
          opencodeDefaultModel: 'other/model',
          selectionSource: 'auto',
        },
      },
      isConnected: false,
    });

    await useConfigStore.getState().activateDirectory(OTHER_DIRECTORY);

    const state = useConfigStore.getState();
    expect(state.activeDirectoryKey).toBe(OTHER_DIRECTORY);
    expect(state.selectionSource).toBe('auto');
    expect(state.opencodeDefaultAgent).toBe('other-default');
    expect(state.opencodeDefaultModel).toBe('other/model');
  });

  test('sync config without defaults clears stored OpenCode defaults without changing manual selection', () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('manual')],
      agents: [testAgent('manual-agent')],
      currentProviderId: 'manual',
      currentModelId: 'manual-model',
      currentAgentName: 'manual-agent',
      selectedProviderId: 'manual',
      selectionSource: 'manual',
      opencodeDefaultAgent: 'old-agent',
      opencodeDefaultModel: 'old/model',
      directoryScoped: {
        [DIRECTORY]: {
          providers: [provider('manual')],
          agents: [testAgent('manual-agent')],
          currentProviderId: 'manual',
          currentModelId: 'manual-model',
          currentAgentName: 'manual-agent',
          selectedProviderId: 'manual',
          agentModelSelections: {},
          defaultProviders: {},
          opencodeDefaultAgent: 'old-agent',
          opencodeDefaultModel: 'old/model',
          selectionSource: 'manual',
        },
      },
    });

    emitSyncConfigChanged(DIRECTORY, {});

    const state = useConfigStore.getState();
    expect(state.opencodeDefaultAgent).toBe(undefined);
    expect(state.opencodeDefaultModel).toBe(undefined);
    expect(state.directoryScoped[DIRECTORY]?.opencodeDefaultAgent).toBe(undefined);
    expect(state.directoryScoped[DIRECTORY]?.opencodeDefaultModel).toBe(undefined);
    expect(state.currentAgentName).toBe('manual-agent');
    expect(state.currentProviderId).toBe('manual');
    expect(state.selectionSource).toBe('manual');
  });
});
