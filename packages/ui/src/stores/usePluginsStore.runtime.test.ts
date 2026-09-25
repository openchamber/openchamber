import { afterAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
});

type Handler = (request: Request) => Promise<Response>;
let handler: Handler = async (request) => {
  throw new Error(`Unexpected request: ${request.url}`);
};
const requests: Request[] = [];
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
  const request = input instanceof Request ? input : new Request(new URL(String(input), window.location.href), init);
  requests.push(request);
  return handler(request);
});

const { usePluginsStore, getPluginsScopeKey, getPluginUpdateKey } = await import('./usePluginsStore');
const { useProjectsStore } = await import('./useProjectsStore');

const inventory = {
  location: { directory: '/a' },
  data: [
    { id: 'foo', source: { type: 'package', target: 'foo', version: '1.0.0', outdated: true }, features: { server: true }, state: { status: 'active' } },
    { source: { type: 'local', path: '/a/.opencode/plugins/bad' }, features: { server: true }, state: { status: 'failed', error: 'Plugin entrypoint not found', ref: 'err_1' } },
    { id: 'opencode.x', source: { type: 'builtin' }, features: { server: true }, state: { status: 'active' } },
  ],
};

beforeEach(() => {
  requests.length = 0;
  useProjectsStore.setState({ projects: [{ id: 'a', path: '/a' }], activeProjectId: 'a' });
  usePluginsStore.setState({ runtime: { kind: 'idle' }, packageUpdates: {}, isCheckingUpdates: false });
});

afterAll(() => {
  fetchSpy.mockRestore();
  browser.close();
});

test('a successful read stores the inventory for the current directory', async () => {
  handler = async () => Response.json(inventory);
  expect(await usePluginsStore.getState().loadRuntime()).toBe(true);
  const runtime = usePluginsStore.getState().runtime;
  expect(runtime.kind).toBe('ready');
  if (runtime.kind !== 'ready') return;
  expect(runtime.scope).toBe(getPluginsScopeKey('/a'));
  expect(runtime.plugins).toEqual([
    { source: { kind: 'package', target: 'foo', version: '1.0.0', outdated: true, updating: false }, state: { kind: 'active' } },
    { source: { kind: 'local', path: '/a/.opencode/plugins/bad' }, state: { kind: 'failed', error: 'Plugin entrypoint not found', ref: 'err_1' } },
    { source: { kind: 'builtin' }, state: { kind: 'active' } },
  ]);
  const request = requests.find((item) => new URL(item.url).pathname === '/api/plugin');
  expect(request?.headers.get('x-opencode-directory')).toBe(encodeURIComponent('/a'));
});

test('a failed read is unknown status, not an empty inventory', async () => {
  handler = async () => Response.json(inventory);
  await usePluginsStore.getState().loadRuntime();
  handler = async () => new Response('down', { status: 500 });
  expect(await usePluginsStore.getState().loadRuntime()).toBe(false);
  expect(usePluginsStore.getState().runtime).toEqual({ kind: 'failed', scope: getPluginsScopeKey('/a') });
});

test('an older read that lands last does not replace a newer one', async () => {
  let releaseFirst: (response: Response) => void = () => undefined;
  let calls = 0;
  handler = () => {
    calls += 1;
    if (calls === 1) return new Promise<Response>((resolve) => { releaseFirst = resolve; });
    return Promise.resolve(Response.json({ ...inventory, data: [] }));
  };
  const first = usePluginsStore.getState().loadRuntime();
  await usePluginsStore.getState().loadRuntime();
  releaseFirst(Response.json(inventory));
  expect(await first).toBe(false);
  const runtime = usePluginsStore.getState().runtime;
  expect(runtime.kind === 'ready' ? runtime.plugins : null).toEqual([]);
});

test('a failed check keeps the inventory on screen', async () => {
  handler = async () => Response.json(inventory);
  await usePluginsStore.getState().loadRuntime();
  handler = async () => new Response('down', { status: 500 });
  expect(await usePluginsStore.getState().checkUpdates()).toBe(false);
  expect(usePluginsStore.getState().runtime.kind).toBe('ready');
  expect(usePluginsStore.getState().isCheckingUpdates).toBe(false);
});

test('an update sends one target and records its own failure', async () => {
  const key = getPluginUpdateKey(getPluginsScopeKey('/a'), 'foo');
  handler = async (request) => {
    if (new URL(request.url).pathname === '/api/plugin/update') {
      return Response.json(
        { _tag: 'ServiceUnavailableError', message: 'Failed to update plugin packages: foo: registry timeout', service: 'plugin' },
        { status: 503 },
      );
    }
    return Response.json(inventory);
  };
  expect(await usePluginsStore.getState().updatePackage('foo')).toBe(false);
  const update = requests.find((item) => new URL(item.url).pathname === '/api/plugin/update');
  expect(await update?.clone().json()).toEqual({ targets: ['foo'] });
  const failure = usePluginsStore.getState().packageUpdates[key];
  expect(failure?.kind).toBe('failed');
  expect(failure?.kind === 'failed' ? failure.error : '').toContain('registry timeout');

  handler = async (request) =>
    new URL(request.url).pathname === '/api/plugin/update' ? new Response(null, { status: 204 }) : Response.json(inventory);
  expect(await usePluginsStore.getState().updatePackage('foo')).toBe(true);
  expect(usePluginsStore.getState().packageUpdates[key]).toBeUndefined();
});
