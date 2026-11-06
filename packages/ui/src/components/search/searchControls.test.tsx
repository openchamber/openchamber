import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';

import type { OmniFilters } from '@/lib/search/omniQuery';
let I18nProvider: typeof import('@/lib/i18n')['I18nProvider'];
let SearchFilterSelect: typeof import('./SearchFilterSelect')['SearchFilterSelect'];
let SearchScopeMenu: typeof import('./SearchScopeMenu')['SearchScopeMenu'];

// Import browser-dependent primitives after installing the DOM globals.

const withDom = async (run: (host: HTMLElement, root: Root) => Promise<void>) => {
  const dom = new Window({ url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent,
    HTMLButtonElement: dom.HTMLButtonElement, HTMLInputElement: dom.HTMLInputElement, FocusEvent: dom.FocusEvent, ResizeObserver: dom.ResizeObserver,
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
  ({ I18nProvider } = await import('@/lib/i18n'));
  ({ SearchFilterSelect } = await import('./SearchFilterSelect'));
  ({ SearchScopeMenu } = await import('./SearchScopeMenu'));
  const { createRoot } = await import('react-dom/client');
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

const drain = async () => {
  for (let i = 0; i < 20; i += 1) await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); });
};

const SCOPE_OPTIONS = { lifecycle: true, project: { currentAvailable: true }, searchIn: true, author: false };
const DEFAULTS = { lifecycle: 'active', searchIn: 'everything' } as const;

type Change = [string, string | null];

const renderScope = async (root: Root, filters: OmniFilters, layout: 'sidebar' | 'mobile', changes: Change[]) => {
  await act(async () => root.render(
    <I18nProvider>
      <SearchScopeMenu filters={filters} defaults={DEFAULTS} options={SCOPE_OPTIONS} onChange={(key, value) => changes.push([key, value])} resultCount={2} layout={layout} />
    </I18nProvider>,
  ));
};

const openScope = async (host: HTMLElement) => {
  await act(async () => host.querySelector<HTMLButtonElement>('[data-search-scope-trigger]')?.click());
  await drain();
};

test('sidebar scope uses a floating menu with a stable summary and count slot', () => withDom(async (host, root) => {
  const changes: Change[] = [];
  await renderScope(root, {}, 'sidebar', changes);
  expect(host.querySelector('details')).toBeNull();
  expect(host.querySelector('[data-slot="dropdown-menu-trigger"]')).not.toBeNull();
  expect(host.querySelector('[data-search-scope-count]')?.textContent).toBe('2');
  expect(document.querySelector('[data-search-scope-panel]')).toBeNull();
  expect(changes).toEqual([]);
}));

test('mobile scope menu shows one filters button and opens a sheet with the same controls', () => withDom(async (host, root) => {
  const changes: Change[] = [];
  await renderScope(root, {}, 'mobile', changes);
  const opener = host.querySelector<HTMLButtonElement>('[data-search-scope-menu] button');
  expect(opener).not.toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();

  await act(async () => opener?.click());
  await drain();
  const sheet = document.querySelector<HTMLElement>('[role="dialog"]');
  expect(sheet).not.toBeNull();
  const choose = async (key: string, index: number) => {
    const button = sheet?.querySelectorAll<HTMLButtonElement>(`[data-search-scope-control="${key}"] button`)[index];
    expect(button).toBeDefined();
    await act(async () => button?.click());
  };
  expect(sheet?.querySelectorAll('[data-search-scope-control="lifecycle"] button')).toHaveLength(3);
  await choose('lifecycle', 2);
  await choose('project', 1);
  await choose('searchIn', 1);
  expect(changes).toEqual([['lifecycle', 'all'], ['project', 'current'], ['searchIn', 'titles']]);
  await renderScope(root, { project: 'current', searchIn: 'titles' }, 'mobile', changes);
  await choose('project', 0);
  await choose('searchIn', 0);
  expect(changes.slice(-2)).toEqual([['project', null], ['searchIn', 'everything']]);
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
}));

test('mobile sheet honors disabled project and emits author keys', () => withDom(async (host, root) => {
  const changes: Change[] = [];
  await act(async () => root.render(<I18nProvider><SearchScopeMenu filters={{}} defaults={DEFAULTS} options={{ ...SCOPE_OPTIONS, author: true, project: { currentAvailable: false } }} onChange={(key, value) => changes.push([key, value])} resultCount={null} layout="mobile" /></I18nProvider>));
  await openScope(host);
  const project = document.querySelectorAll<HTMLButtonElement>('[data-search-scope-control="project"] button');
  expect(project[1].disabled).toBe(true);
  await act(async () => project[1].click());
  expect(changes).toEqual([]);
  const authors = document.querySelectorAll<HTMLButtonElement>('[data-search-scope-control="author"] button');
  expect(authors).toHaveLength(3);
  await act(async () => authors[2].click());
  expect(changes).toEqual([['author', 'assistant']]);
}));

test('each archive filter select owns a trigger that shows its current value', () => withDom(async (host, root) => {
  const valueText = (filter: string) => host.querySelector(`[data-search-filter="${filter}"] [data-slot="select-value"]`)?.textContent ?? '';
  await act(async () => root.render(
    <I18nProvider>
      <SearchFilterSelect filter="lifecycle" value="active" onChange={() => {}} />
      <SearchFilterSelect filter="searchIn" value="titles" onChange={() => {}} />
      <SearchFilterSelect filter="author" value="user" onChange={() => {}} />
    </I18nProvider>,
  ));
  expect(host.querySelectorAll('[data-search-filter]')).toHaveLength(3);
  expect(host.querySelector('[data-search-filter="lifecycle"]')?.getAttribute('aria-label')).toBe('Show');
  expect(host.querySelector('[data-search-filter="searchIn"]')?.getAttribute('aria-label')).toBe('Search in');
  expect(host.querySelector('[data-search-filter="author"]')?.getAttribute('aria-label')).toBe('Author');
  const lifecycleBefore = valueText('lifecycle');
  expect(lifecycleBefore).not.toBe('');
  expect(valueText('searchIn')).not.toBe(valueText('lifecycle'));
  expect(valueText('author')).not.toBe(valueText('searchIn'));

  await act(async () => root.render(
    <I18nProvider>
      <SearchFilterSelect filter="lifecycle" value="archived" onChange={() => {}} />
    </I18nProvider>,
  ));
  expect(valueText('lifecycle')).not.toBe(lifecycleBefore);
  expect(host.querySelector('[data-search-filter="lifecycle"]')?.getAttribute('aria-label')).toBe('Show');
}));

const PROJECT_CHOICES = [{ value: '/repos/alpha', label: 'Alpha' }, { value: 'current', label: 'Current domain project' }] as const;
const WORKTREE_CHOICES = [{ value: '/repos/alpha/feature', label: 'Feature branch' }, { value: 'all', label: 'All domain worktree' }] as const;

test('mobile scope choices emit domain values and reflect selected project and worktree', () => withDom(async (host, root) => {
  const changes: Change[] = [];
  const render = async (filters: OmniFilters) => act(async () => root.render(<I18nProvider><SearchScopeMenu filters={filters} defaults={DEFAULTS} options={{ ...SCOPE_OPTIONS, project: { currentAvailable: false } }} projectOptions={PROJECT_CHOICES} worktreeOptions={WORKTREE_CHOICES} onChange={(key, value) => changes.push([key, value])} resultCount={null} layout="mobile" /></I18nProvider>));
  await render({ project: '/repos/alpha', worktree: '/repos/alpha/feature' });
  await openScope(host);
  const buttons = (key: string) => [...document.querySelectorAll<HTMLButtonElement>(`[data-search-scope-control="${key}"] button`)];
  expect(buttons('project').map((button) => button.textContent)).toEqual(['All projects', 'Alpha', 'Current domain project']);
  expect(buttons('worktree').map((button) => button.textContent)).toEqual(['All', 'Feature branch', 'All domain worktree']);
  expect(buttons('project')[1].getAttribute('aria-pressed')).toBe('true');
  expect(buttons('worktree')[1].getAttribute('aria-pressed')).toBe('true');
  await act(async () => buttons('project')[2].click());
  await act(async () => buttons('worktree')[2].click());
  expect(changes).toEqual([['project', 'current'], ['worktree', 'all']]);
  await render({ project: 'current', worktree: 'all' });
  expect(buttons('project')[2].getAttribute('aria-pressed')).toBe('true');
  expect(buttons('worktree')[2].getAttribute('aria-pressed')).toBe('true');
  await act(async () => buttons('project')[0].click());
  await act(async () => buttons('worktree')[0].click());
  expect(changes.slice(-2)).toEqual([['project', null], ['worktree', null]]);
  await render({});
  expect(buttons('project')[0].getAttribute('aria-pressed')).toBe('true');
  expect(buttons('worktree')[0].getAttribute('aria-pressed')).toBe('true');
}));

test('sidebar scope choices show selected labels and emit raw values', () => withDom(async (host, root) => {
  const changes: Change[] = [];
  const openMenu = async () => {
    await act(async () => host.querySelector<HTMLElement>('[data-search-scope-trigger]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    await drain();
  };
  await act(async () => root.render(<I18nProvider><SearchScopeMenu filters={{ project: '/repos/alpha', worktree: '/repos/alpha/feature' }} defaults={DEFAULTS} options={{ ...SCOPE_OPTIONS, project: null }} projectOptions={PROJECT_CHOICES} worktreeOptions={WORKTREE_CHOICES} onChange={(key, value) => changes.push([key, value])} resultCount={null} layout="sidebar" /></I18nProvider>));
  expect(host.querySelector('[data-search-scope-trigger]')?.textContent).toBe('Active · Alpha · Feature branch');
  await openMenu();
  const project = document.querySelector<HTMLElement>('[data-search-scope-option="project:/repos/alpha"]');
  const worktree = document.querySelector<HTMLElement>('[data-search-scope-option="worktree:/repos/alpha/feature"]');
  expect(project?.getAttribute('aria-checked')).toBe('true');
  expect(worktree?.getAttribute('aria-checked')).toBe('true');
  await act(async () => document.querySelector<HTMLElement>('[data-search-scope-option="project:current"]')?.click());
  expect(changes).toEqual([['project', 'current']]);
  await openMenu();
  await act(async () => document.querySelector<HTMLElement>('[data-search-scope-option="worktree:all"]')?.click());
  expect(changes.slice(-1)).toEqual([['worktree', 'all']]);
  await openMenu();
  await act(async () => document.querySelector<HTMLElement>('[data-search-scope-option="project:"]')?.click());
  await openMenu();
  await act(async () => document.querySelector<HTMLElement>('[data-search-scope-option="worktree:"]')?.click());
  expect(changes.slice(-2)).toEqual([['project', null], ['worktree', null]]);
}));

// happy-dom has no layout, so this pins the classes that bound the chips to the panel and the
// full label that stays in the accessible name; the 390px geometry is checked in a real browser.
// The label is 80 characters long, the same length the 390px browser check uses.
test('mobile scope chips are width-bound and keep a long project label whole', () => withDom(async (host, root) => {
  const LONG_PROJECT = 'Project label long enough to need truncation inside the mobile filter sheet here';
  expect(LONG_PROJECT).toHaveLength(80);
  await act(async () => root.render(<I18nProvider><SearchScopeMenu filters={{}} defaults={DEFAULTS} options={{ ...SCOPE_OPTIONS, project: { currentAvailable: false } }} projectOptions={[{ value: '/repos/long', label: LONG_PROJECT }]} onChange={() => {}} resultCount={null} layout="mobile" /></I18nProvider>));
  const trigger = host.querySelector<HTMLButtonElement>('[data-search-scope-trigger]');
  expect(trigger?.classList.contains('min-h-[44px]')).toBe(true);
  await openScope(host);
  const group = document.querySelector<HTMLElement>('[data-search-scope-control="project"] [role="group"]');
  expect(group?.classList.contains('[&>button]:max-w-full')).toBe(true);
  expect(group?.classList.contains('[&>button]:min-w-0')).toBe(true);
  expect(group?.classList.contains('[&>button]:min-h-[44px]')).toBe(true);
  const longChip = group?.querySelectorAll<HTMLButtonElement>('button')[1];
  expect(longChip?.textContent).toBe(LONG_PROJECT);
  expect(longChip?.querySelector('span')?.classList.contains('truncate')).toBe(true);
  expect(document.querySelectorAll('[data-search-scope-control="lifecycle"] button')).toHaveLength(3);
}));
