import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Agent, Config } from '@/lib/opencode/model';
import type { ModelMetadata } from '@/types';
import type { DesktopSettings } from '@/lib/desktop';
import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';

const DIRECTORY = '/workspace/project';
const OTHER_DIRECTORY = '/workspace/other';
const STORAGE_KEY = 'config-store';
type TestAgent = { name: string; mode?: string; hidden?: boolean; model?: { providerID?: string; modelID?: string }; variant?: string; options?: { hidden?: boolean } };

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
let probeHealthOptions: Array<{ waitMs?: number } | undefined> = [];
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
  // Older agent files carry `options.hidden`; isAgentHidden reads both spellings.
  ...(options?.options ? { options: options.options } : {}),
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

const opencodeClientModule = await import('@/lib/opencode/client');
mock.module('@/lib/opencode/client', () => ({
  ...opencodeClientModule,
  isOpencodeNotFound: () => false,
  OpencodeApiError: Error,
  normalizeOpencodeError: (operation: string, error: unknown) => new Error(`${operation}: ${String(error)}`),
  opencodeClient: {
    setDirectory: mock(() => undefined),
    getDirectory: mock(() => DIRECTORY),
    getFilesystemHome: async () => '/workspace',
    getSystemInfo: async () => ({ homeDirectory: '/workspace' }),
    checkHealth: () => checkHealthImpl(),
    probeHealth: (options?: { waitMs?: number }) => {
      probeHealthOptions.push(options);
      return probeHealthImpl ? probeHealthImpl() : checkHealthImpl().then((healthy) => (healthy ? 'healthy' : 'unhealthy'));
    },
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
    invalidateAgentList: mock(() => undefined),
  },
}));

mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: mock(() => null),
}));

const runtimeFetchModule = await import('@/lib/runtime-fetch');
mock.module('@/lib/runtime-fetch', () => ({
  ...runtimeFetchModule,
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

const {
  useConfigStore,
  selectConfigAgentsForDirectory,
  selectProvidersForDirectory,
  selectImageOnlyProvidersForDirectory,
  selectCatalogLoadedForDirectory,
  markConfigCatalogStale,
  selectKnownAgent,
  selectKnownCatalogModel,
  invalidateConfigAgentsLoad,
} = await import('./useConfigStore');
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
    probeHealthOptions = [];
    loadSettingsImpl = null;
    setSyncRefs({} as never, { children: new Map(), getState: () => undefined } as never, DIRECTORY);
    useSelectionStore.setState({
      sessionModelSelections: new Map(),
      sessionAgentSelections: new Map(),
      sessionAgentModelSelections: new Map(),
      lastUsedProvider: null,
    });
    useSessionUIStore.setState({ currentSessionId: null, availableWorktreesByProject: new Map() });
    useUIStore.setState({ hiddenModels: [], lastSelectedModel: undefined, lastUsedEfforts: {} });
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

  for (const cached of [false, true]) for (const starting of [false, true]) {
    test(`thinking picked with the automatic model survives switching to a ${cached ? 'cached' : 'new'} ${starting ? 'starting' : 'ready'} worktree`, async () => {
      const worktree = '/workspace/effort-worktree';
      persistedOpenChamberSettings = { defaultModel: 'shared/B', defaultVariant: 'low' };
      await useConfigStore.getState().loadSessionDefaults();
      const fullCatalog = {
        providers: [providerInfo('shared')],
        models: [model('shared', 'B', ['low', 'high'])],
        default: { providerID: 'shared', id: 'B' },
      };
      let worktreeStarting = false;
      getProvidersForConfigImpl = async (directory) => (
        directory === worktree && worktreeStarting
          ? { providers: [], models: [], default: { providerID: 'shared', id: 'B' } }
          : fullCatalog
      );

      if (cached) await useConfigStore.getState().activateDirectory(worktree);
      await useConfigStore.getState().activateDirectory(DIRECTORY);
      expect(useConfigStore.getState()).toMatchObject({ currentModelId: 'B', selectionSource: 'auto' });
      useConfigStore.getState().setCurrentVariantOverride('high', 'low');

      worktreeStarting = starting;
      if (cached) markConfigCatalogStale('provider', worktree);
      await useConfigStore.getState().activateDirectory(worktree, { preserveManualModel: true });
      await useConfigStore.getState().loadProviders({ directory: worktree, source: 'test:effort' });

      const state = useConfigStore.getState();
      expect(state.activeDirectoryKey).toBe(worktree);
      expect(state.currentModelId).toBe('B');
      expect(state.currentVariantSelection.override).toBe('high');
      // The send reads `currentVariant`; it must be the pick, not the settings default.
      expect(state.currentVariant).toBe('high');
    });
  }

  test('a picked effort is what an agent load leaves for the send', async () => {
    persistedOpenChamberSettings = { defaultModel: 'shared/B', defaultVariant: 'low', defaultAgent: 'build' };
    liveAgents = [testAgent('build')];
    getProvidersForConfigImpl = async () => ({
      providers: [providerInfo('shared')],
      models: [model('shared', 'B', ['low', 'high'])],
      default: { providerID: 'shared', id: 'B' },
    });
    await useConfigStore.getState().activateDirectory(DIRECTORY);
    expect(useConfigStore.getState()).toMatchObject({ currentModelId: 'B', currentVariant: 'low' });

    useConfigStore.getState().setCurrentVariantOverride('high', 'low');
    await useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:effort', fresh: true });

    const state = useConfigStore.getState();
    expect(state.currentVariantSelection.override).toBe('high');
    expect(state.currentVariant).toBe('high');
  });

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

  test('image models stay out of the chat catalog, and an image-only provider is kept for Settings', async () => {
    const imageModel = (providerId: string, modelId: string) => Object.assign(model(providerId, modelId), { type: 'image' });
    getProvidersForConfigImpl = async () => ({
      providers: [providerInfo('chat'), providerInfo('mixed'), providerInfo('wawa')],
      models: [model('chat', 'talk'), model('mixed', 'talk'), imageModel('mixed', 'draw'), imageModel('wawa', 'flare')],
      default: { providerID: 'chat', id: 'talk' },
    });
    await useConfigStore.getState().activateDirectory(DIRECTORY);

    const state = useConfigStore.getState();
    expect(state.providers.map((entry) => [entry.id, entry.models.map((item) => item.modelID)])).toEqual([
      ['chat', ['talk']],
      ['mixed', ['talk']],
    ]);
    expect(selectImageOnlyProvidersForDirectory(state, DIRECTORY).map((entry) => [entry.id, entry.models.map((item) => item.modelID)])).toEqual([
      ['wawa', ['flare']],
    ]);
    expect(selectImageOnlyProvidersForDirectory(state, OTHER_DIRECTORY)).toEqual([]);

    useConfigStore.getState().invalidateProviderCache(DIRECTORY);
    expect(selectImageOnlyProvidersForDirectory(useConfigStore.getState(), DIRECTORY)).toEqual([]);
  });

  test('Settings without a project reads the active catalog', () => {
    // No project added: Settings has no directory, and the only catalog
    // loaded is the one for the directory the app is on.
    useConfigStore.setState({ providers: [provider('opencode-go')], directoryScoped: {}, activeDirectoryKey: '/home/user' });
    const state = useConfigStore.getState();
    const providers = state.providers;
    expect(selectProvidersForDirectory(state, null)).toBe(providers);
    expect(selectProvidersForDirectory(state, undefined)).toBe(providers);
    expect(selectProvidersForDirectory(state, OTHER_DIRECTORY)).toEqual([]);
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

  test('hydrates a legacy blob with catalogs for instant paint, refreshes to live data, then writes it slim', async () => {
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

    // A blob from before the slim format still carries catalogs; they are
    // hydrated as-is so the pickers paint instantly on that first cold start.
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

    const rewritten = JSON.parse(storage.get(STORAGE_KEY) ?? '{}');
    expect(rewritten.version).toBe(1);
    expect(rewritten.state.providers).toBeUndefined();
    expect(rewritten.state.directoryScoped[DIRECTORY].providers).toBeUndefined();
    expect(rewritten.state.directoryScoped[OTHER_DIRECTORY].agents).toBeUndefined();
    expect(rewritten.state.directoryScoped[DIRECTORY].currentModelId).toBe('fresh-model');
  });

  test('an upgraded cache with keyed variants cannot break model selection', async () => {
    const inactiveLegacyDirectory = '/workspace/inactive-legacy';
    const legacyProvider = {
      ...provider('legacy', 'legacy-model'),
      models: [{ ...model('legacy', 'legacy-model'), variants: { high: {} } }],
    };
    const validProvider = provider('valid', 'valid-model', ['low']);
    storage.set(STORAGE_KEY, JSON.stringify({
      state: {
        configRuntimeKey: getRuntimeKey(),
        activeDirectoryKey: DIRECTORY,
        providers: [legacyProvider],
        agents: [testAgent('build')],
        currentProviderId: 'legacy',
        currentModelId: 'legacy-model',
        currentVariant: 'high',
        settingsDefaultModel: 'legacy/legacy-model',
        settingsDefaultVariant: 'high',
        directoryScoped: {
          [DIRECTORY]: {
            providers: [legacyProvider],
            providersLoaded: true,
            agents: [testAgent('build')],
            currentProviderId: 'legacy',
            currentModelId: 'legacy-model',
            currentVariant: 'high',
            selectedProviderId: 'legacy',
            currentAgentName: 'build',
            agentModelSelections: {},
            defaultProviders: { legacy: 'legacy-model' },
          },
          [OTHER_DIRECTORY]: {
            providers: [validProvider],
            agents: [],
            currentProviderId: 'valid',
            currentModelId: 'valid-model',
            selectedProviderId: 'valid',
            agentModelSelections: {},
            defaultProviders: { valid: 'valid-model' },
          },
          [inactiveLegacyDirectory]: {
            providers: [legacyProvider],
            providersLoaded: true,
            agents: [testAgent('review')],
            currentProviderId: 'legacy',
            currentModelId: 'legacy-model',
            selectedProviderId: 'legacy',
            currentAgentName: 'review',
            agentModelSelections: {},
            defaultProviders: { legacy: 'legacy-model' },
          },
        },
      },
      version: 0,
    }));

    await useConfigStore.persist.rehydrate();

    const hydrated = useConfigStore.getState();
    hydrated.applyDefaultModelAgentSelection();
    expect(hydrated.providers).toEqual([]);
    expect(hydrated.directoryScoped[DIRECTORY]?.providers).toEqual([]);
    expect(selectCatalogLoadedForDirectory(hydrated, 'models', DIRECTORY)).toBe(false);
    expect(hydrated.directoryScoped[OTHER_DIRECTORY]?.providers).toEqual([validProvider]);
    expect(hydrated.directoryScoped[inactiveLegacyDirectory]?.providers).toEqual([]);
    expect(hydrated.directoryScoped[inactiveLegacyDirectory]?.providersLoaded).toBe(false);
    expect(hydrated.directoryScoped[inactiveLegacyDirectory]?.agents).toEqual([testAgent('review')]);
    expect(hydrated.agents).toEqual([testAgent('build')]);
    expect(hydrated.currentProviderId).toBe('legacy');
    expect(hydrated.currentVariant).toBe('high');
    expect(useConfigStore.getState().getCurrentModelVariants()).toEqual([]);

    liveProviderId = 'legacy';
    liveProviderVariants = ['high'];
    await useConfigStore.getState().loadProviders({ directory: DIRECTORY });

    const refreshed = useConfigStore.getState();
    expect(refreshed.providersLoaded).toBe(true);
    expect(refreshed.getCurrentModelVariants()).toEqual(['high']);
    expect(refreshed.currentVariant).toBe('high');
    expect(refreshed.directoryScoped[OTHER_DIRECTORY]?.providers).toEqual([validProvider]);
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
      settingsDefaultModel: 'openai/gpt-5.5',
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

  test('following a session agent switch keeps Auto and the effort on screen', () => {
    useSessionUIStore.setState({ currentSessionId: 'ses_follow_agent' });
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5', ['low', 'high'])],
      agents: [testAgent('plan', { model: { providerID: 'openai', modelID: 'gpt-5.5' } })],
      currentProviderId: 'openchamber',
      currentModelId: 'auto',
      currentVariant: 'low',
      currentVariantSelection: { override: 'low', inherited: undefined },
      directoryScoped: {},
    });

    useConfigStore.getState().setAgent('plan', { keepModel: true });

    const state = useConfigStore.getState();
    expect(state.currentAgentName).toBe('plan');
    expect([state.currentProviderId, state.currentModelId, state.currentVariant]).toEqual(['openchamber', 'auto', 'low']);
    expect(useSelectionStore.getState().getSessionAgentSelection('ses_follow_agent')).toBe('plan');
  });

  test('a model without a variants list reads as having no thinking levels', () => {
    const withoutVariants = provider('openai', 'gpt-legacy');
    // A stored snapshot or a live catalog can carry a model without `variants`.
    Reflect.deleteProperty(withoutVariants.models[0], 'variants');
    useConfigStore.setState({
      providers: [withoutVariants],
      currentProviderId: 'openai',
      currentModelId: 'gpt-legacy',
      currentVariant: 'high',
      currentVariantSelection: { override: undefined, inherited: 'high' },
      directoryScoped: {},
    });

    expect(useConfigStore.getState().getCurrentModelVariants()).toEqual([]);
    // Cycling reads the same list; it must not throw on the missing field.
    useConfigStore.getState().cycleCurrentVariant();
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

  test('cycleCurrentVariant remembers the chosen level without a send', () => {
    useConfigStore.setState({
      providers: [provider('openai', 'gpt-5.6-sol', ['low', 'high'])],
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.6-sol',
      currentVariant: undefined,
      currentVariantSelection: { override: undefined, inherited: undefined },
      directoryScoped: {},
    });
    useUIStore.setState({ lastUsedEfforts: {} });

    const next = useConfigStore.getState().cycleCurrentVariant();

    expect(next).toBe('low');
    expect(useUIStore.getState().lastUsedEfforts).toEqual({ 'openai/gpt-5.6-sol': 'low' });

    // Cycling all the way to Default stores the explicit Default sentinel.
    useConfigStore.setState({ currentVariant: 'low', currentVariantSelection: { override: 'low', inherited: undefined } });
    expect(useConfigStore.getState().cycleCurrentVariant()).toBe('high');
    expect(useConfigStore.getState().cycleCurrentVariant()).toBeUndefined();
    expect(useUIStore.getState().lastUsedEfforts).toEqual({ 'openai/gpt-5.6-sol': null });
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
      settingsDefaultModel: 'openai/gpt-5.5',
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
      settingsDefaultModel: 'openai/gpt-5.5',
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
      settingsDefaultModel: 'openai/gpt-5.5',
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

  test('[issue-4601] the settings effort stays with the settings model', () => {
    const sessionId = 'ses_4601_settings_effort';
    useSessionUIStore.setState({ currentSessionId: sessionId });
    useSelectionStore.getState().saveAgentModelForSession(sessionId, 'plan', 'openai', 'gpt-5.5');
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5', ['low', 'high'])],
      agents: [testAgent('plan')],
      settingsDefaultModel: 'openai/other-model',
      settingsDefaultVariant: 'high',
      currentProviderId: 'openai',
      currentModelId: 'other-model',
      currentVariant: undefined,
      directoryScoped: {},
    });

    useConfigStore.getState().setAgent('plan');

    const state = useConfigStore.getState();
    expect(state.currentModelId).toBe('gpt-5.5');
    expect(state.currentVariant).toBe(undefined);
    expect(state.currentVariantSelection).toEqual({ override: undefined, inherited: undefined });
    expect(state.getDefaultVariantForModel('openai', 'other-model')).toBe('high');
    expect(state.getDefaultVariantForModel('openai', 'gpt-5.5')).toBe(undefined);
  });

  test('a new draft starts on the level its model was last sent with', () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5', ['low', 'high'])],
      agents: [testAgent('build')],
      settingsDefaultModel: 'openai/gpt-5.5',
      currentProviderId: '',
      currentModelId: '',
      currentVariant: undefined,
      directoryScoped: {},
    });
    useUIStore.setState({ lastUsedEfforts: { 'openai/gpt-5.5': 'high' } });

    useConfigStore.getState().applyDefaultModelAgentSelection();

    const state = useConfigStore.getState();
    expect(state.currentModelId).toBe('gpt-5.5');
    expect(state.currentVariant).toBe('high');
    expect(state.currentVariantSelection).toEqual({ override: undefined, inherited: 'high' });
    // Remembered is not configured: the model's configured level is still unset.
    expect(state.getDefaultVariantForModel('openai', 'gpt-5.5')).toBeUndefined();
  });

  test('a configured level for the default model wins over the remembered one', () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5', ['low', 'high'])],
      agents: [testAgent('build')],
      settingsDefaultModel: 'openai/gpt-5.5',
      settingsDefaultVariant: 'low',
      currentProviderId: '',
      currentModelId: '',
      currentVariant: undefined,
      directoryScoped: {},
    });
    useUIStore.setState({ lastUsedEfforts: { 'openai/gpt-5.5': 'high' } });

    useConfigStore.getState().applyDefaultModelAgentSelection();

    expect(useConfigStore.getState().currentVariant).toBe('low');
    expect(useConfigStore.getState().currentVariantSelection).toEqual({ override: undefined, inherited: 'low' });
  });

  test('an agent pin for the default model wins over the remembered level', () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5', ['low', 'high'])],
      agents: [testAgent('plan', {
        model: { providerID: 'openai', modelID: 'gpt-5.5' },
        variant: 'low',
      })],
      settingsDefaultModel: 'openai/gpt-5.5',
      settingsDefaultAgent: 'plan',
      currentProviderId: '',
      currentModelId: '',
      currentVariant: undefined,
      directoryScoped: {},
    });
    useUIStore.setState({ lastUsedEfforts: { 'openai/gpt-5.5': 'high' } });

    useConfigStore.getState().applyDefaultModelAgentSelection();

    expect(useConfigStore.getState().currentVariant).toBe('low');
    expect(useConfigStore.getState().currentVariantSelection).toEqual({ override: undefined, inherited: 'low' });
  });

  test('an explicit Default remembered for a model is kept as a choice', () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5', ['low', 'high'])],
      agents: [testAgent('build')],
      settingsDefaultModel: 'openai/gpt-5.5',
      currentProviderId: '',
      currentModelId: '',
      currentVariant: undefined,
      directoryScoped: {},
    });
    useUIStore.setState({ lastUsedEfforts: { 'openai/gpt-5.5': null } });

    useConfigStore.getState().applyDefaultModelAgentSelection();

    const state = useConfigStore.getState();
    expect(state.currentVariant).toBeUndefined();
    expect(state.currentVariantSelection).toEqual({ override: undefined, inherited: null });
  });

  test('a remembered level the model no longer offers is ignored', () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5', ['low', 'high'])],
      agents: [testAgent('build')],
      settingsDefaultModel: 'openai/gpt-5.5',
      currentProviderId: '',
      currentModelId: '',
      currentVariant: undefined,
      directoryScoped: {},
    });
    useUIStore.setState({ lastUsedEfforts: { 'openai/gpt-5.5': 'removed' } });

    useConfigStore.getState().applyDefaultModelAgentSelection();

    const state = useConfigStore.getState();
    expect(state.currentVariant).toBeUndefined();
    // Not lowercased into an explicit Default the user never picked.
    expect(state.currentVariantSelection).toEqual({ override: undefined, inherited: undefined });
  });

  test('[issue-4601] a remembered level never moves to another model', () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [{
        ...provider('openai', 'model-a', ['low', 'high']),
        models: [
          provider('openai', 'model-a', ['low', 'high']).models[0],
          provider('openai', 'model-b', ['low', 'high']).models[0],
        ],
      }],
      agents: [testAgent('plan', { model: { providerID: 'openai', modelID: 'model-b' } })],
      currentProviderId: 'openai',
      currentModelId: 'model-a',
      currentAgentName: 'build',
      currentVariant: undefined,
      directoryScoped: {},
    });
    useUIStore.setState({ lastUsedEfforts: { 'openai/model-a': 'high' } });

    useConfigStore.getState().setAgent('plan');

    const state = useConfigStore.getState();
    expect(state.currentModelId).toBe('model-b');
    expect(state.currentVariant).toBeUndefined();
    expect(state.currentVariantSelection).toEqual({ override: undefined, inherited: undefined });
  });

  test('setAgent uses the remembered level for the agent-pinned model', () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5', ['low', 'high'])],
      agents: [testAgent('plan', { model: { providerID: 'openai', modelID: 'gpt-5.5' } })],
      currentProviderId: 'openai',
      currentModelId: 'gpt-5.5',
      currentAgentName: 'build',
      currentVariant: undefined,
      directoryScoped: {},
    });
    useUIStore.setState({ lastUsedEfforts: { 'openai/gpt-5.5': 'high' } });

    useConfigStore.getState().setAgent('plan');

    const state = useConfigStore.getState();
    expect(state.currentVariant).toBe('high');
    expect(state.currentVariantSelection).toEqual({ override: undefined, inherited: 'high' });
  });

  test('[issue-4601] an agent effort stays with the agent model', () => {
    const sessionId = 'ses_4601_agent_effort';
    useSessionUIStore.setState({ currentSessionId: sessionId });
    useSelectionStore.getState().saveAgentModelForSession(sessionId, 'plan', 'openai', 'gpt-5.5');
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5', ['low', 'high'])],
      agents: [testAgent('plan', { model: { providerID: 'openai', modelID: 'pinned' }, variant: 'high' })],
      currentProviderId: 'openai',
      currentModelId: 'other-model',
      currentVariant: undefined,
      directoryScoped: {},
    });

    useConfigStore.getState().setAgent('plan');

    expect(useConfigStore.getState().currentModelId).toBe('gpt-5.5');
    expect(useConfigStore.getState().currentVariant).toBe(undefined);
  });

  test('[issue-4601] a model switch drops the effort picked for the previous model', () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [{
        ...provider('openai', 'model-a', ['low', 'high']),
        models: [
          provider('openai', 'model-a', ['low', 'high']).models[0],
          provider('openai', 'model-b', ['low', 'high']).models[0],
        ],
      }],
      currentProviderId: 'openai',
      currentModelId: 'model-a',
      currentVariant: 'high',
      currentVariantSelection: { override: 'high', inherited: undefined },
      directoryScoped: {},
    });

    useConfigStore.getState().setModel('model-a');
    expect(useConfigStore.getState().currentVariantSelection.override).toBe('high');

    useConfigStore.getState().setModel('model-b');
    const afterPick = useConfigStore.getState();
    expect(afterPick.currentVariant).toBe(undefined);
    expect(afterPick.currentVariantSelection).toEqual({ override: undefined, inherited: undefined });
    expect(afterPick.directoryScoped[DIRECTORY]?.currentVariantSelection).toEqual({ override: undefined, inherited: undefined });

    // An explicit Default is a pick for one model too.
    useConfigStore.getState().setCurrentVariantOverride(null, undefined);
    useConfigStore.getState().setModel('model-a');
    expect(useConfigStore.getState().currentVariantSelection.override).toBe(undefined);
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

  test('startup asks the server to hold the health answer until OpenCode is ready', async () => {
    let probes = 0;
    probeHealthImpl = async () => (++probes < 2 ? 'unhealthy' : 'healthy');
    await useConfigStore.getState().checkConnection();

    expect(useConfigStore.getState().isConnected).toBe(true);
    expect(probeHealthOptions.length).toBe(2);
    expect(probeHealthOptions.every((options) => (options?.waitMs ?? 0) > 0)).toBe(true);
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

  test('agent invalidation supersedes the config store load already in flight', async () => {
    const staleAgents = deferred<TestAgent[]>();
    let calls = 0;
    listAgentsImpl = async () => {
      calls += 1;
      if (calls === 1) return staleAgents.promise;
      return [{ name: 'new-agent', mode: 'primary' }];
    };

    const staleLoad = useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:stale' });
    await Promise.resolve();
    expect(calls).toBe(1);

    invalidateConfigAgentsLoad(DIRECTORY);
    const freshLoad = useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:fresh' });
    staleAgents.resolve([{ name: 'old-agent', mode: 'primary' }]);

    expect(calls).toBe(2);
    expect(await staleLoad).toBe(true);
    expect(await freshLoad).toBe(true);
    expect(selectConfigAgentsForDirectory(useConfigStore.getState(), DIRECTORY).map((entry) => entry.name))
      .toEqual(['new-agent']);
  });

  test('a caller that joined an agent load before invalidation gets the replacement list', async () => {
    const staleAgents = deferred<TestAgent[]>();
    let calls = 0;
    listAgentsImpl = async () => {
      calls += 1;
      if (calls === 1) return staleAgents.promise;
      return [{ name: 'new-agent', mode: 'primary' }];
    };

    const ownerLoad = useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:owner' });
    const joinedLoad = useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:joined' });
    await Promise.resolve();
    expect(calls).toBe(1);

    invalidateConfigAgentsLoad(DIRECTORY);
    staleAgents.resolve([{ name: 'old-agent', mode: 'primary' }]);

    expect(await ownerLoad).toBe(true);
    expect(await joinedLoad).toBe(true);
    expect(selectConfigAgentsForDirectory(useConfigStore.getState(), DIRECTORY).map((entry) => entry.name))
      .toEqual(['new-agent']);
  });

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

  test('the startup agent recheck still discovers agents in the same runtime', async () => {
    liveAgents = [testAgent('build')];
    switchRuntimeEndpoint({ apiBaseUrl: 'https://recheck-current.example', runtimeKey: 'recheck-current' });
    await useConfigStore.getState().initializeApp();
    expect(useConfigStore.getState().agents.map((agent) => agent.name)).toEqual(['build']);

    liveAgents = [testAgent('build'), testAgent('plugin-agent')];
    await new Promise((resolve) => setTimeout(resolve, 8_100));
    expect(useConfigStore.getState().directoryScoped[DIRECTORY]?.agents.map((agent) => agent.name)).toEqual(['build', 'plugin-agent']);
  }, 12_000);

  test('the startup agent recheck survives a transport change for the same instance', async () => {
    liveAgents = [testAgent('build')];
    switchRuntimeEndpoint({ apiBaseUrl: 'https://transport-one.example', runtimeKey: 'same-device' });
    await useConfigStore.getState().initializeApp();
    expect(useConfigStore.getState().agents.map((agent) => agent.name)).toEqual(['build']);

    // Mobile rebinds the SDK for LAN/relay changes without initializing again.
    switchRuntimeEndpoint({ apiBaseUrl: 'https://transport-two.example', runtimeKey: 'same-device' });
    liveAgents = [testAgent('build'), testAgent('plugin-agent')];
    await new Promise((resolve) => setTimeout(resolve, 8_100));
    expect(useConfigStore.getState().directoryScoped[DIRECTORY]?.agents.map((agent) => agent.name)).toEqual(['build', 'plugin-agent']);
  }, 12_000);

  for (const returnToFirstRuntime of [false, true]) {
    test(`the startup agent recheck cannot outlive its runtime${returnToFirstRuntime ? ' after a round trip' : ''}`, async () => {
      liveAgents = [testAgent('build')];
      switchRuntimeEndpoint({ apiBaseUrl: 'https://recheck-a.example', runtimeKey: 'recheck-a' });
      await useConfigStore.getState().initializeApp();
      expect(useConfigStore.getState().agents.map((agent) => agent.name)).toEqual(['build']);

      switchRuntimeEndpoint({ apiBaseUrl: 'https://recheck-b.example', runtimeKey: 'recheck-b' });
      if (returnToFirstRuntime) {
        switchRuntimeEndpoint({ apiBaseUrl: 'https://recheck-a.example', runtimeKey: 'recheck-a' });
      }
      const callsAfterSwitch = listAgentsCalls;
      // Wait beyond the delayed startup recheck. It must neither start a
      // location on the new runtime nor seed that runtime's directory catalog.
      await new Promise((resolve) => setTimeout(resolve, 8_100));
      expect(listAgentsCalls).toBe(callsAfterSwitch);
      expect(useConfigStore.getState().directoryScoped).toEqual({});
    }, 12_000);
  }

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

  test('a fresh provider load reads again instead of joining an older read', async () => {
    // Opening a worktree starts a read while OpenCode has not registered its
    // plugin providers yet; `provider.updated` then asks for a fresh read.
    const stale = deferred<TestProviderResponse>();
    let calls = 0;
    getProvidersForConfigImpl = () => ++calls === 1 ? stale.promise : Promise.resolve(providerResponse('plugin'));

    const first = useConfigStore.getState().loadProviders({ directory: DIRECTORY });
    const joined = useConfigStore.getState().loadProviders({ directory: DIRECTORY });
    const fresh = useConfigStore.getState().loadProviders({ directory: DIRECTORY, fresh: true });
    stale.resolve(providerResponse('builtin'));
    await Promise.all([first, joined, fresh]);

    expect(calls).toBe(2);
    expect(useConfigStore.getState().providers.map((entry) => entry.id)).toEqual(['plugin']);
  });

  test('a directory whose providers never loaded is read once more on its own', async () => {
    let calls = 0;
    getProvidersForConfigImpl = async () => {
      calls += 1;
      if (calls <= 3) throw new Error('instance still starting');
      return providerResponse('live');
    };

    await useConfigStore.getState().loadProviders({ directory: DIRECTORY });
    expect(useConfigStore.getState().providersLoaded).toBe(false);

    const deadline = Date.now() + 5000;
    while (!useConfigStore.getState().providersLoaded && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(calls).toBe(4);
    expect(useConfigStore.getState().providersLoaded).toBe(true);
    expect(useConfigStore.getState().providers.map((entry) => entry.id)).toEqual(['live']);
  }, 8000);

  // OpenCode answers a directory it is still starting with the providers it has
  // so far; a plugin provider registers later and is announced by an event.
  // When that event lands while another directory is active, only that one is
  // re-read, so returning must not trust the incomplete snapshot.
  const pluginCatalog = () => ({
    providers: [providerInfo('builtin'), providerInfo('plugin')],
    models: [model('builtin', 'builtin-model'), model('plugin', 'plugin-model')],
    default: { providerID: 'builtin', id: 'builtin-model' },
  });
  const catalogIds = () => useConfigStore.getState().providers.map((entry) => entry.id);
  const waitForProviders = async (ids: string[]) => {
    const deadline = Date.now() + 2000;
    while (JSON.stringify(catalogIds()) !== JSON.stringify(ids) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  test('a worktree left while its catalog was incomplete is read again on return', async () => {
    const worktree = '/workspace/starting-worktree';
    let pluginRegistered = false;
    const requested: Array<string | null | undefined> = [];
    getProvidersForConfigImpl = async (directory) => {
      requested.push(directory);
      if (directory === worktree && !pluginRegistered) return providerResponse('builtin', 'builtin-model');
      return pluginCatalog();
    };

    await useConfigStore.getState().activateDirectory(worktree);
    expect(catalogIds()).toEqual(['builtin']);
    await useConfigStore.getState().activateDirectory(DIRECTORY);

    pluginRegistered = true;
    markConfigCatalogStale('provider', worktree);
    await useConfigStore.getState().activateDirectory(worktree);
    await waitForProviders(['builtin', 'plugin']);

    expect(requested.filter((directory) => directory === worktree)).toHaveLength(2);
    expect(catalogIds()).toEqual(['builtin', 'plugin']);
  });

  test('a read that began before the catalog changed does not make the worktree fresh', async () => {
    const worktree = '/workspace/slow-worktree';
    const slowRead = deferred<TestProviderResponse>();
    let reads = 0;
    getProvidersForConfigImpl = async (directory) => {
      if (directory !== worktree) return pluginCatalog();
      reads += 1;
      return reads === 1 ? slowRead.promise : pluginCatalog();
    };

    const activation = useConfigStore.getState().activateDirectory(worktree);
    await new Promise((resolve) => setTimeout(resolve, 0));
    markConfigCatalogStale('provider', worktree);
    slowRead.resolve(providerResponse('builtin', 'builtin-model'));
    await activation;
    await useConfigStore.getState().activateDirectory(DIRECTORY);

    await useConfigStore.getState().activateDirectory(worktree);
    await waitForProviders(['builtin', 'plugin']);

    expect(reads).toBe(2);
    expect(catalogIds()).toEqual(['builtin', 'plugin']);
  });

  test('what other catalogs know fills in for a directory still starting', async () => {
    const worktree = '/workspace/known-catalog-worktree';
    liveAgents = [testAgent('build')];
    getProvidersForConfigImpl = async (directory) => (
      directory === worktree
        ? { providers: [], models: [], default: { providerID: 'builtin', id: 'builtin-model' } }
        : pluginCatalog()
    );
    await useConfigStore.getState().activateDirectory(DIRECTORY);
    liveAgents = [];
    await useConfigStore.getState().activateDirectory(worktree);

    const state = useConfigStore.getState();
    expect(state.providers).toEqual([]);
    expect(selectKnownCatalogModel(state, 'plugin', 'plugin-model')?.name).toBe('plugin-model');
    expect(selectKnownCatalogModel(state, 'plugin', 'missing-model')).toBeUndefined();
    expect(selectKnownAgent(state, 'build')?.name).toBe('build');
    expect(selectKnownAgent(state, 'missing')).toBeUndefined();
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

  test('a new conversation skips a model hidden in the picker when nothing is configured (#1801)', async () => {
    useUIStore.setState({ hiddenModels: [{ providerID: 'opencode', modelID: 'big-pickle' }] });
    useConfigStore.setState({ providers: [provider('opencode', 'big-pickle'), provider('deepseek', 'v4-pro')], agents: [testAgent('build')] });
    useConfigStore.getState().applyDefaultModelAgentSelection();
    expect(useConfigStore.getState()).toMatchObject({ currentProviderId: 'deepseek', currentModelId: 'v4-pro' });

    getProvidersForConfigImpl = async () => ({
      providers: [providerResponse('opencode', 'big-pickle').providers[0], providerResponse('deepseek', 'v4-pro').providers[0]],
      models: [providerResponse('opencode', 'big-pickle').models[0], providerResponse('deepseek', 'v4-pro').models[0]],
      default: { providerID: 'opencode', id: 'big-pickle' },
    });
    useConfigStore.setState({ currentProviderId: '', currentModelId: '' });
    await useConfigStore.getState().loadProviders({ directory: DIRECTORY });
    expect(useConfigStore.getState()).toMatchObject({ currentProviderId: 'deepseek', currentModelId: 'v4-pro' });
  });

  test('a default model the user set stays selected even when hidden in the picker', () => {
    useUIStore.setState({ hiddenModels: [{ providerID: 'opencode', modelID: 'big-pickle' }] });
    useConfigStore.setState({
      providers: [provider('opencode', 'big-pickle'), provider('deepseek', 'v4-pro')],
      agents: [testAgent('build')],
      settingsDefaultModel: 'opencode/big-pickle',
    });
    useConfigStore.getState().applyDefaultModelAgentSelection();
    expect(useConfigStore.getState()).toMatchObject({ currentProviderId: 'opencode', currentModelId: 'big-pickle' });
  });

  test('a new session starts on the model last picked in a chat when nothing is configured (#1801)', async () => {
    const providers = [provider('opencode', 'big-pickle'), provider('deepseek', 'v4-pro')];
    useConfigStore.setState({ providers, agents: [testAgent('build')] });
    useUIStore.getState().setLastSelectedModel('deepseek', 'v4-pro');
    useConfigStore.getState().applyDefaultModelAgentSelection();
    expect(useConfigStore.getState()).toMatchObject({ currentProviderId: 'deepseek', currentModelId: 'v4-pro', selectionSource: 'auto' });

    // After a restart the catalog load lands on it too.
    getProvidersForConfigImpl = async () => ({
      providers: [providerResponse('opencode', 'big-pickle').providers[0], providerResponse('deepseek', 'v4-pro').providers[0]],
      models: [providerResponse('opencode', 'big-pickle').models[0], providerResponse('deepseek', 'v4-pro').models[0]],
      default: { providerID: 'opencode', id: 'big-pickle' },
    });
    useConfigStore.setState({ currentProviderId: '', currentModelId: '' });
    await useConfigStore.getState().loadProviders({ directory: DIRECTORY });
    expect(useConfigStore.getState()).toMatchObject({ currentProviderId: 'deepseek', currentModelId: 'v4-pro' });
  });

  test('the last chat pick survives a provider that has not registered yet', () => {
    useConfigStore.setState({ providers: [provider('opencode', 'big-pickle')], agents: [testAgent('build')] });
    useUIStore.getState().setLastSelectedModel('claude-code', 'opus');
    useConfigStore.getState().applyDefaultModelAgentSelection();
    expect(useConfigStore.getState()).toMatchObject({ currentProviderId: 'claude-code', currentModelId: 'opus' });
  });

  test('anything configured outranks the last chat pick, and a hidden pick is skipped', () => {
    const providers = [provider('opencode', 'big-pickle'), provider('deepseek', 'v4-pro'), provider('anthropic', 'claude')];
    useUIStore.getState().setLastSelectedModel('deepseek', 'v4-pro');

    useConfigStore.setState({ providers, agents: [testAgent('build')], settingsDefaultModel: 'anthropic/claude' });
    useConfigStore.getState().applyDefaultModelAgentSelection();
    expect(useConfigStore.getState().currentModelId).toBe('claude');

    useConfigStore.setState({ settingsDefaultModel: undefined, agents: [testAgent('build', { model: { providerID: 'anthropic', modelID: 'claude' } })] });
    useConfigStore.getState().applyDefaultModelAgentSelection();
    expect(useConfigStore.getState().currentModelId).toBe('claude');

    useConfigStore.setState({ agents: [testAgent('build')], opencodeDefaultModel: 'anthropic/claude' });
    useConfigStore.getState().applyDefaultModelAgentSelection();
    expect(useConfigStore.getState().currentModelId).toBe('claude');

    useConfigStore.setState({ opencodeDefaultModel: undefined });
    useUIStore.setState({ hiddenModels: [{ providerID: 'deepseek', modelID: 'v4-pro' }] });
    useConfigStore.getState().applyDefaultModelAgentSelection();
    expect(useConfigStore.getState()).toMatchObject({ currentProviderId: 'opencode', currentModelId: 'big-pickle' });
  });

  test('with every model hidden a new conversation still gets one', () => {
    useUIStore.setState({ hiddenModels: [{ providerID: 'opencode', modelID: 'big-pickle' }, { providerID: 'deepseek', modelID: 'v4-pro' }] });
    useConfigStore.setState({ providers: [provider('deepseek', 'v4-pro'), provider('opencode', 'big-pickle')], agents: [testAgent('build')] });
    useConfigStore.getState().applyDefaultModelAgentSelection();
    expect(useConfigStore.getState()).toMatchObject({ currentProviderId: 'opencode', currentModelId: 'big-pickle' });
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

  test('sync config applies the explicit model object form, variant included', () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5', ['high', 'xhigh'])],
      agents: [testAgent('build'), testAgent('review')],
      currentProviderId: 'anthropic',
      currentModelId: 'claude',
      currentAgentName: 'build',
      selectedProviderId: 'openai',
      selectionSource: 'auto',
    });

    emitSyncConfigChanged(DIRECTORY, {
      default_agent: 'review',
      model: { providerID: 'openai', model: 'gpt-5.5', variant: 'xhigh' },
    });

    const state = useConfigStore.getState();
    expect(state.opencodeDefaultAgent).toBe('review');
    expect(state.opencodeDefaultModel).toBe('openai/gpt-5.5#xhigh');
    expect(state.directoryScoped[DIRECTORY]?.opencodeDefaultModel).toBe('openai/gpt-5.5#xhigh');
    expect(state.currentProviderId).toBe('openai');
    expect(state.currentModelId).toBe('gpt-5.5');
    expect(state.currentVariant).toBe('xhigh');
    expect(state.currentVariantSelection).toEqual({ override: undefined, inherited: 'xhigh' });
  });

  test('sync config drops a config variant the catalog does not offer', () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5', ['high'])],
      agents: [testAgent('build'), testAgent('review')],
      currentProviderId: 'anthropic',
      currentModelId: 'claude',
      currentAgentName: 'build',
      selectedProviderId: 'openai',
      selectionSource: 'auto',
    });

    emitSyncConfigChanged(DIRECTORY, {
      model: { providerID: 'openai', model: 'gpt-5.5', variant: 'ultra' },
    });

    const state = useConfigStore.getState();
    expect(state.opencodeDefaultModel).toBe('openai/gpt-5.5#ultra');
    expect(state.currentProviderId).toBe('openai');
    expect(state.currentModelId).toBe('gpt-5.5');
    expect(state.currentVariant).toBe(undefined);
  });

  test('loadAgents reads the short string form with a variant', async () => {
    const syncConfigs = new Map<string, Config>([
      [DIRECTORY, { default_agent: 'review', model: 'openai/gpt-5.5#xhigh' }],
    ]);
    // SAFETY: the mock implements only the child-store surface getSyncConfig reads.
    setSyncRefs(
      {} as never,
      {
        children: new Map(),
        getState: (directory: string) => ({ config: syncConfigs.get(directory) ?? {} }),
      } as never,
      DIRECTORY,
    );
    liveAgents = [testAgent('build'), testAgent('review')];
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5', ['high', 'xhigh'])],
      agents: [testAgent('build'), testAgent('review')],
      currentProviderId: 'anthropic',
      currentModelId: 'claude',
      currentAgentName: 'build',
      selectedProviderId: 'openai',
      selectionSource: 'auto',
    });

    await useConfigStore.getState().loadAgents({ directory: DIRECTORY, source: 'test:objectModel' });

    const state = useConfigStore.getState();
    expect(state.opencodeDefaultAgent).toBe('review');
    expect(state.opencodeDefaultModel).toBe('openai/gpt-5.5#xhigh');
    expect(state.directoryScoped[DIRECTORY]?.opencodeDefaultModel).toBe('openai/gpt-5.5#xhigh');
    expect(state.currentProviderId).toBe('openai');
    expect(state.currentModelId).toBe('gpt-5.5');
    expect(state.currentVariant).toBe('xhigh');
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

  test('skips hidden primary agents during fallback selection (both hidden and options.hidden)', () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('live')],
      agents: [
        testAgent('compaction', { mode: 'primary', hidden: true }),
        testAgent('options-hidden', { mode: 'primary', options: { hidden: true } }),
        testAgent('summary', { mode: 'primary', hidden: true }),
        testAgent('custom-agent', { mode: 'primary', hidden: false }),
      ],
      settingsDefaultAgent: undefined,
      opencodeDefaultAgent: undefined,
      currentAgentName: undefined,
    });
    useConfigStore.getState().applyDefaultModelAgentSelection();
    expect(useConfigStore.getState().currentAgentName).toBe('custom-agent');
  });

  // VS Code gives every OpenChamber webview one origin, so each config-store
  // write reaches every webview in every window as a StorageEvent carrying the
  // old and the new value. Persisting the catalogs made each write ~27 MB.
  test('persisted config keeps selections but no provider or agent catalogs', () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('live')],
      agents: [testAgent('build')],
      providersLoaded: true,
      agentsLoaded: true,
      currentProviderId: 'live',
      currentModelId: 'live-model',
      currentAgentName: 'build',
      directoryScoped: {
        [DIRECTORY]: {
          providersLoaded: true,
          agentsLoaded: true,
          providers: [provider('live')],
          agents: [testAgent('build')],
          currentProviderId: 'live',
          currentModelId: 'live-model',
          currentAgentName: 'build',
          selectedProviderId: 'live',
          agentModelSelections: { build: { providerId: 'live', modelId: 'live-model' } },
          defaultProviders: { live: 'live-model' },
        },
        [OTHER_DIRECTORY]: {
          providersLoaded: true,
          agentsLoaded: true,
          providers: [provider('other')],
          agents: [testAgent('review')],
          currentProviderId: 'other',
          currentModelId: 'other-model',
          currentAgentName: 'review',
          selectedProviderId: 'other',
          agentModelSelections: {},
          defaultProviders: { other: 'other-model' },
        },
      },
    });

    const persisted = JSON.parse(storage.get(STORAGE_KEY) ?? '{}');
    expect(persisted.state.providers).toBeUndefined();
    expect(persisted.state.agents).toBeUndefined();
    for (const directory of [DIRECTORY, OTHER_DIRECTORY]) {
      const snapshot = persisted.state.directoryScoped[directory];
      expect(snapshot.providers).toBeUndefined();
      expect(snapshot.agents).toBeUndefined();
      expect(snapshot.providersLoaded).toBeUndefined();
      expect(snapshot.agentsLoaded).toBeUndefined();
    }
    expect(persisted.state.currentProviderId).toBe('live');
    expect(persisted.state.directoryScoped[DIRECTORY].currentAgentName).toBe('build');
    expect(persisted.state.directoryScoped[DIRECTORY].agentModelSelections).toEqual({ build: { providerId: 'live', modelId: 'live-model' } });
    expect(persisted.state.directoryScoped[OTHER_DIRECTORY].currentModelId).toBe('other-model');
    expect(persisted.state.directoryScoped[OTHER_DIRECTORY].defaultProviders).toEqual({ other: 'other-model' });
  });

  // Builds without the slim format read `snapshot.agents.find` straight away;
  // a newer version makes them skip this blob (no migrate) instead of crashing.
  test('persisted config is written as version 1', () => {
    useConfigStore.setState({ activeDirectoryKey: DIRECTORY, currentModelId: 'live-model' });

    const persisted = JSON.parse(storage.get(STORAGE_KEY) ?? '{}');
    expect(persisted.version).toBe(1);
  });

  test('a persisted snapshot without catalogs hydrates its selections and empty catalogs', async () => {
    storage.set(STORAGE_KEY, JSON.stringify({
      state: {
        configRuntimeKey: getRuntimeKey(),
        activeDirectoryKey: DIRECTORY,
        directoryScoped: {
          [DIRECTORY]: {
            currentProviderId: 'stale',
            currentModelId: 'stale-model',
            currentAgentName: 'build',
            selectedProviderId: 'stale',
            agentModelSelections: {},
            defaultProviders: { stale: 'stale-model' },
          },
          [OTHER_DIRECTORY]: {
            currentProviderId: 'other-stale',
            currentModelId: 'other-stale-model',
            currentAgentName: 'review',
            selectedProviderId: 'other-stale',
            agentModelSelections: {},
            defaultProviders: {},
          },
        },
        currentProviderId: 'stale',
        currentModelId: 'stale-model',
      },
      version: 0,
    }));

    await useConfigStore.persist.rehydrate();

    const hydrated = useConfigStore.getState();
    expect(hydrated.directoryScoped[DIRECTORY]?.providers).toEqual([]);
    expect(hydrated.directoryScoped[DIRECTORY]?.agents).toEqual([]);
    expect(hydrated.directoryScoped[OTHER_DIRECTORY]?.providers).toEqual([]);
    expect(hydrated.directoryScoped[OTHER_DIRECTORY]?.currentAgentName).toBe('review');
    expect(hydrated.directoryScoped[DIRECTORY]?.currentModelId).toBe('stale-model');
    // A snapshot without catalogs is not a legacy cache with incompatible
    // variants, so its defaults survive.
    expect(hydrated.directoryScoped[DIRECTORY]?.defaultProviders).toEqual({ stale: 'stale-model' });
    expect(hydrated.defaultProviders).toEqual({ stale: 'stale-model' });
    expect(selectCatalogLoadedForDirectory(hydrated, 'models', DIRECTORY)).toBe(false);

    liveProviderId = 'fresh';
    await hydrated.initializeApp();

    const reloaded = useConfigStore.getState();
    expect(reloaded.providers.map((entry) => entry.id)).toEqual(['fresh']);
    expect(reloaded.directoryScoped[DIRECTORY]?.providers.map((entry) => entry.id)).toEqual(['fresh']);
  });

  describe('setters write config-store only when the selection changes', () => {
    afterEach(() => {
      storage = new Map<string, string>();
    });

    class CountingMap extends Map<string, string> {
      configWrites = 0;

      override set(key: string, value: string) {
        if (key === STORAGE_KEY) this.configWrites += 1;
        return super.set(key, value);
      }
    }

    const settledSelection = () => {
      useConfigStore.setState({
        activeDirectoryKey: DIRECTORY,
        providers: [provider('live')],
        agents: [testAgent('build')],
        currentProviderId: 'live',
        currentModelId: 'live-model',
        currentAgentName: 'build',
        agentSelectionSource: 'manual',
        selectionSource: 'manual',
        directoryScoped: {
          [DIRECTORY]: {
            providers: [provider('live')],
            agents: [testAgent('build')],
            currentProviderId: 'live',
            currentModelId: 'live-model',
            currentAgentName: 'build',
            agentSelectionSource: 'manual',
            selectionSource: 'manual',
            selectedProviderId: 'live',
            agentModelSelections: {},
            defaultProviders: {},
          },
        },
      });
      const counting = new CountingMap(storage);
      storage = counting;
      return counting;
    };

    test('setModel with the current model', () => {
      const counting = settledSelection();
      useConfigStore.getState().setModel('live-model');
      expect(counting.configWrites).toBe(0);
    });

    test('setProvider with the current provider and model', () => {
      const counting = settledSelection();
      useConfigStore.getState().setProvider('live');
      expect(counting.configWrites).toBe(0);
    });

    test('setAgent with the current agent', () => {
      const counting = settledSelection();
      useConfigStore.getState().setAgent('build');
      expect(counting.configWrites).toBe(0);
      expect(useConfigStore.getState().currentModelId).toBe('live-model');
    });

    test('setAgent with the current agent pinned to the current model', () => {
      const pinned = testAgent('build', { model: { providerID: 'live', modelID: 'live-model' } });
      const counting = settledSelection();
      useConfigStore.setState((state) => ({
        agents: [pinned],
        selectionSource: 'auto',
        currentVariantSelection: { override: undefined, inherited: undefined },
        directoryScoped: {
          [DIRECTORY]: { ...state.directoryScoped[DIRECTORY], agents: [pinned], selectionSource: 'auto' },
        },
      }));
      counting.configWrites = 0;
      useConfigStore.getState().setAgent('build');
      expect(counting.configWrites).toBe(0);
      expect(useConfigStore.getState().currentModelId).toBe('live-model');
      expect(useConfigStore.getState().selectionSource).toBe('auto');
    });

    test('setModel with another model writes it', () => {
      const counting = settledSelection();
      useConfigStore.getState().setModel('other-model');
      expect(counting.configWrites).toBe(1);
      expect(useConfigStore.getState().directoryScoped[DIRECTORY]?.currentModelId).toBe('other-model');
    });

    test('setAgent with another agent writes it', () => {
      const counting = settledSelection();
      useConfigStore.getState().setAgent('review');
      expect(counting.configWrites).toBeGreaterThan(0);
      expect(useConfigStore.getState().directoryScoped[DIRECTORY]?.currentAgentName).toBe('review');
    });

    test('a setter writes when the active directory has no snapshot yet, and creates it', () => {
      const counting = settledSelection();
      useConfigStore.setState({ directoryScoped: {} });
      counting.configWrites = 0;
      useConfigStore.getState().setModel('live-model');
      expect(counting.configWrites).toBe(1);
      expect(useConfigStore.getState().directoryScoped[DIRECTORY]?.currentModelId).toBe('live-model');
    });

    test('a setter writes when the snapshot disagrees with the top-level selection', () => {
      const counting = settledSelection();
      useConfigStore.setState((state) => ({
        directoryScoped: { [DIRECTORY]: { ...state.directoryScoped[DIRECTORY], currentModelId: 'old-model' } },
      }));
      counting.configWrites = 0;
      useConfigStore.getState().setModel('live-model');
      expect(counting.configWrites).toBe(1);
      expect(useConfigStore.getState().directoryScoped[DIRECTORY]?.currentModelId).toBe('live-model');
    });

    test('setAgent(undefined) writes once to clear an agent, then not again', () => {
      const counting = settledSelection();
      useConfigStore.getState().setAgent(undefined);
      expect(counting.configWrites).toBe(1);
      expect(useConfigStore.getState().directoryScoped[DIRECTORY]?.currentAgentName).toBeUndefined();
      expect(useConfigStore.getState().directoryScoped[DIRECTORY]?.agentSelectionSource).toBe('auto');

      counting.configWrites = 0;
      useConfigStore.getState().setAgent(undefined);
      expect(counting.configWrites).toBe(0);
    });
  });

  test('selections round-trip through storage without catalogs, which read as not loaded', async () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('live')],
      agents: [testAgent('build')],
      directoryScoped: {
        [DIRECTORY]: { providers: [provider('live')], agents: [testAgent('build')], currentProviderId: 'live', currentModelId: 'live-model', currentAgentName: undefined, selectedProviderId: 'live', agentModelSelections: {}, defaultProviders: {} },
        [OTHER_DIRECTORY]: { providersLoaded: true, agentsLoaded: true, providers: [provider('other')], agents: [testAgent('review')], currentProviderId: 'other', currentModelId: 'other-model', currentAgentName: 'review', selectedProviderId: 'other', agentModelSelections: {}, defaultProviders: {} },
      },
    });
    useConfigStore.getState().setModel('live-model');
    useConfigStore.getState().setAgent('build');
    const written = storage.get(STORAGE_KEY) ?? '';
    // Clearing the store writes too, so the saved blob is put back before rehydrating.
    useConfigStore.setState({ directoryScoped: {}, providers: [], agents: [], currentModelId: '', currentAgentName: undefined });
    storage.set(STORAGE_KEY, written);

    await useConfigStore.persist.rehydrate();

    const hydrated = useConfigStore.getState();
    expect(hydrated.directoryScoped[DIRECTORY]?.currentModelId).toBe('live-model');
    expect(hydrated.directoryScoped[DIRECTORY]?.currentAgentName).toBe('build');
    expect(hydrated.directoryScoped[OTHER_DIRECTORY]?.currentModelId).toBe('other-model');
    expect(hydrated.directoryScoped[OTHER_DIRECTORY]?.providers).toEqual([]);
    expect(selectCatalogLoadedForDirectory(hydrated, 'models', OTHER_DIRECTORY)).toBe(false);
    expect(selectCatalogLoadedForDirectory(hydrated, 'agents', OTHER_DIRECTORY)).toBe(false);
  });
});

describe('ttsChunkedMode default', () => {
  test('defaults to disabled until the user enables it', () => {
    expect(useConfigStore.getState().ttsChunkedMode).toBe(false);
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

  test('an unavailable Auto default falls back once without retriggering the cleanup', () => {
    useUIStore.setState({ routingFeatureAvailable: true });
    useRoutingStore.setState({ loaded: true, available: true, autoReady: false, tokenPresent: false });
    const sessionId = 'ses_auto_default';
    useSessionUIStore.setState({ currentSessionId: sessionId });
    useSelectionStore.getState().saveSessionModelSelection(sessionId, 'openchamber', 'auto');
    useConfigStore.setState({
      ...AUTO,
      settingsDefaultModel: 'openchamber/auto',
      selectionSource: 'manual',
      providers: [provider('live')],
      providersLoaded: true,
    });
    let updates = 0;
    const unsubscribe = useConfigStore.subscribe(() => {
      updates += 1;
    });

    useConfigStore.getState().dropStaleAutoSelection();
    useConfigStore.getState().dropStaleAutoSelection();
    unsubscribe();

    const state = useConfigStore.getState();
    expect(state.currentProviderId).toBe('live');
    expect(state.currentModelId).toBe('live-model');
    expect(updates).toBe(1);
    expect(useSelectionStore.getState().getSessionModelSelection(sessionId)).toEqual({ providerId: 'live', modelId: 'live-model' });
  });

  test('a fresh draft skips unavailable settings and project Auto defaults', () => {
    useUIStore.setState({ routingFeatureAvailable: true });
    useRoutingStore.setState({ loaded: true, available: true, autoReady: false, tokenPresent: false });
    useConfigStore.setState({
      currentProviderId: '',
      currentModelId: '',
      settingsDefaultModel: 'openchamber/auto',
      providers: [provider('live')],
      agents: [testAgent('build')],
    });

    useConfigStore.getState().applyDefaultModelAgentSelection();
    expect(useConfigStore.getState()).toMatchObject({ currentProviderId: 'live', currentModelId: 'live-model' });

    useConfigStore.setState({ currentProviderId: '', currentModelId: '', settingsDefaultModel: undefined });
    useConfigStore.getState().applyDefaultModelAgentSelection({ projectDefaultModel: 'openchamber/auto' });
    expect(useConfigStore.getState()).toMatchObject({ currentProviderId: 'live', currentModelId: 'live-model' });
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

describe('getModelMetadata release dates', () => {
  test('projects the runtime release date without a metadata catalog', () => {
    const live = provider('agent-openai', 'gpt-6.1-sol');
    live.models[0].time.released = 1790640000000;
    useConfigStore.setState({ providers: [live], modelsMetadata: new Map() });
    expect(useConfigStore.getState()
      .getModelMetadata('agent-openai', 'gpt-6.1-sol')?.release_date)
      .toBe('2026-09-29');
  });

  const invalidReleaseTimes: ReadonlyArray<number | string | null | undefined> = [
    undefined, null, 0, -1, NaN, Infinity, -Infinity,
    '1790640000000', '', Number.MAX_VALUE, 253402300800000,
  ];
  for (const released of invalidReleaseTimes) {
    test(`does not project invalid release time ${String(released)}`, () => {
      const live = provider('custom', 'local');
      Reflect.set(live.models[0].time, 'released', released);
      useConfigStore.setState({ providers: [live], modelsMetadata: new Map() });
      expect(useConfigStore.getState().getModelMetadata('custom', 'local')?.release_date)
        .toBeUndefined();
    });
  }

  test('does not project a release date when the runtime time object is missing', () => {
    const live = provider('custom', 'local');
    Reflect.deleteProperty(live.models[0], 'time');
    useConfigStore.setState({ providers: [live], modelsMetadata: new Map() });
    expect(useConfigStore.getState().getModelMetadata('custom', 'local')?.release_date)
      .toBeUndefined();
  });

  test('does not project a release date when the runtime released field is missing', () => {
    const live = provider('custom', 'local');
    Reflect.deleteProperty(live.models[0].time, 'released');
    useConfigStore.setState({ providers: [live], modelsMetadata: new Map() });
    expect(useConfigStore.getState().getModelMetadata('custom', 'local')?.release_date)
      .toBeUndefined();
  });

  test('projects a UTC midnight timestamp as that calendar day', () => {
    const live = provider('custom', 'local');
    live.models[0].time.released = 1704067200000;
    useConfigStore.setState({ providers: [live], modelsMetadata: new Map() });
    expect(useConfigStore.getState().getModelMetadata('custom', 'local')?.release_date)
      .toBe('2024-01-01');
  });

  test('projects a late UTC day as that calendar day', () => {
    const live = provider('custom', 'local');
    live.models[0].time.released = 1790726399999;
    useConfigStore.setState({ providers: [live], modelsMetadata: new Map() });
    expect(useConfigStore.getState().getModelMetadata('custom', 'local')?.release_date)
      .toBe('2026-09-29');
  });

  test('a valid runtime release date overrides an older exact catalog date when context is zero', () => {
    const live = provider('openai', 'gpt-6-astra');
    live.models[0].time.released = 1790640000000;
    const cached = {
      id: 'gpt-6-astra',
      providerId: 'openai',
      name: 'GPT-6 Astra',
      tool_call: false,
      attachment: true,
      cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      limit: { context: 32_000, output: 4_000 },
      knowledge: '2025-08',
      release_date: '2025-08-01',
      last_updated: '2025-09-01',
    };
    useConfigStore.setState({
      providers: [live],
      modelsMetadata: new Map([['openai/gpt-6-astra', cached]]),
    });

    const metadata = useConfigStore.getState().getModelMetadata('openai', 'gpt-6-astra');

    expect(metadata?.release_date).toBe('2026-09-29');
    expect(metadata?.limit).toEqual({ context: 32_000, output: 4_000 });
    expect(metadata?.cost).toEqual(cached.cost);
    expect(metadata?.tool_call).toBe(false);
    expect(metadata?.attachment).toBe(true);
    expect(metadata?.knowledge).toBe('2025-08');
    expect(metadata?.name).toBe('GPT-6 Astra');
    expect(cached.release_date).toBe('2025-08-01');
    expect(cached.limit).toEqual({ context: 32_000, output: 4_000 });
  });

  test('a valid runtime release date overrides an older exact catalog date when context is positive', () => {
    const live = provider('openai', 'gpt-6-astra');
    live.models[0].time.released = 1790640000000;
    live.models[0].limit = { context: 400_000, output: 128_000 };
    const cached = {
      id: 'gpt-6-astra',
      providerId: 'openai',
      name: 'GPT-6 Astra',
      tool_call: false,
      attachment: true,
      cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      limit: { context: 1_050_000, output: 128_000 },
      knowledge: '2025-08',
      release_date: '2025-08-01',
      last_updated: '2025-09-01',
    };
    useConfigStore.setState({
      providers: [live],
      modelsMetadata: new Map([['openai/gpt-6-astra', cached]]),
    });

    const metadata = useConfigStore.getState().getModelMetadata('openai', 'gpt-6-astra');

    expect(metadata?.release_date).toBe('2026-09-29');
    expect(metadata?.limit).toEqual({ context: 400_000, output: 128_000 });
    expect(metadata?.cost).toEqual(cached.cost);
    expect(metadata?.tool_call).toBe(false);
    expect(metadata?.attachment).toBe(true);
    expect(metadata?.knowledge).toBe('2025-08');
    expect(metadata?.last_updated).toBe('2025-09-01');
    expect(metadata?.name).toBe('GPT-6 Astra');
    expect(cached.release_date).toBe('2025-08-01');
    expect(cached.limit).toEqual({ context: 1_050_000, output: 128_000 });
  });

  test('an invalid runtime release time keeps the exact catalog date', () => {
    const live = provider('openai', 'gpt-6-astra');
    live.models[0].time.released = 0;
    live.models[0].limit = { context: 400_000, output: 8_000 };
    useConfigStore.setState({
      providers: [live],
      modelsMetadata: new Map([['openai/gpt-6-astra', {
        id: 'gpt-6-astra',
        providerId: 'openai',
        name: 'GPT-6 Astra',
        cost: { input: 3, output: 15 },
        limit: { context: 1_050_000, output: 128_000 },
        release_date: '2025-08-01',
      }]]),
    });

    const metadata = useConfigStore.getState().getModelMetadata('openai', 'gpt-6-astra');

    expect(metadata?.release_date).toBe('2025-08-01');
    expect(metadata?.limit).toEqual({ context: 400_000, output: 8_000 });
    expect(metadata?.cost).toEqual({ input: 3, output: 15 });
  });

  test('a missing runtime time keeps the exact catalog date', () => {
    const live = provider('custom', 'local');
    Reflect.deleteProperty(live.models[0], 'time');
    useConfigStore.setState({
      providers: [live],
      modelsMetadata: new Map([['custom/local', {
        id: 'local',
        providerId: 'custom',
        limit: { context: 32_000, output: 4_000 },
        release_date: '2024-03-01',
      }]]),
    });

    const metadata = useConfigStore.getState().getModelMetadata('custom', 'local');

    expect(metadata?.release_date).toBe('2024-03-01');
    expect(metadata?.limit).toEqual({ context: 32_000, output: 4_000 });
  });

  test('a missing runtime model keeps the exact catalog entry', () => {
    const cached = {
      id: 'local',
      providerId: 'custom',
      name: 'Local',
      limit: { context: 32_000, output: 4_000 },
      cost: { input: 1, output: 2 },
      knowledge: '2024-01',
      release_date: '2024-03-01',
    };
    useConfigStore.setState({
      providers: [],
      modelsMetadata: new Map([['custom/local', cached]]),
    });

    expect(useConfigStore.getState().getModelMetadata('custom', 'local')).toEqual(cached);
  });
});

describe('getModelMetadata descriptive fallback', () => {
  const catalogEntry = (
    providerId: string,
    fields: Partial<ModelMetadata> = {},
  ): ModelMetadata => ({
    id: 'different-entry-id',
    providerId,
    ...fields,
  });

  test('supplements a Fast alias using actual modelID without replacing gateway data', () => {
    const standard = model('agent-openai', 'gpt-6.1-sol');
    const fast = {
      ...standard,
      id: 'gpt-6.1-sol-fast',
      canonical: 'openai',
      name: 'Gateway Fast',
      cost: [{ input: 9, output: 18, cache: { read: 0, write: 7 } }],
      limit: { context: 123000, output: 5000 },
      capabilities: { tools: false, input: ['text'], output: ['text'] },
      time: { released: 1790640000000 },
    };
    const entry: ModelMetadata = {
      id: 'gpt-6.1-sol', providerId: 'openai', name: 'Standard',
      knowledge: '2026-04-30', release_date: '2026-01-01', last_updated: '2026-10-01',
      cost: { input: 1, output: 2, cache_read: 3, cache_write: 4 },
      limit: { context: 1000000, output: 100000 },
      tool_call: true, attachment: true, reasoning: true, temperature: true,
      structured_output: true, modalities: { input: ['text', 'image'], output: ['image'] },
    };
    useConfigStore.setState({
      providers: [{ ...provider('agent-openai'), models: [standard, fast] }],
      modelsMetadata: new Map([['openai/gpt-6.1-sol', entry]]),
    });
    const result = useConfigStore.getState().getModelMetadata('agent-openai', fast.id);
    expect(result).toMatchObject({
      id: 'gpt-6.1-sol', providerId: 'agent-openai', name: 'Gateway Fast',
      knowledge: '2026-04-30', release_date: '2026-09-29', last_updated: '2026-10-01',
      cost: { input: 9, output: 18, cache_read: 0, cache_write: 7 },
      limit: fast.limit, tool_call: false, attachment: false,
      modalities: { input: ['text'], output: ['text'] },
    });
    expect(result?.reasoning).toBeUndefined();
    expect(result?.temperature).toBeUndefined();
    expect(result?.structured_output).toBeUndefined();
  });

  test('uses provider canonical when the model has none', () => {
    const live = provider('agent-openai', 'gpt-6.1-sol');
    useConfigStore.setState({
      providers: [{ ...live, canonical: 'openai' }],
      modelsMetadata: new Map([[
        'openai/gpt-6.1-sol',
        catalogEntry('openai', { knowledge: '2026-04-30', last_updated: '2026-10-01' }),
      ]]),
    });
    const result = useConfigStore.getState().getModelMetadata('agent-openai', 'gpt-6.1-sol');
    expect(result?.knowledge).toBe('2026-04-30');
    expect(result?.last_updated).toBe('2026-10-01');
    expect(result?.providerId).toBe('agent-openai');
    expect(result?.id).toBe('gpt-6.1-sol');
  });

  test('prefers model canonical over a conflicting provider canonical', () => {
    const live = provider('agent-openai', 'gpt-6.1-sol');
    useConfigStore.setState({
      providers: [{
        ...live,
        canonical: 'other',
        models: [{ ...live.models[0], canonical: 'openai' }],
      }],
      modelsMetadata: new Map([
        ['openai/gpt-6.1-sol', catalogEntry('openai', { knowledge: 'from-model' })],
        ['other/gpt-6.1-sol', catalogEntry('other', { knowledge: 'from-provider' })],
      ]),
    });
    expect(useConfigStore.getState().getModelMetadata('agent-openai', 'gpt-6.1-sol')?.knowledge)
      .toBe('from-model');
  });

  test('does not search elsewhere when the explicit canonical entry is missing', () => {
    const live = provider('agent-openai', 'gpt-6.1-sol');
    useConfigStore.setState({
      providers: [{
        ...live,
        canonical: 'openai',
        models: [{ ...live.models[0], canonical: 'declared-missing' }],
      }],
      modelsMetadata: new Map([
        ['openai/gpt-6.1-sol', catalogEntry('openai', { knowledge: 'from-elsewhere' })],
      ]),
    });
    expect(useConfigStore.getState().getModelMetadata('agent-openai', 'gpt-6.1-sol')?.knowledge)
      .toBeUndefined();
  });

  test('matches a canonical provider id with surrounding whitespace', () => {
    const live = provider('agent-openai', 'gpt-6.1-sol');
    useConfigStore.setState({
      providers: [{
        ...live,
        models: [{ ...live.models[0], canonical: '  OpenAI  ' }],
      }],
      modelsMetadata: new Map([[
        'openai/gpt-6.1-sol',
        catalogEntry('openai', { knowledge: '2026-04-30' }),
      ]]),
    });
    expect(useConfigStore.getState().getModelMetadata('agent-openai', 'gpt-6.1-sol')?.knowledge)
      .toBe('2026-04-30');
  });

  test('a blank canonical does not block a unique modelID match', () => {
    const live = provider('agent-openai', 'gpt-6.1-sol');
    useConfigStore.setState({
      providers: [{
        ...live,
        canonical: '   ',
        models: [{ ...live.models[0], canonical: '   ' }],
      }],
      modelsMetadata: new Map([[
        'openai/gpt-6.1-sol',
        catalogEntry('openai', { knowledge: '2026-04-30' }),
      ]]),
    });
    expect(useConfigStore.getState().getModelMetadata('agent-openai', 'gpt-6.1-sol')?.knowledge)
      .toBe('2026-04-30');
  });

  test('uses the canonical release date when runtime time is invalid', () => {
    const live = provider('agent-openai', 'gpt-6.1-sol');
    useConfigStore.setState({
      providers: [{
        ...live,
        models: [{ ...live.models[0], canonical: 'openai', time: { released: 0 } }],
      }],
      modelsMetadata: new Map([[
        'openai/gpt-6.1-sol',
        catalogEntry('openai', {
          knowledge: '2026-04-30',
          release_date: '2026-01-01',
          last_updated: '2026-10-01',
        }),
      ]]),
    });
    const result = useConfigStore.getState().getModelMetadata('agent-openai', 'gpt-6.1-sol');
    expect(result?.release_date).toBe('2026-01-01');
    expect(result?.knowledge).toBe('2026-04-30');
    expect(result?.last_updated).toBe('2026-10-01');
  });

  test('an exact catalog entry wins over canonical metadata', () => {
    const live = provider('agent-openai', 'gpt-6.1-sol');
    const exact = {
      id: 'gpt-6.1-sol',
      providerId: 'agent-openai',
      name: 'Exact custom',
      knowledge: 'exact-knowledge',
      release_date: '2020-01-01',
      cost: { input: 4, output: 5, cache_read: 6, cache_write: 7 },
      limit: { context: 32_000, output: 4_000 },
    };
    useConfigStore.setState({
      providers: [{
        ...live,
        canonical: 'openai',
        models: [{
          ...live.models[0],
          canonical: 'openai',
          time: { released: 1790640000000 },
          limit: { context: 0, output: 0 },
        }],
      }],
      modelsMetadata: new Map<string, ModelMetadata>([
        ['agent-openai/gpt-6.1-sol', exact],
        ['openai/gpt-6.1-sol', catalogEntry('openai', {
          name: 'Canonical',
          knowledge: 'canonical-knowledge',
          release_date: '2024-06-01',
          cost: { input: 1, output: 2 },
          limit: { context: 1_000_000, output: 100_000 },
        })],
      ]),
    });
    const result = useConfigStore.getState().getModelMetadata('agent-openai', 'gpt-6.1-sol');
    expect(result?.knowledge).toBe('exact-knowledge');
    expect(result?.name).toBe('Exact custom');
    expect(result?.release_date).toBe('2026-09-29');
    expect(result?.cost).toEqual(exact.cost);
    expect(result?.limit).toEqual(exact.limit);
    expect(exact.release_date).toBe('2020-01-01');
  });

  test('keeps explicit zero runtime prices when descriptive metadata matches', () => {
    const live = provider('agent-openai', 'gpt-6.1-sol');
    useConfigStore.setState({
      providers: [{
        ...live,
        models: [{
          ...live.models[0],
          canonical: 'openai',
          cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
        }],
      }],
      modelsMetadata: new Map([[
        'openai/gpt-6.1-sol',
        catalogEntry('openai', {
          knowledge: '2026-04-30',
          cost: { input: 1, output: 2, cache_read: 3, cache_write: 4 },
        }),
      ]]),
    });
    const result = useConfigStore.getState().getModelMetadata('agent-openai', 'gpt-6.1-sol');
    expect(result?.knowledge).toBe('2026-04-30');
    expect(result?.cost).toEqual({ input: 0, output: 0, cache_read: 0, cache_write: 0 });
  });

  test('leaves runtime cost missing when the runtime cost list is empty', () => {
    const live = provider('agent-openai', 'gpt-6.1-sol');
    useConfigStore.setState({
      providers: [{
        ...live,
        models: [{ ...live.models[0], canonical: 'openai', cost: [] }],
      }],
      modelsMetadata: new Map([[
        'openai/gpt-6.1-sol',
        catalogEntry('openai', {
          knowledge: '2026-04-30',
          cost: { input: 1, output: 2, cache_read: 3, cache_write: 4 },
        }),
      ]]),
    });
    const result = useConfigStore.getState().getModelMetadata('agent-openai', 'gpt-6.1-sol');
    expect(result?.knowledge).toBe('2026-04-30');
    expect(result?.cost).toBeUndefined();
  });

  test('keeps explicit zero runtime limits from another provider catalog', () => {
    const live = provider('agent-openai', 'gpt-6.1-sol');
    useConfigStore.setState({
      providers: [{
        ...live,
        models: [{
          ...live.models[0],
          canonical: 'openai',
          limit: { context: 0, output: 0 },
        }],
      }],
      modelsMetadata: new Map([[
        'openai/gpt-6.1-sol',
        catalogEntry('openai', {
          knowledge: '2026-04-30',
          limit: { context: 1_000_000, output: 100_000 },
        }),
      ]]),
    });
    const result = useConfigStore.getState().getModelMetadata('agent-openai', 'gpt-6.1-sol');
    expect(result?.knowledge).toBe('2026-04-30');
    expect(result?.limit).toEqual({ context: 0, output: 0 });
  });

  const identityCases = [
    { modelID: 'gpt-6.1-sol', keys: ['openai/gpt-6.1-sol'], matched: true },
    { modelID: 'gpt-6.1-sol', keys: ['openai/gpt-6.1-sol', 'other/gpt-6.1-sol'], matched: false },
    { modelID: 'gpt-6.1-sol-fast', keys: ['openai/gpt-6.1-sol'], matched: false },
    { modelID: 'fast-gpt-6.1-sol', keys: ['openai/gpt-6.1-sol'], matched: false },
    { modelID: 'GPT-6.1-SOL', keys: ['openai/gpt-6.1-sol'], matched: false },
    { modelID: 'vendor/model', keys: ['gateway/vendor/model'], matched: true },
    { modelID: 'model', keys: ['gateway/vendor/model'], matched: false },
  ];

  for (const { modelID, keys, matched } of identityCases) {
    test(`uses complete modelID ${modelID} with ${keys.join(',')}`, () => {
      const live = provider('agent-openai', modelID);
      const entries = keys.map((key): [string, ModelMetadata] => [key, {
        id: 'different-entry-id', providerId: key.slice(0, key.indexOf('/')),
        knowledge: '2026-04-30',
      }]);
      useConfigStore.setState({ providers: [live], modelsMetadata: new Map(entries) });
      expect(useConfigStore.getState().getModelMetadata('agent-openai', modelID)?.knowledge)
        .toBe(matched ? '2026-04-30' : undefined);
    });
  }

  test('keeps runtime identity when the catalog entry id differs', () => {
    const live = provider('agent-openai', 'gpt-6.1-sol');
    const gateway = {
      ...live.models[0],
      name: 'Gateway name',
    };
    useConfigStore.setState({
      providers: [{ ...live, models: [gateway] }],
      modelsMetadata: new Map([['openai/gpt-6.1-sol', {
        id: 'different-entry-id',
        providerId: 'openai',
        name: 'Catalog name',
        knowledge: '2026-04-30',
        tool_call: false,
        attachment: true,
        reasoning: true,
        temperature: true,
        structured_output: true,
        cost: { input: 8, output: 9, cache_read: 1, cache_write: 2 },
        limit: { context: 999, output: 999 },
        modalities: { input: ['text', 'image'], output: ['image'] },
      }]]),
    });
    const result = useConfigStore.getState().getModelMetadata('agent-openai', 'gpt-6.1-sol');
    expect(result).toMatchObject({
      id: 'gpt-6.1-sol',
      providerId: 'agent-openai',
      name: 'Gateway name',
      knowledge: '2026-04-30',
      tool_call: true,
      attachment: false,
      modalities: { input: ['text'], output: ['text'] },
    });
    expect(result?.reasoning).toBeUndefined();
    expect(result?.temperature).toBeUndefined();
    expect(result?.structured_output).toBeUndefined();
  });

  test('does not match an unknown alias by display name or family', () => {
    const live = provider('agent-openai', 'private-alias');
    useConfigStore.setState({
      providers: [{
        ...live,
        models: [{
          ...live.models[0],
          name: 'GPT-6.1 Sol',
          family: 'gpt-6.1-sol',
        }],
      }],
      modelsMetadata: new Map([[
        'openai/gpt-6.1-sol',
        catalogEntry('openai', { name: 'GPT-6.1 Sol', knowledge: '2026-04-30' }),
      ]]),
    });
    expect(useConfigStore.getState().getModelMetadata('agent-openai', 'private-alias')?.knowledge)
      .toBeUndefined();
  });

  test('treats duplicate model ids as unknown in either map order', () => {
    const live = provider('agent-openai', 'gpt-6.1-sol');
    const alpha = catalogEntry('alpha', { knowledge: '2026-04-30' });
    const beta = catalogEntry('beta', { knowledge: '2026-04-30' });
    for (const entries of [
      [['alpha/gpt-6.1-sol', alpha], ['beta/gpt-6.1-sol', beta]],
      [['beta/gpt-6.1-sol', beta], ['alpha/gpt-6.1-sol', alpha]],
    ] as const) {
      useConfigStore.setState({
        providers: [live],
        modelsMetadata: new Map(entries),
      });
      expect(useConfigStore.getState().getModelMetadata('agent-openai', 'gpt-6.1-sol')?.knowledge)
        .toBeUndefined();
    }
  });

  test('does not infer a cross-provider identity when the runtime model is missing', () => {
    useConfigStore.setState({
      providers: [],
      modelsMetadata: new Map([[
        'openai/gpt-6.1-sol',
        catalogEntry('openai', { knowledge: '2026-04-30' }),
      ]]),
    });
    expect(useConfigStore.getState().getModelMetadata('agent-openai', 'gpt-6.1-sol'))
      .toBeUndefined();
  });

  test('keeps an exact entry when the runtime model is missing', () => {
    const exact = {
      id: 'gpt-6.1-sol',
      providerId: 'agent-openai',
      name: 'Exact custom',
      knowledge: 'exact-knowledge',
      release_date: '2020-01-01',
    };
    useConfigStore.setState({
      providers: [],
      modelsMetadata: new Map<string, ModelMetadata>([
        ['agent-openai/gpt-6.1-sol', exact],
        ['openai/gpt-6.1-sol', catalogEntry('openai', { knowledge: 'canonical-knowledge' })],
      ]),
    });
    expect(useConfigStore.getState().getModelMetadata('agent-openai', 'gpt-6.1-sol'))
      .toEqual(exact);
  });

  test('projects a runtime date and no borrowed fields from an empty catalog', () => {
    const live = provider('agent-openai', 'gpt-6.1-sol');
    useConfigStore.setState({
      providers: [{
        ...live,
        canonical: 'openai',
        models: [{
          ...live.models[0],
          canonical: 'openai',
          time: { released: 1790640000000 },
        }],
      }],
      modelsMetadata: new Map(),
    });
    const result = useConfigStore.getState().getModelMetadata('agent-openai', 'gpt-6.1-sol');
    expect(result?.release_date).toBe('2026-09-29');
    expect(result?.knowledge).toBeUndefined();
    expect(result?.last_updated).toBeUndefined();
  });

  test('keeps present descriptive text and drops blank descriptive fields', () => {
    const live = provider('agent-openai', 'gpt-6.1-sol');
    useConfigStore.setState({
      providers: [{
        ...live,
        models: [{ ...live.models[0], canonical: 'openai', time: { released: 0 } }],
      }],
      modelsMetadata: new Map([[
        'openai/gpt-6.1-sol',
        catalogEntry('openai', {
          knowledge: '  2026-04-30  ',
          release_date: '   ',
          last_updated: '',
        }),
      ]]),
    });
    const result = useConfigStore.getState().getModelMetadata('agent-openai', 'gpt-6.1-sol');
    expect(result?.knowledge).toBe('2026-04-30');
    expect(result?.release_date).toBeUndefined();
    expect(result?.last_updated).toBeUndefined();
  });

  test('does not match when the runtime modelID is missing', () => {
    const live = provider('agent-openai', 'gpt-6.1-sol');
    useConfigStore.setState({
      providers: [{
        ...live,
        canonical: 'openai',
        models: [{
          ...live.models[0],
          id: 'gpt-6.1-sol',
          modelID: '',
          canonical: 'openai',
          name: 'GPT-6.1 Sol',
          family: 'gpt-6.1-sol',
        }],
      }],
      modelsMetadata: new Map([[
        'openai/gpt-6.1-sol',
        catalogEntry('openai', { knowledge: '2026-04-30' }),
      ]]),
    });
    expect(useConfigStore.getState().getModelMetadata('agent-openai', 'gpt-6.1-sol')?.knowledge)
      .toBeUndefined();
  });

  test('does not parse a canonical value as a provider and model alias', () => {
    const live = provider('agent-openai', 'gpt-6.1-sol');
    useConfigStore.setState({
      providers: [{
        ...live,
        canonical: 'openai',
        models: [{ ...live.models[0], canonical: 'openai/gpt-6.1-sol' }],
      }],
      modelsMetadata: new Map([[
        'openai/gpt-6.1-sol',
        catalogEntry('openai', { knowledge: '2026-04-30' }),
      ]]),
    });
    expect(useConfigStore.getState().getModelMetadata('agent-openai', 'gpt-6.1-sol')?.knowledge)
      .toBeUndefined();
  });

  test('does not keep a previous match after the catalog becomes ambiguous or empty', () => {
    const live = provider('agent-openai', 'gpt-6.1-sol');
    const read = () => useConfigStore.getState().getModelMetadata('agent-openai', 'gpt-6.1-sol')?.knowledge;
    useConfigStore.setState({
      providers: [live],
      modelsMetadata: new Map([[
        'openai/gpt-6.1-sol',
        catalogEntry('openai', { knowledge: '2026-04-30' }),
      ]]),
    });
    expect(read()).toBe('2026-04-30');

    useConfigStore.setState({
      providers: [live],
      modelsMetadata: new Map([
        ['other/gpt-6.1-sol', catalogEntry('other', { knowledge: '2026-05-01' })],
        ['openai/gpt-6.1-sol', catalogEntry('openai', { knowledge: '2026-04-30' })],
      ]),
    });
    expect(read()).toBeUndefined();

    useConfigStore.setState({ providers: [live], modelsMetadata: new Map() });
    expect(read()).toBeUndefined();
  });

  test('leaves runtime and catalog inputs unchanged and does not fetch', () => {
    const exactModel = {
      ...model('openai', 'gpt-6-astra'),
      time: { released: 1790640000000 },
      limit: { context: 400_000, output: 128_000 },
    };
    const exactProvider = { ...provider('openai', 'gpt-6-astra'), models: [exactModel] };
    const exactEntry: ModelMetadata = {
      id: 'gpt-6-astra',
      providerId: 'openai',
      name: 'GPT-6 Astra',
      knowledge: '2025-08',
      release_date: '2025-08-01',
      last_updated: '2025-09-01',
      cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      limit: { context: 1_050_000, output: 128_000 },
    };
    const crossModel = {
      ...model('agent-openai', 'gpt-6.1-sol'),
      canonical: 'openai',
      name: 'Gateway Fast',
      time: { released: 1790640000000 },
      cost: [{ input: 9, output: 18, cache: { read: 0, write: 7 } }],
      limit: { context: 123_000, output: 5_000 },
    };
    const crossProvider = {
      ...provider('agent-openai'),
      canonical: 'other',
      models: [crossModel],
    };
    const crossEntry = catalogEntry('openai', {
      name: 'Standard',
      knowledge: '2026-04-30',
      release_date: '2026-01-01',
      last_updated: '2026-10-01',
      cost: { input: 1, output: 2, cache_read: 3, cache_write: 4 },
      limit: { context: 1_000_000, output: 100_000 },
    });
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    function recordingFetch(input: RequestInfo | URL): Promise<Response> {
      calls.push(String(input));
      return Promise.reject(new Error('metadata lookup must not fetch'));
    }
    globalThis.fetch = recordingFetch;

    try {
      const exactEntryBefore = structuredClone(exactEntry);
      const exactModelBefore = structuredClone(exactModel);
      useConfigStore.setState({
        providers: [exactProvider],
        modelsMetadata: new Map([['openai/gpt-6-astra', exactEntry]]),
      });
      const exactResult = useConfigStore.getState().getModelMetadata('openai', 'gpt-6-astra');
      expect(exactResult?.release_date).toBe('2026-09-29');
      expect(exactResult?.knowledge).toBe('2025-08');
      expect(exactResult?.limit).toEqual({ context: 400_000, output: 128_000 });
      expect(exactEntry).toEqual(exactEntryBefore);
      expect(exactModel).toEqual(exactModelBefore);

      const crossEntryBefore = structuredClone(crossEntry);
      const crossModelBefore = structuredClone(crossModel);
      const crossProviderBefore = structuredClone(crossProvider);
      useConfigStore.setState({
        providers: [crossProvider],
        modelsMetadata: new Map([['openai/gpt-6.1-sol', crossEntry]]),
      });
      const crossResult = useConfigStore.getState().getModelMetadata('agent-openai', 'gpt-6.1-sol');
      expect(crossResult?.knowledge).toBe('2026-04-30');
      expect(crossResult?.release_date).toBe('2026-09-29');
      expect(crossResult?.last_updated).toBe('2026-10-01');
      expect(crossResult?.id).toBe('gpt-6.1-sol');
      expect(crossResult?.providerId).toBe('agent-openai');
      expect(crossResult?.name).toBe('Gateway Fast');
      expect(crossResult?.cost).toEqual({ input: 9, output: 18, cache_read: 0, cache_write: 7 });
      expect(crossEntry).toEqual(crossEntryBefore);
      expect(crossModel).toEqual(crossModelBefore);
      expect(crossProvider).toEqual(crossProviderBefore);
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('voice endpoint path settings', () => {
  beforeEach(() => {
    storage = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: makeStorage() });
  });

  test('defaults both endpoint paths to empty', () => {
    expect(useConfigStore.getState().openaiCompatibleTtsEndpointPath).toBe('');
    expect(useConfigStore.getState().sttEndpointPath).toBe('');
  });

  test('keeps the tts endpoint path in local storage', () => {
    useConfigStore.getState().setOpenaiCompatibleTtsEndpointPath('/custom/speech');

    expect(useConfigStore.getState().openaiCompatibleTtsEndpointPath).toBe('/custom/speech');
    expect(localStorage.getItem('openaiCompatibleTtsEndpointPath')).toBe('/custom/speech');
  });

  test('keeps the stt endpoint path in local storage', () => {
    useConfigStore.getState().setSttEndpointPath('/speech_to_text');

    expect(useConfigStore.getState().sttEndpointPath).toBe('/speech_to_text');
    expect(localStorage.getItem('sttEndpointPath')).toBe('/speech_to_text');
  });
});
