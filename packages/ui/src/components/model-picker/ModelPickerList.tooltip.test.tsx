import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

import type { ModelPickerEntry, ModelPickerProvider } from './ModelPickerList';

/**
 * The details card beside a highlighted row names the provider serving the
 * model, so two models with the same name from different providers can be told
 * apart in Favorites and Recent, where rows carry only a logo. Models without
 * capability or cost data get the card too.
 */

let ModelPickerList: typeof import('./ModelPickerList')['ModelPickerList'];
let dom: Window;
let root: Root;
let host: HTMLDivElement;
let restoreFetch: () => void;
const globals = new Map<string, PropertyDescriptor | undefined>();

// Two providers serve a model with the same name; neither has catalog data.
const providers: ModelPickerProvider[] = [
  { id: 'labcloud', name: 'Lab Cloud', models: [{ id: 'ds-flash', name: 'DeepSeek V4.1 Flash' }] },
  { id: 'labrouter', name: 'Lab Router', models: [{ id: 'ds-flash', name: 'DeepSeek V4.1 Flash' }] },
];
const favorites: ModelPickerEntry[] = providers.map((provider) => ({
  providerID: provider.id,
  modelID: 'ds-flash',
  model: provider.models![0],
}));
const autoEntry: ModelPickerEntry = { providerID: 'openchamber-auto', modelID: 'auto', model: { id: 'auto', name: 'Auto' } };

const labels = {
  searchPlaceholder: 'Search models',
  list: 'Models',
  noResults: 'No models found',
  favorites: 'Favorites',
  recent: 'Recent',
  keyboardHint: 'navigate',
  provider: 'Provider',
  capabilities: 'Capabilities',
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

const renderPicker = async (leadingEntry: ModelPickerEntry | null = null) => {
  await act(async () => {
    root.render(
      <ModelPickerList
        providers={providers}
        favoriteModels={favorites}
        recentModels={[]}
        searchQuery=""
        onSearchQueryChange={() => {}}
        onSelect={() => {}}
        labels={labels}
        leadingEntry={leadingEntry}
        autoFocus={false}
        stickyHeaders={false}
      />,
    );
  });
};

const rows = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];

/** A row's text as it shows on screen, without the provider name kept for screen readers. */
const visibleText = (row: HTMLElement) => row.textContent?.replace(row.querySelector('.sr-only')?.textContent ?? '', '');

/** Points at a row and waits out the card's hover delay. */
const hover = async (row: HTMLElement, x: number) => {
  await act(async () => {
    row.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: 10 }));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 500)); });
};

const cardText = () => document.querySelector('[data-slot="tooltip-content"]')?.textContent ?? null;

test('names the provider of each same-named favorite, without catalog data', async () => {
  await renderPicker();
  const [first, second] = rows();
  expect(visibleText(first)).toBe(visibleText(second));

  await hover(first, 1);
  expect(cardText()).toBe('ProviderLab Cloud');

  await hover(second, 2);
  expect(cardText()).toBe('ProviderLab Router');
});

test('the Auto row, which has no provider, gets no card', async () => {
  await renderPicker(autoEntry);
  const autoRow = rows().find((row) => row.textContent?.includes('Auto'));
  expect(autoRow).toBeDefined();

  await hover(autoRow!, 3);
  expect(cardText()).toBeNull();
});
