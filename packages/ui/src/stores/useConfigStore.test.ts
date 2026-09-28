import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Agent } from '@/lib/opencode/model';
import type { DesktopSettings } from '@/lib/desktop';
import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';

const DIRECTORY = '/workspace/project';
const OTHER_DIRECTORY = '/workspace/other';
const STORAGE_KEY = 'config-store';
type TestAgent = { name: string; mode?: string; hidden?: boolean; model?: { providerID?: string; modelID?: string }; variant?: string };

let storage = new Map<string, string>();
let liveProviderId = 'live';
let liveProviderIdsByDirectory = new Map<string, string>();
let liveProviderVariants: string[] | undefined;
let getProvidersCalls = 0;
let getConfigCalls = 0;
let listAgentsCalls = 0;
let liveAgents: TestAgent[] = [];
let listAgentsImpl: ((directory?: string | null) => Promise<TestAgent[]>) | null = null;
let getProvidersForConfigImpl: ((directory?: string | null) => Promise<TestProviderResponse>) | null = null;
let withDirectoryCalls: Array<string | null> = [];
let currentFetchDirectory: string | null = DIRECTORY;
let configListener: ((event: { scopes: string[]; source?: string; timestamp: number }) => void | Promise<void>) | null = null;
let persistedOpenChamberSettings: DesktopSettings | null = {};
let settingsLoadCalls = 0;
let checkHealthImpl = async () => true;
let probeHealthImpl: (() => Promise<'healthy' | 'unhealthy' | 'unreachable'>) | null = null;
let loadSettingsImpl: (() => Promise<DesktopSettings | null>) | null = null;
let projectsState: {
  activeProjectId: string | null;
  projects: Array<{ id: string; path: string; label: string; defaultAgent?: string }>;
} = {
  activeProjectId: 'project',
  projects: [
    { id: 'project', path: DIRECTORY, label: 'Project' },
    { id: 'other', path: OTHER_DIRECTORY, label: 'Other' },
  ],
};

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

const model = (providerId: string, modelId: string, variantIds?: string[]) => ({
  id: `${providerId}/${modelId}`,
  modelID: modelId,
  providerID: providerId,
  name: modelId,
  capabilities: { tools: true, input: ['text'], output: ['text'] },
  variants: (variantIds ?? []).map((id) => ({ id })),
  time: { released: 0 },
  cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
  status: 'active' as const,
  enabled: true,
  limit: { context: 0, output: 0 },
});

const providerInfo = (id: string) => ({
  id,
  name: id,
  activation: 'enabled' as const,
  package: id,
});

/** A provider as the store keeps it: catalog models regrouped under it. */
const provider = (id: string, modelId = `${id}-model`, variantIds?: string[]) => ({
  ...providerInfo(id),
  models: [model(id, modelId, variantIds)],
});

/** A whole `getProvidersForConfig` answer: two flat lists plus one default. */
const providerResponse = (id: string, modelId = `${id}-model`, variantIds?: string[]) => ({
  providers: [providerInfo(id)],
  models: [model(id, modelId, variantIds)],
  default: { providerID: id, id: modelId },
});

type TestProviderResponse = ReturnType<typeof providerResponse>;

const testAgent = (name: string, options?: Partial<TestAgent>): Agent => ({
  id: name,
  name,
  displayName: name,
  mode: (options?.mode ?? 'primary') as Agent['mode'],
  hidden: options?.hidden ?? false,
  model: options?.model
    ? { providerID: options.model.providerID ?? '', id: options.model.modelID ?? '', variant: options?.variant }
    : undefined,
  request: { settings: {}, headers: {}, body: {} },
  permissions: [],
});

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
  getDeferredSafeStorage: () => makeStorage(),
  getSafeStorage: () => makeStorage(),
  getSafeSessionStorage: () => makeStorage(),
  createDeferredSafeJSONStorage: () => {
    const testStorage = makeStorage();
    return {
      getItem: (name: string) => {
        const value = testStorage.getItem(name);
        return value === null ? null : JSON.parse(value);
      },
      setItem: (name: string, value: unknown) => {
        testStorage.setItem(name, JSON.stringify(value));
      },
      removeItem: (name: string) => {
        testStorage.removeItem(name);
      },
    };
  },
}));

mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: {
    getState: () => projectsState,
  },
}));

let directoryAvailability: 'available' | 'missing' | 'unknown' = 'available';

mock.module('@/lib/opencode/client', () => ({
  OpencodeApiError: Error,
  normalizeOpencodeError: (operation: string, error: unknown) => new Error(`${operation}: ${String(error)}`),
  opencodeClient: {
    setDirectory: mock(() => undefined),
    getDirectory: mock(() => DIRECTORY),
    getFilesystemHome: async () => '/workspace',
    getSystemInfo: async () => ({ homeDirectory: '/workspace' }),
    checkHealth: () => checkHealthImpl(),
    probeHealth: () => (probeHealthImpl ? probeHealthImpl() : checkHealthImpl().then((healthy) => (healthy ? 'healthy' : 'unhealthy'))),
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
      return providerResponse(id, `${id}-model`, liveProviderVariants);
    }),
    getProvidersForConfig: mock(async (directory?: string | null) => {
      getProvidersCalls += 1;
      if (getProvidersForConfigImpl) {
        return getProvidersForConfigImpl(directory);
      }
      const id = liveProviderIdsByDirectory.get(directory ?? '') ?? liveProviderId;
      return providerResponse(id, `${id}-model`, liveProviderVariants);
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
    getDirectoryAvailability: mock(async () => directoryAvailability),
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
  updateDesktopSettings: mock(async () => ({ ok: true })),
  reportSettingsSaveState: () => undefined,
  // The store reads the shared document through this; an empty document
  // keeps every OpenChamber default unset, like the settings route used to.
  loadDesktopSettings: mock(async () => {
    settingsLoadCalls += 1;
    return loadSettingsImpl ? loadSettingsImpl() : persistedOpenChamberSettings;
  }),
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

// Runtime-generation guards subscribe at module load. Use real event delivery
// so A -> B -> A exercises the lifecycle, not just unequal runtime strings.
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: Object.assign(new EventTarget(), { location: new URL('https://config-tests.example') }),
});
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: makeStorage() });

const { useConfigStore, selectConfigAgentsForDirectory, selectCatalogLoadedForDirectory } = await import('./useConfigStore');
const { emitSyncConfigChanged, setSyncRefs } = await import('@/sync/sync-refs');
const { useSelectionStore } = await import('@/sync/selection-store');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { useRoutingStore } = await import('@/stores/useRoutingStore');
const { useUIStore } = await import('@/stores/useUIStore');

describe('useConfigStore provider persistence', () => {
  beforeEach(() => {
    storage = new Map<string, string>();
    projectsState = {
      activeProjectId: 'project',
      projects: [
        { id: 'project', path: DIRECTORY, label: 'Project' },
        { id: 'other', path: OTHER_DIRECTORY, label: 'Other' },
      ],
    };
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
    getProvidersForConfigImpl = null;
    withDirectoryCalls = [];
    currentFetchDirectory = DIRECTORY;
    persistedOpenChamberSettings = {};
    settingsLoadCalls = 0;
    checkHealthImpl = async () => true;
    probeHealthImpl = null;
    loadSettingsImpl = null;
    setSyncRefs({} as never, { children: new Map(), getState: () => undefined } as never, DIRECTORY);
    useSelectionStore.setState({
      sessionModelSelections: new Map(),
      sessionAgentSelections: new Map(),
      sessionAgentModelSelections: new Map(),
      lastUsedProvider: null,
    });
    useSessionUIStore.setState({ currentSessionId: null, availableWorktreesByProject: new Map() });
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      directoryScoped: {},
      providers: [],
      providersLoaded: false,
      agentsLoaded: false,
      defaultProviders: {},
      currentProviderId: '',
      currentModelId: '',
      currentVariant: undefined,
      currentVariantSelection: { override: undefined, inherited: undefined },
      selectedProviderId: '',
      currentAgentName: undefined,
      settingsDefaultAgent: undefined,
      settingsDefaultModel: undefined,
      settingsDefaultVariant: undefined,
      agents: [],
      agentModelSelections: {},
      opencodeDefaultAgent: undefined,
      opencodeDefaultModel: undefined,
      settingsDefaultsLoaded: true,
      selectionSource: 'auto',
      isConnected: true,
      isInitialized: false,
      projectConfigErrors: {},
      lastInitFailure: null,
    });
    // The defaults loader has a short-lived module cache. Reset it between
    // tests through the same setter the settings page uses for a user edit.
    useConfigStore.getState().setSettingsDefaultModel(undefined);
  });

  test('provider and agent discovery gaps preserve a manual model and effort', async () => {
    useConfigStore.setState({
      currentProviderId: 'temporarily-missing',
      currentModelId: 'chosen-model',
      currentVariant: 'high',
      currentVariantSelection: { override: 'high', inherited: undefined },
      currentAgentName: 'build',
      selectionSource: 'manual',
    });
    liveAgents = [{ name: 'build', mode: 'primary' }];
    await useConfigStore.getState().loadProviders({ directory: DIRECTORY });
    expect(useConfigStore.getState().currentProviderId).toBe('temporarily-missing');
    await useConfigStore.getState().loadAgents({ directory: DIRECTORY });
    expect(useConfigStore.getState().currentModelId).toBe('chosen-model');
    expect(useConfigStore.getState().currentVariant).toBe('high');
    expect(useConfigStore.getState().currentVariantSelection.override).toBe('high');
  });

  test('worktree catalog uses its own directory and retains its manual model across switches', async () => {
    const worktree = '/workspace/project-catalog-worktree';
    useSessionUIStore.setState({
      availableWorktreesByProject: new Map([[DIRECTORY, [{
        path: worktree,
        projectDirectory: DIRECTORY,
        branch: 'catalog',
        label: 'catalog',
      }]]]),
    });
    liveProviderIdsByDirectory.set(DIRECTORY, 'root');
    liveProviderIdsByDirectory.set(worktree, 'worktree');
    const requested: Array<string | null | undefined> = [];
    const agentRequests: Array<string | null | undefined> = [];
    listAgentsImpl = async (directory) => {
      agentRequests.push(directory);
      return [testAgent(directory === worktree ? 'worktree-agent' : 'root-agent')];
    };
    getProvidersForConfigImpl = async (directory) => {
      requested.push(directory);
      const id = liveProviderIdsByDirectory.get(directory ?? '') ?? 'unexpected';
      return providerResponse(id, `${id}-model`);
    };

    await useConfigStore.getState().activateDirectory(worktree);
    let state = useConfigStore.getState();
    expect(requested).toEqual([worktree]);
    expect(agentRequests).toEqual([worktree]);
    expect(state.activeDirectoryKey).toBe(worktree);
    expect(state.providers[0]?.models[0]?.modelID).toBe('worktree-model');
    expect(state.agents[0]?.name).toBe('worktree-agent');
    expect(state.directoryScoped[DIRECTORY]?.providers).toEqual([]);

    useConfigStore.setState({
      currentProviderId: 'worktree',
      currentModelId: 'worktree-model',
      selectionSource: 'manual',
      directoryScoped: {
        ...state.directoryScoped,
        [worktree]: {
          ...state.directoryScoped[worktree],
          currentProviderId: 'worktree',
          currentModelId: 'worktree-model',
          selectionSource: 'manual',
        },
      },
    });
    await useConfigStore.getState().activateDirectory(DIRECTORY);
    state = useConfigStore.getState();
    expect(requested).toEqual([worktree, DIRECTORY]);
    expect(agentRequests).toEqual([worktree, DIRECTORY]);
    expect(state.providers[0]?.models[0]?.modelID).toBe('root-model');
    expect(state.directoryScoped[worktree]?.currentModelId).toBe('worktree-model');

    await useConfigStore.getState().activateDirectory(worktree);
    state = useConfigStore.getState();
    expect(state.providers[0]?.models[0]?.modelID).toBe('worktree-model');
    expect(state.currentModelId).toBe('worktree-model');
    expect(state.selectionSource).toBe('manual');
  });

  for (const cached of [false, true]) for (const override of ['high', null]) {
    test(`manual draft model and ${override ?? 'Default'} thinking survive switching to a ${cached ? 'cached' : 'new'} worktree`, async () => {
      const worktree = '/workspace/manual-model-worktree';
      useSessionUIStore.setState({
        availableWorktreesByProject: new Map([[DIRECTORY, [{
          path: worktree,
          projectDirectory: DIRECTORY,
          branch: 'manual',
          label: 'manual',
        }]]]),
      });
      getProvidersForConfigImpl = async () => ({
        providers: [providerInfo('shared')],
        models: [model('shared', 'A', ['low']), model('shared', 'B', ['low', 'high'])],
        default: { providerID: 'shared', id: 'A' },
      });

      if (cached) {
        await useConfigStore.getState().activateDirectory(worktree);
        expect(useConfigStore.getState().currentModelId).toBe('A');
        useConfigStore.getState().setCurrentVariantOverride('low', 'low');
      }
      await useConfigStore.getState().activateDirectory(DIRECTORY);
      useConfigStore.getState().setModel('B');
      useConfigStore.getState().setCurrentVariantOverride(override, 'high');
      expect(useConfigStore.getState().selectionSource).toBe('manual');

      await useConfigStore.getState().activateDirectory(worktree, { preserveManualModel: true });
      const state = useConfigStore.getState();
      expect(state.activeDirectoryKey).toBe(worktree);
      expect(state.providers[0]?.models.map((entry) => entry.modelID)).toEqual(['A', 'B']);
      expect(state.currentModelId).toBe('B');
      expect(state.selectionSource).toBe('manual');
      expect(state.directoryScoped[worktree]?.currentModelId).toBe('B');
      expect(state.currentVariant).toBe(override ?? undefined);
      expect(state.currentVariantSelection).toEqual({ override, inherited: 'high' });
      expect(state.directoryScoped[worktree]?.currentVariant).toBe(override ?? undefined);
      expect(state.directoryScoped[worktree]?.currentVariantSelection).toEqual({ override, inherited: 'high' });
    });
  }

  test('a directory absent from project discovery still loads its own catalog', async () => {
    const directory = '/workspace/new-worktree';
    getProvidersForConfigImpl = async (requested) => {
      expect(requested).toBe(directory);
      return providerResponse('new', 'new-model');
    };
    await useConfigStore.getState().activateDirectory(directory);
    expect(useConfigStore.getState().activeDirectoryKey).toBe(directory);
    expect(useConfigStore.getState().providers[0]?.models[0]?.modelID).toBe('new-model');
  });

  test('worktree catalog keeps its parent project agent default', async () => {
    const worktree = '/workspace/project-default-worktree';
    useSessionUIStore.setState({
      availableWorktreesByProject: new Map([[DIRECTORY, [{
        path: worktree,
        projectDirectory: DIRECTORY,
        branch: 'default',
        label: 'default',
      }]]]),
    });
    projectsState.projects[0] = { ...projectsState.projects[0], defaultAgent: 'review' };
    liveAgents = [testAgent('build'), testAgent('review')];

    await useConfigStore.getState().activateDirectory(worktree);

    expect(useConfigStore.getState().activeDirectoryKey).toBe(worktree);
    expect(useConfigStore.getState().currentAgentName).toBe('review');
  });

  test('loading another project agent picker leaves the active composer untouched', async () => {
    useConfigStore.setState({ agents: [testAgent('active-agent')], currentAgentName: 'active-agent', agentsLoaded: true });
    listAgentsImpl = async () => [{ name: 'other-agent', mode: 'primary' }];
    await useConfigStore.getState().loadAgents({ directory: OTHER_DIRECTORY });
    const state = useConfigStore.getState();
    expect(selectConfigAgentsForDirectory(state, OTHER_DIRECTORY).map((agent) => agent.name)).toEqual(['other-agent']);
    expect(selectCatalogLoadedForDirectory(state, 'agents', OTHER_DIRECTORY)).toBe(true);
    expect(state.agents.map((agent) => agent.name)).toEqual(['active-agent']);
    expect(state.currentAgentName).toBe('active-agent');
  });

  test('directory restoration retains an explicit Default effort', async () => {
    useConfigStore.setState({ providers: [provider('live')], agents: [testAgent('build')], agentsLoaded: true, providersLoaded: true });
    useConfigStore.getState().setCurrentVariantOverride(null, 'high');
    expect(useConfigStore.getState().directoryScoped[DIRECTORY]?.currentVariantSelection).toEqual({ override: null, inherited: 'high' });
    useConfigStore.setState({ activeDirectoryKey: OTHER_DIRECTORY });
    await useConfigStore.getState().activateDirectory(DIRECTORY);
    expect(useConfigStore.getState().currentVariantSelection.override).toBeNull();
    expect(useConfigStore.getState().currentVariant).toBeUndefined();
  });

  test('hydrates persisted provider snapshots for instant paint, then refreshes to live data', async () => {
    storage.set(STORAGE_KEY, JSON.stringify({
      state: {
        configRuntimeKey: getRuntimeKey(),
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
    expect(state.directoryScoped[OTHER_DIRECTORY]?.defaultProviders).toEqual({ 'inactive-live': 'inactive-live-model' });
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
    liveProviderVariants = ['fast', 'slow'];
    await useConfigStore.getState().loadProviders({ source: 'test:variant' });

    const state = useConfigStore.getState();
    expect(state.currentProviderId).toBe('live');
    expect(state.currentModelId).toBe('live-model');
    expect(state.currentVariant).toBe('fast');
  });

  test('the settings provider selection survives a refresh that no longer lists it', async () => {
    // Plugin-registered providers vanish from the list while OpenCode restarts.
    // A refresh in that window used to move the user to another provider while
    // they were reading or editing the one they picked.
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      currentProviderId: 'live',
      currentModelId: 'live-model',
      selectedProviderId: 'plugin-provider',
      directoryScoped: {},
    });

    liveProviderId = 'live';
    await useConfigStore.getState().loadProviders({ source: 'test:missing-selection' });

    const state = useConfigStore.getState();
    expect(state.providers.map((entry) => entry.id)).toEqual(['live']);
    expect(state.selectedProviderId).toBe('plugin-provider');
    expect(state.directoryScoped[DIRECTORY]?.selectedProviderId).toBe('plugin-provider');
  });

  test('an empty settings provider selection is filled from the refreshed list', async () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      currentProviderId: '',
      currentModelId: '',
      selectedProviderId: '',
      directoryScoped: {},
    });

    liveProviderId = 'live';
    await useConfigStore.getState().loadProviders({ source: 'test:empty-selection' });

    expect(useConfigStore.getState().selectedProviderId).toBe('live');
  });

  test('changing the chat provider leaves the settings provider selection alone', async () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('anthropic'), provider('openai')],
      currentProviderId: 'anthropic',
      currentModelId: 'anthropic-model',
      selectedProviderId: 'openai',
      directoryScoped: {},
    });

    useConfigStore.getState().setProvider('anthropic');

    const state = useConfigStore.getState();
    expect(state.currentProviderId).toBe('anthropic');
    expect(state.selectedProviderId).toBe('openai');
    expect(state.directoryScoped[DIRECTORY]?.selectedProviderId).toBe('openai');
  });

  test('provider reload preserves the add-provider sentinel selection', async () => {
    // The user has opened the "Add provider" form, which sets selectedProviderId
    // to the sentinel. A background provider refresh must not navigate them away
    // (and discard their unsaved input) just because the sentinel is not a real
    // provider id. See issue #1765.
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      currentProviderId: 'live',
      currentModelId: 'live-model',
      selectedProviderId: '__add_provider__',
      directoryScoped: {},
    });

    liveProviderId = 'live';
    await useConfigStore.getState().loadProviders({ source: 'test:add-provider' });

    expect(useConfigStore.getState().selectedProviderId).toBe('__add_provider__');
  });

  test('add-provider sentinel is not persisted as a stable provider selection', async () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      currentProviderId: 'live',
      currentModelId: 'live-model',
      selectedProviderId: '__add_provider__',
      directoryScoped: {
        [DIRECTORY]: {
          providers: [provider('live')],
          agents: [],
          currentProviderId: 'live',
          currentModelId: 'live-model',
          currentAgentName: undefined,
          selectedProviderId: '__add_provider__',
          agentModelSelections: {},
          defaultProviders: { default: 'live' },
        },
      },
    });

    const persisted = JSON.parse(storage.get(STORAGE_KEY) ?? '{}');
    expect(persisted.state.selectedProviderId).toBe('');
    expect(persisted.state.directoryScoped[DIRECTORY].selectedProviderId).toBe('');
  });

  test('setAgent applies settings default variant for an agent configured model', () => {
    useSessionUIStore.setState({ currentSessionId: 'ses_agent_default_variant' });
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5', ['low', 'high'])],
      agents: [testAgent('plan', { model: { providerID: 'openai', modelID: 'gpt-5.5' } })],
      settingsDefaultVariant: 'high',
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.5',
      currentVariant: undefined,
      directoryScoped: {},
    });

    useConfigStore.getState().setAgent('plan');

    const state = useConfigStore.getState();
    expect(state.currentProviderId).toBe('openai');
    expect(state.currentModelId).toBe('gpt-5.5');
    expect(state.currentVariant).toBe('high');
    expect(state.directoryScoped[DIRECTORY]?.currentVariant).toBe('high');
  });

  test('cycleCurrentVariant reaches Default, low, and medium from inherited high', () => {
    useConfigStore.setState({
      providers: [provider('openai', 'gpt-5.6-sol', ['none', 'low', 'medium', 'high', 'xhigh', 'max'])],
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.6-sol',
      currentVariant: 'high',
      currentVariantSelection: { override: undefined, inherited: 'high' },
      directoryScoped: {},
    });

    const expectedVariants = ['xhigh', 'max', undefined, 'none', 'low', 'medium', 'high'];
    for (const expectedVariant of expectedVariants) {
      expect(useConfigStore.getState().cycleCurrentVariant()).toBe(expectedVariant);
      expect(useConfigStore.getState().currentVariantSelection.override).toBe(expectedVariant ?? null);
    }

    useConfigStore.getState().setCurrentVariantOverride('max', 'high');
    expect(useConfigStore.getState().cycleCurrentVariant()).toBe(undefined);
    // Default is a choice to send no effort, not a way back to the inherited one.
    expect(useConfigStore.getState().currentVariant).toBe(undefined);
    expect(useConfigStore.getState().currentVariantSelection).toEqual({ override: null, inherited: 'high' });
  });

  test('cycleCurrentVariant toggles a single variant with Default', () => {
    useConfigStore.setState({
      providers: [provider('openai', 'single', ['high'])],
      currentProviderId: 'openai',
      currentModelId: 'single',
      currentVariant: 'high',
      currentVariantSelection: { override: null, inherited: 'high' },
      directoryScoped: {},
    });

    expect(useConfigStore.getState().cycleCurrentVariant()).toBe('high');
    expect(useConfigStore.getState().currentVariantSelection.override).toBe('high');
    expect(useConfigStore.getState().cycleCurrentVariant()).toBe(undefined);
    expect(useConfigStore.getState().currentVariantSelection.override).toBeNull();
    expect(useConfigStore.getState().currentVariant).toBe(undefined);
  });

  test('an unavailable explicit variant cycles back to Default', () => {
    useConfigStore.setState({
      providers: [provider('openai', 'changed', ['low', 'high'])],
      currentProviderId: 'openai',
      currentModelId: 'changed',
      currentVariant: 'removed',
      currentVariantSelection: { override: 'removed', inherited: 'low' },
      directoryScoped: {},
    });

    expect(useConfigStore.getState().cycleCurrentVariant()).toBe(undefined);
    expect(useConfigStore.getState().currentVariant).toBe(undefined);
    expect(useConfigStore.getState().currentVariantSelection.override).toBeNull();
  });

  test('setAgent prefers saved and agent variants before settings default', () => {
    const sessionId = 'ses_agent_saved_variant';
    useSessionUIStore.setState({ currentSessionId: sessionId });
    useSelectionStore.getState().saveAgentModelVariantForSession(sessionId, 'plan', 'openai', 'gpt-5.5', 'low');
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5', ['low', 'medium', 'high'])],
      agents: [testAgent('plan', {
        model: { providerID: 'openai', modelID: 'gpt-5.5' },
        variant: 'medium',
      })],
      settingsDefaultVariant: 'high',
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.5',
      currentVariant: undefined,
      directoryScoped: {},
    });

    useConfigStore.getState().setAgent('plan');
    expect(useConfigStore.getState().currentVariant).toBe('low');

    useSelectionStore.getState().saveAgentModelVariantForSession(sessionId, 'plan', 'openai', 'gpt-5.5', undefined);
    useConfigStore.setState({ currentVariant: undefined, directoryScoped: {} });

    useConfigStore.getState().setAgent('plan');
    expect(useConfigStore.getState().currentVariant).toBe('medium');
  });

  test('an explicit Default effort sends no variant instead of the settings default', () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5', ['low', 'high'])],
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.5',
      currentVariant: 'low',
      currentVariantSelection: { override: 'low', inherited: 'low' },
      settingsDefaultVariant: 'low',
      directoryScoped: {},
    });

    useConfigStore.getState().setCurrentVariantOverride(null, 'low');

    expect(useConfigStore.getState().currentVariant).toBe(undefined);
    expect(useConfigStore.getState().currentVariantSelection).toEqual({ override: null, inherited: 'low' });
  });

  test('setAgent keeps a session Default effort instead of restoring the settings default', () => {
    const sessionId = 'ses_agent_default_effort';
    useSessionUIStore.setState({ currentSessionId: sessionId });
    useSelectionStore.getState().saveAgentModelForSession(sessionId, 'plan', 'openai', 'gpt-5.5');
    useSelectionStore.getState().saveAgentModelVariantForSession(sessionId, 'plan', 'openai', 'gpt-5.5', null);
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5', ['low', 'high'])],
      agents: [testAgent('plan')],
      settingsDefaultVariant: 'low',
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.5',
      currentVariant: 'low',
      currentVariantSelection: { override: undefined, inherited: 'low' },
      directoryScoped: {},
    });

    useConfigStore.getState().setAgent('plan');

    const state = useConfigStore.getState();
    expect(state.currentVariant).toBe(undefined);
    expect(state.currentVariantSelection).toEqual({ override: null, inherited: 'low' });
    expect(state.directoryScoped[DIRECTORY]?.currentVariant).toBe(undefined);
  });

  test('setAgent reports the same effort through currentVariant and the picker selection', () => {
    const sessionId = 'ses_agent_effort_in_sync';
    useSessionUIStore.setState({ currentSessionId: sessionId });
    useSelectionStore.getState().saveAgentModelForSession(sessionId, 'plan', 'openai', 'gpt-5.5');
    useSelectionStore.getState().saveAgentModelVariantForSession(sessionId, 'plan', 'openai', 'gpt-5.5', 'high');
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5', ['low', 'high'])],
      agents: [testAgent('plan')],
      settingsDefaultVariant: 'low',
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.5',
      currentVariant: 'low',
      currentVariantSelection: { override: 'low', inherited: 'low' },
      directoryScoped: {},
    });

    useConfigStore.getState().setAgent('plan');

    const state = useConfigStore.getState();
    expect(state.currentVariant).toBe('high');
    expect(state.currentVariantSelection).toEqual({ override: 'high', inherited: 'low' });
  });

  test('setAgent applies settings default variant for a saved session agent model', () => {
    const sessionId = 'ses_existing_agent_model_default_variant';
    useSessionUIStore.setState({ currentSessionId: sessionId });
    useSelectionStore.getState().saveAgentModelForSession(sessionId, 'plan', 'openai', 'gpt-5.5');
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5', ['low', 'high'])],
      agents: [testAgent('plan')],
      settingsDefaultVariant: 'high',
      currentProviderId: 'other',
      currentModelId: 'other-model',
      currentVariant: undefined,
      directoryScoped: {},
    });

    useConfigStore.getState().setAgent('plan');

    const state = useConfigStore.getState();
    expect(state.currentProviderId).toBe('openai');
    expect(state.currentModelId).toBe('gpt-5.5');
    expect(state.currentVariant).toBe('high');
  });

  test('[issue-2404] setAgent keeps session model override over agent default model', () => {
    // Custom agent default is model-a; user manually overrode to model-b for this session.
    // Re-applying setAgent (e.g. after delegated subtask completion rematerializes the
    // parent) must keep model-b rather than resetting to the agent pin.
    const sessionId = 'ses_2404_model_override';
    const multiModelProvider = {
      ...provider('provider', 'model-a'),
      models: [
        provider('provider', 'model-a').models[0],
        provider('provider', 'model-b').models[0],
      ],
    };
    useSessionUIStore.setState({ currentSessionId: sessionId });
    useSelectionStore.getState().saveSessionModelSelection(sessionId, 'provider', 'model-b');
    useSelectionStore.getState().saveAgentModelForSession(sessionId, 'custom-agent', 'provider', 'model-b');
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [multiModelProvider],
      agents: [testAgent('custom-agent', { model: { providerID: 'provider', modelID: 'model-a' } })],
      currentProviderId: 'provider',
      currentModelId: 'model-b',
      currentAgentName: 'custom-agent',
      selectionSource: 'manual',
      currentVariant: undefined,
      directoryScoped: {},
    });

    useConfigStore.getState().setAgent('custom-agent');

    const state = useConfigStore.getState();
    expect(state.currentProviderId).toBe('provider');
    expect(state.currentModelId).toBe('model-b');
    expect(useSelectionStore.getState().getAgentModelForSession(sessionId, 'custom-agent')).toEqual({
      providerId: 'provider',
      modelId: 'model-b',
    });
  });

  test('[issue-2404] setAgent uses agent default when no session override exists', () => {
    const sessionId = 'ses_2404_agent_default';
    const multiModelProvider = {
      ...provider('provider', 'model-a'),
      models: [
        provider('provider', 'model-a').models[0],
        provider('provider', 'model-b').models[0],
      ],
    };
    useSessionUIStore.setState({ currentSessionId: sessionId });
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [multiModelProvider],
      agents: [testAgent('custom-agent', { model: { providerID: 'provider', modelID: 'model-a' } })],
      currentProviderId: 'provider',
      currentModelId: 'model-b',
      currentAgentName: undefined,
      selectionSource: 'auto',
      currentVariant: undefined,
      directoryScoped: {},
    });

    useConfigStore.getState().setAgent('custom-agent');

    const state = useConfigStore.getState();
    expect(state.currentProviderId).toBe('provider');
    expect(state.currentModelId).toBe('model-a');
  });

  test('[issue-2531] setAgent keeps the manual model when switching to an agent without an override', () => {
    const sessionId = 'ses_2531_mode_switch';
    useSessionUIStore.setState({ currentSessionId: sessionId });
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('deepseek', 'deepseek-v4-pro'), provider('kimi', 'kimi-k3')],
      agents: [testAgent('build'), testAgent('plan')],
      settingsDefaultModel: 'deepseek/deepseek-v4-pro',
      currentProviderId: 'kimi',
      currentModelId: 'kimi-k3',
      currentAgentName: 'build',
      selectionSource: 'manual',
      currentVariant: undefined,
      directoryScoped: {},
    });

    useConfigStore.getState().setAgent('plan');

    const state = useConfigStore.getState();
    expect(state.currentAgentName).toBe('plan');
    expect(state.currentProviderId).toBe('kimi');
    expect(state.currentModelId).toBe('kimi-k3');
  });

  test('[issue-2690] setAgent persists the kept manual model for the session and agent', () => {
    const sessionId = 'ses_2690_persist_kept_model';
    useSessionUIStore.setState({ currentSessionId: sessionId });
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('deepseek', 'deepseek-v4-pro'), provider('kimi', 'kimi-k3')],
      agents: [testAgent('build'), testAgent('plan')],
      settingsDefaultModel: 'deepseek/deepseek-v4-pro',
      currentProviderId: 'kimi',
      currentModelId: 'kimi-k3',
      currentAgentName: 'build',
      selectionSource: 'manual',
      currentVariant: undefined,
      directoryScoped: {},
    });

    useConfigStore.getState().setAgent('plan');

    // Keeping the pair only in memory loses it on reload; the write is what
    // makes the choice survive.
    const selection = useSelectionStore.getState();
    expect(selection.getSessionModelSelection(sessionId)).toEqual({ providerId: 'kimi', modelId: 'kimi-k3' });
    expect(selection.getAgentModelForSession(sessionId, 'plan')).toEqual({ providerId: 'kimi', modelId: 'kimi-k3' });
  });

  test('setAgent preserves the manual model while it is absent from discovery', () => {
    const sessionId = 'ses_2690_stale_model';
    useSessionUIStore.setState({ currentSessionId: sessionId });
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('deepseek', 'deepseek-v4-pro')],
      agents: [testAgent('build'), testAgent('plan')],
      settingsDefaultModel: 'deepseek/deepseek-v4-pro',
      // The provider still exists but this model was removed from it.
      currentProviderId: 'deepseek',
      currentModelId: 'retired-model',
      currentAgentName: 'build',
      selectionSource: 'manual',
      currentVariant: undefined,
      directoryScoped: {},
    });

    useConfigStore.getState().setAgent('plan');

    const state = useConfigStore.getState();
    expect(state.currentProviderId).toBe('deepseek');
    expect(state.currentModelId).toBe('retired-model');
  });

  test('setAgent switching from agent with pinned model to agent without pinned model uses default model, does not leak pinned model', () => {
    const sessionId = 'ses_pinned_to_unpinned_leak';
    useSessionUIStore.setState({ currentSessionId: sessionId });
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.6-sol'), provider('google', 'antigravity-gemini-3.8-flash')],
      agents: [
        testAgent('plan'),
        testAgent('Plan - Gemini', { model: { providerID: 'google', modelID: 'antigravity-gemini-3.8-flash' } }),
      ],
      settingsDefaultModel: 'openai/gpt-5.6-sol',
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.6-sol',
      currentAgentName: 'plan',
      selectionSource: 'auto',
      currentVariant: undefined,
      directoryScoped: {},
    });

    useConfigStore.getState().setAgent('Plan - Gemini');
    let state = useConfigStore.getState();
    expect(state.currentAgentName).toBe('Plan - Gemini');
    expect(state.currentProviderId).toBe('google');
    expect(state.currentModelId).toBe('antigravity-gemini-3.8-flash');
    expect(state.selectionSource).toBe('auto');

    useConfigStore.getState().setAgent('plan');
    state = useConfigStore.getState();
    expect(state.currentAgentName).toBe('plan');
    expect(state.currentProviderId).toBe('openai');
    expect(state.currentModelId).toBe('gpt-5.6-sol');
    expect(state.selectionSource).toBe('auto');
    expect(useSelectionStore.getState().getAgentModelForSession(sessionId, 'plan')).toBeNull();
  });

  test('cycling through agents with and without pinned models respects each agent config after sending message', () => {
    const sessionId = 'ses_tab_cycle_all_agents';
    useSessionUIStore.setState({ currentSessionId: sessionId });
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [
        provider('openai', 'gpt-5.6-sol'),
        provider('google', 'antigravity-gemini-3.8-flash'),
      ],
      agents: [
        testAgent('plan'),
        testAgent('Plan - Gemini', { model: { providerID: 'google', modelID: 'antigravity-gemini-3.8-flash' } }),
        testAgent('build'),
        testAgent('Build - Gemini', { model: { providerID: 'google', modelID: 'antigravity-gemini-3.8-flash' } }),
      ],
      settingsDefaultModel: 'openai/gpt-5.6-sol',
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.6-sol',
      currentAgentName: 'plan',
      selectionSource: 'auto',
      currentVariant: undefined,
      directoryScoped: {},
    });

    useConfigStore.getState().setAgent('Plan - Gemini');
    expect(useConfigStore.getState().currentAgentName).toBe('Plan - Gemini');
    expect(useConfigStore.getState().currentModelId).toBe('antigravity-gemini-3.8-flash');

    // Message reconciliation records the sent model as the live manual selection.
    useSelectionStore.getState().saveSessionModelSelection(sessionId, 'google', 'antigravity-gemini-3.8-flash');
    useSelectionStore.getState().saveAgentModelForSession(sessionId, 'Plan - Gemini', 'google', 'antigravity-gemini-3.8-flash');
    useConfigStore.setState({ selectionSource: 'manual' });

    useConfigStore.getState().setAgent('build');
    expect(useConfigStore.getState().currentAgentName).toBe('build');
    expect(useConfigStore.getState().currentModelId).toBe('gpt-5.6-sol');
    expect(useSelectionStore.getState().getAgentModelForSession(sessionId, 'build')).toBeNull();

    useConfigStore.getState().setAgent('Build - Gemini');
    expect(useConfigStore.getState().currentAgentName).toBe('Build - Gemini');
    expect(useConfigStore.getState().currentModelId).toBe('antigravity-gemini-3.8-flash');

    useConfigStore.getState().setAgent('plan');
    expect(useConfigStore.getState().currentAgentName).toBe('plan');
    expect(useConfigStore.getState().currentModelId).toBe('gpt-5.6-sol');
    expect(useSelectionStore.getState().getAgentModelForSession(sessionId, 'plan')).toBeNull();
  });

  test('a picked agent survives an agents reload, with its inherited model still inherited', async () => {
    const agentsList = [
      testAgent('build', { model: { providerID: 'openai', modelID: 'gpt-5.6-sol' } }),
      testAgent('Build - Gemini', { model: { providerID: 'google', modelID: 'antigravity-gemini-3.8-flash' } }),
      testAgent('plan'),
    ];
    const providersList = [
      provider('openai', 'gpt-5.6-sol'),
      provider('google', 'antigravity-gemini-3.8-flash'),
    ];
    listAgentsImpl = async () => agentsList;
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: providersList,
      agents: agentsList,
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.6-sol',
      currentAgentName: 'build',
      selectionSource: 'auto',
      agentSelectionSource: 'auto',
      currentVariant: undefined,
      directoryScoped: {},
    });

    useConfigStore.getState().setAgent('Build - Gemini');
    await useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:pickedPinnedAgent' });

    expect(useConfigStore.getState().currentAgentName).toBe('Build - Gemini');
    expect(useConfigStore.getState().currentModelId).toBe('antigravity-gemini-3.8-flash');
    // The pin was inherited, not chosen: a reload must not promote it.
    expect(useConfigStore.getState().selectionSource).toBe('auto');

    useConfigStore.getState().setAgent('plan');
    await useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:pickedUnpinnedAgent' });

    expect(useConfigStore.getState().currentAgentName).toBe('plan');
  });

  test('default selection clears an agent pick so the next draft resolves defaults again', async () => {
    const agentsList = [
      testAgent('build', { model: { providerID: 'openai', modelID: 'gpt-5.6-sol' } }),
      testAgent('Build - Gemini', { model: { providerID: 'google', modelID: 'antigravity-gemini-3.8-flash' } }),
    ];
    listAgentsImpl = async () => agentsList;
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [
        provider('openai', 'gpt-5.6-sol'),
        provider('google', 'antigravity-gemini-3.8-flash'),
      ],
      agents: agentsList,
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.6-sol',
      currentAgentName: 'build',
      selectionSource: 'auto',
      agentSelectionSource: 'auto',
      settingsDefaultsLoaded: true,
      directoryScoped: {},
    });

    useConfigStore.getState().setAgent('Build - Gemini');
    useConfigStore.getState().applyDefaultModelAgentSelection();
    await useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:pickCleared' });

    expect(useConfigStore.getState().agentSelectionSource).toBe('auto');
    expect(useConfigStore.getState().currentAgentName).toBe('build');
  });

  test('setAgent carries an explicit override from a pinned agent to an unpinned agent', () => {
    const sessionId = 'ses_explicit_override_from_pinned';
    useSessionUIStore.setState({ currentSessionId: sessionId });
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [
        provider('openai', 'gpt-5.6-sol'),
        provider('google', 'antigravity-gemini-3.8-flash'),
        provider('anthropic', 'claude-sonnet'),
      ],
      agents: [
        testAgent('plan'),
        testAgent('Plan - Gemini', { model: { providerID: 'google', modelID: 'antigravity-gemini-3.8-flash' } }),
      ],
      settingsDefaultModel: 'openai/gpt-5.6-sol',
      currentProviderId: 'anthropic',
      currentModelId: 'claude-sonnet',
      currentAgentName: 'Plan - Gemini',
      selectionSource: 'manual',
      currentVariant: undefined,
      directoryScoped: {},
    });

    useConfigStore.getState().setAgent('plan');

    expect(useConfigStore.getState().currentModelId).toBe('claude-sonnet');
    expect(useSelectionStore.getState().getAgentModelForSession(sessionId, 'plan')).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-sonnet',
    });
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

  test('refreshes cached OpenChamber defaults after the default model changes', async () => {
    liveAgents = [testAgent('build')];
    liveProviderId = 'first';
    persistedOpenChamberSettings = { defaultModel: 'first/first-model' };

    await useConfigStore.getState().loadProviders({ directory: DIRECTORY, source: 'test:defaults-cache-first' });
    await useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:defaults-cache-first' });
    expect(useConfigStore.getState().settingsDefaultModel).toBe('first/first-model');

    liveProviderId = 'second';
    persistedOpenChamberSettings = { defaultModel: 'second/second-model' };
    useConfigStore.getState().setSettingsDefaultModel('second/second-model');

    await useConfigStore.getState().loadProviders({ directory: DIRECTORY, source: 'test:defaults-cache-second' });
    await useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:defaults-cache-second' });

    expect(useConfigStore.getState().settingsDefaultModel).toBe('second/second-model');
    expect(settingsLoadCalls).toBe(2);
  });

  test('an invalid project config finishes startup and stays scoped to that project', async () => {
    listAgentsImpl = async () => {
      throw new Error('agent.list failed (400)', {
        cause: Object.assign(new Error('bad file reference'), {
          name: 'ConfigInvalidError',
          data: { path: `${DIRECTORY}/opencode.json`, message: 'bad file reference' },
        }),
      });
    };
    await useConfigStore.getState().initializeApp();

    expect(useConfigStore.getState().isInitialized).toBe(true);
    expect(listAgentsCalls).toBe(1);
    expect(useConfigStore.getState().projectConfigErrors).toEqual({
      [DIRECTORY]: { name: 'ConfigInvalidError', path: `${DIRECTORY}/opencode.json`, message: 'bad file reference' },
    });

    listAgentsImpl = null;
    liveAgents = [testAgent('build')];
    await useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:fixed' });
    expect(useConfigStore.getState().projectConfigErrors).toEqual({});
  });

  test('an unreachable server is recorded as the startup failure', async () => {
    probeHealthImpl = async () => 'unreachable';
    await useConfigStore.getState().initializeApp();

    expect(useConfigStore.getState().isInitialized).toBe(false);
    expect(useConfigStore.getState().lastInitFailure).toEqual({ step: 'serverUnreachable', message: null });
  }, 10_000);

  test('a live server with OpenCode not ready is not reported as unreachable', async () => {
    probeHealthImpl = async () => 'unhealthy';
    await useConfigStore.getState().initializeApp();

    expect(useConfigStore.getState().lastInitFailure).toEqual({ step: 'openCodeUnavailable', message: null });
  }, 10_000);

  test('a project whose folder is gone does not block startup', async () => {
    listAgentsImpl = async () => {
      throw new Error('agent.list failed (500)');
    };
    directoryAvailability = 'missing';
    try {
      await useConfigStore.getState().initializeApp();
    } finally {
      directoryAvailability = 'available';
    }

    expect(useConfigStore.getState().isInitialized).toBe(true);
    expect(useConfigStore.getState().lastInitFailure).toBeNull();
  }, 10_000);

  test('a failed agent load records its error text, and a later success clears it', async () => {
    listAgentsImpl = async () => {
      throw new Error('agent.list failed (500): provider plugin crashed');
    };
    await useConfigStore.getState().initializeApp();

    expect(useConfigStore.getState().isInitialized).toBe(false);
    expect(useConfigStore.getState().lastInitFailure).toEqual({
      step: 'loadAgents',
      message: 'agent.list failed (500): provider plugin crashed',
    });

    listAgentsImpl = null;
    liveAgents = [testAgent('build')];
    await useConfigStore.getState().initializeApp();
    expect(useConfigStore.getState().isInitialized).toBe(true);
    expect(useConfigStore.getState().lastInitFailure).toBeNull();
  }, 10_000);

  test('publishes configured defaults before slow catalogs finish', async () => {
    const providers = deferred<TestProviderResponse>();
    const agents = deferred<TestAgent[]>();
    getProvidersForConfigImpl = () => providers.promise;
    listAgentsImpl = () => agents.promise;
    persistedOpenChamberSettings = { defaultModel: 'sidecar/chosen', defaultAgent: 'review', defaultVariant: 'high' };
    useConfigStore.setState({ settingsDefaultsLoaded: false });
    const initialization = useConfigStore.getState().initializeApp();
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settingsLoadCalls).toBe(1);
      expect(useConfigStore.getState()).toMatchObject({
        currentProviderId: 'sidecar', currentModelId: 'chosen', currentAgentName: 'review', currentVariant: 'high',
      });
      expect(useConfigStore.getState().isInitialized).toBe(false);
    } finally {
      providers.resolve(providerResponse('sidecar', 'chosen', ['high']));
      agents.resolve([testAgent('review')]);
      await initialization;
    }
  });

  test('starts agent and provider requests together during cold directory activation', async () => {
    const providers = deferred<TestProviderResponse>();
    getProvidersForConfigImpl = () => providers.promise;
    liveAgents = [testAgent('build')];
    const activation = useConfigStore.getState().activateDirectory(DIRECTORY);
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(getProvidersCalls).toBe(1);
      expect(listAgentsCalls).toBe(1);
    } finally {
      providers.resolve(providerResponse('live'));
      await activation;
    }
  });

  test('does not re-read settings after waiting for the provider catalog', async () => {
    const providers = deferred<TestProviderResponse>();
    getProvidersForConfigImpl = () => providers.promise;
    liveAgents = [testAgent('build')];
    const providerLoad = useConfigStore.getState().loadProviders({ directory: DIRECTORY });
    const agentLoad = useConfigStore.getState().loadAgents({ directory: DIRECTORY });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    providers.resolve(providerResponse('live'));
    await Promise.all([providerLoad, agentLoad]);
    expect(settingsLoadCalls).toBe(1);
  });

  test('loads preferences before a slow OpenCode health check finishes', async () => {
    const health = deferred<boolean>();
    checkHealthImpl = () => health.promise;
    persistedOpenChamberSettings = { defaultModel: 'sidecar/chosen', defaultAgent: 'review' };
    useConfigStore.setState({ settingsDefaultsLoaded: false });
    liveAgents = [testAgent('review')];
    const initialization = useConfigStore.getState().initializeApp();
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(useConfigStore.getState().currentModelId).toBe('chosen');
      expect(useConfigStore.getState().currentAgentName).toBe('review');
      expect(settingsLoadCalls).toBe(1);
      expect(getProvidersCalls).toBe(0);
    } finally {
      health.resolve(true);
      await initialization;
    }
  });

  test('publishes the default agent before a slow provider catalog finishes', async () => {
    const providers = deferred<TestProviderResponse>();
    getProvidersForConfigImpl = () => providers.promise;
    liveAgents = [testAgent('build', { model: { providerID: 'live', modelID: 'live-model' } })];
    const activation = useConfigStore.getState().activateDirectory(DIRECTORY);
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(useConfigStore.getState().agentsLoaded).toBe(true);
      expect(useConfigStore.getState().providersLoaded).toBe(false);
      expect(useConfigStore.getState().currentAgentName).toBe('build');
      expect(useConfigStore.getState().currentModelId).toBe('live-model');
    } finally {
      providers.resolve(providerResponse('live'));
      await activation;
    }
  });

  test('does not let an in-flight settings read overwrite a newer default model', async () => {
    const pendingSettings = deferred<DesktopSettings | null>();
    loadSettingsImpl = () => pendingSettings.promise;
    liveAgents = [testAgent('build')];
    useConfigStore.setState({ providers: [provider('sidecar', 'new-model')] });

    const load = useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:defaults-race' });
    useConfigStore.getState().setSettingsDefaultModel('sidecar/new-model');
    pendingSettings.resolve({ defaultModel: 'sidecar/old-model' });
    await load;

    expect(useConfigStore.getState().settingsDefaultModel).toBe('sidecar/new-model');
  });

  test('reconciles defaults changed while loadAgents awaits providers', async () => {
    const pendingProviders = deferred<TestProviderResponse>();
    getProvidersForConfigImpl = async () => pendingProviders.promise;
    liveAgents = [testAgent('build'), testAgent('review')];
    persistedOpenChamberSettings = {
      defaultModel: 'sidecar/old-model',
      defaultVariant: 'low',
      defaultAgent: 'build',
    };
    useConfigStore.setState({ providers: [], currentProviderId: '', currentModelId: '' });

    const providerLoad = useConfigStore.getState().loadProviders({ directory: DIRECTORY, source: 'test:defaults-provider-wait' });
    const agentsLoad = useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:defaults-provider-wait' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    useConfigStore.getState().setSettingsDefaultModel('sidecar/new-model');
    useConfigStore.getState().setSettingsDefaultVariant('high');
    useConfigStore.getState().setSettingsDefaultAgent('review');
    pendingProviders.resolve(providerResponse('sidecar', 'new-model', ['high']));

    await Promise.all([providerLoad, agentsLoad]);

    const state = useConfigStore.getState();
    expect(state.settingsDefaultModel).toBe('sidecar/new-model');
    expect(state.settingsDefaultVariant).toBe('high');
    expect(state.settingsDefaultAgent).toBe('review');
    expect(state.currentProviderId).toBe('sidecar');
    expect(state.currentModelId).toBe('new-model');
    expect(state.currentVariant).toBe('high');
    expect(state.currentAgentName).toBe('review');
  });

  test('does not publish runtime A defaults after switching to runtime B', async () => {
    const pendingProvidersA = deferred<TestProviderResponse>();
    let providerRequest = 0;
    getProvidersForConfigImpl = async () => {
      providerRequest += 1;
      if (providerRequest === 1) return pendingProvidersA.promise;
      return providerResponse('runtime-b', 'b-model', ['high']);
    };
    liveAgents = [testAgent('build')];
    let settingsRuntime: 'a' | 'b' = 'a';
    loadSettingsImpl = async () => settingsRuntime === 'a'
      ? { defaultModel: 'runtime-a/a-model', defaultVariant: 'low' }
      : { defaultModel: 'runtime-b/b-model', defaultVariant: 'high' };

    switchRuntimeEndpoint({ apiBaseUrl: 'https://config-a.example', runtimeKey: 'config-a' });
    const providerLoadA = useConfigStore.getState().loadProviders({ directory: DIRECTORY, source: 'test:runtime-a' });
    const agentsLoadA = useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:runtime-a' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    settingsRuntime = 'b';
    switchRuntimeEndpoint({ apiBaseUrl: 'https://config-b.example', runtimeKey: 'config-b' });
    const providerLoadB = useConfigStore.getState().loadProviders({ directory: DIRECTORY, source: 'test:runtime-b' });
    const agentsLoadB = useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:runtime-b' });
    await Promise.all([providerLoadB, agentsLoadB]);

    pendingProvidersA.resolve(providerResponse('runtime-a', 'a-model', ['low']));
    await Promise.all([providerLoadA, agentsLoadA]);

    const state = useConfigStore.getState();
    expect(state.settingsDefaultModel).toBe('runtime-b/b-model');
    expect(state.settingsDefaultVariant).toBe('high');
    expect(state.currentProviderId).toBe('runtime-b');
    expect(state.currentModelId).toBe('b-model');
    expect(state.currentVariant).toBe('high');
  });

  test('does not retain another runtime defaults or directory snapshots on a failed read', async () => {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://retained-a.example', runtimeKey: 'retained-a' });
    liveAgents = [testAgent('build')];
    persistedOpenChamberSettings = { defaultModel: 'live/live-model', defaultVariant: 'high', defaultAgent: 'build' };
    await useConfigStore.getState().loadProviders({ directory: DIRECTORY });
    await useConfigStore.getState().loadAgents({ directory: DIRECTORY });
    expect(useConfigStore.getState().directoryScoped[DIRECTORY]).toBeDefined();

    switchRuntimeEndpoint({ apiBaseUrl: 'https://retained-b.example', runtimeKey: 'retained-b' });
    persistedOpenChamberSettings = null;
    expect(useConfigStore.getState().directoryScoped).toEqual({});
    await useConfigStore.getState().activateDirectory(DIRECTORY);
    expect(useConfigStore.getState().providers).toEqual([]);
    await useConfigStore.getState().loadAgents({ directory: DIRECTORY });
    expect(useConfigStore.getState().settingsDefaultModel).toBeUndefined();
    expect(useConfigStore.getState().settingsDefaultVariant).toBeUndefined();
    expect(useConfigStore.getState().settingsDefaultAgent).toBeUndefined();
  });

  test('rejects a persisted config snapshot belonging to another runtime', async () => {
    storage.set(STORAGE_KEY, JSON.stringify({ state: {
      configRuntimeKey: 'some-other-instance',
      settingsDefaultModel: 'foreign/model',
      providers: [provider('foreign')],
    }, version: 0 }));
    await useConfigStore.persist.rehydrate();
    expect(useConfigStore.getState().settingsDefaultModel).toBeUndefined();
    expect(useConfigStore.getState().providers).toEqual([]);
  });

  test('an obsolete initialization cannot publish readiness or consume the new initialization', async () => {
    const pendingA = deferred<TestProviderResponse>();
    const pendingB = deferred<TestProviderResponse>();
    let calls = 0;
    getProvidersForConfigImpl = () => ++calls === 1 ? pendingA.promise : pendingB.promise;
    liveAgents = [testAgent('build')];
    switchRuntimeEndpoint({ apiBaseUrl: 'https://init-a.example', runtimeKey: 'init-a' });
    const initA = useConfigStore.getState().initializeApp();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    switchRuntimeEndpoint({ apiBaseUrl: 'https://init-b.example', runtimeKey: 'init-b' });
    const initB = useConfigStore.getState().initializeApp();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(2);
    pendingA.resolve(providerResponse('a'));
    await initA;
    expect(useConfigStore.getState().isInitialized).toBe(false);
    pendingB.resolve(providerResponse('b'));
    await initB;
    expect(useConfigStore.getState().isInitialized).toBe(true);
    expect(useConfigStore.getState().providers[0]?.id).toBe('b');
  });

  test('an A to B to A switch still rejects the first A completion', async () => {
    const pending = deferred<TestProviderResponse>();
    switchRuntimeEndpoint({ apiBaseUrl: 'https://roundtrip-a.example', runtimeKey: 'roundtrip-a' });
    getProvidersForConfigImpl = () => pending.promise;
    const firstA = useConfigStore.getState().loadProviders({ directory: DIRECTORY });
    switchRuntimeEndpoint({ apiBaseUrl: 'https://roundtrip-b.example', runtimeKey: 'roundtrip-b' });
    switchRuntimeEndpoint({ apiBaseUrl: 'https://roundtrip-a.example', runtimeKey: 'roundtrip-a' });
    getProvidersForConfigImpl = async () => (providerResponse('fresh'));
    await useConfigStore.getState().loadProviders({ directory: DIRECTORY });
    pending.resolve(providerResponse('obsolete'));
    await firstA;
    expect(useConfigStore.getState().providers[0]?.id).toBe('fresh');
  });

  test('a directory activation stops after a runtime switch during its provider wait', async () => {
    const pending = deferred<TestProviderResponse>();
    getProvidersForConfigImpl = () => pending.promise;
    const activation = useConfigStore.getState().activateDirectory(DIRECTORY);
    switchRuntimeEndpoint({ apiBaseUrl: 'https://activation-next.example', runtimeKey: 'activation-next' });
    pending.resolve(providerResponse('obsolete'));
    await activation;
    expect(listAgentsCalls).toBe(1);
    expect(useConfigStore.getState().agents).toEqual([]);
    expect(useConfigStore.getState().providers).toEqual([]);
  });

  test('keeps a saved default model while a sidecar temporarily omits it', async () => {
    liveAgents = [testAgent('build')];
    liveProviderId = 'sidecar';
    persistedOpenChamberSettings = { defaultModel: 'sidecar/default' };

    await useConfigStore.getState().loadProviders({ directory: DIRECTORY, source: 'test:sidecar-default' });
    await useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:sidecar-default' });

    expect(useConfigStore.getState().settingsDefaultModel).toBe('sidecar/default');
    expect(useConfigStore.getState().currentProviderId).toBe('sidecar');
    expect(useConfigStore.getState().currentModelId).toBe('default');
  });

  test('a fresh draft keeps its configured identity and thinking before discovery and after return', async () => {
    useConfigStore.setState({
      providers: [], agents: [], settingsDefaultsLoaded: false,
      settingsDefaultModel: 'sidecar/chosen', settingsDefaultVariant: 'high', settingsDefaultAgent: 'build',
    });
    useConfigStore.getState().applyDefaultModelAgentSelection();
    expect(useConfigStore.getState()).toMatchObject({
      currentProviderId: 'sidecar', currentModelId: 'chosen', currentVariant: 'high', currentAgentName: 'build',
    });
    persistedOpenChamberSettings = { defaultModel: 'sidecar/chosen', defaultVariant: 'high', defaultAgent: 'build' };
    liveAgents = [testAgent('build')];
    getProvidersForConfigImpl = async () => (providerResponse('opencode', 'big-pickle'));
    await useConfigStore.getState().loadProviders({ directory: DIRECTORY });
    await useConfigStore.getState().loadAgents({ directory: DIRECTORY });
    useConfigStore.getState().applyDefaultModelAgentSelection();
    expect(useConfigStore.getState()).toMatchObject({ currentProviderId: 'sidecar', currentModelId: 'chosen', currentVariant: 'high' });
    getProvidersForConfigImpl = async () => (providerResponse('sidecar', 'chosen', ['high']));
    await useConfigStore.getState().loadProviders({ directory: DIRECTORY });
    expect(useConfigStore.getState()).toMatchObject({ currentProviderId: 'sidecar', currentModelId: 'chosen', currentVariant: 'high' });
    expect(useConfigStore.getState().getCurrentModel()?.modelID).toBe('chosen');
  });

  test('an effort picked in a draft survives the settings document arriving late', async () => {
    persistedOpenChamberSettings = { defaultModel: 'sidecar/chosen', defaultVariant: 'high' };
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('sidecar', 'chosen')],
      agents: [testAgent('build')],
      currentProviderId: 'sidecar',
      currentModelId: 'chosen',
      currentAgentName: 'build',
      selectionSource: 'auto',
      agentSelectionSource: 'auto',
      settingsDefaultsLoaded: false,
      directoryScoped: {},
    });

    useConfigStore.getState().setCurrentVariantOverride('low', 'high');
    await useConfigStore.getState().loadSessionDefaults();

    expect(useConfigStore.getState().settingsDefaultVariant).toBe('high');
    expect(useConfigStore.getState().currentVariant).toBe('low');
    expect(useConfigStore.getState().currentVariantSelection.override).toBe('low');
  });

  test('does not choose Big Pickle while settings are still loading', async () => {
    useConfigStore.setState({ settingsDefaultsLoaded: false });
    getProvidersForConfigImpl = async () => (providerResponse('opencode', 'big-pickle'));
    await useConfigStore.getState().loadProviders({ directory: DIRECTORY });
    useConfigStore.getState().applyDefaultModelAgentSelection();
    expect(useConfigStore.getState().currentModelId).toBe('');
    persistedOpenChamberSettings = { defaultModel: 'sidecar/chosen' };
    liveAgents = [testAgent('build')];
    await useConfigStore.getState().loadAgents({ directory: DIRECTORY });
    expect(useConfigStore.getState().currentModelId).toBe('chosen');
  });

  test('a project default remains selected when only the global default is discoverable', () => {
    useConfigStore.setState({ providers: [provider('global')], agents: [testAgent('build')], settingsDefaultModel: 'global/global-model' });
    useConfigStore.getState().applyDefaultModelAgentSelection({ projectDefaultModel: 'project/chosen', projectDefaultVariant: 'high' });
    expect(useConfigStore.getState()).toMatchObject({ currentProviderId: 'project', currentModelId: 'chosen', currentVariant: 'high' });
  });

  test('does not turn an unavailable settings read into an empty default', async () => {
    liveAgents = [testAgent('build')];
    persistedOpenChamberSettings = null;
    useConfigStore.setState({ settingsDefaultModel: 'sidecar/default' });

    await useConfigStore.getState().loadProviders({ directory: DIRECTORY, source: 'test:settings-unavailable' });
    await useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:settings-unavailable' });

    expect(useConfigStore.getState().settingsDefaultModel).toBe('sidecar/default');

    persistedOpenChamberSettings = { defaultModel: 'live/live-model' };
    await useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:settings-retry' });

    expect(useConfigStore.getState().settingsDefaultModel).toBe('live/live-model');
    expect(settingsLoadCalls).toBe(2);
  });

  test('a project default carries its own thinking level', async () => {
    // The project pins a model plus the level to run it at. Before, the level
    // was dropped and only the global settings variant was ever considered —
    // and that one belongs to the global model, not this project's.
    const projectProvider = provider('anthropic', 'claude-opus-5', ['high', 'low']);
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [projectProvider],
      agents: [testAgent('build')],
      currentProviderId: '',
      currentModelId: '',
      currentVariant: undefined,
      settingsDefaultModel: undefined,
      settingsDefaultVariant: 'low',
      selectionSource: 'auto',
      directoryScoped: {},
    });

    useConfigStore.getState().applyDefaultModelAgentSelection({
      projectDefaultModel: 'anthropic/claude-opus-5',
      projectDefaultVariant: 'high',
    });

    const state = useConfigStore.getState();
    expect(state.currentProviderId).toBe('anthropic');
    expect(state.currentModelId).toBe('claude-opus-5');
    expect(state.currentVariant).toBe('high');
  });

  test('a project default agent overrides the global default agent for fresh drafts', () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5')],
      agents: [testAgent('build'), testAgent('plan')],
      currentProviderId: '',
      currentModelId: '',
      currentVariant: undefined,
      settingsDefaultAgent: 'build',
      settingsDefaultModel: 'openai/gpt-5.5',
      selectionSource: 'auto',
      directoryScoped: {},
    });

    useConfigStore.getState().applyDefaultModelAgentSelection({ projectDefaultAgent: 'plan' });

    expect(useConfigStore.getState().currentAgentName).toBe('plan');
  });

  test('an unknown project default agent falls back to the global default agent', () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5')],
      agents: [testAgent('build'), testAgent('plan')],
      currentProviderId: '',
      currentModelId: '',
      currentVariant: undefined,
      settingsDefaultAgent: 'build',
      settingsDefaultModel: 'openai/gpt-5.5',
      selectionSource: 'auto',
      directoryScoped: {},
    });

    useConfigStore.getState().applyDefaultModelAgentSelection({ projectDefaultAgent: 'missing' });

    expect(useConfigStore.getState().currentAgentName).toBe('build');
  });

  test('a fresh session applies the settings thinking level instead of the previous override', () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5', ['low', 'high'])],
      agents: [testAgent('build')],
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.5',
      currentVariant: 'low',
      currentVariantSelection: { override: 'low', inherited: 'high' },
      settingsDefaultModel: 'openai/gpt-5.5',
      settingsDefaultVariant: 'high',
      selectionSource: 'manual',
      directoryScoped: {},
    });

    useConfigStore.getState().applyDefaultModelAgentSelection();

    const state = useConfigStore.getState();
    expect(state.currentVariant).toBe('high');
    expect(state.currentVariantSelection).toEqual({ override: undefined, inherited: 'high' });
    expect(state.directoryScoped[DIRECTORY]?.currentVariant).toBe('high');
  });

  test('a thinking level the project model does not offer is ignored', async () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('anthropic', 'claude-opus-5')],
      agents: [testAgent('build')],
      currentProviderId: '',
      currentModelId: '',
      currentVariant: undefined,
      settingsDefaultModel: undefined,
      settingsDefaultVariant: undefined,
      selectionSource: 'auto',
      directoryScoped: {},
    });

    useConfigStore.getState().applyDefaultModelAgentSelection({
      projectDefaultModel: 'anthropic/claude-opus-5',
      projectDefaultVariant: 'high',
    });

    expect(useConfigStore.getState().currentVariant).toBe(undefined);
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

  test('a fresh agent load re-reads after a request that started before it', async () => {
    const responses = [deferred<TestAgent[]>(), deferred<TestAgent[]>()];
    let calls = 0;
    listAgentsImpl = async () => responses[calls++].promise;
    useConfigStore.setState({ activeDirectoryKey: DIRECTORY });

    const startup = useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:startup' });
    const refresh = useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:catalog', fresh: true });
    responses[0].resolve([testAgent('build')]);
    await startup;
    await Promise.resolve();
    await Promise.resolve();
    responses[1].resolve([testAgent('build'), testAgent('plugin-agent')]);
    await refresh;

    expect(calls).toBe(2);
    expect(useConfigStore.getState().agents.map((agent) => agent.name)).toContain('plugin-agent');
  });

  test('worktree sync config applies only to its own snapshot', () => {
    const worktree = '/workspace/project-worktree';
    storage.set('oc.worktreeProjectMap', JSON.stringify({ [worktree]: DIRECTORY }));
    useConfigStore.setState({
      activeDirectoryKey: worktree,
      providers: [provider('openai', 'gpt-5.5')],
      agents: [testAgent('build'), testAgent('review')],
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.5',
      currentAgentName: 'build',
      selectedProviderId: 'openai',
      selectionSource: 'auto',
      directoryScoped: {
        [worktree]: {
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
    expect(state.directoryScoped[worktree]?.opencodeDefaultAgent).toBe('review');
    expect(state.directoryScoped[DIRECTORY]?.opencodeDefaultAgent).toBeUndefined();
    expect(state.currentAgentName).toBe('review');
  });

  test('sync config does not overwrite a project default agent for auto selection', () => {
    projectsState = {
      activeProjectId: 'project',
      projects: [
        { id: 'project', path: DIRECTORY, label: 'Project', defaultAgent: 'plan' },
        { id: 'other', path: OTHER_DIRECTORY, label: 'Other' },
      ],
    };
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5')],
      agents: [testAgent('build'), testAgent('plan'), testAgent('review')],
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.5',
      currentAgentName: 'plan',
      settingsDefaultAgent: 'build',
      selectedProviderId: 'openai',
      selectionSource: 'auto',
      directoryScoped: {
        [DIRECTORY]: {
          providers: [provider('openai', 'gpt-5.5')],
          agents: [testAgent('build'), testAgent('plan'), testAgent('review')],
          currentProviderId: 'openai',
          currentModelId: 'gpt-5.5',
          currentAgentName: 'plan',
          selectedProviderId: 'openai',
          agentModelSelections: {},
          defaultProviders: {},
          selectionSource: 'auto',
        },
      },
    });

    emitSyncConfigChanged(DIRECTORY, { default_agent: 'review', model: 'openai/gpt-5.5' });

    const state = useConfigStore.getState();
    expect(state.currentAgentName).toBe('plan');
    expect(state.directoryScoped[DIRECTORY]?.currentAgentName).toBe('plan');
  });

  test('sync config defaults do not close the add-provider settings flow', () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5'), provider('anthropic', 'claude')],
      agents: [
        testAgent('build', { model: { providerID: 'anthropic', modelID: 'claude' } }),
        testAgent('review', { model: { providerID: 'openai', modelID: 'gpt-5.5' } }),
      ],
      currentProviderId: 'anthropic',
      currentModelId: 'claude',
      currentAgentName: 'build',
      selectedProviderId: '__add_provider__',
      selectionSource: 'auto',
      directoryScoped: {
        [DIRECTORY]: {
          providers: [provider('openai', 'gpt-5.5'), provider('anthropic', 'claude')],
          agents: [
            testAgent('build', { model: { providerID: 'anthropic', modelID: 'claude' } }),
            testAgent('review', { model: { providerID: 'openai', modelID: 'gpt-5.5' } }),
          ],
          currentProviderId: 'anthropic',
          currentModelId: 'claude',
          currentAgentName: 'build',
          selectedProviderId: '__add_provider__',
          agentModelSelections: {},
          defaultProviders: {},
          selectionSource: 'auto',
        },
      },
    });

    emitSyncConfigChanged(DIRECTORY, { default_agent: 'review', model: 'openai/gpt-5.5' });

    const state = useConfigStore.getState();
    expect(state.currentAgentName).toBe('review');
    expect(state.currentProviderId).toBe('openai');
    expect(state.currentModelId).toBe('gpt-5.5');
    expect(state.selectedProviderId).toBe('__add_provider__');
    expect(state.directoryScoped[DIRECTORY]?.selectedProviderId).toBe('__add_provider__');
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

  test('worktree loadAgents preserves defaults previously applied from its config event', async () => {
    const worktree = '/workspace/project-worktree';
    storage.set('oc.worktreeProjectMap', JSON.stringify({ [worktree]: DIRECTORY }));
    useConfigStore.setState({
      activeDirectoryKey: worktree,
      providers: [provider('openai', 'gpt-5.5')],
      agents: [testAgent('build'), testAgent('review')],
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.5',
      currentAgentName: 'build',
      selectedProviderId: 'openai',
      selectionSource: 'auto',
      directoryScoped: {
        [worktree]: {
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
    await useConfigStore.getState().loadAgents({ directory: worktree, source: 'test:preserveWorktreeDefaults' });

    const state = useConfigStore.getState();
    expect(state.directoryScoped[worktree]?.opencodeDefaultAgent).toBe('review');
    expect(state.directoryScoped[worktree]?.opencodeDefaultModel).toBe('openai/gpt-5.5');
    expect(state.opencodeDefaultAgent).toBe('review');
    expect(state.opencodeDefaultModel).toBe('openai/gpt-5.5');
  });

  test('loadAgents refresh does not overwrite a project default agent with the global default', async () => {
    projectsState = {
      activeProjectId: 'project',
      projects: [
        { id: 'project', path: DIRECTORY, label: 'Project', defaultAgent: 'plan' },
        { id: 'other', path: OTHER_DIRECTORY, label: 'Other' },
      ],
    };
    liveAgents = [testAgent('build'), testAgent('plan')];
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5')],
      agents: [testAgent('build'), testAgent('plan')],
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.5',
      currentAgentName: 'plan',
      settingsDefaultAgent: 'build',
      selectedProviderId: 'openai',
      selectionSource: 'auto',
      directoryScoped: {
        [DIRECTORY]: {
          providers: [provider('openai', 'gpt-5.5')],
          agents: [testAgent('build'), testAgent('plan')],
          currentProviderId: 'openai',
          currentModelId: 'gpt-5.5',
          currentAgentName: 'plan',
          selectedProviderId: 'openai',
          agentModelSelections: {},
          defaultProviders: {},
          selectionSource: 'auto',
        },
      },
    });

    await useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:projectAgentWinsRefresh' });

    const state = useConfigStore.getState();
    expect(state.currentAgentName).toBe('plan');
    expect(state.directoryScoped[DIRECTORY]?.currentAgentName).toBe('plan');
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
      currentVariant: 'high',
      currentVariantSelection: { override: 'high', inherited: 'medium' },
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
          currentVariant: 'low',
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
    expect(state.currentVariantSelection).toEqual({ override: undefined, inherited: 'low' });
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

describe('stale Auto selection', () => {
  const AUTO = { currentProviderId: 'openchamber', currentModelId: 'auto' };

  beforeEach(() => {
    useUIStore.setState({ routingFeatureAvailable: false });
    useRoutingStore.getState().resetForRuntime();
    useConfigStore.setState({ settingsDefaultsLoaded: true });
  });

  test('a manual Auto pick is replaced on providers load when this server has no routing', async () => {
    useConfigStore.setState({ ...AUTO, selectionSource: 'manual' });
    await useConfigStore.getState().loadProviders({ directory: DIRECTORY });
    expect(useConfigStore.getState().currentProviderId).not.toBe('openchamber');
    expect(useConfigStore.getState().currentModelId).not.toBe('auto');
  });

  test('Auto survives while routing readiness is unknown and while it is ready', async () => {
    useUIStore.setState({ routingFeatureAvailable: true });
    useConfigStore.setState({ ...AUTO, selectionSource: 'manual', providers: [provider('live')], providersLoaded: true });
    useConfigStore.getState().dropStaleAutoSelection();
    expect(useConfigStore.getState().currentModelId).toBe('auto');

    useRoutingStore.setState({ loaded: true, available: true, autoReady: true, tokenPresent: true });
    useConfigStore.getState().dropStaleAutoSelection();
    expect(useConfigStore.getState().currentModelId).toBe('auto');
  });

  test('Auto is dropped, and the session pick overwritten, once routing reports not ready', () => {
    useUIStore.setState({ routingFeatureAvailable: true });
    useRoutingStore.setState({ loaded: true, available: true, autoReady: false, tokenPresent: false });
    const sessionId = 'ses_auto';
    useSessionUIStore.setState({ currentSessionId: sessionId });
    useSelectionStore.getState().saveSessionModelSelection(sessionId, 'openchamber', 'auto');
    useConfigStore.setState({ ...AUTO, selectionSource: 'manual', providers: [provider('live')], providersLoaded: true });

    useConfigStore.getState().dropStaleAutoSelection();

    const state = useConfigStore.getState();
    expect(state.currentProviderId).toBe('live');
    expect(state.currentModelId).toBe('live-model');
    expect(state.selectionSource).toBe('auto');
    expect(useSelectionStore.getState().getSessionModelSelection(sessionId)).toEqual({ providerId: 'live', modelId: 'live-model' });
  });
});

describe('getModelMetadata limits', () => {
  test('the running OpenCode limits override the models.dev catalog', () => {
    const live = provider('openai', 'gpt-6-astra');
    live.models[0].limit = { context: 400_000, output: 128_000 };
    useConfigStore.setState({
      providers: [live],
      modelsMetadata: new Map([['openai/gpt-6-astra', {
        id: 'gpt-6-astra',
        providerId: 'openai',
        name: 'GPT-6 Astra',
        limit: { context: 1_050_000, output: 128_000 },
      }]]),
    });

    const metadata = useConfigStore.getState().getModelMetadata('openai', 'gpt-6-astra');
    expect(metadata?.name).toBe('GPT-6 Astra');
    expect(metadata?.limit).toEqual({ context: 400_000, output: 128_000 });
  });

  test('keeps the catalog limits when OpenCode reports no window', () => {
    useConfigStore.setState({
      providers: [provider('custom', 'local')],
      modelsMetadata: new Map([['custom/local', { id: 'local', providerId: 'custom', limit: { context: 32_000, output: 4_000 } }]]),
    });

    expect(useConfigStore.getState().getModelMetadata('custom', 'local')?.limit).toEqual({ context: 32_000, output: 4_000 });
  });
});
