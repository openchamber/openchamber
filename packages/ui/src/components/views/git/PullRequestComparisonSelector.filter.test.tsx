import React, { act } from 'react';
import { expect, jest, test } from 'bun:test';
import { Window } from 'happy-dom';

import type {
  ChangeRequest, Label, PageResult, Project, SourceControlAuthStatus, SourceControlIdentity, SourceControlReadContext, SourceControlUser,
} from '@/lib/source-control/types';

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

const CONTEXT: SourceControlReadContext = {
  ...IDENTITY, accountId: 'github.com#7', repositoryId: 'repo-1', bindingRevision: 4, directory: '/repo', primaryRemote: 'origin',
};
const CONNECTED: SourceControlAuthStatus = {
  ...IDENTITY, status: 'connected', connected: true, user: user('octocat'),
  accounts: [{
    id: CONTEXT.accountId, credentialId: CONTEXT.accountId, credentialRevision: 1, providerUserId: 'github.com#7',
    providerUserStatus: 'available', user: user('octocat'), current: true, source: 'oauth', status: 'valid',
  }],
};

type ListRead = { page: number; state: string | null };
type HostAnswer = PageResult<ChangeRequest> | Response;
type Host = (read: ListRead) => HostAnswer | Promise<HostAnswer>;

const hostOf = (prs: ChangeRequest[]): Host => ({ page, state }) => ({
  items: state === 'all' ? prs : prs.filter((pr) => pr.state === 'open'), page, hasMore: false,
});

const docs: Label = { name: 'docs', color: '6e7781' };
const bug: Label = { name: 'bug', color: 'd73a4a' };

const labelledPullRequests: ChangeRequest[] = [
  { ...changeRequest(1, 'nebula', 'open', 'Nebula open'), labels: [docs, bug] },
  { ...changeRequest(2, 'octocat', 'open', 'Octocat open'), labels: [docs] },
];

const manyLabels: Label[] = [
  'api', 'bug', 'docs', 'feature', 'good first issue', 'help wanted',
  'performance', 'question', 'refactor', 'tests', 'ui', 'wontfix',
].map((name, index) => ({ name, color: index % 2 === 0 ? '6e7781' : 'd73a4a' }));

const crowdedPullRequests: ChangeRequest[] = [
  { ...changeRequest(1, 'nebula', 'open', 'Nebula open'), labels: manyLabels },
  changeRequest(2, 'octocat', 'open', 'Octocat open'),
];

type PickerHarness = {
  container: HTMLDivElement;
  click: (element: HTMLElement | null | undefined) => Promise<void>;
  rows: () => HTMLElement[];
  reads: ListRead[];
};

const withPicker = async (
  host: Host,
  run: (harness: PickerHarness) => Promise<void>,
  options: { mobile?: boolean; list?: boolean } = {},
) => {
  const dom = new Window({ url: 'http://localhost' });
  if (options.mobile) dom.happyDOM.setWindowSize({ width: 390, height: 844 });
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
    CustomEvent: dom.CustomEvent,
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
  const reads: ListRead[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    if (url.pathname === '/api/fs/home' || url.pathname === '/api/session-folders') return new Promise<Response>(() => {});
    if (url.pathname === '/api/source-control/github/pr/status') {
      return Response.json({ identity: IDENTITY, project, branch: 'feature', changeRequest: null });
    }
    if (url.pathname === '/api/source-control/github/pulls/list') {
      const read = { page: Number(url.searchParams.get('page')), state: url.searchParams.get('state') };
      reads.push(read);
      const answer = await host(read);
      return answer instanceof Response ? answer : Response.json(answer);
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  }, originalFetch);
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { PullRequestComparisonSelector } = await import('./PullRequestComparisonSelector');
  const { PullRequestListPanel } = await import('./PullRequestListPanel');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../../../web/src/api/index');
  const { forgetSharedPullRequestLists, usePullRequestComparison } = await import('@/hooks/usePullRequestComparison');
  forgetSharedPullRequestLists();
  const { usePullRequestSelectionStore } = await import('@/stores/usePullRequestSelectionStore');
  usePullRequestSelectionStore.setState({ selections: new Map() });
  const { getSourceControlAuthKey, useSourceControlAuthStore } = await import('@/stores/useSourceControlAuthStore');
  useSourceControlAuthStore.setState({
    entries: { [getSourceControlAuthKey(CONTEXT)]: { status: CONNECTED, isLoading: false, hasChecked: true } },
  });
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const descriptor = githubLikeDescriptor();
  useSourceControlProviderRegistry.setState({ ordered: [descriptor], byId: new Map([[descriptor.id, descriptor]]), status: 'ready', holdsList: true });
  const apis = createWebAPIs();
  const Harness = () => {
    const comparison = usePullRequestComparison('/repo', 'feature', CONTEXT, true);
    return options.list
      ? <PullRequestListPanel comparison={comparison} onSelect={comparison.select} />
      : <><PullRequestComparisonSelector comparison={comparison} mobile={options.mobile} />
        <output>{comparison.selectedSource?.number}</output></>;
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  const click = async (element: HTMLElement | null | undefined) => {
    if (!element) throw new Error('Missing element');
    await act(async () => { element.click(); });
  };
  const rows = () => [...document.querySelectorAll<HTMLElement>('[cmdk-item]')];

  try {
    await act(async () => root.render(<I18nProvider><RuntimeAPIContext.Provider value={apis}><Harness /></RuntimeAPIContext.Provider></I18nProvider>));
    await run({ container, click, rows, reads });
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

const option = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
  .find((element) => element.textContent?.trim() === name);
const filterTrigger = () => document.querySelector<HTMLButtonElement>('button[aria-pressed]');
const buttonNamed = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')]
  .find((element) => element.textContent?.trim() === name);

test('the picker lists open pull requests until a status that shows others is picked, and starts over when closed', async () => {
  await withPicker(hostOf(pullRequests), async ({ container, click, rows, reads }) => {
    const trigger = container.querySelector<HTMLButtonElement>('button');
    await click(trigger);
    expect(rows().map((row) => row.textContent)).toHaveLength(2);
    expect(reads).toEqual([{ page: 1, state: 'open' }]);
    expect(filterTrigger()?.getAttribute('aria-pressed')).toBe('false');

    await click(filterTrigger());
    await click(option('nebula'));
    expect(rows()).toHaveLength(1);
    expect(reads).toHaveLength(1);
    await click(option('Closed'));
    expect(reads.at(-1)).toEqual({ page: 1, state: 'all' });
    expect(filterTrigger()?.getAttribute('aria-label')).toBe('Filter: Closed · nebula');
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.textContent).toContain('Nebula closed');

    await click(rows()[0]);
    expect(container.querySelector('output')?.textContent).toBe('3');
    await click(trigger);
    expect(rows()).toHaveLength(2);
    expect(filterTrigger()?.getAttribute('aria-label')).toBe('Filter');
  });
});

test('keys pressed in the filter neither pick a pull request nor close the picker', async () => {
  await withPicker(hostOf(pullRequests), async ({ container, click, rows }) => {
    const press = async (element: HTMLElement | null | undefined, key: string) => {
      if (!element) throw new Error('Missing element');
      await act(async () => {
        element.focus();
        element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      });
    };
    await click(container.querySelector<HTMLButtonElement>('button'));
    await press(filterTrigger(), 'Enter');
    expect(container.querySelector('output')?.textContent).toBe('');
    expect(rows()).toHaveLength(2);

    if (!option('Closed')) await click(filterTrigger());
    await press(option('Closed'), 'Escape');
    expect(option('Closed')).toBeUndefined();
    expect(rows()).toHaveLength(2);
  });
});

for (const list of [false, true]) {
  test(`${list ? 'the Git list' : 'the picker'} keeps Load more and its retry when the filter excludes every loaded row`, async () => {
    let failing = true;
    const host: Host = ({ page, state }) => {
      if (state !== 'all' || page === 1) return { items: pullRequests.slice(0, 2), page, hasMore: true };
      if (failing) return Response.json({ error: 'Next page failed' }, { status: 503 });
      return { items: pullRequests.slice(2), page, hasMore: false };
    };
    await withPicker(host, async ({ container, click, reads }) => {
      if (!list) await click(container.querySelector<HTMLButtonElement>('button'));
      await click(filterTrigger());
      await click(option('Closed'));
      expect(document.body.textContent).not.toContain('Nebula open');
      expect(document.body.textContent).toContain('No pull requests found');

      await click(buttonNamed('Load more'));
      expect(document.body.textContent).toContain('Next page failed');
      expect(filterTrigger()?.getAttribute('aria-label')).toBe('Filter: Closed');

      failing = false;
      await click(buttonNamed('Retry'));
      expect(reads.at(-1)).toEqual({ page: 2, state: 'all' });
      expect(document.body.textContent).toContain('Nebula closed');
      expect(document.body.textContent).not.toContain('Nebula open');
      expect(filterTrigger()?.getAttribute('aria-label')).toBe('Filter: Closed');
    }, { list });
  });
}

test('the picker keeps its label choices collapsed until the Labels row is opened and collapses when filters are cleared', async () => {
  await withPicker(hostOf(labelledPullRequests), async ({ container, click, rows }) => {
    const filterMenu = () => [...document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-content"]')]
      .filter((menu) => menu.querySelector('[role="menuitemradio"]'))
      .at(-1);
    const labelRow = () => [...(filterMenu()?.querySelectorAll<HTMLElement>('[aria-expanded]') ?? [])]
      .find((element) => element.textContent?.trim().startsWith('Labels'));
    const labelChoices = () => [...(filterMenu()?.querySelectorAll<HTMLElement>('[cmdk-item]') ?? [])];
    await click(container.querySelector<HTMLButtonElement>('button'));
    expect(rows()).toHaveLength(2);

    await click(document.querySelector<HTMLButtonElement>('button[aria-label="Filter"]'));
    expect(labelChoices()).toHaveLength(0);
    expect(labelRow()?.tagName).toBe('BUTTON');
    expect(labelRow()?.getAttribute('aria-expanded')).toBe('false');

    await click(labelRow());
    expect(labelChoices().map((choice) => choice.textContent?.trim())).toEqual(['bug', 'docs']);
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

test('the phone picker opens the filter as its own sheet over the picker sheet', async () => {
  await withPicker(hostOf(crowdedPullRequests), async ({ container, click, rows }) => {
    const dialogs = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
    const filterSheet = () => {
      const last = dialogs().at(-1);
      return last && last.textContent?.includes('Status') ? last : null;
    };
    const labelsRow = () => [...(filterSheet()?.querySelectorAll<HTMLButtonElement>('button[aria-expanded]') ?? [])]
      .find((element) => element.textContent?.trim().startsWith('Labels')) ?? null;

    await click(container.querySelector<HTMLButtonElement>('button'));
    expect(dialogs()).toHaveLength(1);
    await click(document.querySelector<HTMLButtonElement>('button[aria-label="Filter"]'));

    expect(dialogs()).toHaveLength(2);
    expect(filterSheet()).not.toBeNull();
    expect(labelsRow()?.getAttribute('aria-expanded')).toBe('false');
    expect(filterSheet()?.textContent).not.toContain('api');

    await click(buttonNamed('All'));
    await click(labelsRow());
    expect(labelsRow()?.getAttribute('aria-expanded')).toBe('true');
    for (const label of manyLabels) expect(filterSheet()?.textContent).toContain(label.name);

    await click(dialogs().at(-1)!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
      ?? dialogs().at(-1)!.querySelector<HTMLButtonElement>('button')!);
    expect(rows().length).toBeGreaterThan(0);
    expect(document.body.style.overflow).toBe('hidden');

    await click(dialogs()[0]?.querySelector<HTMLButtonElement>('button[aria-label="Close"]'));
    expect(dialogs()).toHaveLength(0);
    expect(document.body.style.overflow).toBe('');
  }, { mobile: true });
});

test('switching to a list read before frees Load more while the other list still loads its next page', async () => {
  let finishOpenPage = () => {};
  const host: Host = ({ page, state }) => {
    if (state === 'all') return { items: page === 1 ? pullRequests.slice(0, 2) : pullRequests.slice(2), page, hasMore: page === 1 };
    const answer = { items: pullRequests.slice(0, 2), page, hasMore: true };
    return page === 1 ? answer : new Promise((resolve) => { finishOpenPage = () => resolve(answer); });
  };
  await withPicker(host, async ({ click, reads }) => {
    await click(filterTrigger());
    await click(option('All'));
    await click(option('Open'));
    await click(buttonNamed('Load more'));
    expect(reads.at(-1)).toEqual({ page: 2, state: 'open' });

    await click(option('All'));
    await act(async () => finishOpenPage());
    await click(buttonNamed('Load more'));
    expect(reads.at(-1)).toEqual({ page: 2, state: 'all' });
    expect(document.body.textContent).toContain('Nebula closed');
  }, { list: true });
});

test('a status qualifier in the search decides the status over the filter', async () => {
  const host: Host = ({ page }) => ({ items: pullRequests.slice(2), page, hasMore: false });
  await withPicker(host, async ({ container, click }) => {
    expect(document.body.textContent).not.toContain('Nebula closed');
    const input = container.querySelector('input');
    if (!input) throw new Error('Missing search');
    jest.useFakeTimers();
    window.setTimeout = globalThis.setTimeout;
    window.clearTimeout = globalThis.clearTimeout;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'is:closed');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { jest.advanceTimersByTime(400); });
    jest.useRealTimers();
    expect(document.body.textContent).toContain('Nebula closed');
    expect(filterTrigger()?.getAttribute('aria-label')).toBe('Filter: is:closed');
    await click(filterTrigger());
    expect(option('Open')?.getAttribute('aria-disabled')).toBe('true');
  }, { list: true });
});
