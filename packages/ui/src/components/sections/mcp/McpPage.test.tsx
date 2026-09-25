import { afterEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, HTMLTextAreaElement: browser.HTMLTextAreaElement,
  Event: browser.Event, FocusEvent: browser.FocusEvent, CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ home: '/test' }));
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useMcpConfigStore } = await import('@/stores/useMcpConfigStore');
const { useMcpStore } = await import('@/stores/useMcpStore');
const { McpPage } = await import('./McpPage');
const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);
afterEach(async () => { await act(async () => root.unmount()); fetchSpy.mockRestore(); browser.close(); });

test('an MCP catalog echo preserves a newer draft before and after save completion', async () => {
  const writes: Array<{ value: string; finish: () => void }> = [];
  const server = { name: 'test', type: 'remote' as const, url: 'https://initial.test' };
  useMcpStore.setState({ refresh: async () => {} });
  useMcpConfigStore.setState({
    selectedMcpName: 'test', serversByDirectory: { __default__: [server] },
    getMcpByName: () => useMcpConfigStore.getState().serversByDirectory.__default__?.[0] ?? null,
    updateMcp: async (_name, config) => new Promise((resolve) => {
      writes.push({ value: config.url ?? '', finish: () => resolve({ ok: true }) });
    }),
  });
  await act(async () => { root.render(<I18nProvider><McpPage /></I18nProvider>); });
  const field = [...container.querySelectorAll<HTMLInputElement>('input')].find((entry) => entry.value === server.url);
  if (!field) throw new Error('Missing MCP URL field');
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setValue) throw new Error('Missing input setter');
  const edit = async (value: string, blur = true) => {
    await act(async () => { setValue.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
    if (blur) await act(async () => { field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
  };
  await edit('https://older.test ');
  await edit('https://newer.test', false);
  expect(writes.map((write) => write.value)).toEqual(['https://older.test ']);
  const echo = () => useMcpConfigStore.setState({ serversByDirectory: { __default__: [{ ...server, url: 'https://older.test' }] } });
  await act(async () => { echo(); });
  expect(field.value).toBe('https://newer.test');
  await act(async () => { writes[0].finish(); });
  await act(async () => { echo(); });
  expect(field.value).toBe('https://newer.test');
  await act(async () => { field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
  expect(writes.map((write) => write.value)).toEqual(['https://older.test ', 'https://newer.test']);
  await act(async () => { echo(); });
  expect(field.value).toBe('https://newer.test');
  await act(async () => {
    useMcpConfigStore.setState({ selectedMcpName: 'other', serversByDirectory: { __default__: [{ ...server, name: 'other', url: 'https://older.test ' }] } });
  });
  expect(field.value).toBe('https://older.test ');
  await act(async () => { writes[1].finish(); });
});
