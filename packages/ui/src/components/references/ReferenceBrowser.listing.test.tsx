/**
 * The list as the host's answers drive it, through the real web adapter: a
 * label write the host's search has not caught up with, pages a label filter
 * leaves empty, and the phone's filter sheet.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type {
  Label,
  RuntimeAPIs,
  SourceControlBindingRead,
} from '@/lib/api/types';

const browser = new Window({ url: 'http://localhost/' });

// The end of the list is always in view: each observation reports it at once.
class VisibleSentinelObserver {
  constructor(private readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
  observe() { queueMicrotask(() => this.callback([{ isIntersecting: true }])); }
  disconnect() {}
  unobserve() {}
}

Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node, Text: browser.Text,
  HTMLInputElement: browser.HTMLInputElement, SVGElement: browser.SVGElement,
  Event: browser.Event, CustomEvent: browser.CustomEvent, KeyboardEvent: browser.KeyboardEvent, MouseEvent: browser.MouseEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  IntersectionObserver: VisibleSentinelObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});

const ENDPOINT = { displayUrl: 'https://github.com/acme/app', fingerprint: 'origin-fetch' };

const bindingRead: SourceControlBindingRead = {
  status: 'bound',
  revision: 1,
  repository: {
    repositoryId: 'repo-1', configRevision: 'rev', bare: false,
    remotes: [{ name: 'origin', fetch: ENDPOINT, push: ENDPOINT }],
  },
  binding: {
    repositoryId: 'repo-1', configRevision: 'rev', revision: 1, state: 'bound',
    providers: [{
      provider: 'github', instance: 'github.com', accountId: 'github.com#7', primaryRemote: 'origin',
      readiness: 'ready', endpoint: ENDPOINT, repository: { owner: 'acme', name: 'app' },
    }],
    remotes: [], auxiliary: [],
  },
};

const LABELS: Label[] = [{ name: 'bug', color: 'd73a4a' }, { name: 'docs' }];
const IDENTITY = { provider: 'github', instance: 'github.com' };
const PROJECT = { ...IDENTITY, id: '1', owner: 'acme', name: 'app', url: 'https://github.com/acme/app' };

const issue = (number: number, labels: string[]) => ({
  ...IDENTITY,
  id: String(number),
  number,
  project: PROJECT,
  title: `Issue ${number}`,
  url: `https://github.com/acme/app/issues/${number}`,
  state: 'open',
  labels: labels.map((name) => ({ name })),
});

type IssuePage = { items: ReturnType<typeof issue>[]; hasMore: boolean };

/** What the host answers for a list read: by its page and `label` params. */
let answer: (page: number, labels: string[]) => IssuePage;
/** Every list read, oldest first: its page and `label` params. */
let reads: Array<{ page: number; labels: string[] }> = [];

let root: Root;
let host: HTMLDivElement;
let shown: ReturnType<typeof import('./useReferenceBrowser').useReferenceBrowser> | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  reads = [];
  shown = null;
  localStorage.clear();
  const realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname.endsWith('/issues/list')) {
      const page = Number(url.searchParams.get('page') ?? '1');
      const labels = url.searchParams.getAll('label');
      reads.push({ page, labels });
      return new Response(JSON.stringify({ ...answer(page, labels), page }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Promise<Response>(() => {});
  }, realFetch);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.replaceChildren();
});

const flush = async () => {
  for (let round = 0; round < 4; round += 1) {
    for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
};

/** `directory` keeps each test's lists apart: the list cache outlives a mount. */
const show = async (directory: string, { isMobile = false }: { isMobile?: boolean } = {}): Promise<void> => {
  const [{ useReferenceBrowser }, { ReferenceBrowserList, ReferenceBrowserSearch }, { I18nProvider }, { RuntimeAPIContext }, { createWebAPIs }, { useSourceControlProviderRegistry }, { githubLikeDescriptor }] = await Promise.all([
    import('./useReferenceBrowser'),
    import('./ReferenceBrowser'),
    import('@/lib/i18n'),
    import('@/contexts/runtimeAPIContext'),
    import('../../../../web/src/api/index'),
    import('@/lib/source-control/providers/registry'),
    import('@/lib/source-control/providers/descriptor.fixture'),
  ]);
  const descriptor = githubLikeDescriptor();
  const state = { ordered: [descriptor], byId: new Map([[descriptor.id, descriptor]]), status: 'ready' as const, holdsList: true };
  useSourceControlProviderRegistry.setState(state);
  Object.assign(useSourceControlProviderRegistry.getInitialState(), state);

  const base = createWebAPIs();
  const apis: RuntimeAPIs = {
    ...base,
    sourceControl: {
      ...base.sourceControl,
      repositoryBinding: async () => bindingRead,
      referenceLabels: async () => LABELS,
    },
  };

  const Harness: React.FC = () => {
    const referenceBrowser = useReferenceBrowser({ source: 'repository', directory, directories: null, isMobile });
    shown = referenceBrowser;
    return (
      <>
        <ReferenceBrowserSearch browser={referenceBrowser} onKeyDown={() => undefined} />
        <ReferenceBrowserList browser={referenceBrowser} label="Issues" multiselectable={false} onOpenSettings={() => undefined} />
      </>
    );
  };

  await act(async () => {
    root.render(
      <I18nProvider>
        <RuntimeAPIContext.Provider value={apis}>
          <Harness />
        </RuntimeAPIContext.Provider>
      </I18nProvider>,
    );
  });
  await flush();
};

const browserShown = () => {
  if (!shown) throw new Error('Expected the browser');
  return shown;
};
/** Each listed item's number and labels, as the list holds them. */
const listed = () => browserShown().items.map((item) => (
  item.source === 'repository' ? `#${item.reference.number} ${item.reference.labels.map((label) => label.name).join(',')}`.trim() : ''
));
const click = async (element: HTMLElement | null | undefined) => {
  if (!element) throw new Error('Expected the element');
  await act(async () => { element.click(); });
  await flush();
};
const filterTrigger = () => host.querySelector<HTMLButtonElement>('button[aria-label="Filter"], button[aria-label^="Filter:"]');

describe('a label write the host search has not caught up with', () => {
  test('the list keeps the written labels, and the filter follows them', async () => {
    // Search keeps answering the set from before the write.
    answer = (_page, labels) => ({
      items: [issue(1, ['bug']), issue(2, ['bug'])].filter((item) => labels.every((name) => item.labels.some((label) => label.name === name))),
      hasMore: false,
    });
    await show('/work/written');
    await act(async () => browserShown().selectRepositoryFilter({ labels: ['bug'] }));
    await flush();
    expect(listed()).toEqual(['#1 bug', '#2 bug']);

    const first = browserShown().items[0];
    if (first?.source !== 'repository') throw new Error('Expected a repository item');
    // #1 gets docs too: it stays, with both labels, after a read that still says bug.
    await act(async () => browserShown().labelsWritten(first.reference, [{ name: 'bug' }, { name: 'docs' }]));
    await act(async () => { await browserShown().list.retry(); });
    await flush();
    expect(listed()).toEqual(['#1 bug,docs', '#2 bug']);

    // #2 loses bug: it leaves the bug list though the read still holds it.
    const second = browserShown().items[1];
    if (second?.source !== 'repository') throw new Error('Expected a repository item');
    await act(async () => browserShown().labelsWritten(second.reference, []));
    await act(async () => { await browserShown().list.retry(); });
    await flush();
    expect(listed()).toEqual(['#1 bug,docs']);

    // A read that drops #1 mid-update does not take it off the list it still matches.
    answer = () => ({ items: [], hasMore: false });
    await act(async () => { await browserShown().list.retry(); });
    await flush();
    expect(listed()).toEqual(['#1 bug,docs']);
  });
});

describe('pages a label filter leaves empty', () => {
  test('the list reads on through them to the next match', async () => {
    answer = (page) => (page < 3 ? { items: [], hasMore: true } : { items: [issue(9, ['bug', 'docs'])], hasMore: false });
    await show('/work/paged');
    // The end of the list never left view; nothing was scrolled or reopened.
    expect(reads.map((read) => read.page)).toEqual([1, 2, 3]);
    expect(listed()).toEqual(['#9 bug,docs']);
  });
});

describe("the phone's filter", () => {
  test('opens as one sheet without raising the keyboard; a label narrows, Clear widens', async () => {
    answer = () => ({ items: [], hasMore: false });
    await show('/work/phone', { isMobile: true });
    await click(filterTrigger());
    const sheet = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Filter"]');
    expect(sheet).not.toBeNull();
    // Status, people and the labels with their search, together in the sheet.
    const groups = [...(sheet?.querySelectorAll<HTMLElement>('[role="group"]') ?? [])].map((group) => group.getAttribute('aria-label'));
    expect(groups).toEqual(['Status', 'People', 'Labels']);
    expect(sheet?.querySelector('input')).not.toBeNull();
    expect(document.activeElement?.tagName).not.toBe('INPUT');

    const labelRow = (name: string) => [...(sheet?.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Labels"] button') ?? [])]
      .find((button) => button.textContent?.trim() === name);
    reads = [];
    await click(labelRow('bug'));
    expect(reads.at(-1)?.labels).toEqual(['bug']);
    expect(filterTrigger()?.getAttribute('aria-label')).toBe('Filter: bug');
    // Picking keeps the sheet open.
    expect(document.querySelector('[role="dialog"][aria-label="Filter"]')).not.toBeNull();

    // The unfiltered list was read on open, so it shows from the cache.
    await click(labelRow('Clear'));
    expect(browserShown().repositoryFilter.labels).toEqual([]);
    expect(filterTrigger()?.getAttribute('aria-label')).toBe('Filter');

    await click(document.querySelector<HTMLButtonElement>('[role="dialog"][aria-label="Filter"] button[aria-label="Close"]'));
    expect(document.querySelector('[role="dialog"][aria-label="Filter"]')).toBeNull();
  });
});
