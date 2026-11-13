import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';

import type { ProjectFileSearchHit } from '@/lib/opencode/client';
import type { FileMentionHandle } from './FileMentionAutocomplete';

let FileMentionAutocomplete: typeof import('./FileMentionAutocomplete')['FileMentionAutocomplete'];
let I18nProvider: typeof import('@/lib/i18n')['I18nProvider'];
let SyncProvider: typeof import('@/sync/sync-context')['SyncProvider'];
let RuntimeAPIContext: typeof import('@/contexts/runtimeAPIContext')['RuntimeAPIContext'];
let apis: React.ContextType<typeof RuntimeAPIContext>;
let dom: Window;
let root: Root;
let host: HTMLDivElement;
let restore: Array<() => void>;
let searches: Array<{ query: string; type: string; toggled: boolean; resolve: (hits: ProjectFileSearchHit[]) => void }>;
let picked: string[];
const globals = new Map<string, PropertyDescriptor | undefined>();
const directory = '/mention-test';
const sdk = OpenCode.make({ baseUrl: 'http://mention.test', fetch: () => new Promise<Response>(() => undefined) });
// Past the popup's search debounce.
const DEBOUNCE_MS = 220;

beforeEach(async () => {
  dom = new Window({ url: 'http://localhost' });
  const values = {
    window: dom, document: dom.document, navigator: dom.navigator,
    localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
    Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement,
    HTMLInputElement: dom.HTMLInputElement, HTMLButtonElement: dom.HTMLButtonElement,
    SVGElement: dom.SVGElement, Document: dom.Document, ShadowRoot: dom.ShadowRoot,
    Event: dom.Event, MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent,
    KeyboardEvent: dom.KeyboardEvent, CustomEvent: dom.CustomEvent,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(values)) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  // Keep unrelated bootstrap requests pending.
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => undefined));
  ({ I18nProvider } = await import('@/lib/i18n'));
  ({ SyncProvider } = await import('@/sync/sync-context'));
  ({ RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext'));
  ({ FileMentionAutocomplete } = await import('./FileMentionAutocomplete'));
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  apis = createWebAPIs();
  const { useFileSearchStore } = await import('@/stores/useFileSearchStore');
  const { useConfigStore } = await import('@/stores/useConfigStore');
  const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
  const { useUIStore } = await import('@/stores/useUIStore');
  const priorSearch = useFileSearchStore.getState();
  const priorConfig = useConfigStore.getState();
  const priorDirectory = useDirectoryStore.getState();
  const priorUI = useUIStore.getState();
  restore = [
    () => fetch.mockRestore(),
    () => useFileSearchStore.setState(priorSearch),
    () => useConfigStore.setState(priorConfig),
    () => useDirectoryStore.setState(priorDirectory),
    () => useUIStore.setState(priorUI),
  ];
  searches = [];
  picked = [];
  useDirectoryStore.setState({ currentDirectory: directory });
  useUIStore.setState({ isMobile: false });
  useConfigStore.setState({ agents: [] });
  useFileSearchStore.setState({
    invalidateDirectory: () => undefined,
    searchFiles: (_directory, query, _limit, options) => new Promise<ProjectFileSearchHit[]>((resolve) => {
      searches.push({ query, type: options?.type ?? 'file', toggled: options?.includeHidden !== undefined, resolve });
    }),
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  const { createRoot } = await import('react-dom/client');
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  restore.forEach((undo) => undo());
  host.remove();
  await dom.happyDOM.close();
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  globals.clear();
});

const handle = React.createRef<FileMentionHandle>();

const type = (searchQuery: string) => act(async () => root.render(
  <SyncProvider sdk={sdk} directory="">
    <I18nProvider>
      <RuntimeAPIContext.Provider value={apis}>
        <FileMentionAutocomplete
          ref={handle}
          searchQuery={searchQuery}
          onClose={() => undefined}
          onFileSelect={(file) => picked.push(file.relativePath ?? file.path)}
        />
      </RuntimeAPIContext.Provider>
    </I18nProvider>
  </SyncProvider>,
));

const settleDebounce = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS));
});

const hit = (relativePath: string): ProjectFileSearchHit => ({
  name: relativePath.split('/').pop() ?? relativePath,
  path: `${directory}/${relativePath}`,
  relativePath,
});

/** Answers the file and folder searches sent for `query`. */
const answer = (query: string, files: string[]) => act(async () => {
  const sent = searches.filter((search) => search.query === query);
  expect(sent.map((search) => search.type).sort()).toEqual(['directory', 'file', 'file']);
  for (const search of sent) search.resolve(search.type === 'file' ? files.map(hit) : []);
});

/** Answers only OpenCode's index for `query`; the toggles' file search stays open. */
const answerIndexed = (query: string, files: string[]) => act(async () => {
  for (const search of searches) {
    if (search.query !== query) continue;
    if (search.type === 'directory') search.resolve([]);
    else if (!search.toggled) search.resolve(files.map(hit));
  }
});

/** Answers the toggles' file search for `query`. */
const answerToggled = (query: string, files: string[]) => act(async () => {
  searches.find((search) => search.query === query && search.type === 'file' && search.toggled)?.resolve(files.map(hit));
});

const press = (key: string) => act(async () => handle.current?.handleKeyDown(key));

// A file row names its path in its label; the text holds it twice, once for measuring.
const pathOf = (row: Element | null) => row?.querySelector('[aria-label]')?.getAttribute('aria-label') ?? null;
const rows = () => Array.from(host.querySelectorAll('.cursor-pointer')).map(pathOf);
const selectedRow = () => pathOf(host.querySelector('.bg-interactive-selection'));
const spinner = () => host.querySelector('[data-spinner]');
const empty = () => host.textContent?.includes('No matches found') ?? false;
const busy = () => host.querySelector('[data-mention-list]')?.getAttribute('aria-busy') === 'true';

test('the first query shows one loading row, and says nothing matched only once its search answers', async () => {
  await type('zz');
  expect(spinner()).not.toBeNull();
  expect(empty()).toBe(false);

  await settleDebounce();
  expect(spinner()).not.toBeNull();
  expect(empty()).toBe(false);

  await answer('zz', []);
  expect(spinner()).toBeNull();
  expect(empty()).toBe(true);
});

test('rows of the last answer stay while the next query searches, then give way to its answer', async () => {
  await type('ap');
  await settleDebounce();
  await answer('ap', ['src/app.ts', 'src/map.ts']);
  expect(rows()).toEqual(['src/app.ts', 'src/map.ts']);
  expect(busy()).toBe(false);

  // Typed on: the rows hold, marked busy, through the debounce and the search.
  await type('app');
  expect(rows()).toEqual(['src/app.ts', 'src/map.ts']);
  expect(busy()).toBe(true);
  expect(spinner()).toBeNull();
  await settleDebounce();
  expect(rows()).toEqual(['src/app.ts', 'src/map.ts']);
  expect(busy()).toBe(true);

  await answer('app', ['src/app.ts', 'src/apple.ts']);
  expect(rows()).toEqual(['src/app.ts', 'src/apple.ts']);
  expect(busy()).toBe(false);

  // An answer of nothing replaces the rows with "no matches", never a spinner first.
  await type('appz');
  expect(rows()).toEqual(['src/app.ts', 'src/apple.ts']);
  await settleDebounce();
  expect(spinner()).toBeNull();
  await answer('appz', []);
  expect(rows()).toEqual([]);
  expect(empty()).toBe(true);
});

test('files from the index show while the search behind the toggles still runs, and its rows join later', async () => {
  await type('ap');
  await settleDebounce();
  await answerIndexed('ap', ['src/app.ts']);
  expect(rows()).toEqual(['src/app.ts']);
  expect(busy()).toBe(false);

  await answerToggled('ap', ['src/app.ts', '.config/app.json']);
  expect(rows()).toEqual(['src/app.ts', '.config/app.json']);
});

test('an empty index answer keeps searching until the search behind the toggles answers', async () => {
  await type('ap');
  await settleDebounce();
  await answerIndexed('ap', []);
  expect(spinner()).not.toBeNull();
  expect(empty()).toBe(false);

  await answerToggled('ap', ['.config/app.json']);
  expect(rows()).toEqual(['.config/app.json']);
});

test('rows that join later keep the selection on the row the keyboard moved to', async () => {
  await type('ap');
  await settleDebounce();
  await answerIndexed('ap', ['src/app.ts', 'src/map.ts']);
  await press('ArrowDown');
  expect(selectedRow()).toBe('src/map.ts');

  // The joining row ranks above the selected one, which moves down with it.
  await answerToggled('ap', ['src/app.ts', 'src/map.ts', 'ap.json']);
  expect(rows()).toEqual(['ap.json', 'src/app.ts', 'src/map.ts']);
  expect(selectedRow()).toBe('src/map.ts');
  await press('Enter');
  expect(picked).toEqual(['src/map.ts']);
});

test('rows that join later keep the selection on the row the mouse is on', async () => {
  await type('ap');
  await settleDebounce();
  await answerIndexed('ap', ['src/app.ts', 'src/map.ts']);
  await act(async () => {
    host.querySelectorAll('.cursor-pointer')[1]?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
  });
  expect(selectedRow()).toBe('src/map.ts');

  await answerToggled('ap', ['src/app.ts', 'src/map.ts', 'ap.json']);
  expect(selectedRow()).toBe('src/map.ts');
});

test('an arrow press before the first answer does not keep later rows out', async () => {
  await type('ap');
  await settleDebounce();
  await answer('ap', ['src/ap.ts']);
  await type('app');
  await press('ArrowDown');
  await settleDebounce();

  await answerIndexed('app', ['src/app.ts']);
  await answerToggled('app', ['src/app.ts', '.config/app.json']);
  expect(rows()).toEqual(['src/app.ts', '.config/app.json']);
  expect(selectedRow()).toBe('src/app.ts');
});

test('an answer to an older query never shows as the newer one\'s', async () => {
  await type('ab');
  await settleDebounce();
  await type('abc');
  await settleDebounce();
  await answer('ab', ['src/ab.ts']);
  expect(rows()).toEqual([]);
  expect(spinner()).not.toBeNull();

  await answer('abc', ['src/abc.ts']);
  expect(rows()).toEqual(['src/abc.ts']);
});

test('the keyboard keeps its row while results update, and Enter picks the row it shows', async () => {
  await type('ap');
  await settleDebounce();
  await answer('ap', ['src/app.ts', 'src/map.ts']);
  await press('ArrowDown');
  expect(selectedRow()).toBe('src/map.ts');

  await type('app');
  await settleDebounce();
  expect(selectedRow()).toBe('src/map.ts');
  await press('Enter');
  expect(picked).toEqual(['src/map.ts']);

  // A new answer starts at its best match.
  await answer('app', ['src/app.ts', 'src/apple.ts']);
  expect(selectedRow()).toBe('src/app.ts');
  await press('ArrowDown');
  await press('Enter');
  expect(picked).toEqual(['src/map.ts', 'src/apple.ts']);
});
