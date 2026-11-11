import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { parseOmniQuery } from './omniQuery';
import { absorbTypedFilters, omniQueryString, readRememberedFilters, rememberFilters, useOmniSearchState, withoutDefaults } from './omniSearchState';

const storageKey = 'openchamber.search.filters.v1.sidebar';

test('absorbs completed flags and retains unfinished, unknown, and malformed input', () => {
  expect(absorbTypedFilters('find in:archived', {}, {})).toEqual({ text: 'find in:archived', filters: {} });
  expect(absorbTypedFilters('find in:archived ', {}, {})).toEqual({ text: 'find ', filters: { lifecycle: 'archived' } });
  expect(absorbTypedFilters('foo:bar in: ', {}, { commit: true })).toEqual({ text: 'foo:bar in:', filters: {} });
  expect(absorbTypedFilters('project:"My Project" type:message', {}, { commit: true })).toEqual({ text: '', filters: { project: 'My Project', category: 'messages' } });
});

test('drops defaults and serializes filters into a parseable query', () => {
  const filters = withoutDefaults({ lifecycle: 'active', searchIn: 'titles', author: 'any', project: '/work/app' }, { lifecycle: 'active', author: 'any' });
  expect(filters).toEqual({ searchIn: 'titles', project: '/work/app' });
  expect(parseOmniQuery(omniQueryString('find this', filters))).toEqual({ text: 'find this', filters });
});

test('remembers filters without categories and ignores corrupt storage', () => {
  const storage = getDeferredSafeStorage();
  storage.removeItem(storageKey);
  rememberFilters('sidebar', { category: 'messages', project: '/work/app', lifecycle: 'archived' });
  expect(readRememberedFilters('sidebar')).toEqual({ project: '/work/app', lifecycle: 'archived' });
  storage.setItem(storageKey, 'project:"unfinished');
  expect(readRememberedFilters('sidebar')).toEqual({});
});

test('prunes stale projects only when projects are registered', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location,
    localStorage: dom.localStorage, Element: dom.Element, HTMLElement: dom.HTMLElement,
    Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  const { createRoot } = await import('react-dom/client');
  let state: ReturnType<typeof useOmniSearchState> | undefined;
  function Probe({ projects }: { projects: readonly { value: string; label: string }[] }) {
    state = useOmniSearchState({ surface: 'sidebar', defaults: {}, projects });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  const storage = getDeferredSafeStorage();

  try {
    rememberFilters('sidebar', { project: '/gone' });
    await act(async () => { root.render(<Probe projects={[]} />); });
    expect(state?.filters).toEqual({ project: '/gone' });
    await act(async () => { root.render(<Probe projects={[{ value: '/live', label: 'Live' }]} />); });
    expect(state?.filters).toEqual({});
    expect(storage.getItem(storageKey)).toBe('');
    await act(async () => { root.unmount(); });

    rememberFilters('sidebar', { project: '/live', lifecycle: 'archived' });
    const validRoot = createRoot(document.createElement('div'));
    await act(async () => { validRoot.render(<Probe projects={[]} />); });
    await act(async () => { validRoot.render(<Probe projects={[{ value: '/live', label: 'Live' }]} />); });
    expect(state?.filters).toEqual({ project: '/live', lifecycle: 'archived' });
    expect(readRememberedFilters('sidebar')).toEqual({ project: '/live', lifecycle: 'archived' });
    await act(async () => { validRoot.unmount(); });

    rememberFilters('sidebar', { project: '/gone' });
    const nextRoot = createRoot(document.createElement('div'));
    await act(async () => { nextRoot.render(<Probe projects={[{ value: '/live', label: 'Live' }]} />); });
    expect(state?.filters).toEqual({});
    expect(storage.getItem(storageKey)).toBe('');
    await act(async () => { nextRoot.unmount(); });

    // Removing the last project empties a confirmed list: its filter goes too.
    const { useProjectsStore } = await import('@/stores/useProjectsStore');
    useProjectsStore.setState({ hasServerSnapshot: true });
    rememberFilters('sidebar', { project: '/only', lifecycle: 'archived' });
    const lastRoot = createRoot(document.createElement('div'));
    await act(async () => { lastRoot.render(<Probe projects={[{ value: '/only', label: 'Only' }]} />); });
    expect(state?.filters).toEqual({ project: '/only', lifecycle: 'archived' });
    await act(async () => { lastRoot.render(<Probe projects={[]} />); });
    expect(state?.filters).toEqual({ lifecycle: 'archived' });
    expect(readRememberedFilters('sidebar')).toEqual({ lifecycle: 'archived' });
    await act(async () => { lastRoot.unmount(); });
    useProjectsStore.setState({ hasServerSnapshot: false });
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
