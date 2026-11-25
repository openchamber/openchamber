import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

import type { SpaceEntry } from '@/lib/spaces/spaces-api';
import type { ModelPickerEntry, ModelPickerProvider } from './ModelPickerList';

// Type-only imports above: the modules load after the DOM globals exist.
let ModelPickerList: typeof import('./ModelPickerList')['ModelPickerList'];
let useSpaceModelPicker: typeof import('@/lib/spaces/useSpaceModelPicker')['useSpaceModelPicker'];
let useSpacesStore: typeof import('@/lib/spaces/spaces-store')['useSpacesStore'];
let useConfigStore: typeof import('@/stores/useConfigStore')['useConfigStore'];
let useComposerFollowsSpace: typeof import('@/lib/spaces/useComposerFollowsSpace')['useComposerFollowsSpace'];
let I18nProvider: typeof import('@/lib/i18n')['I18nProvider'];
let dom: Window;
let root: Root;
let host: HTMLDivElement;
let restoreFetch: () => void;
const globals = new Map<string, PropertyDescriptor | undefined>();

const ID = 'a1b2c3d4e5f6';
const DIRECTORY = `/spaces/${ID}/app`;
const target = { requestId: null, directory: DIRECTORY };
const anthropic = { kind: 'model' as const, id: 'anthropic', provider: 'anthropic', upstream: 'https://api.anthropic.com/v1', source: { kind: 'env' as const, name: 'KEY' }, url: 'http://gatekeeper:8080/model/anthropic' };
const openai = { ...anthropic, id: 'openai', provider: 'openai' };
const space = (change: Partial<SpaceEntry> = {}): SpaceEntry => ({
  id: ID, name: 'Fix login', placeId: 'docker', machine: null, projectDirectory: '/home/me/app', projectFolder: { path: '/home/me/app', found: true },
  directory: DIRECTORY, state: 'running', stoppedIdle: false, step: null, failure: null, network: { mode: 'allowlist', domains: [] },
  grants: [anthropic], access: 'granted', needsAccess: [], accessFailures: [], damage: null, setup: null, ...change,
});
const providers: ModelPickerProvider[] = [
  { id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude', name: 'Claude' }] },
  { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt', name: 'GPT' }, { id: 'gpt-mini', name: 'GPT Mini' }] },
  { id: 'opencode', name: 'OpenCode', models: [{ id: 'big-pickle', name: 'Big Pickle' }] },
];
const entry = (providerID: string, index = 0): ModelPickerEntry => {
  const model = providers.find((provider) => provider.id === providerID)!.models![index];
  return { providerID, modelID: String(model.id), model };
};
const labels = { searchPlaceholder: 'Search', list: 'Models', noResults: 'No models found', favorites: 'Favorites', recent: 'Recent', keyboardHint: 'navigate' };

beforeEach(async () => {
  dom = new Window({ url: 'http://localhost', width: 1280, height: 800 });
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
  // happy-dom lays nothing out; the list's scroller gets a menu's height so
  // the virtual list mounts the rows in view, as it does in a browser.
  for (const [name, size] of [['clientHeight', 400], ['clientWidth', 380]] as const) {
    Object.defineProperty(dom.HTMLElement.prototype, name, {
      configurable: true,
      get(this: HTMLElement) { return this.classList.contains('overlay-scrollbar-target') ? size : 0; },
    });
  }
  // The stores this list reads start background loads; keep them pending.
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => undefined));
  restoreFetch = () => fetch.mockRestore();
  ({ ModelPickerList } = await import('./ModelPickerList'));
  ({ useSpaceModelPicker } = await import('@/lib/spaces/useSpaceModelPicker'));
  ({ useSpacesStore } = await import('@/lib/spaces/spaces-store'));
  ({ useConfigStore } = await import('@/stores/useConfigStore'));
  ({ useComposerFollowsSpace } = await import('@/lib/spaces/useComposerFollowsSpace'));
  ({ I18nProvider } = await import('@/lib/i18n'));
  useSpacesStore.getState().resetForRuntimeSwitch();
  host = document.createElement('div');
  document.body.appendChild(host);
  const { createRoot } = await import('react-dom/client');
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  restoreFetch();
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  globals.clear();
  await dom.happyDOM.abort();
  dom.close();
});


const list = (change: Partial<SpaceEntry> = {}) => useSpacesStore.getState().applyJourney([space(change)], useSpacesStore.getState().progressRevision);
let openStates: boolean[] = [];

const Picker: React.FC<{ directory?: string; query?: string }> = ({ directory = DIRECTORY, query = '' }) => {
  const spaceTarget = React.useMemo(() => ({ requestId: null, directory }), [directory]);
  const picker = useSpaceModelPicker(spaceTarget, providers, (open) => openStates.push(open));
  return (
    <ModelPickerList
      providers={providers}
      favoriteModels={[entry('openai')]}
      recentModels={[entry('openai', 1), entry('opencode')]}
      leadingEntry={{ providerID: 'openchamber', modelID: 'auto', model: { id: 'auto', name: 'Auto' } }}
      space={picker}
      searchQuery={query}
      onSearchQueryChange={() => {}}
      onSelect={() => {}}
      labels={labels}
      autoFocus={false}
      stickyHeaders={false}
    />
  );
};
const render = async (props: React.ComponentProps<typeof Picker> = {}) => {
  openStates = [];
  await act(async () => root.render(<I18nProvider><Picker {...props} /></I18nProvider>));
};
const rows = () => Array.from(document.querySelectorAll('[role="option"]'), (row) => (row.querySelector('.font-medium')?.textContent ?? ''));

test('a space lists only its providers, favorites, recents, Auto and search included, and ends with Grant access', async () => {
  list();
  await render();
  expect(rows()).toEqual(['Claude', 'Grant access']);
  await render({ query: 'gpt' });
  expect(document.body.textContent).toContain('No models found');
  expect(rows()).toEqual(['Grant access']);
});

test('the host keeps the whole list and no Grant access row', async () => {
  list();
  await render({ directory: '/home/me/app' });
  expect(rows()).toEqual(['Auto', 'GPT', 'GPT Mini', 'Big Pickle', 'Claude', 'GPT', 'GPT Mini', 'Big Pickle']);
});

test('a grant given while the picker is open adds the provider', async () => {
  list();
  await render();
  await act(async () => useSpacesStore.getState().noteGrantGiven(ID, openai));
  expect(rows()).toContain('GPT Mini');
});

test('Grant access opens the dialog and the picker comes back when it closes', async () => {
  list();
  await render();
  const row = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).at(-1)!;
  await act(async () => row.click());
  expect(useSpacesStore.getState().accessDialog).toEqual({ spaceId: ID, providerId: null });
  expect(openStates).toEqual([false]);
  await act(async () => useSpacesStore.getState().closeAccessDialog());
  expect(openStates).toEqual([false, true]);
});

test('the row says what a stopped space or a lost key needs, and a space without grants says it has none', async () => {
  list({ state: 'exited', access: null });
  await render();
  expect(rows()).toEqual(['Claude', 'Start the space to grant access']);
  await act(async () => list({ access: 'needs_access', needsAccess: ['anthropic'] }));
  expect(rows()).toEqual(['Grant Anthropic access again']);
  await act(async () => list({ grants: [], access: null }));
  expect(document.body.textContent).toContain('This space has no access to any model');
  expect(rows()).toEqual(['Grant access']);
});

const catalogModel = (providerID: string, modelID: string) => ({
  id: modelID, modelID, providerID, name: modelID, capabilities: { tools: true, input: ['text'], output: ['text'] }, variants: [], time: { released: 0 },
  cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }], status: 'active' as const, enabled: true, limit: { context: 0, output: 0 },
});
const Follower: React.FC = () => { useComposerFollowsSpace(target, null); return null; };
const seedComposer = (activeDirectoryKey: string) => useConfigStore.setState({
  activeDirectoryKey, directoryScoped: {}, currentProviderId: 'opencode', currentModelId: 'big-pickle', selectionSource: 'manual',
  providers: [['opencode', 'big-pickle'], ['anthropic', 'claude'], ['openai', 'gpt']].map(([id, model]) => ({ id, name: id, activation: 'enabled' as const, package: id, models: [catalogModel(id, model)] })),
});
const shown = () => [useConfigStore.getState().currentProviderId, useConfigStore.getState().currentModelId];

test('opening a draft in a space shows a model it may use, and losing access moves it again', async () => {
  seedComposer(DIRECTORY);
  await act(async () => root.render(<Follower />));
  expect(shown()).toEqual(['opencode', 'big-pickle']);
  await act(async () => list({ access: 'unknown' }));
  expect(shown()).toEqual(['opencode', 'big-pickle']);
  await act(async () => list({ state: 'exited', access: null }));
  expect(shown()).toEqual(['anthropic', 'claude']);
  // Moving is not the user's pick: it must not travel to the next folder as one.
  expect(useConfigStore.getState().selectionSource).toBe('auto');
  await act(async () => list({ grants: [anthropic, openai], access: 'needs_access', needsAccess: ['anthropic'] }));
  expect(shown()).toEqual(['openai', 'gpt']);
});

test('a composer still on the host folder keeps its model until the space folder is active', async () => {
  seedComposer('/home/me/app');
  list();
  await act(async () => root.render(<Follower />));
  expect(shown()).toEqual(['opencode', 'big-pickle']);
});
