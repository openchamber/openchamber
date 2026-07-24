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
// Test-controlled health check result. Default healthy; individual tests can
// flip it to `false` to simulate a transient HTTP health probe failure (used
// to validate the issue #1769 guard in `probeConnection`).
let healthCheckResult: boolean = true;

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
  getDeferredSafeStorage: () => makeStorage(),
  getSafeStorage: () => makeStorage(),
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
    checkHealth: mock(async () => healthCheckResult),
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
const { useSelectionStore } = await import('@/sync/selection-store');
const { useSessionUIStore } = await import('@/sync/session-ui-store');

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
    healthCheckResult = true;
    setSyncRefs({} as never, { children: new Map(), getState: () => undefined } as never, DIRECTORY);
    useSelectionStore.setState({
      sessionModelSelections: new Map(),
      sessionAgentSelections: new Map(),
      sessionAgentModelSelections: new Map(),
      lastUsedProvider: null,
    });
    useSessionUIStore.setState({ currentSessionId: null });
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
      providers: [provider('openai', 'gpt-5.5', { low: {}, high: {} })],
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

  test('setAgent prefers saved and agent variants before settings default', () => {
    const sessionId = 'ses_agent_saved_variant';
    useSessionUIStore.setState({ currentSessionId: sessionId });
    useSelectionStore.getState().saveAgentModelVariantForSession(sessionId, 'plan', 'openai', 'gpt-5.5', 'low');
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5', { low: {}, medium: {}, high: {} })],
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

  test('setAgent applies settings default variant for a saved session agent model', () => {
    const sessionId = 'ses_existing_agent_model_default_variant';
    useSessionUIStore.setState({ currentSessionId: sessionId });
    useSelectionStore.getState().saveAgentModelForSession(sessionId, 'plan', 'openai', 'gpt-5.5');
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('openai', 'gpt-5.5', { low: {}, high: {} })],
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

describe('useConfigStore probeConnection — issue #1769', () => {
  beforeEach(() => {
    storage = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: makeStorage(),
    });
    liveProviderId = 'live';
    liveProviderIdsByDirectory = new Map();
    liveProviderVariants = undefined;
    getProvidersCalls = 0;
    getConfigCalls = 0;
    listAgentsCalls = 0;
    liveAgents = [];
    listAgentsImpl = null;
    withDirectoryCalls = [];
    currentFetchDirectory = DIRECTORY;
    healthCheckResult = true;
    setSyncRefs({} as never, { children: new Map(), getState: () => undefined } as never, DIRECTORY);
    useSelectionStore.setState({
      sessionModelSelections: new Map(),
      sessionAgentSelections: new Map(),
      sessionAgentModelSelections: new Map(),
      lastUsedProvider: null,
    });
    useSessionUIStore.setState({ currentSessionId: null });
  });

  test('probe failure during warmup does not flip connectionPhase to reconnecting', async () => {
    // Reload after a previous session: hasEverConnected is true (carried
    // over by store hydration), but the SSE/WS pipeline has not yet
    // reported its first onReconnect in this lifecycle, so
    // transportConnectedAt is null. A transient HTTP probe failure here
    // must not surface as a spurious "reconnecting" indicator flicker.
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      isConnected: false,
      hasEverConnected: true,
      connectionPhase: 'connecting',
      transportConnectedAt: null,
    });
    healthCheckResult = false;

    const ok = await useConfigStore.getState().probeConnection();
    const state = useConfigStore.getState();

    expect(ok).toBe(false);
    expect(state.connectionPhase).toBe('connecting');
    // warmup-guarded path also stamps lastDisconnectReason so the
    // user-facing connectionLostError in session-actions.ts has accurate
    // context (matches the non-guarded branch behaviour).
    expect(state.lastDisconnectReason).toBe('health_check_unhealthy');
  });

  test('probe failure after a real transport connect still reports reconnecting', async () => {
    // Once the pipeline has reported at least one onReconnect in this
    // lifecycle (transportConnectedAt set) and the stream is currently
    // down (isConnected false), a probe failure must still surface
    // reconnecting — the pipeline itself can additionally override this
    // via onDisconnect, but the probe must not pretend everything is fine.
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      isConnected: false,
      hasEverConnected: true,
      connectionPhase: 'reconnecting',
      transportConnectedAt: Date.now() - 5_000,
      lastDisconnectReason: 'ws_heartbeat_timeout',
    });
    healthCheckResult = false;

    const ok = await useConfigStore.getState().probeConnection();
    const state = useConfigStore.getState();

    expect(ok).toBe(false);
    expect(state.connectionPhase).toBe('reconnecting');
  });

  test('probe success sets connected and transportConnectedAt is left to pipeline', async () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      isConnected: false,
      hasEverConnected: false,
      connectionPhase: 'connecting',
      transportConnectedAt: null,
    });
    healthCheckResult = true;

    const ok = await useConfigStore.getState().probeConnection();
    const state = useConfigStore.getState();

    expect(ok).toBe(true);
    expect(state.isConnected).toBe(true);
    expect(state.hasEverConnected).toBe(true);
    expect(state.connectionPhase).toBe('connected');
    // probeConnection does not stamp transportConnectedAt — that is the
    // pipeline's job via setTransportConnectedAt on onReconnect.
    expect(state.transportConnectedAt).toBe(null);
    // probeConnection now calls setConnected(), which stamps
    // hasEverConnectedSince for the warmup-guard timeout anchor.
    expect(state.hasEverConnectedSince).not.toBeNull();
  });

  test('probe does not downgrade an already-connected stream', async () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      isConnected: true,
      hasEverConnected: true,
      connectionPhase: 'connected',
      transportConnectedAt: Date.now() - 1_000,
    });
    healthCheckResult = false;

    const ok = await useConfigStore.getState().probeConnection();
    const state = useConfigStore.getState();

    expect(ok).toBe(true);
    expect(state.isConnected).toBe(true);
    expect(state.connectionPhase).toBe('connected');
  });

  test('first-start probe failure keeps connecting (no reconnecting flash)', async () => {
    // First-ever launch: hasEverConnected false, transportConnectedAt null.
    // The original code path already handled this correctly; guard against
    // regressions when the warmup guard lands.
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      isConnected: false,
      hasEverConnected: false,
      connectionPhase: 'connecting',
      transportConnectedAt: null,
    });
    healthCheckResult = false;

    const ok = await useConfigStore.getState().probeConnection();
    const state = useConfigStore.getState();

    expect(ok).toBe(false);
    expect(state.connectionPhase).toBe('connecting');
  });

  test('setTransportConnectedAt is idempotent for the same timestamp', () => {
    useConfigStore.setState({ transportConnectedAt: null });
    const ts = Date.now();
    useConfigStore.getState().setTransportConnectedAt(ts);
    useConfigStore.getState().setTransportConnectedAt(ts);
    expect(useConfigStore.getState().transportConnectedAt).toBe(ts);
  });

  test('setTransportConnectedAt(null) clears the marker after a teardown', () => {
    useConfigStore.getState().setTransportConnectedAt(Date.now());
    useConfigStore.getState().setTransportConnectedAt(null);
    expect(useConfigStore.getState().transportConnectedAt).toBe(null);
  });

  test('warmup guard releases after WARMUP_GUARD_MAX_MS without a pipeline connect', async () => {
    // Regression guard for the issue #1769 fix: a pipeline that never
    // reports `onReconnect` (e.g. the server is genuinely down and the
    // SSE/WS transport cannot establish) must not keep the warmup guard
    // active forever. After the warmup window elapses, the guard
    // releases so a subsequent HTTP probe failure surfaces
    // `reconnecting` (the correct end-user state) rather than staying
    // stuck on `connecting`.
    const now = Date.now();
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      isConnected: false,
      hasEverConnected: true,
      connectionPhase: 'connecting',
      transportConnectedAt: null,
      transportMountedAt: now - (31_000), // past the 30s warmup window
    });
    healthCheckResult = false;

    expect(useConfigStore.getState().isWarmupGuarded()).toBe(false);
    const ok = await useConfigStore.getState().probeConnection();

    // Now that the guard is released, the probe failure must surface
    // reconnecting (hasEverConnected is true).
    expect(ok).toBe(false);
    expect(useConfigStore.getState().connectionPhase).toBe('reconnecting');
  });

  test('warmup guard is still active within the window', () => {
    const now = Date.now();
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      isConnected: false,
      hasEverConnected: true,
      connectionPhase: 'connecting',
      transportConnectedAt: null,
      transportMountedAt: now - 5_000, // well within the 30s window
    });

    expect(useConfigStore.getState().isWarmupGuarded()).toBe(true);
  });

  test('warmup guard falls back to hasEverConnectedSince when transportMountedAt is null', () => {
    // First mount case: the pipeline effect cleanup that would set
    // transportMountedAt has not yet run. If hasEverConnected was
    // hydrated as true (rehydrated store), the guard must still release
    // after WARMUP_GUARD_MAX_MS so a broken transport is not masked
    // forever. See issue #1769.
    const now = Date.now();
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      isConnected: false,
      hasEverConnected: true,
      connectionPhase: 'connecting',
      transportConnectedAt: null,
      transportMountedAt: null,
      hasEverConnectedSince: now - 31_000, // past the 30s window
    });

    expect(useConfigStore.getState().isWarmupGuarded()).toBe(false);
  });

  test('setConnected stamps hasEverConnectedSince for the warmup-guard timeout', () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      isConnected: false,
      hasEverConnected: false,
      connectionPhase: 'connecting',
      hasEverConnectedSince: null,
    });

    const before = Date.now();
    useConfigStore.getState().setConnected();
    const after = Date.now();

    const state = useConfigStore.getState();
    expect(state.isConnected).toBe(true);
    expect(state.hasEverConnected).toBe(true);
    expect(state.connectionPhase).toBe('connected');
    expect(state.hasEverConnectedSince).not.toBeNull();
    expect(state.hasEverConnectedSince!).toBeGreaterThan(before - 1);
    expect(state.hasEverConnectedSince!).toBeLessThan(after + 1);
  });

  test('setWarmupGuardedDisconnect without a reason preserves the existing one', () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      isConnected: false,
      hasEverConnected: true,
      connectionPhase: 'connecting',
      transportConnectedAt: null,
      lastDisconnectReason: 'health_check_failed',
    });

    useConfigStore.getState().setWarmupGuardedDisconnect();

    const state = useConfigStore.getState();
    expect(state.isConnected).toBe(false);
    expect(state.connectionPhase).toBe('connecting');
    // The existing reason is preserved instead of being silently cleared.
    expect(state.lastDisconnectReason).toBe('health_check_failed');
  });

  test('after pipeline teardown, a probe failure is warmup-guarded again', async () => {
    // Reproduces the SyncProvider useEffect cleanup path: when the
    // pipeline re-mounts (deps change, hot reload, worktree switch, ...),
    // `setTransportConnectedAt(null)` is invoked in cleanup. The store
    // must then go back to the warmup-guarded state so a transient HTTP
    // failure during the new pipeline's bootstrap does not flash
    // "reconnecting" again. Regression guard for the issue #1769 fix.
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      isConnected: true,
      hasEverConnected: true,
      connectionPhase: 'connected',
      transportConnectedAt: Date.now() - 5_000,
    });

    // Simulate cleanup of the previous lifecycle.
    useConfigStore.getState().setTransportConnectedAt(null);
    expect(useConfigStore.getState().transportConnectedAt).toBe(null);

    // The store now mirrors a fresh lifecycle: isConnected reset to
    // false because the previous pipeline is gone. hasEverConnected
    // stays true (carried over from the prior lifecycle, as the store
    // would hydrate it). This is exactly the post-reload scenario the
    // issue #1769 fix targets.
    useConfigStore.setState({
      isConnected: false,
      connectionPhase: 'connecting',
    });
    healthCheckResult = false;

    const ok = await useConfigStore.getState().probeConnection();

    // The probe must NOT flip to reconnecting while the new pipeline
    // has not yet reported its first onReconnect.
    expect(ok).toBe(false);
    expect(useConfigStore.getState().connectionPhase).toBe('connecting');
    expect(useConfigStore.getState().lastDisconnectReason).toBe('health_check_unhealthy');
  });

  test('checkConnection during warmup does not flip to reconnecting on HTTP failure', async () => {
    // Same root cause as the probeConnection test above, but exercising
    // the initializeApp health-check loop. After a reload, the first
    // `checkConnection` call can transiently fail while the pipeline is
    // still bootstrapping; without the warmup guard it would surface
    // `reconnecting` for the duration of the 5-attempt retry loop.
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      isConnected: false,
      hasEverConnected: true,
      connectionPhase: 'connecting',
      transportConnectedAt: null,
    });
    healthCheckResult = false;

    const ok = await useConfigStore.getState().checkConnection();

    // 5 attempts × up-to-400-1600ms backoff ≈ 4s; that's acceptable
    // for a single regression guard against a real user-visible flicker.
    expect(ok).toBe(false);
    expect(useConfigStore.getState().connectionPhase).toBe('connecting');
    expect(useConfigStore.getState().isConnected).toBe(false);
  });

  test('checkConnection after pipeline connect still reports reconnecting on HTTP failure', async () => {
    // Once the pipeline has reported at least one onReconnect in this
    // lifecycle (transportConnectedAt set), `checkConnection` must
    // behave as it did before the fix — a probe failure while the
    // stream is currently down should surface reconnecting.
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      isConnected: false,
      hasEverConnected: true,
      connectionPhase: 'reconnecting',
      transportConnectedAt: Date.now() - 5_000,
      lastDisconnectReason: 'ws_heartbeat_timeout',
    });
    healthCheckResult = false;

    const ok = await useConfigStore.getState().checkConnection();

    expect(ok).toBe(false);
    expect(useConfigStore.getState().connectionPhase).toBe('reconnecting');
  });
});
