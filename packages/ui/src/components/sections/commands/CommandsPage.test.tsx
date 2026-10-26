import { afterEach, expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  sessionStorage: browser.sessionStorage,
  Node: browser.Node,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  HTMLTextAreaElement: browser.HTMLTextAreaElement,
  Event: browser.Event,
  FocusEvent: browser.FocusEvent,
  CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
  const request = new Request(input instanceof Request ? input : new URL(input, window.location.href), init);
  const path = new URL(request.url).pathname;
  if (path === '/api/fs/home') return Response.json({ home: '/test' });
  if (path === '/api/config/settings') return Response.json({});
  throw new Error(`Unexpected request: ${request.method} ${path}`);
});

// React's input-event support is detected when react-dom loads.
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
// Match Vite's eager asset glob when the real model selector loads in Bun.
plugin({
  name: 'command-settings-provider-logos',
  setup(build) {
    build.onLoad({ filter: /useProviderLogo\.ts$/ }, ({ path }) => {
      const directory = resolve(dirname(path), '../assets/provider-logos');
      const logos = Object.fromEntries(readdirSync(directory).filter((name) => name.endsWith('.svg')).map((name) => [
        `../assets/provider-logos/${name}`, pathToFileURL(resolve(directory, name)).href,
      ]));
      return { contents: readFileSync(path, 'utf8').replace(/import\.meta\.glob<string>\([\s\S]*?\);/, `${JSON.stringify(logos)};`), loader: 'ts' };
    });
  },
});
const { CommandsPage } = await import('./CommandsPage');
const { useCommandsStore } = await import('@/stores/useCommandsStore');
const initialStore = useCommandsStore.getState();
const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);

afterEach(async () => {
  await act(async () => root.unmount());
  useCommandsStore.setState(initialStore, true);
  await new Promise((resolve) => setTimeout(resolve, 350));
  fetchSpy.mockRestore();
  browser.close();
});

test('a command refresh during save preserves the newer draft for the queued save', async () => {
  const writes: Array<{ template: string; publish: () => void; finish: (success?: boolean) => void }> = [];
  const command = { name: 'example', template: 'initial' };
  useCommandsStore.setState({
    selectedCommandName: command.name,
    commands: [command],
    commandsByDirectory: { __default__: [command] },
    updateCommand: async (_name, config) => new Promise<boolean>((resolve) => {
      writes.push({ template: config.template || '', publish: () => {
        const updated = { ...command, ...config };
        useCommandsStore.setState({ commands: [updated], commandsByDirectory: { __default__: [updated] } });
      }, finish: (success = true) => resolve(success) });
    }),
  });
  await act(async () => { root.render(<I18nProvider><CommandsPage /></I18nProvider>); });
  const prompt = container.querySelector<HTMLTextAreaElement>('textarea[rows="12"]');
  if (!prompt) throw new Error('Missing command template');
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (!setValue) throw new Error('Missing native textarea setter');
  const edit = async (value: string) => {
    await act(async () => {
      setValue.call(prompt, value);
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { prompt.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
  };
  await edit(' older ');
  await edit('newer');
  expect(writes.map((write) => write.template)).toEqual(['older']);
  // updateCommand publishes the refreshed catalog before its promise settles.
  await act(async () => { writes[0].publish(); });
  expect(prompt.value).toBe('newer');
  await act(async () => { writes[0].finish(); });
  expect(writes.map((write) => write.template)).toEqual(['older', 'newer']);
  await act(async () => { writes[1].publish(); writes[1].finish(); });
  expect(prompt.value).toBe('newer');

  // React may process the refreshed catalog only after the save has settled.
  await edit(' trimmed ');
  await edit('latest');
  await act(async () => { writes[2].publish(); writes[2].finish(); });
  await act(async () => { writes[2].publish(); });
  expect(prompt.value).toBe('latest');
  expect(writes.map((write) => write.template)).toEqual(['older', 'newer', 'trimmed', 'latest']);
  await act(async () => { writes[3].publish(); writes[3].finish(); });

  // A failed write must leave the draft dirty so the next blur retries it.
  await edit('retry me');
  await act(async () => { writes[4].finish(false); });
  expect(prompt.value).toBe('retry me');
  await act(async () => { prompt.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
  expect(writes.map((write) => write.template)).toEqual(['older', 'newer', 'trimmed', 'latest', 'retry me', 'retry me']);
  await act(async () => { writes[5].publish(); writes[5].finish(); });

  // An old completion must not replace the baseline for a different command.
  await edit('pending');
  const other = { name: 'other', template: 'other initial' };
  await act(async () => {
    useCommandsStore.setState({ selectedCommandName: other.name, commands: [other], commandsByDirectory: { __default__: [other] } });
  });
  expect(prompt.value).toBe('other initial');
  await act(async () => { writes[6].finish(); });
  await act(async () => { prompt.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
  expect(writes).toHaveLength(7);
});
