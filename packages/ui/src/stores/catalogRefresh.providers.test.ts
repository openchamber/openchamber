import { beforeEach, describe, expect, jest, spyOn, test } from 'bun:test';
import { directoryEnvironment } from './test-support/directoryEnvironment';

const CHATS = '/workspace/chats';
const PROJECT = '/workspace/project';
const SETTINGS = '/workspace/settings-project';
const UNRELATED = '/workspace/unrelated';
const environment = directoryEnvironment({ home: '/workspace', lastDirectory: PROJECT });
const catalogs = new Map<string, string[]>();
const providerModels = new Map<string, string[]>();
const reads: Array<{ path: string; directory: string }> = [];
let providerResponse: ((directory: string) => Promise<Response> | undefined) | undefined;

const providerList = (directory: string) => Response.json({
  data: (catalogs.get(directory) ?? []).map(id => ({ id, name: id, activation: 'enabled', package: 'test' })),
});

environment.respond(async (url, init) => {
  const directory = url.searchParams.get('directory')
    ?? decodeURIComponent(new Headers(init?.headers).get('x-opencode-directory') ?? '');
  reads.push({ path: url.pathname, directory });
  if (url.pathname === '/api/provider') return providerResponse?.(directory) ?? providerList(directory);
  if (url.pathname === '/api/model') return Response.json({ data: (catalogs.get(directory) ?? []).flatMap(providerID => (providerModels.get(providerID) ?? ['model']).map(modelID => ({
    id: `${providerID}/${modelID}`, modelID, providerID, name: modelID, enabled: true,
    capabilities: { tools: true, input: ['text'], output: ['text'] },
    variants: [], time: { released: 0 }, cost: [], status: 'active', limit: { context: 1000, output: 100 },
  }))) });
  if (url.pathname === '/api/model/default') return Response.json({ data: { providerID: catalogs.get(directory)?.[0], modelID: 'model' } });
  if (url.pathname === '/api/agent' || url.pathname === '/api/command') return Response.json({ data: [] });
  if (url.pathname === '/api/plugin') return Response.json({ data: [{ source: { type: 'builtin' }, features: {}, state: { status: 'active' } }] });
  if (url.pathname === '/api/config' || url.pathname === '/api/config/mcp') return Response.json([]);
  if (url.pathname === '/api/config/disabled-agents') return Response.json({ disabledAgents: [] });
  if (url.pathname === '/api/config/command-configs') return Response.json({ commands: [] });
  if (url.pathname === '/api/config/skills') return Response.json({ skills: [] });
  if (url.pathname === '/api/config/skills/catalog') return Response.json({ sources: [] });
  if (url.pathname === '/api/config/plugins') return Response.json({ entries: [], files: [] });
  if (url.pathname === '/api/openchamber/models-metadata') return Response.json({});
  if (url.pathname === '/api/fs/home') return Response.json({ home: '/workspace', chatsRoot: CHATS });
  if (url.pathname === '/api/fs/directory-stats') return Response.json({ results: [{ path: PROJECT, isDirectory: true }] });
  if (url.pathname === '/api/location' || url.pathname === '/api/session') return Response.json({}, { status: 401 });
  throw new Error(`Unexpected request: ${url}`);
});

const { opencodeClient } = await import('@/lib/opencode/client');
const { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
const { useProjectsStore } = await import('./useProjectsStore');
const { selectProvidersForDirectory, useConfigStore } = await import('./useConfigStore');
const { refreshStoresForCatalogKind, refreshStoresForCatalogKinds } = await import('./catalogRefresh');
const { subscribeCredentialChanges } = await import('@/lib/opencode/integration-catalog');
const { ChildStoreManager } = await import('@/sync/child-store');
const { createEventRoutingIndex, handleEvent } = await import('@/sync/sync-context');
const originalRuntime = { apiBaseUrl: getRuntimeApiBaseUrl(), runtimeKey: getRuntimeKey() };

const ids = (directory: string) => selectProvidersForDirectory(useConfigStore.getState(), directory).map(provider => provider.id);
const providerReads = () => reads.filter(read => read.path === '/api/provider').map(read => read.directory);
const deferred = <T>() => {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

beforeEach(async () => {
  providerResponse = undefined;
  await environment.settle();
  switchRuntimeEndpoint(originalRuntime);
  opencodeClient.reconnectToRuntimeBaseUrl();
  opencodeClient.setDirectory(PROJECT);
  useProjectsStore.setState({
    projects: [PROJECT, SETTINGS, UNRELATED].map(path => ({ id: path, path })),
    activeProjectId: PROJECT,
  });
  useConfigStore.setState({
    activeDirectoryKey: CHATS, directoryScoped: {}, providers: [], providersLoaded: false,
    settingsOnlyProviders: {}, settingsDefaultsLoaded: true, isConnected: false,
  });
  catalogs.clear();
  providerModels.clear();
  catalogs.set(CHATS, ['chat-provider']);
  catalogs.set(SETTINGS, ['settings-provider']);
  catalogs.set(UNRELATED, ['unrelated-provider']);
  for (const directory of [CHATS, SETTINGS, UNRELATED]) {
    await useConfigStore.getState().loadProviders({ directory });
  }
  useConfigStore.setState({ currentProviderId: 'chat-provider', currentModelId: 'chat-provider/model', selectionSource: 'manual' });
  reads.length = 0;
});

describe('provider catalog refresh directories', () => {
  test('refreshes the Settings catalog while an untargeted Chat draft owns the active catalog', async () => {
    const unrelated = selectProvidersForDirectory(useConfigStore.getState(), UNRELATED);
    catalogs.set(SETTINGS, ['settings-provider', 'custom-provider']);

    await refreshStoresForCatalogKind('provider', [SETTINGS, ` ${SETTINGS} `, 'global', '']);

    expect(ids(SETTINGS)).toEqual(['settings-provider', 'custom-provider']);
    expect(ids(CHATS)).toEqual(['chat-provider']);
    expect(useConfigStore.getState().currentModelId).toBe('chat-provider/model');
    expect(selectProvidersForDirectory(useConfigStore.getState(), UNRELATED)).toBe(unrelated);
    expect(providerReads().sort()).toEqual([CHATS, SETTINGS]);
  });

  test('a config, provider and model burst reads each affected provider catalog once', async () => {
    catalogs.set(SETTINGS, ['settings-provider', 'custom-provider']);

    await refreshStoresForCatalogKinds(new Map([
      ['config', [SETTINGS]], ['provider', [SETTINGS]], ['model', [SETTINGS]],
    ]));

    expect(ids(SETTINGS)).toEqual(['settings-provider', 'custom-provider']);
    expect(providerReads().sort()).toEqual([CHATS, SETTINGS]);
  });

  test('credential bursts include the named directories in the delayed provider reread', async () => {
    const reload = refreshStoresForCatalogKinds(new Map([
      ['credential', [SETTINGS]], ['provider', [SETTINGS]], ['model', [SETTINGS]],
    ]));
    await environment.settle();
    expect(providerReads().sort()).toEqual([CHATS, SETTINGS]);
    catalogs.set(SETTINGS, ['settings-provider', 'late-provider']);

    jest.advanceTimersByTime(5000);
    await reload;

    expect(ids(SETTINGS)).toEqual(['settings-provider', 'late-provider']);
    expect(providerReads().sort()).toEqual([CHATS, CHATS, SETTINGS, SETTINGS]);
  });

  test('a global credential change rereads the project of an open Providers page, also after model discovery', async () => {
    const childStores = new ChildStoreManager();
    const close = subscribeCredentialChanges(() => {}, SETTINGS);
    try {
      handleEvent('global', { type: 'catalog.updated', properties: { kind: 'credential' } }, childStores, createEventRoutingIndex(), getRuntimeKey());
      jest.advanceTimersByTime(250);
      await environment.settle();
      expect(providerReads().sort()).toEqual([CHATS, PROJECT, SETTINGS]);
      catalogs.set(SETTINGS, ['settings-provider', 'late-provider']);

      jest.advanceTimersByTime(5000);
      await environment.settle();

      expect(ids(SETTINGS)).toEqual(['settings-provider', 'late-provider']);
      expect(providerReads()).not.toContain(UNRELATED);

      close();
      reads.length = 0;
      const closed = refreshStoresForCatalogKind('credential');
      await environment.settle();
      jest.advanceTimersByTime(5000);
      await closed;
      expect(providerReads()).not.toContain(SETTINGS);
    } finally {
      close();
      childStores.disposeAll();
    }
  });

  test('a Windows drive root event refreshes the catalog Settings reads for that root', async () => {
    const childStores = new ChildStoreManager();
    catalogs.set('C:/', ['drive-provider']);
    await useConfigStore.getState().loadProviders({ directory: 'C:/' });
    catalogs.set('C:/', ['drive-provider', 'new-drive-provider']);
    reads.length = 0;
    try {
      handleEvent('c:\\', { type: 'catalog.updated', properties: { kind: 'provider' } }, childStores, createEventRoutingIndex(), getRuntimeKey());
      jest.advanceTimersByTime(250);
      await environment.settle();

      expect(ids('C:/')).toEqual(['drive-provider', 'new-drive-provider']);
      expect(providerReads().sort()).toEqual([CHATS, 'C:/'].sort());
    } finally {
      childStores.disposeAll();
    }
  });

  test('a failed directory retains its catalog while the other directory refreshes', async () => {
    const previous = selectProvidersForDirectory(useConfigStore.getState(), SETTINGS);
    catalogs.set(CHATS, ['chat-provider', 'new-chat-provider']);
    providerResponse = async directory => directory === SETTINGS ? new Response(null, { status: 503 }) : providerList(directory);
    const error = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const reload = refreshStoresForCatalogKind('model', [SETTINGS]);
      for (let step = 0; step < 10; step++) await environment.settle();
      await reload;

      expect(selectProvidersForDirectory(useConfigStore.getState(), SETTINGS)).toBe(previous);
      expect(ids(CHATS)).toEqual(['chat-provider', 'new-chat-provider']);
      expect(providerReads().filter(directory => directory === SETTINGS)).toHaveLength(3);
    } finally {
      error.mockRestore();
    }
  });

  for (const activeDirectoryKey of [CHATS, '__global__']) {
    test(`delayed credential discovery also refreshes the catalog activated from ${activeDirectoryKey}`, async () => {
      if (activeDirectoryKey === '__global__') useConfigStore.setState({ activeDirectoryKey, providers: [], providersLoaded: false });
      const reload = refreshStoresForCatalogKind('credential', [SETTINGS]);
      await environment.settle();
      catalogs.set(PROJECT, ['project-provider']);
      providerModels.set('project-provider', ['early-model']);
      useConfigStore.setState({ isConnected: true });
      await useConfigStore.getState().activateDirectory(PROJECT);
      expect(selectProvidersForDirectory(useConfigStore.getState(), PROJECT)[0].models.map(model => model.id)).toEqual(['project-provider/early-model']);
      providerModels.set('project-provider', ['early-model', 'discovered-model']);

      jest.advanceTimersByTime(5000);
      await reload;

      expect(selectProvidersForDirectory(useConfigStore.getState(), PROJECT)[0].models.map(model => model.id)).toEqual(['project-provider/early-model', 'project-provider/discovered-model']);
      expect(providerReads().filter(directory => directory === PROJECT)).toHaveLength(2);
      expect(providerReads().filter(directory => directory === SETTINGS)).toHaveLength(2);
    });
  }

  test('a joined credential batch retains its newly active catalog follow-up', async () => {
    const first = refreshStoresForCatalogKind('credential', [SETTINGS]);
    await environment.settle();
    jest.advanceTimersByTime(1000);
    useConfigStore.setState({ isConnected: true });
    await useConfigStore.getState().activateDirectory(SETTINGS);
    const joined = refreshStoresForCatalogKind('credential');
    await environment.settle();
    jest.advanceTimersByTime(4000);
    await environment.settle();
    catalogs.set(PROJECT, ['project-provider']);
    providerModels.set('project-provider', ['early-model']);
    await useConfigStore.getState().activateDirectory(PROJECT);
    providerModels.set('project-provider', ['early-model', 'discovered-model']);

    jest.advanceTimersByTime(5000);
    await Promise.all([first, joined]);

    expect(selectProvidersForDirectory(useConfigStore.getState(), PROJECT)[0].models.map(model => model.id)).toEqual(['project-provider/early-model', 'project-provider/discovered-model']);
    expect(providerReads().filter(directory => directory === PROJECT)).toHaveLength(2);
  });

  test('invalidations during a Settings read earn one trailing read for that directory', async () => {
    const started = deferred<void>();
    const response = deferred<Response>();
    let pending = true;
    providerResponse = directory => {
      if (directory !== SETTINGS || !pending) return undefined;
      pending = false;
      started.resolve();
      return response.promise;
    };
    const first = refreshStoresForCatalogKind('model', [SETTINGS]);
    await started.promise;
    const obsolete = providerList(SETTINGS);
    catalogs.set(SETTINGS, ['settings-provider', 'custom-provider']);
    const joined = Array.from({ length: 8 }, () => refreshStoresForCatalogKind('provider', [SETTINGS]));
    response.resolve(obsolete);
    await Promise.all([first, ...joined]);

    expect(ids(SETTINGS)).toEqual(['settings-provider', 'custom-provider']);
    expect(providerReads().filter(directory => directory === SETTINGS)).toHaveLength(2);
  });

  test('a runtime round trip retires the delayed credential rereads', async () => {
    const reload = refreshStoresForCatalogKind('credential', [SETTINGS]);
    await environment.settle();
    const immediateReads = providerReads();
    switchRuntimeEndpoint({ runtimeKey: 'runtime-b', apiBaseUrl: 'https://runtime-b.test' });
    switchRuntimeEndpoint(originalRuntime);

    jest.advanceTimersByTime(5000);
    await reload;

    expect(providerReads()).toEqual(immediateReads);
    expect(useConfigStore.getState().providers).toEqual([]);
    expect(useConfigStore.getState().directoryScoped).toEqual({});
  });
});
