/**
 * Reproduction test for issue #2168
 *
 * Problem: After updating OpenCode to v1.17.15+, provider loading fails for all
 * projects except one. The model selector shows no models, sessions can't load
 * content, and newly added projects cannot get providers.
 *
 * Root cause hypothesis: OpenChamber's `loadProviders` calls `config.providers`
 * WITH a directory parameter scoped to each project. If OpenCode v1.17.15+
 * changed this endpoint to return ONLY project-scoped providers (from the
 * project's opencode.json) instead of merging in the global user config, then
 * any project without its own opencode.json with providers defined gets an
 * empty provider list. The one project that "works" is either the initial
 * project loaded during startup, or has providers in its own opencode.json.
 *
 * This test demonstrates:
 * 1. A project whose directory-scoped provider request returns providers works
 * 2. A project whose directory-scoped provider request returns empty array
 *    stores empty providers, which then causes the model selector to show nothing
 * 3. The diagnostic probe (which calls /config/providers WITHOUT a directory)
 *    may succeed, masking the real issue during troubleshooting
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Agent } from '@opencode-ai/sdk/v2';

const WORKING_DIRECTORY = '/workspace/working-project';
const BROKEN_DIRECTORY = '/workspace/broken-project';
const NEW_PROJECT_DIRECTORY = '/workspace/new-project';
const STORAGE_KEY = 'config-store';

let storage = new Map<string, string>();
let getProvidersForConfigImpl: ((directory?: string | null) => Promise<{ providers: unknown[]; default: Record<string, string> }>) | null = null;
let configListener: ((event: { scopes: string[]; source?: string; timestamp: number }) => void | Promise<void>) | null = null;

const makeStorage = (): Storage => ({
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); },
  clear: () => { storage.clear(); },
  key: (index: number) => Array.from(storage.keys())[index] ?? null,
  get length() { return storage.size; },
}) as Storage;

const provider = (id: string, modelId = `${id}-model`) => ({
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
        temperature: true, reasoning: false, attachment: false,
        toolcall: true, input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 0, output: 0 },
      options: {},
      release_date: '',
      status: 'active' as const,
      headers: {},
      attachment: false, reasoning: false, temperature: true, tool_call: true,
    },
  ],
});

const providerResponse = (id: string, modelId = `${id}-model`) => ({
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
        temperature: true, reasoning: false, attachment: false,
        toolcall: true, input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 0, output: 0 },
      options: {},
      release_date: '',
      status: 'active' as const,
      headers: {},
      attachment: false, reasoning: false, temperature: true, tool_call: true,
    },
  },
});

const testAgent = (name: string, options?: Partial<{ mode: string; hidden?: boolean }>): Agent => ({
  name,
  mode: options?.mode ?? 'primary',
  hidden: options?.hidden,
  model: undefined,
  variant: undefined,
  permission: {},
  options: {},
}) as Agent;

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
      removeItem: (name: string) => { testStorage.removeItem(name); },
    };
  },
}));

mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: {
    getState: () => ({
      activeProjectId: 'working',
      projects: [
        { id: 'working', path: WORKING_DIRECTORY, label: 'Working Project' },
        { id: 'broken', path: BROKEN_DIRECTORY, label: 'Broken Project' },
        { id: 'new', path: NEW_PROJECT_DIRECTORY, label: 'New Project' },
      ],
    }),
  },
}));

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    setDirectory: mock(() => undefined),
    getDirectory: mock(() => WORKING_DIRECTORY),
    checkHealth: mock(async () => true),
    withDirectory: mock(async (_directory: string | null, callback: () => Promise<unknown>) => {
      return await callback();
    }),
    getProviders: mock(async () => {
      // Global provider list (without directory scope) returns all providers
      return { providers: [providerResponse('global-provider')], default: { default: 'global-provider' } };
    }),
    getProvidersForConfig: mock(async (directory?: string | null) => {
      // Simulate OpenCode v1.17.15+ behavior: directory-scoped requests return
      // ONLY project-specific providers from the project's opencode.json.
      // Projects without their own opencode.json get an EMPTY provider list.
      if (directory === WORKING_DIRECTORY) {
        // The working project has providers in its opencode.json
        return { providers: [providerResponse('working-provider')], default: { default: 'working-provider' } };
      }
      if (directory === null || directory === undefined) {
        // Global request (no directory) returns all providers
        return { providers: [providerResponse('global-provider')], default: { default: 'global-provider' } };
      }
      // Projects without their own opencode.json get empty providers
      return { providers: [], default: {} };
    }),
    listAgents: mock(async (_directory?: string | null) => {
      return [testAgent('default')];
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
  measureStartupTrace: mock(async (_name: string, callback: () => Promise<unknown>) => callback()),
}));

mock.module('@/lib/configSync', () => ({
  emitConfigChange: mock(() => undefined),
  scopeMatches: mock((event: { scopes: string[] }, scope: string) => event.scopes.includes('all') || event.scopes.includes(scope)),
  subscribeToConfigChanges: mock((listener: typeof configListener) => {
    configListener = listener;
    return () => { if (configListener === listener) configListener = null; };
  }),
}));

const { useConfigStore } = await import('./useConfigStore');
const { emitSyncConfigChanged, setSyncRefs } = await import('@/sync/sync-refs');
const { useSelectionStore } = await import('@/sync/selection-store');
const { useSessionUIStore } = await import('@/sync/session-ui-store');

describe('Reproduction: Issue #2168 - Provider loading fails per project', () => {
  beforeEach(() => {
    storage = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: makeStorage(),
    });
    getProvidersForConfigImpl = null;
    configListener = null;
    setSyncRefs({} as never, { children: new Map(), getState: () => undefined } as never, WORKING_DIRECTORY);
    useSelectionStore.setState({
      sessionModelSelections: new Map(),
      sessionAgentSelections: new Map(),
      sessionAgentModelSelections: new Map(),
      lastUsedProvider: null,
    });
    useSessionUIStore.setState({ currentSessionId: null });
    useConfigStore.setState({
      activeDirectoryKey: WORKING_DIRECTORY,
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

  test('[REPRODUCTION] Working project gets providers, broken project gets empty providers', async () => {
    // Simulate startup: load providers for the WORKING project (like initializeApp does)
    await useConfigStore.getState().loadProviders({ directory: WORKING_DIRECTORY, source: 'test:init' });

    // The working project has providers in its directoryScoped cache
    let state = useConfigStore.getState();
    expect(state.directoryScoped[WORKING_DIRECTORY]?.providers).toBeDefined();
    expect(state.directoryScoped[WORKING_DIRECTORY]!.providers.length).toBe(1);
    expect(state.directoryScoped[WORKING_DIRECTORY]!.providers[0].id).toBe('working-provider');
    expect(state.providers.length).toBe(1); // Active directory gets top-level copy
    expect(state.providers[0].id).toBe('working-provider');
    console.log('[REPRO] Working project providers:', state.providers.length, 'entries');

    // Now simulate switching to the BROKEN project (like activateDirectory does)
    await useConfigStore.getState().loadProviders({ directory: BROKEN_DIRECTORY, source: 'test:switch' });

    state = useConfigStore.getState();
    expect(state.directoryScoped[BROKEN_DIRECTORY]?.providers).toBeDefined();
    // THE BUG: broken project has empty providers because the OpenCode API
    // returned an empty list for this directory-scoped request
    expect(state.directoryScoped[BROKEN_DIRECTORY]!.providers.length).toBe(0);
    console.log('[REPRO] Broken project providers:', state.directoryScoped[BROKEN_DIRECTORY]!.providers.length, 'entries');

    // When the user activates the broken project, the model selector sees NO providers
    state = useConfigStore.getState();
    const hasModels = state.directoryScoped[BROKEN_DIRECTORY]!.providers.some(
      (p) => p.models.length > 0
    );
    expect(hasModels).toBe(false);
    console.log('[REPRO] Broken project has models available:', hasModels);

    // The working project's providers are still cached separately
    expect(state.directoryScoped[WORKING_DIRECTORY]!.providers.length).toBe(1);
    console.log('[REPRO] Working project still has:', state.directoryScoped[WORKING_DIRECTORY]!.providers.length, 'providers');
  });

  test('[REPRODUCTION] Newly added project also gets empty providers', async () => {
    // Simulate loading providers for a newly created project (one that
    // doesn't have its own opencode.json with providers)
    await useConfigStore.getState().loadProviders({ directory: NEW_PROJECT_DIRECTORY, source: 'test:newProject' });

    const state = useConfigStore.getState();
    expect(state.directoryScoped[NEW_PROJECT_DIRECTORY]?.providers).toBeDefined();
    expect(state.directoryScoped[NEW_PROJECT_DIRECTORY]!.providers.length).toBe(0);
    console.log('[REPRO] New project providers:', state.directoryScoped[NEW_PROJECT_DIRECTORY]!.providers.length, 'entries');
  });

  test('[REPRODUCTION] Global provider request succeeds, masking the project-scoped issue', async () => {
    // Simulate what the diagnostic probe does: call config.providers
    // WITHOUT a directory parameter
    const globalProviders = await (
      await import('@/lib/opencode/client')
    ).opencodeClient.getProviders();

    // Global provider request returns providers (this is what shows in diagnostics)
    expect(globalProviders.providers.length).toBe(1);
    expect(globalProviders.providers[0].id).toBe('global-provider');
    console.log('[REPRO] Global providers (diagnostic):', globalProviders.providers.length, 'entries');

    // But per-project loading fails for the broken project
    const scopedProviders = await (
      await import('@/lib/opencode/client')
    ).opencodeClient.getProvidersForConfig(BROKEN_DIRECTORY);

    expect(scopedProviders.providers.length).toBe(0);
    console.log('[REPRO] Scoped providers (broken project):', scopedProviders.providers.length, 'entries');

    // THIS IS THE BUG: the diagnostic shows "ok" because it queries globally,
    // but the actual provider loading fails because it queries per-project
    console.log('[REPRO] === BUG CONFIRMED ===');
    console.log('[REPRO] Global provider query succeeds but per-project query returns empty.');
    console.log('[REPRO] This matches issue #2168: diagnostic shows providers=ok, but model selector shows nothing.');
  });

  test('[REPRODUCTION] Activating broken project clears model selector because providers are empty', async () => {
    // Load working project first (simulating startup)
    await useConfigStore.getState().loadProviders({ directory: WORKING_DIRECTORY, source: 'test:init' });
    expect(useConfigStore.getState().providers.length).toBe(1);

    // Now activate the broken project (simulating user switching projects)
    await useConfigStore.getState().activateDirectory(BROKEN_DIRECTORY);

    // After activation, the top-level providers are overwritten with the
    // broken project's empty providers
    const state = useConfigStore.getState();
    expect(state.activeDirectoryKey).toBe(BROKEN_DIRECTORY);
    // THE BUG: top-level providers are now EMPTY because the broken
    // project's directoryScoped snapshot has 0 providers
    expect(state.providers.length).toBe(0);
    expect(state.currentProviderId).toBe('');
    expect(state.currentModelId).toBe('');
    console.log('[REPRO] Top-level providers after activating broken project:', state.providers.length);
    console.log('[REPRO] currentProviderId:', JSON.stringify(state.currentProviderId));
    console.log('[REPRO] currentModelId:', JSON.stringify(state.currentModelId));

    // The model selector reads `providers` from the store - it will show
    // nothing because providers is empty
    const modelSelectorHasOptions = state.providers.some((p) => p.models.length > 0);
    expect(modelSelectorHasOptions).toBe(false);
    console.log('[REPRO] Model selector has options:', modelSelectorHasOptions);
  });
});
