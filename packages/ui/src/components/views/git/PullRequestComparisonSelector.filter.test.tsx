import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import type { usePullRequestComparison } from '@/hooks/usePullRequestComparison';
import type { ChangeRequest, Project, SourceControlIdentity, SourceControlUser } from '@/lib/source-control/types';

const IDENTITY: SourceControlIdentity = { provider: 'github', instance: 'github.com' };

const user = (username: string): SourceControlUser => ({ ...IDENTITY, id: `user-${username}`, username });

const project: Project = { ...IDENTITY, id: 'upstream/project', owner: 'upstream', name: 'project', url: 'https://github.com/upstream/project' };

const changeRequest = (number: number, author: string, state: 'open' | 'closed', title: string): ChangeRequest => ({
  ...IDENTITY,
  id: `upstream/project#${number}`,
  number,
  project,
  title,
  url: `https://github.com/upstream/project/pull/${number}`,
  state,
  draft: false,
  base: 'main',
  head: `feature-${number}`,
  author: user(author),
});

const pullRequests = [
  changeRequest(1, 'nebula', 'open', 'Nebula open'),
  changeRequest(2, 'octocat', 'open', 'Octocat open'),
  changeRequest(3, 'nebula', 'closed', 'Nebula closed'),
];

const comparison: ReturnType<typeof usePullRequestComparison> = {
  enabled: true,
  readContext: null,
  provider: 'github',
  diffUnavailable: false,
  selectedSource: null,
  prs: pullRequests,
  query: '',
  setQuery: () => {},
  loading: false,
  loadingMore: false,
  hasMore: false,
  incompleteProjectIds: [],
  error: null,
  refresh: () => Promise.resolve(),
  revalidate: () => Promise.resolve(),
  loadMore: () => Promise.resolve(),
  select: () => {},
};

test('the picker filter narrows the loaded pull requests and shows its active state', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    location: dom.location,
    localStorage: dom.localStorage,
    Element: dom.Element,
    HTMLElement: dom.HTMLElement,
    HTMLInputElement: dom.HTMLInputElement,
    Node: dom.Node,
    customElements: dom.customElements,
    CSSStyleSheet: dom.CSSStyleSheet,
    Event: dom.Event,
    KeyboardEvent: dom.KeyboardEvent,
    MouseEvent: dom.MouseEvent,
    MutationObserver: dom.MutationObserver,
    ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    if (url.pathname === '/api/fs/home' || url.pathname === '/api/session-folders') return new Promise<Response>(() => {});
    throw new Error(`Unexpected request ${url.pathname}`);
  }, originalFetch);
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { PullRequestComparisonSelector } = await import('./PullRequestComparisonSelector');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  const click = async (element: HTMLElement | null | undefined) => {
    if (!element) throw new Error('Missing element');
    await act(async () => { element.click(); });
  };
  const rows = () => [...document.querySelectorAll<HTMLElement>('[cmdk-item]')];
  const option = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
    .find((element) => element.textContent?.trim() === name);
  const filterTrigger = () => document.querySelector<HTMLButtonElement>('button[aria-pressed]');

  try {
    await act(async () => root.render(<I18nProvider><PullRequestComparisonSelector comparison={comparison} /></I18nProvider>));
    await click(container.querySelector<HTMLButtonElement>('button'));
    expect(rows()).toHaveLength(3);

    await click(document.querySelector<HTMLButtonElement>('button[aria-label="Filter"]'));
    await click(option('Open'));
    await click(option('nebula'));

    expect(filterTrigger()?.getAttribute('aria-pressed')).toBe('true');
    expect(filterTrigger()?.getAttribute('aria-label')).toBe('Filter: Open · nebula');
    expect(rows().map((row) => row.textContent)).toHaveLength(1);
    expect(rows()[0]?.textContent).toContain('Nebula open');
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    await dom.happyDOM.abort();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
