/**
 * What the list asks the host for, through the real URL and request path: the
 * two ticks of a label filter and the remembered filter a reload restores.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type {
  Label,
  RepositoryReferenceFilter,
  RuntimeAPIs,
  SourceControlBindingRead,
} from '@/lib/api/types';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node, Text: browser.Text,
  HTMLInputElement: browser.HTMLInputElement, SVGElement: browser.SVGElement,
  Event: browser.Event, CustomEvent: browser.CustomEvent, KeyboardEvent: browser.KeyboardEvent, MouseEvent: browser.MouseEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
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
const STORAGE_KEY = 'openchamber.repositoryFilters.v1';
const LIST_FILTER_KEY = ['github', 'github.com', 'acme/app', 'issue'].join('\u0000');

/** The `label` params of every list read the app sent, oldest first. */
let reads: string[][] = [];

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  reads = [];
  localStorage.clear();
  // The app's stores fetch on import; only the list this test reads answers.
  const realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname.endsWith('/issues/list')) {
      reads.push(url.searchParams.getAll('label'));
      return new Response(JSON.stringify({ items: [], page: 1, hasMore: false }), {
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
  // A closed panel's portal can outlive its root; the next test reads the document.
  document.body.replaceChildren();
});

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};

/** Renders the browser on the board's folder, reading lists through the real web API. */
const show = async (): Promise<void> => {
  const [{ useReferenceBrowser }, { ReferenceBrowserSearch }, { I18nProvider }, { RuntimeAPIContext }, { createWebAPIs }, { useSourceControlProviderRegistry }, { githubLikeDescriptor }] = await Promise.all([
    import('./useReferenceBrowser'),
    import('./ReferenceBrowser'),
    import('@/lib/i18n'),
    import('@/contexts/runtimeAPIContext'),
    import('../../../../web/src/api/index'),
    import('@/lib/source-control/providers/registry'),
    import('@/lib/source-control/providers/descriptor.fixture'),
  ]);
  // A host without a reference search lists through the provider-neutral reads, as GitLab does.
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
    const referenceBrowser = useReferenceBrowser({
      source: 'repository',
      directory: '/work/app',
      directories: null,
      isMobile: false,
    });
    return <ReferenceBrowserSearch browser={referenceBrowser} onKeyDown={() => undefined} />;
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

/** The one filter trigger: the filter, and the applied labels named after it. */
const filterTrigger = () => host.querySelector<HTMLButtonElement>('button[aria-label="Filter"], button[aria-label^="Filter:"]');
/** The open panel; one still animating out is left over in the document. */
const menu = () => [...document.querySelectorAll<HTMLElement>('[role="menu"]')]
  .find((element) => !element.hasAttribute('data-ending-style')) ?? null;
/** One row of the open menu's label list, by the name it shows. */
const labelChoice = (name: string) => [...(menu()?.querySelectorAll<HTMLElement>('[data-slot="command-item"]') ?? [])]
  .find((item) => item.textContent?.trim() === name);
const click = async (element: HTMLElement | null | undefined) => {
  if (!element) throw new Error('Expected the element');
  await act(async () => { element.click(); });
  await flush();
};
const openMenu = () => click(filterTrigger());
const closeMenu = async () => {
  if (menu()) await click(filterTrigger());
};

/** A filter the app remembers for this folder and tab, as an earlier run left it. */
const remember = (filter: RepositoryReferenceFilter) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([[LIST_FILTER_KEY, filter]]));
};

describe('the labels a list read carries', () => {
  test('a remembered filter is applied to the first read, not after an unfiltered one', async () => {
    remember({ state: 'open', people: 'any', labels: ['bug', 'reload-only'] });
    await show();
    // One read, already narrowed: the remembered filter never trails an unfiltered read.
    expect(reads).toEqual([['bug', 'reload-only']]);
    expect(filterTrigger()?.getAttribute('aria-label')).toBe('Filter: bug, reload-only');
    await openMenu();
    await closeMenu();
  });

  test('a second tick sends both labels, which the host ands', async () => {
    await show();
    await openMenu();
    // The selection is remembered for the app run: start from none.
    if (filterTrigger()?.getAttribute('aria-label')?.includes(':')) await click(labelChoice('Clear'));
    reads = [];
    await click(labelChoice('bug'));
    await click(labelChoice('docs'));
    expect(filterTrigger()?.getAttribute('aria-label')).toBe('Filter: bug, docs');
    expect(reads.at(-1)).toEqual(['bug', 'docs']);
    // Unticking one leaves the other applied, and reads with it.
    await click(labelChoice('bug'));
    expect(filterTrigger()?.getAttribute('aria-label')).toBe('Filter: docs');
    expect(reads.at(-1)).toEqual(['docs']);
    await closeMenu();
  });
});
