import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { ModelPickerEntry, ModelPickerProvider } from './ModelPickerList';

/**
 * A model OpenCode's config hides (`hidden: true`) stays out of OpenChamber's
 * pickers too, as it stays out of OpenCode's own. Oracle: OpenCode's contract
 * for `hidden` (picker-only; still routable).
 */
let ModelPickerList: typeof import('./ModelPickerList')['ModelPickerList'];
let useOpenCodeModelSettings: typeof import('@/lib/opencodeModelSettings')['useOpenCodeModelSettings'];
let dom: Window;
let root: Root;
let host: HTMLDivElement;
let restoreFetch: () => void;
const globals = new Map<string, PropertyDescriptor | undefined>();

const providers: ModelPickerProvider[] = [
  { id: 'labsmall', name: 'Lab Small', models: [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }] },
  // Long enough that the section mounts only the rows near the viewport.
  { id: 'labbig', name: 'Lab Big', models: Array.from({ length: 60 }, (_, index) => ({ id: `big-${index + 1}`, name: `Big Model ${index + 1}` })) },
];
const favorite: ModelPickerEntry = { providerID: 'labsmall', modelID: 'beta', model: providers[0].models![1] };

const labels = {
  searchPlaceholder: 'Search models',
  list: 'Models',
  noResults: 'No models found',
  favorites: 'Favorites',
  recent: 'Recent',
  keyboardHint: 'navigate',
  favorite: 'Favorite',
  unfavorite: 'Unfavorite',
};

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
  ({ useOpenCodeModelSettings } = await import('@/lib/opencodeModelSettings'));
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

const renderPicker = async (favoriteModels: ModelPickerEntry[] = []) => {
  await act(async () => {
    root.render(
      <ModelPickerList
        providers={providers}
        favoriteModels={favoriteModels}
        recentModels={[]}
        searchQuery=""
        onSearchQueryChange={() => {}}
        onSelect={() => {}}
        labels={labels}
        onToggleFavorite={() => {}}
        isFavorite={(entry) => entry.modelID === favorite.modelID}
        autoFocus={false}
        stickyHeaders={false}
      />,
    );
  });
};


test('a model hidden in OpenCode\'s config is left out of the list, the rest stay', async () => {
  useOpenCodeModelSettings.setState({ status: 'ready', models: { 'labsmall/beta': { hidden: true } } });
  try {
    await renderPicker();
    const names = [...document.querySelectorAll('[role="option"]')].map((row) => row.textContent ?? '');
    expect(names.some((name) => name.includes('Alpha'))).toBe(true);
    expect(names.some((name) => name.includes('Beta'))).toBe(false);
  } finally {
    useOpenCodeModelSettings.setState({ status: 'idle', models: {} });
  }
});
