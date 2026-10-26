import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

import type { ModelPickerEntry, ModelPickerProvider } from './ModelPickerList';

/**
 * Focus stays in the search field while arrows move the highlight, so a screen
 * reader learns the highlighted row only through the field's
 * aria-activedescendant. That row must be a named option inside a listbox,
 * grouped under its provider, and the field must never point at a row that is
 * not in the page.
 */

let ModelPickerList: typeof import('./ModelPickerList')['ModelPickerList'];
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
  // The stores this list reads start background loads; keep them pending.
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => undefined));
  restoreFetch = () => fetch.mockRestore();
  ({ ModelPickerList } = await import('./ModelPickerList'));
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

const field = () => document.querySelector<HTMLInputElement>('input')!;

const press = async (key: 'ArrowDown' | 'ArrowUp') => {
  await act(async () => {
    field().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
};

/** The row the field points at, or null when it points at nothing. */
const activeRow = () => {
  const id = field().getAttribute('aria-activedescendant');
  return id ? document.getElementById(id) : null;
};

/** The name a screen reader reads for a row, from its aria-labelledby. */
const rowName = (row: Element) => (row.getAttribute('aria-labelledby') ?? '')
  .split(' ')
  .map((id) => document.getElementById(id)?.textContent)
  .filter(Boolean)
  .join(' ');

const highlightedRow = () => document.querySelector('[role="option"].bg-interactive-selection');

test('the search field is a combobox that points at the highlighted row as arrows move', async () => {
  await renderPicker();
  const listbox = document.querySelector('[role="listbox"]');
  expect(field().getAttribute('role')).toBe('combobox');
  expect(field().getAttribute('aria-controls')).toBe(listbox?.id ?? null);
  expect(listbox?.getAttribute('aria-label')).toBe('Models');

  expect(activeRow()).toBe(highlightedRow());
  expect(rowName(activeRow()!)).toBe('Alpha');

  await press('ArrowDown');
  const row = activeRow()!;
  expect(row).toBe(highlightedRow());
  expect(row.getAttribute('role')).toBe('option');
  // The star button inside the row is left out of its name.
  expect(rowName(row)).toBe('Beta');
  expect(row.closest('[role="group"]')?.getAttribute('aria-label')).toBe('Lab Small');
  expect(row.closest('[role="listbox"]')).toBe(listbox);
});

test('a favorite row, which shows its provider only as a logo, names the provider', async () => {
  await renderPicker([favorite]);
  const row = activeRow()!;
  expect(row.closest('[role="group"]')?.getAttribute('aria-label')).toBe('Favorites');
  expect(rowName(row)).toBe('Beta Lab Small');
});

test('the field never points at a row that is not in the page', async () => {
  await renderPicker();
  // Up from the first row wraps to the last row of the long section, which is
  // not mounted until the list scrolls to it.
  for (const key of ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowDown'] as const) {
    await press(key);
    const id = field().getAttribute('aria-activedescendant');
    if (id) expect(activeRow()).toBe(highlightedRow());
    else expect(highlightedRow()).toBeNull();
  }
});
