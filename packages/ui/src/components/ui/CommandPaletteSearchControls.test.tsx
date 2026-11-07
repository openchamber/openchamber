import React, { act } from 'react';
import { expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { parseOmniQuery } from '@/lib/search/omniQuery';

type TestMenuContextValue = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete?: (open: boolean) => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  finalFocusRef: React.RefObject<(() => boolean) | null>;
};
const TestMenuContext = React.createContext<TestMenuContextValue | null>(null);
const useTestMenu = () => {
  const context = React.useContext(TestMenuContext);
  if (!context) throw new Error('Test menu component requires a root');
  return context;
};

mock.module('./dropdown-menu', () => ({
  DropdownMenu: ({ open, onOpenChange, onOpenChangeComplete, children }: React.PropsWithChildren<Pick<TestMenuContextValue, 'open' | 'onOpenChange' | 'onOpenChangeComplete'>>) => {
    const triggerRef = React.useRef<HTMLButtonElement>(null);
    const finalFocusRef = React.useRef<(() => boolean) | null>(null);
    const wasOpen = React.useRef(open);
    React.useLayoutEffect(() => {
      if (wasOpen.current && !open) {
        onOpenChangeComplete?.(false);
        if (finalFocusRef.current?.() !== false) triggerRef.current?.focus();
      }
      wasOpen.current = open;
    }, [onOpenChangeComplete, open]);
    return <TestMenuContext.Provider value={{ open, onOpenChange, onOpenChangeComplete, triggerRef, finalFocusRef }}>{children}</TestMenuContext.Provider>;
  },
  DropdownMenuTrigger: ({ children, ref, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { ref?: React.RefObject<HTMLButtonElement | null> }) => {
    const menu = useTestMenu();
    return <button {...props} ref={(element) => {
      menu.triggerRef.current = element;
      if (ref) ref.current = element;
    }} onClick={() => menu.onOpenChange(!menu.open)}>{children}</button>;
  },
  DropdownMenuContent: ({ children, finalFocus, ...props }: React.HTMLAttributes<HTMLDivElement> & { finalFocus: () => boolean }) => {
    const menu = useTestMenu();
    menu.finalFocusRef.current = finalFocus;
    return menu.open ? <div {...props}>{children}</div> : null;
  },
  DropdownMenuLabel: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuRadioGroup: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  DropdownMenuRadioItem: ({ children, closeOnClick: _closeOnClick, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { closeOnClick?: boolean }) => <button {...props}>{children}</button>,
}));

const { CommandPaletteSearchControls } = await import('./CommandPaletteSearchControls');

const withDom = async (run: (host: HTMLElement, root: Root) => Promise<void>) => {
  const dom = new Window({ url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent,
    MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent, KeyboardEvent: dom.KeyboardEvent,
    getComputedStyle: dom.getComputedStyle.bind(dom), MutationObserver: dom.MutationObserver,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try { await run(host, root); } finally {
    await act(async () => root.unmount());
    await dom.happyDOM.abort();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
};

const defaults: React.ComponentProps<typeof CommandPaletteSearchControls> = {
  query: 'find this', category: 'all', onQueryChange: () => {},
  projects: [{ value: '/repos/first', label: 'First project' }, { value: '/repos/second', label: 'Second project' }],
  worktrees: [{ value: '/trees/first', label: 'First branch' }, { value: '/trees/actual', label: 'Actual branch' }],
  mobile: false, allowArchived: true, reasoningAvailable: true, onRefocus: () => {},
};
const render = async (root: Root, props: Partial<typeof defaults> = {}) => {
  await act(async () => root.render(<I18nProvider><CommandPaletteSearchControls {...defaults} {...props} /></I18nProvider>));
};
const openFilters = async (host: HTMLElement) => {
  await act(async () => host.querySelector<HTMLButtonElement>('[data-palette-filters-trigger]')?.click());
};
const choose = async (key: string, value: string) => {
  const option = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-palette-filter-option]'))
    .find((element) => element.getAttribute('data-palette-filter-option') === `${key}:${value}`);
  expect(option).toBeDefined();
  await act(async () => option?.click());
};

test('category tabs are separate from the sole raised filter trigger and write category flags', () => withDom(async (host, root) => {
  const changes: string[] = [];
  let refocus = 0;
  const filterButtonRef = React.createRef<HTMLButtonElement>();
  await render(root, { query: 'needle type:message project:App', category: 'messages', onQueryChange: (value) => changes.push(value), onRefocus: () => { refocus += 1; }, filterButtonRef });
  const tablist = host.querySelector('[role="tablist"]');
  expect(tablist?.querySelectorAll('[role="tab"]')).toHaveLength(5);
  expect(tablist?.querySelector('[data-palette-filters-trigger]')).toBeNull();
  expect(host.querySelectorAll('[data-palette-filters-trigger]')).toHaveLength(1);
  expect(filterButtonRef.current).toBe(host.querySelector('[data-palette-filters-trigger]'));
  expect(filterButtonRef.current?.title).toContain('Alt+↓');
  expect(host.querySelector('[data-palette-category="messages"]')?.getAttribute('aria-selected')).toBe('true');
  await act(async () => host.querySelector<HTMLButtonElement>('[data-palette-category="files"]')?.click());
  expect(parseOmniQuery(changes[0])).toEqual({ text: 'needle', filters: { category: 'files', project: 'App' } });
  await act(async () => host.querySelector<HTMLButtonElement>('[data-palette-category="all"]')?.click());
  expect(parseOmniQuery(changes[1]).filters).toEqual({ project: 'App' });
  expect(refocus).toBe(2);
}));

test('arrow navigation moves category focus without changing query or handling Tab', () => withDom(async (host, root) => {
  const changes: string[] = [];
  await render(root, { onQueryChange: (value) => changes.push(value) });
  const all = host.querySelector<HTMLButtonElement>('[data-palette-category="all"]');
  all?.focus();
  await act(async () => all?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(host.querySelector('[data-palette-category="sessions"]'));
  const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  host.querySelector('[role="tablist"]')?.dispatchEvent(tab);
  expect(tab.defaultPrevented).toBe(false);
  expect(changes).toEqual([]);
}));

test('desktop filter selection keeps search focus after the dismissal callback', () => withDom(async (host, root) => {
  const search = document.createElement('input');
  document.body.prepend(search);
  const changes: string[] = [];
  await render(root, {
    onQueryChange: (value) => changes.push(value),
    onRefocus: () => search.focus(),
  });
  search.focus();
  await openFilters(host);
  await choose('searchIn', 'titles');
  expect(parseOmniQuery(changes[0]).filters.searchIn).toBe('titles');
  expect(document.querySelector('[data-palette-filters-panel]')).toBeNull();
  expect(document.activeElement).toBe(search);
}));

test('desktop dismissal without a filter selection returns focus to the trigger', () => withDom(async (host, root) => {
  await render(root);
  const trigger = host.querySelector<HTMLButtonElement>('[data-palette-filters-trigger]');
  await openFilters(host);
  await act(async () => trigger?.click());
  expect(document.activeElement).toBe(trigger);
}));

test('mobile sheet exposes actual project/worktree options and typed selected state, then refocuses after dismissal', () => withDom(async (host, root) => {
  const changes: string[] = [];
  const dismissed: boolean[] = [];
  await render(root, {
    mobile: true, query: 'needle project:/repos/second worktree:/trees/actual search:titles author:user in:all',
    onQueryChange: (value) => changes.push(value),
    onRefocus: () => dismissed.push(document.querySelector('[data-palette-filters-panel]') === null),
  });
  expect(host.querySelector('[data-palette-filters-trigger]')?.getAttribute('aria-label')?.endsWith('4')).toBe(true);
  await openFilters(host);
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.querySelectorAll('[data-palette-filter-group="lifecycle"] button')).toHaveLength(3);
  const selected = document.querySelector('[data-palette-filter-option="worktree:/trees/actual"]');
  expect(selected?.getAttribute('aria-checked')).toBe('true');
  expect(selected?.textContent).toBe('Actual branch');
  expect(document.querySelector('[data-palette-filter-option="project:/repos/second"]')?.getAttribute('aria-checked')).toBe('true');
  await choose('worktree', '/trees/first');
  expect(parseOmniQuery(changes[0]).filters.worktree).toBe('/trees/first');
  expect(dismissed).toEqual([true]);
  await openFilters(host);
  await choose('project', '');
  expect(parseOmniQuery(changes[1]).filters.project).toBeUndefined();
  await openFilters(host);
  await choose('worktree', '');
  expect(parseOmniQuery(changes[2]).filters.worktree).toBeUndefined();
}));

test('mobile filter callbacks preserve text and flags while unavailable archive/reasoning choices are absent', () => withDom(async (host, root) => {
  const changes: string[] = [];
  await render(root, { mobile: true, allowArchived: false, reasoningAvailable: false, query: 'needle type:message', onQueryChange: (value) => changes.push(value) });
  await openFilters(host);
  expect(document.querySelectorAll('[data-palette-filter-group="lifecycle"] button')).toHaveLength(1);
  expect(document.querySelectorAll('[data-palette-filter-group="author"] [role="radio"]')).toHaveLength(3);
  expect(document.querySelector('[data-palette-filter-option="author:reasoning"]')).toBeNull();
  await choose('author', 'assistant');
  expect(parseOmniQuery(changes[0])).toEqual({ text: 'needle', filters: { category: 'messages', author: 'assistant' } });
  await openFilters(host);
  await choose('searchIn', 'titles');
  expect(parseOmniQuery(changes[1]).filters.searchIn).toBe('titles');
  await openFilters(host);
  const active = document.querySelector<HTMLButtonElement>('[data-palette-filter-group="lifecycle"] button');
  expect(active?.getAttribute('aria-pressed')).toBe('true');
  await act(async () => active?.click());
  expect(parseOmniQuery(changes[2]).filters.lifecycle).toBe('active');
}));

test('archive-enabled default selects Both, Active writes an explicit flag, and Both clears it', () => withDom(async (host, root) => {
  const changes: string[] = [];
  await render(root, { mobile: true, allowArchived: true, query: 'needle project:App', onQueryChange: (value) => changes.push(value) });
  await openFilters(host);
  const lifecycle = document.querySelectorAll<HTMLButtonElement>('[data-palette-filter-group="lifecycle"] button');
  expect(lifecycle[2].getAttribute('aria-pressed')).toBe('true');
  expect(lifecycle[0].getAttribute('aria-pressed')).toBe('false');
  await act(async () => lifecycle[0].click());
  expect(parseOmniQuery(changes[0])).toEqual({ text: 'needle', filters: { project: 'App', lifecycle: 'active' } });
  await render(root, { mobile: true, allowArchived: true, query: changes[0], onQueryChange: (value) => changes.push(value) });
  await openFilters(host);
  const narrowed = document.querySelectorAll<HTMLButtonElement>('[data-palette-filter-group="lifecycle"] button');
  expect(narrowed[0].getAttribute('aria-pressed')).toBe('true');
  await act(async () => narrowed[2].click());
  expect(parseOmniQuery(changes[1])).toEqual({ text: 'needle', filters: { project: 'App' } });
}));

test('mobile lifecycle choices write archive flags and default choices remove their flags', () => withDom(async (host, root) => {
  const changes: string[] = [];
  await render(root, { mobile: true, query: 'needle in:all author:reasoning search:titles', onQueryChange: (value) => changes.push(value) });
  await openFilters(host);
  const lifecycle = document.querySelectorAll<HTMLButtonElement>('[data-palette-filter-group="lifecycle"] button');
  expect(lifecycle[2].getAttribute('aria-pressed')).toBe('true');
  await act(async () => lifecycle[1].click());
  expect(parseOmniQuery(changes[0]).filters.lifecycle).toBe('archived');
  await openFilters(host);
  expect(document.querySelector('[data-palette-filter-option="author:reasoning"]')?.getAttribute('aria-checked')).toBe('true');
  await choose('author', 'any');
  expect(parseOmniQuery(changes[1]).filters.author).toBeUndefined();
  await openFilters(host);
  await choose('searchIn', 'everything');
  expect(parseOmniQuery(changes[2]).filters.searchIn).toBeUndefined();
  expect(parseOmniQuery(changes[2]).text).toBe('needle');
}));
