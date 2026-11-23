import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import type { usePullRequestComparison } from '@/hooks/usePullRequestComparison';
import type { ChangeRequest, Label, Project, SourceControlIdentity, SourceControlUser } from '@/lib/source-control/types';

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

const docs: Label = { name: 'docs', color: '6e7781' };
const bug: Label = { name: 'bug', color: 'd73a4a' };

const labelledComparison: ReturnType<typeof usePullRequestComparison> = {
  ...comparison,
  prs: [
    { ...changeRequest(1, 'nebula', 'open', 'Nebula open'), labels: [docs, bug] },
    { ...changeRequest(2, 'octocat', 'open', 'Octocat open'), labels: [docs] },
  ],
};

type PickerHarness = {
  container: HTMLDivElement;
  click: (element: HTMLElement | null | undefined) => Promise<void>;
  rows: () => HTMLElement[];
};

const withPicker = async (
  pickerComparison: ReturnType<typeof usePullRequestComparison>,
  run: (harness: PickerHarness) => Promise<void>,
) => {
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

  try {
    await act(async () => root.render(<I18nProvider><PullRequestComparisonSelector comparison={pickerComparison} /></I18nProvider>));
    await run({ container, click, rows });
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    await dom.happyDOM.abort();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
};

test('the picker filter narrows the loaded pull requests and shows its active state', async () => {
  await withPicker(comparison, async ({ container, click, rows }) => {
    const option = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
      .find((element) => element.textContent?.trim() === name);
    const filterTrigger = () => document.querySelector<HTMLButtonElement>('button[aria-pressed]');

    await click(container.querySelector<HTMLButtonElement>('button'));
    expect(rows()).toHaveLength(3);

    await click(document.querySelector<HTMLButtonElement>('button[aria-label="Filter"]'));
    await click(option('Open'));
    await click(option('nebula'));

    expect(filterTrigger()?.getAttribute('aria-pressed')).toBe('true');
    expect(filterTrigger()?.getAttribute('aria-label')).toBe('Filter: Open · nebula');
    expect(rows().map((row) => row.textContent)).toHaveLength(1);
    expect(rows()[0]?.textContent).toContain('Nebula open');
  });
});

test('the picker keeps its label choices collapsed until the Labels row is opened and collapses when filters are cleared', async () => {
  await withPicker(labelledComparison, async ({ container, click, rows }) => {
    const filterMenu = () => [...document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-content"]')]
      .filter((menu) => menu.querySelector('[role="menuitemradio"]'))
      .at(-1);
    const labelRow = () => [...(filterMenu()?.querySelectorAll<HTMLElement>('[aria-expanded]') ?? [])]
      .find((element) => element.textContent?.trim().startsWith('Labels'));
    const labelChoices = () => [...(filterMenu()?.querySelectorAll<HTMLElement>('[cmdk-item]') ?? [])];
    const filterTrigger = () => document.querySelector<HTMLButtonElement>('button[aria-pressed]');

    await click(container.querySelector<HTMLButtonElement>('button'));
    expect(rows()).toHaveLength(2);

    await click(document.querySelector<HTMLButtonElement>('button[aria-label="Filter"]'));
    expect(labelChoices()).toHaveLength(0);
    expect(labelRow()?.getAttribute('aria-expanded')).toBe('false');

    await click(labelRow());
    expect(labelChoices().map((choice) => choice.textContent?.trim())).toEqual(['docs', 'bug']);
    expect(labelRow()?.getAttribute('aria-expanded')).toBe('true');

    await click(labelChoices().find((choice) => choice.textContent?.includes('docs')));
    expect(filterTrigger()?.getAttribute('aria-label')).toBe('Filter: docs');
    expect(labelRow()?.getAttribute('aria-expanded')).toBe('true');

    await click(labelRow());
    expect(labelRow()?.getAttribute('aria-expanded')).toBe('false');
    expect(labelChoices()).toHaveLength(0);
    expect(labelRow()?.textContent).toContain('docs');

    const clearAll = [...(filterMenu()?.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-item"]') ?? [])]
      .find((element) => element.textContent?.trim() === 'Clear filters');
    expect(clearAll).toBeDefined();
    await click(clearAll);

    await click(document.querySelector<HTMLButtonElement>('button[aria-label="Filter"]'));
    expect(labelRow()?.getAttribute('aria-expanded')).toBe('false');
    expect(labelChoices()).toHaveLength(0);
    expect(labelRow()?.textContent?.trim()).toBe('Labels');
    expect(filterTrigger()?.getAttribute('aria-label')).toBe('Filter');
    expect(rows()).toHaveLength(2);
  });
});
