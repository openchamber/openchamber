import { afterAll, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { PluginFile } from '@/stores/usePluginsStore';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  Event: browser.Event, FocusEvent: browser.FocusEvent,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
  if (url.pathname === '/api/fs/home') return Response.json({ home: '/test' });
  if (url.pathname === '/api/location') return Response.json({ data: { directory: '/test' } });
  if (url.pathname === '/api/session') return Response.json({ data: [], cursor: {} });
  throw new Error(`Unexpected request: ${url.pathname}`);
});
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { usePluginsStore, getPluginsScopeKey } = await import('@/stores/usePluginsStore');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { getRuntimeKey } = await import('@/lib/runtime-switch');
const { PluginsPage } = await import('./PluginsPage');
const { PluginsGrid } = await import('./PluginsGrid');
const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);
afterAll(async () => {
  await act(async () => root.unmount());
  fetchSpy.mockRestore();
  browser.close();
});

test('one card opens the configured options editor, also when runtime status becomes unavailable', async () => {
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/project' }], activeProjectId: 'project' });
  usePluginsStore.setState({
    entries: [
      { id: 'memory-config', kind: 'config', scope: 'user', parsedKind: 'path', spec: './plugins/memory', sourcePath: '/config/opencode.jsonc', resolvedPath: '/config/plugins/memory', options: { enabled: true } },
      { id: 'secret-config', kind: 'config', scope: 'user', parsedKind: 'path', spec: './plugins/secret-input', sourcePath: '/config/opencode.jsonc' },
    ],
    files: ['memory', 'secret-input', 'strip-read-images'].map((name): PluginFile => ({ id: name, kind: 'package', scope: 'user', fileName: name, absolutePath: `/config/plugins/${name}` })),
    selectedId: null, draft: null, loadedDirectory: '/project', loadedRuntimeKey: getRuntimeKey(),
    loadPlugins: async () => true,
    runtime: { kind: 'ready', scope: getPluginsScopeKey('/project'), plugins: [{ source: { kind: 'local', path: '/config/plugins/memory/index.js' }, state: { kind: 'active' } }] },
    registryInfo: {},
  });
  await act(async () => root.render(<I18nProvider><PluginsPage /></I18nProvider>));
  expect(container.querySelectorAll('[title="memory"]')).toHaveLength(1);
  expect(container.querySelectorAll('[title="secret-input"]')).toHaveLength(1);
  expect(container.querySelectorAll('[title="strip-read-images"]')).toHaveLength(1);
  await act(async () => usePluginsStore.setState({ runtime: { kind: 'failed', scope: getPluginsScopeKey('/project') } }));
  expect(container.querySelectorAll('[title="memory"]')).toHaveLength(1);
  expect(container.querySelectorAll('[title="secret-input"]')).toHaveLength(1);
  expect(container.querySelectorAll('[title="strip-read-images"]')).toHaveLength(1);
  const card = container.querySelector('[title="memory"]')?.closest('button');
  if (!card) throw new Error('Plugin card missing');
  await act(async () => card.click());
  expect(usePluginsStore.getState().selectedId).toBe('memory-config');
  expect(container.querySelector('input')?.value).toBe('./plugins/memory');
  expect(JSON.parse(container.querySelector('textarea')?.value ?? '{}')).toEqual({ enabled: true });
});

test('keeps independent declarations and different same-name or nested targets', async () => {
  await act(async () => usePluginsStore.setState({
    entries: [
      { id: 'user', kind: 'config', scope: 'user', parsedKind: 'path', spec: './plugins/memory', sourcePath: '/config/opencode.jsonc', resolvedPath: '/config/plugins/memory', options: { owner: 'user' } },
      { id: 'project', kind: 'config', scope: 'project', parsedKind: 'path', spec: '/config/plugins/memory', sourcePath: '/project/opencode.json', resolvedPath: '/config/plugins/memory', options: { owner: 'project' } },
    ],
    files: [
      { id: 'same', kind: 'package', scope: 'user', fileName: 'memory', absolutePath: '/config-alias/plugins/memory', resolvedPath: '/config/plugins/memory' },
      { id: 'other', kind: 'package', scope: 'project', fileName: 'memory', absolutePath: '/elsewhere/plugins/memory' },
      { id: 'nested', kind: 'package', scope: 'user', fileName: 'nested', absolutePath: '/config/plugins/memory/nested' },
    ],
    selectedId: null, draft: null, registryInfo: {},
  }));
  expect(container.querySelectorAll('[title="memory"]')).toHaveLength(3);
  expect(container.querySelectorAll('[title="nested"]')).toHaveLength(1);
  const first = container.querySelector('[title="memory"]')?.closest('button');
  if (!first) throw new Error('User declaration card missing');
  await act(async () => first.click());
  expect(usePluginsStore.getState().selectedId).toBe('user');
  expect(JSON.parse(container.querySelector('textarea')?.value ?? '{}')).toEqual({ owner: 'user' });
  await act(async () => usePluginsStore.getState().setSelected(null));
  const second = container.querySelectorAll('[title="memory"]')[1]?.closest('button');
  if (!second) throw new Error('Project declaration card missing');
  await act(async () => second.click());
  expect(usePluginsStore.getState().selectedId).toBe('project');
  expect(JSON.parse(container.querySelector('textarea')?.value ?? '{}')).toEqual({ owner: 'project' });
});

test('a declared local file keeps its editor and file delete action', async () => {
  const deleted: unknown[] = [];
  await act(async () => {
    usePluginsStore.setState({
      entries: [{ id: 'file-config', kind: 'config', scope: 'user', parsedKind: 'path', spec: './plugins/memory.ts', resolvedPath: '/config/plugins/memory.ts' }],
      files: [{ id: 'memory-file', kind: 'file', scope: 'user', fileName: 'memory.ts', absolutePath: '/config/plugins/memory.ts' }],
      selectedId: null, draft: null,
    });
    root.render(<I18nProvider><PluginsGrid onAdd={() => {}} onDelete={(target) => deleted.push(target)} /></I18nProvider>);
  });
  const titles = container.querySelectorAll('[title="memory.ts"]');
  expect(titles).toHaveLength(2);
  const card = titles[1]?.closest('button');
  if (!card) throw new Error('Editable plugin file card missing');
  await act(async () => card.click());
  expect(usePluginsStore.getState().selectedId).toBe('memory-file');
  const actions = card.parentElement?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]');
  if (!actions) throw new Error('Plugin file actions missing');
  await act(async () => actions.click());
  const deleteItem = document.querySelector<HTMLElement>('[role="menuitem"]');
  if (!deleteItem) throw new Error('Plugin file delete action missing');
  await act(async () => deleteItem.click());
  expect(deleted).toEqual([{ kind: 'file', id: 'memory-file', label: 'memory.ts' }]);
});
