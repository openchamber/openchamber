import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const originalFetch = globalThis.fetch;

import type { PluginEntry, PluginFile, RegistryResult } from './usePluginsStore';

const activeProjectPath = '/workspace/project';

const refreshAfterOpenCodeRestartMock = mock(async () => undefined);
const startConfigUpdateMock = mock(() => undefined);
const finishConfigUpdateMock = mock(() => undefined);

mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: {
    getState: () => ({
      getActiveProject: () => ({ path: activeProjectPath }),
    }),
  },
}));

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getDirectory: () => '/fallback/project',
  },
}));

mock.module('@/stores/useAgentsStore', () => ({
  refreshAfterOpenCodeRestart: refreshAfterOpenCodeRestartMock,
}));

mock.module('@/lib/configUpdate', () => ({
  startConfigUpdate: startConfigUpdateMock,
  finishConfigUpdate: finishConfigUpdateMock,
}));

// mock.module is process-global in bun: another test file (e.g.
// useCommandsStore.test.ts) may have replaced '@/lib/runtime-fetch' with its
// own stub before this file runs. Register our own mock so this suite always
// reaches its fetch double regardless of test file ordering. Delegating to
// globalThis.fetch (instead of this file's double directly) keeps later test
// files that stub global fetch working if this registration outlives us.
mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

const { usePluginsStore } = await import('./usePluginsStore');

const entry: PluginEntry = {
  id: 'config:user:plugin-a',
  spec: 'plugin-a',
  scope: 'user',
  kind: 'config',
  parsedKind: 'npm',
};

const file: PluginFile = {
  id: 'file:user:plugin.ts',
  fileName: 'plugin.ts',
  scope: 'user',
  kind: 'file',
};

const pluginListPayload = {
  entries: [entry],
  files: [file],
};

const okMutationPayload = {
  success: true,
  requiresReload: false,
  message: 'ok',
  reloadDelayMs: 800,
  reloadFailed: false,
};

const registryOk: RegistryResult = {
  kind: 'npm-ok',
  spec: 'plugin-a',
  name: 'plugin-a',
  currentVersion: null,
  latestVersion: '1.0.0',
  versions: ['1.0.0'],
  hasUpdate: false,
};

const jsonResponse = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });

type FetchCall = {
  input: RequestInfo | URL;
  init?: RequestInit;
};

const fetchCalls: FetchCall[] = [];
let queuedResponses: Response[] = [];

const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  fetchCalls.push({ input, init });
  return queuedResponses.shift() ?? jsonResponse(pluginListPayload);
});

const queueFetchResponses = (responses: Response[]) => {
  queuedResponses = [...responses];
};

const resetStore = () => {
  usePluginsStore.setState({
    entries: [],
    files: [],
    selectedId: null,
    isLoading: false,
    registryInfo: {},
    isLoadingRegistry: false,
    draft: null,
  });
};

const registryCalls = (): FetchCall[] => fetchCalls.filter((call) => String(call.input).includes('/api/config/plugins/registry'));

const requestBody = (callIndex: number): unknown => {
  const init = fetchCalls[callIndex]?.init;
  return init?.body ? JSON.parse(String(init.body)) : undefined;
};

const flushPluginFollowUps = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('usePluginsStore', () => {
  beforeEach(() => {
    resetStore();
    fetchCalls.length = 0;
    queuedResponses = [];
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  test('loadPlugins calls config plugins endpoint once and populates entries/files', async () => {
    queueFetchResponses([jsonResponse(pluginListPayload), jsonResponse({ results: [registryOk] })]);

    const result = await usePluginsStore.getState().loadPlugins();
    await flushPluginFollowUps();

    expect(result).toBe(true);
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0]?.input).toBe('/api/config/plugins?directory=%2Fworkspace%2Fproject');
    expect(usePluginsStore.getState().entries).toEqual([entry]);
    expect(usePluginsStore.getState().files).toEqual([file]);
    expect(usePluginsStore.getState().isLoading).toBe(false);
  });

  test('second loadPlugins within TTL reuses cached store data', async () => {
    queueFetchResponses([jsonResponse(pluginListPayload), jsonResponse({ results: [registryOk] })]);

    await usePluginsStore.getState().loadPlugins();
    await usePluginsStore.getState().loadPlugins();
    await flushPluginFollowUps();

    expect(fetchCalls).toHaveLength(2);
  });

  test('force loadPlugins bypasses TTL cache', async () => {
    queueFetchResponses([jsonResponse(pluginListPayload), jsonResponse({ results: [registryOk] }), jsonResponse(pluginListPayload)]);

    await usePluginsStore.getState().loadPlugins();
    await usePluginsStore.getState().loadPlugins({ force: true });

    expect(fetchCalls).toHaveLength(3);
  });

  test('createEntry posts spec and scope in request body', async () => {
    queueFetchResponses([jsonResponse(okMutationPayload), jsonResponse(pluginListPayload)]);

    const result = await usePluginsStore.getState().createEntry({ spec: 'a', scope: 'user' });

    expect(result.ok).toBe(true);
    expect(fetchCalls[0]?.input).toBe('/api/config/plugins/entry?directory=%2Fworkspace%2Fproject');
    expect(fetchCalls[0]?.init?.method).toBe('POST');
    expect(requestBody(0)).toEqual({ spec: 'a', scope: 'user' });
  });

  test('createEntry includes options when provided', async () => {
    queueFetchResponses([jsonResponse(okMutationPayload), jsonResponse(pluginListPayload)]);

    await usePluginsStore.getState().createEntry({ spec: 'a', options: { enabled: true }, scope: 'project' });

    expect(requestBody(0)).toEqual({ spec: 'a', options: { enabled: true }, scope: 'project' });
  });

  test('updateEntry patches entry id path', async () => {
    queueFetchResponses([jsonResponse(okMutationPayload), jsonResponse(pluginListPayload)]);

    const result = await usePluginsStore.getState().updateEntry('entry-id', { spec: 'b' });

    expect(result.ok).toBe(true);
    expect(fetchCalls[0]?.input).toBe('/api/config/plugins/entry/entry-id?directory=%2Fworkspace%2Fproject');
    expect(fetchCalls[0]?.init?.method).toBe('PATCH');
    expect(requestBody(0)).toEqual({ spec: 'b' });
  });

  test('deleteEntry deletes entry id, invalidates cache, reloads, and clears selected id', async () => {
    queueFetchResponses([jsonResponse(pluginListPayload), jsonResponse({ results: [registryOk] }), jsonResponse(okMutationPayload), jsonResponse({ entries: [], files: [file] })]);
    await usePluginsStore.getState().loadPlugins();
    usePluginsStore.getState().setSelected(entry.id);

    const result = await usePluginsStore.getState().deleteEntry(entry.id);

    expect(result.ok).toBe(true);
    expect(fetchCalls[2]?.input).toBe(`/api/config/plugins/entry/${encodeURIComponent(entry.id)}?directory=%2Fworkspace%2Fproject`);
    expect(fetchCalls[2]?.init?.method).toBe('DELETE');
    expect(fetchCalls[3]?.input).toBe('/api/config/plugins?directory=%2Fworkspace%2Fproject');
    expect(usePluginsStore.getState().entries).toEqual([]);
    expect(usePluginsStore.getState().selectedId).toBeNull();
  });

  test('createFile posts file name, content, and scope', async () => {
    queueFetchResponses([jsonResponse(okMutationPayload), jsonResponse(pluginListPayload)]);

    const result = await usePluginsStore.getState().createFile({ fileName: 'plugin.ts', content: 'export {}', scope: 'user' });

    expect(result.ok).toBe(true);
    expect(fetchCalls[0]?.input).toBe('/api/config/plugins/file?directory=%2Fworkspace%2Fproject');
    expect(fetchCalls[0]?.init?.method).toBe('POST');
    expect(requestBody(0)).toEqual({ fileName: 'plugin.ts', content: 'export {}', scope: 'user' });
  });

  test('failed mutation returns ok false and leaves plugins unchanged', async () => {
    usePluginsStore.setState({ entries: [entry], files: [file] });
    queueFetchResponses([jsonResponse({ error: 'boom' }, { status: 500 })]);

    const result = await usePluginsStore.getState().createEntry({ spec: 'bad', scope: 'user' });

    expect(result).toEqual({ ok: false });
    expect(usePluginsStore.getState().entries).toEqual([entry]);
    expect(usePluginsStore.getState().files).toEqual([file]);
  });

  test('getById returns entries and files by id', () => {
    usePluginsStore.setState({ entries: [entry], files: [file] });

    expect(usePluginsStore.getState().getById(entry.id)).toEqual(entry);
    expect(usePluginsStore.getState().getById(file.id)).toEqual(file);
  });

  test('readFile fetches plugin file content', async () => {
    queueFetchResponses([jsonResponse({ fileName: 'plugin.ts', scope: 'user', content: 'export {}' })]);

    const result = await usePluginsStore.getState().readFile(file.id);

    expect(fetchCalls[0]?.input).toBe(`/api/config/plugins/file/${encodeURIComponent(file.id)}?directory=%2Fworkspace%2Fproject`);
    expect(result).toEqual({ fileName: 'plugin.ts', scope: 'user', content: 'export {}' });
  });

  test('loadRegistryInfo derives specs from entries and stores registry results', async () => {
    usePluginsStore.setState({ entries: [{ ...entry, spec: 'foo@1' }] });
    queueFetchResponses([
      jsonResponse({
        results: [{ kind: 'npm-ok', spec: 'foo@1', name: 'foo', currentVersion: '1', latestVersion: '2', hasUpdate: true, versions: ['1', '2'] }],
      }),
    ]);

    await usePluginsStore.getState().loadRegistryInfo();

    expect(String(fetchCalls[0]?.input)).toContain('specs=foo%401');
    expect(usePluginsStore.getState().registryInfo['foo@1']?.kind).toBe('npm-ok');
    expect(usePluginsStore.getState().isLoadingRegistry).toBe(false);
  });

  test('loadRegistryInfo force adds refresh flag', async () => {
    queueFetchResponses([jsonResponse({ results: [] })]);

    await usePluginsStore.getState().loadRegistryInfo({ specs: ['foo@1'], force: true });

    expect(String(fetchCalls[0]?.input)).toContain('refresh=true');
  });

  test('loadRegistryInfo accepts explicit comma-joined specs', async () => {
    queueFetchResponses([jsonResponse({ results: [] })]);

    await usePluginsStore.getState().loadRegistryInfo({ specs: ['x@1', 'y@2'] });

    expect(String(fetchCalls[0]?.input)).toContain('specs=x%401,y%402');
  });

  test('loadRegistryInfo skips empty specs and clears loading flag', async () => {
    usePluginsStore.setState({ isLoadingRegistry: true });

    await usePluginsStore.getState().loadRegistryInfo({ specs: [] });

    expect(fetchCalls).toHaveLength(0);
    expect(usePluginsStore.getState().isLoadingRegistry).toBe(false);
  });

  test('loadPlugins success triggers registry load without blocking result', async () => {
    queueFetchResponses([jsonResponse(pluginListPayload), jsonResponse({ results: [registryOk] })]);

    const result = await usePluginsStore.getState().loadPlugins();
    await flushPluginFollowUps();

    expect(result).toBe(true);
    expect(fetchCalls[0]?.input).toBe('/api/config/plugins?directory=%2Fworkspace%2Fproject');
    expect(registryCalls()).toHaveLength(1);
  });

  test('createEntry success refreshes registry for new spec with force', async () => {
    queueFetchResponses([jsonResponse(okMutationPayload), jsonResponse(pluginListPayload), jsonResponse({ results: [] })]);

    const result = await usePluginsStore.getState().createEntry({ spec: 'new-plugin@1', scope: 'user' });
    await flushPluginFollowUps();

    expect(result.ok).toBe(true);
    expect(registryCalls()).toHaveLength(1);
    expect(String(registryCalls()[0]?.input)).toContain('specs=new-plugin%401');
    expect(String(registryCalls()[0]?.input)).toContain('refresh=true');
  });

  test('updateEntry success refreshes changed spec with force', async () => {
    usePluginsStore.setState({ entries: [entry] });
    queueFetchResponses([jsonResponse(okMutationPayload), jsonResponse(pluginListPayload), jsonResponse({ results: [] })]);

    const result = await usePluginsStore.getState().updateEntry(entry.id, { spec: 'plugin-b@2' });
    await flushPluginFollowUps();

    expect(result.ok).toBe(true);
    expect(registryCalls()).toHaveLength(1);
    expect(String(registryCalls()[0]?.input)).toContain('specs=plugin-b%402');
    expect(String(registryCalls()[0]?.input)).toContain('refresh=true');
  });

  test('updateEntry success refreshes existing spec when spec unchanged', async () => {
    usePluginsStore.setState({ entries: [entry] });
    queueFetchResponses([jsonResponse(okMutationPayload), jsonResponse(pluginListPayload), jsonResponse({ results: [] })]);

    const result = await usePluginsStore.getState().updateEntry(entry.id, { options: { enabled: true } });
    await flushPluginFollowUps();

    expect(result.ok).toBe(true);
    expect(String(registryCalls()[0]?.input)).toContain('specs=plugin-a');
  });

  test('deleteEntry success removes deleted spec from registryInfo', async () => {
    usePluginsStore.setState({ entries: [entry], registryInfo: { [entry.spec]: registryOk } });
    queueFetchResponses([jsonResponse(okMutationPayload), jsonResponse({ entries: [], files: [] })]);

    const result = await usePluginsStore.getState().deleteEntry(entry.id);

    expect(result.ok).toBe(true);
    expect(usePluginsStore.getState().registryInfo[entry.spec]).toBe(undefined);
  });

  test('updateToLatest updates npm-ok entry to latest version', async () => {
    usePluginsStore.setState({
      entries: [{ ...entry, id: 'X', spec: 'foo@1' }],
      registryInfo: {
        'foo@1': { kind: 'npm-ok', spec: 'foo@1', name: 'foo', currentVersion: '1', latestVersion: '2', versions: ['1', '2'], hasUpdate: true },
      },
    });
    queueFetchResponses([jsonResponse(okMutationPayload), jsonResponse(pluginListPayload), jsonResponse({ results: [] })]);

    const result = await usePluginsStore.getState().updateToLatest('X');

    expect(result.ok).toBe(true);
    expect(fetchCalls[0]?.input).toBe('/api/config/plugins/entry/X?directory=%2Fworkspace%2Fproject');
    expect(requestBody(0)).toEqual({ spec: 'foo@2' });
  });

  test('updateToLatest returns ok false when hasUpdate is false', async () => {
    usePluginsStore.setState({ entries: [entry], registryInfo: { [entry.spec]: registryOk } });

    const result = await usePluginsStore.getState().updateToLatest(entry.id);

    expect(result).toEqual({ ok: false });
    expect(fetchCalls).toHaveLength(0);
  });

  test('updateToLatest returns ok false for missing package registry result', async () => {
    usePluginsStore.setState({
      entries: [entry],
      registryInfo: { [entry.spec]: { kind: 'npm-missing-package', spec: entry.spec, name: entry.spec, error: 'missing' } },
    });

    const result = await usePluginsStore.getState().updateToLatest(entry.id);

    expect(result).toEqual({ ok: false });
    expect(fetchCalls).toHaveLength(0);
  });

  test('loadRegistryInfo chunks long spec lists into multiple registry requests', async () => {
    const entries = Array.from({ length: 50 }, (_, index): PluginEntry => ({
      ...entry,
      id: `config:user:plugin-${index}`,
      spec: `plugin-${index}-${'x'.repeat(20)}@1.0.0`,
    }));
    usePluginsStore.setState({ entries });
    queueFetchResponses([jsonResponse({ results: [] }), jsonResponse({ results: [] })]);

    await usePluginsStore.getState().loadRegistryInfo();

    expect(registryCalls()).toHaveLength(2);
  });
});
