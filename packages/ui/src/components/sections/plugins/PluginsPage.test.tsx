import { afterEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

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
const { usePluginsStore } = await import('@/stores/usePluginsStore');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { PluginsPage } = await import('./PluginsPage');
const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);
afterEach(async () => {
  await act(async () => root.unmount());
  fetchSpy.mockRestore();
  browser.close();
});

test('catalog refresh keeps unsaved plugin text and selection changes load the new entry', async () => {
  const entry = { id: 'one', spec: 'plugin-one', scope: 'user', kind: 'config', parsedKind: 'npm' } satisfies import('@/stores/usePluginsStore').PluginEntry;
  useProjectsStore.setState({ projects: [{ id: 'a', path: '/a' }, { id: 'b', path: '/b' }], activeProjectId: 'a' });
  const writes: Array<{ options: string; finish: () => void }> = [];
  usePluginsStore.setState({ entries: [entry], files: [], loadedDirectory: '/a', loadedRuntimeKey: (await import('@/lib/runtime-switch')).getRuntimeKey(), selectedId: entry.id, draft: null,
    updateEntry: async (id, input) => new Promise((resolve) => {
      const options = JSON.stringify(input.options);
      writes.push({ options, finish: () => {
        usePluginsStore.setState({ entries: [{ ...entry, id, options: input.options }] });
        resolve({ ok: true });
      } });
    }),
  });
  await act(async () => root.render(<I18nProvider><PluginsPage /></I18nProvider>));
  await act(async () => {
    const draft = usePluginsStore.getState().draft;
    if (!draft) throw new Error('Plugin draft missing');
    usePluginsStore.getState().setDraft({ ...draft, optionsJson: '{"value":"older"}' });
  });
  await act(async () => usePluginsStore.setState({ entries: [{ ...entry }] }));
  expect(usePluginsStore.getState().draft?.optionsJson).toBe('{"value":"older"}');
  const input = container.querySelector('input');
  if (!input) throw new Error('Plugin spec field missing');
  await act(async () => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
  expect(writes.map((write) => write.options)).toEqual(['{"value":"older"}']);
  await act(async () => {
    const draft = usePluginsStore.getState().draft;
    if (!draft) throw new Error('Plugin draft missing');
    usePluginsStore.getState().setDraft({ ...draft, optionsJson: '{"value":"newer"}' });
  });
  await act(async () => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
  await act(async () => { writes[0].finish(); });
  expect(usePluginsStore.getState().draft?.optionsJson).toBe('{"value":"newer"}');
  expect(writes.map((write) => write.options)).toEqual(['{"value":"older"}', '{"value":"newer"}']);
  await act(async () => { writes[1].finish(); });
  expect(usePluginsStore.getState().entries[0]?.options).toEqual({ value: 'newer' });
  await act(async () => usePluginsStore.setState({ entries: [{ ...entry, options: { value: 'external-edit' } }] }));
  expect(JSON.parse(usePluginsStore.getState().draft?.optionsJson ?? '{}')).toEqual({ value: 'external-edit' });
  await act(async () => usePluginsStore.setState({ entries: [{ ...entry, id: 'two', spec: 'plugin-two' }], selectedId: 'two' }));
  expect(usePluginsStore.getState().draft?.spec).toBe('plugin-two');

  const file = { id: 'file', fileName: 'plugin.ts', scope: 'user', kind: 'file' } satisfies import('@/stores/usePluginsStore').PluginFile;
  let content = 'initial';
  const fileWrites: Array<{ content: string; finish: () => void }> = [];
  await act(async () => usePluginsStore.setState({
    readFile: async () => ({ content, fileName: file.fileName, scope: file.scope }),
    updateFile: async (_id, data) => new Promise((resolve) => {
      const submitted = data.content ?? '';
      fileWrites.push({ content: submitted, finish: () => {
        content = submitted;
        usePluginsStore.setState({ files: [{ ...file }] });
        resolve({ ok: true });
      } });
    }),
  }));
  await act(async () => usePluginsStore.setState({ entries: [], files: [file], selectedId: file.id }));
  const textarea = container.querySelector('textarea');
  if (!textarea) throw new Error('Plugin file editor missing');
  const editFile = async (value: string) => {
    await act(async () => {
      const draft = usePluginsStore.getState().draft;
      if (!draft) throw new Error('Plugin file draft missing');
      usePluginsStore.getState().setDraft({ ...draft, content: value });
    });
    await act(async () => { textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
  };
  await editFile('older');
  await editFile('newer');
  await act(async () => { fileWrites[0].finish(); });
  expect(usePluginsStore.getState().draft?.content).toBe('newer');
  expect(fileWrites.map((write) => write.content)).toEqual(['older', 'newer']);
  await act(async () => { fileWrites[1].finish(); });
  expect(content).toBe('newer');
  await act(async () => {
    const draft = usePluginsStore.getState().draft;
    if (!draft) throw new Error('Plugin file draft missing');
    usePluginsStore.getState().setDraft({ ...draft, content: 'unsaved project A' });
  });
  await act(async () => useProjectsStore.setState({ activeProjectId: 'b' }));
  expect(usePluginsStore.getState().draft).toBeNull();
  content = 'project B file';
  await act(async () => usePluginsStore.setState({ files: [{ ...file }], loadedDirectory: '/b' }));
  expect(usePluginsStore.getState().draft?.content).toBe('project B file');
  const projectBEditor = container.querySelector('textarea');
  if (!projectBEditor) throw new Error('Project B file editor missing');
  await act(async () => { projectBEditor.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
  expect(fileWrites).toHaveLength(2);
});
