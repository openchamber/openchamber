import { expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import type { OmniFilters } from '@/lib/search/omniQuery';

let I18nProvider: typeof import('@/lib/i18n')['I18nProvider'];
let SearchScopeMenu: typeof import('@/components/search/SearchScopeMenu')['SearchScopeMenu'];
let useSessionSearchEffects: typeof import('./useSessionSearchEffects')['useSessionSearchEffects'];

const DEFAULTS = { lifecycle: 'active', searchIn: 'everything' } as const;
const SCOPE_OPTIONS = { lifecycle: true, project: { currentAvailable: true }, searchIn: true, author: false };

const drain = async () => {
  for (let index = 0; index < 20; index += 1) {
    await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); });
  }
};

const withDom = async (run: (host: HTMLElement, root: Root) => Promise<void>) => {
  const dom = new Window({ url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    location: dom.location,
    // Settings rows read stores that load from storage when imported.
    localStorage: dom.localStorage,
    Element: dom.Element,
    HTMLElement: dom.HTMLElement,
    Node: dom.Node,
    Event: dom.Event,
    CustomEvent: dom.CustomEvent,
    HTMLButtonElement: dom.HTMLButtonElement,
    HTMLInputElement: dom.HTMLInputElement,
    FocusEvent: dom.FocusEvent,
    ResizeObserver: dom.ResizeObserver,
    MouseEvent: dom.MouseEvent,
    PointerEvent: dom.PointerEvent,
    KeyboardEvent: dom.KeyboardEvent,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    MutationObserver: dom.MutationObserver,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const host = document.createElement('div');
  document.body.append(host);
  ({ I18nProvider } = await import('@/lib/i18n'));
  ({ SearchScopeMenu } = await import('@/components/search/SearchScopeMenu'));
  ({ useSessionSearchEffects } = await import('./useSessionSearchEffects'));
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(host);
  try {
    await run(host, root);
  } finally {
    await act(async () => root.unmount());
    await dom.happyDOM.abort();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
};

type HarnessProps = {
  closeSessionSearch: () => void;
  isSessionSearchOpen?: boolean;
  showUnrelatedScope?: boolean;
};

function ScopeMenu({ filters = {} }: { filters?: OmniFilters }) {
  return (
    <SearchScopeMenu
      filters={filters}
      defaults={DEFAULTS}
      options={SCOPE_OPTIONS}
      onChange={() => undefined}
      resultCount={2}
      layout="sidebar"
    />
  );
}

function SearchEffectsHarness({ closeSessionSearch, isSessionSearchOpen = true, showUnrelatedScope = false }: HarnessProps) {
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  useSessionSearchEffects({
    isSessionSearchOpen,
    openSessionSearch: () => undefined,
    closeSessionSearch,
    sessionSearchInputRef: inputRef,
    sessionSearchContainerRef: containerRef,
  });
  return (
    <>
      <div data-session-search-container ref={containerRef}>
        <input ref={inputRef} />
        <ScopeMenu />
      </div>
      {showUnrelatedScope ? <div data-unrelated-scope-menu><ScopeMenu filters={{ lifecycle: 'archived' }} /></div> : null}
    </>
  );
}

const openScopeMenu = async (trigger: Element) => {
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
  await drain();
};

const firstScopeOption = (trigger: Element): Element => {
  const popupId = trigger.getAttribute('aria-controls');
  expect(popupId).not.toBeNull();
  const popup = document.getElementById(popupId!);
  expect(popup).not.toBeNull();
  const option = popup?.querySelector('[data-search-scope-option]');
  expect(option).not.toBeNull();
  return option!;
};

test('mousedown in the owned portaled scope menu keeps session search open', () => withDom(async (host, root) => {
  let closes = 0;
  await act(async () => root.render(<I18nProvider><SearchEffectsHarness closeSessionSearch={() => { closes += 1; }} /></I18nProvider>));
  const trigger = host.querySelector('[data-session-search-container] [data-search-scope-trigger]');
  expect(trigger).not.toBeNull();
  await openScopeMenu(trigger!);

  firstScopeOption(trigger!).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

  expect(closes).toBe(0);
}));

test('mousedown in an unrelated portaled scope menu closes session search', () => withDom(async (host, root) => {
  let closes = 0;
  await act(async () => root.render(<I18nProvider><SearchEffectsHarness closeSessionSearch={() => { closes += 1; }} showUnrelatedScope /></I18nProvider>));
  const trigger = host.querySelector('[data-unrelated-scope-menu] [data-search-scope-trigger]');
  expect(trigger).not.toBeNull();
  await openScopeMenu(trigger!);

  firstScopeOption(trigger!).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

  expect(closes).toBe(1);
}));

test('mousedown on a plain outside element closes session search', () => withDom(async (_host, root) => {
  let closes = 0;
  await act(async () => root.render(<I18nProvider><SearchEffectsHarness closeSessionSearch={() => { closes += 1; }} /></I18nProvider>));
  const outside = document.createElement('div');
  document.body.append(outside);

  outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

  expect(closes).toBe(1);
}));


test('closing session search removes the outside mousedown listener', () => withDom(async (_host, root) => {
  let closes = 0;
  const closeSessionSearch = () => { closes += 1; };
  await act(async () => root.render(<I18nProvider><SearchEffectsHarness closeSessionSearch={closeSessionSearch} /></I18nProvider>));
  await act(async () => root.render(<I18nProvider><SearchEffectsHarness closeSessionSearch={closeSessionSearch} isSessionSearchOpen={false} /></I18nProvider>));

  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

  expect(closes).toBe(0);
}));

test('unmount removes the outside mousedown listener', () => withDom(async (_host, root) => {
  let closes = 0;
  await act(async () => root.render(<I18nProvider><SearchEffectsHarness closeSessionSearch={() => { closes += 1; }} /></I18nProvider>));
  await act(async () => root.render(null));

  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

  expect(closes).toBe(0);
}));
