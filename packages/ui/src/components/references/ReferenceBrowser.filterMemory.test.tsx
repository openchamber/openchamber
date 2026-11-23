import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type {
  RepositoryReferenceFilter,
  RepositoryReferenceQuery,
  RepositoryReferenceKind,
  RuntimeAPIs,
  SourceControlBindingRead,
} from '@/lib/api/types';
import {
  rememberRepositoryFilter,
  repositoryFilterKey,
  savedRepositoryFilter,
} from '@/lib/source-control/repositoryFilterMemory';
import type { ReferencePickerSource } from './referencePickerItems';
import type { ReferenceBrowser } from './useReferenceBrowser';

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
// The browser's imports pull in app stores that load on import; their requests never answer.
globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), globalThis.fetch);

const STORAGE_KEY = 'openchamber.repositoryFilters.v1';
const DEFAULT_FILTER: RepositoryReferenceFilter = { state: 'open', people: 'any', labels: [] };

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const bindingAt = (owner: string, repo: string): SourceControlBindingRead => {
  const url = `https://github.com/${owner}/${repo}`;
  const endpoint = { displayUrl: url, fingerprint: `${owner}-${repo}-fetch` };
  return {
    status: 'bound',
    revision: 1,
    repository: {
      repositoryId: `repo-${owner}-${repo}`, configRevision: 'rev', bare: false,
      remotes: [{ name: 'origin', fetch: endpoint, push: { ...endpoint, fingerprint: `${owner}-${repo}-push` } }],
    },
    binding: {
      repositoryId: `repo-${owner}-${repo}`, configRevision: 'rev', revision: 1, state: 'bound',
      providers: [{
        provider: 'github', instance: 'github.com', accountId: 'github.com#7', primaryRemote: 'origin',
        readiness: 'ready', endpoint, repository: { owner, name: repo },
      }],
      remotes: [], auxiliary: [],
    },
  };
};

const setProvider = async () => {
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const base = githubLikeDescriptor();
  const descriptor = { ...base, features: { ...base.features, referenceSearch: true, referenceDetail: true, referencesAcross: true } };
  const state = { ordered: [descriptor], byId: new Map([[descriptor.id, descriptor]]), status: 'ready' as const, holdsList: true };
  useSourceControlProviderRegistry.setState(state);
  Object.assign(useSourceControlProviderRegistry.getInitialState(), state);
};

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};

const filterKey = (repo: string, kind: RepositoryReferenceKind = 'issue', owner = 'acme') => repositoryFilterKey(
  'github',
  'github.com',
  { owner, repo },
  kind,
);

type Shown = {
  reads: RepositoryReferenceQuery[];
  acrossReads: RepositoryReferenceQuery[];
  openDirectory: (directory: string) => Promise<void>;
};

let latestBrowser: ReferenceBrowser | null = null;

const show = async (options: {
  kind?: RepositoryReferenceKind;
  source?: ReferencePickerSource;
  across?: boolean;
  directory?: string;
} = {}): Promise<Shown> => {
  const [{ useReferenceBrowser }, { I18nProvider }, { RuntimeAPIContext }, { createWebAPIs }] = await Promise.all([
    import('./useReferenceBrowser'),
    import('@/lib/i18n'),
    import('@/contexts/runtimeAPIContext'),
    import('../../../../web/src/api/index'),
  ]);
  await setProvider();
  const base = createWebAPIs();
  const reads: RepositoryReferenceQuery[] = [];
  const acrossReads: RepositoryReferenceQuery[] = [];
  const bindings = new Map<string, SourceControlBindingRead>([
    ['/work/app', bindingAt('acme', 'app')],
    ['/work/other', bindingAt('acme', 'other')],
  ]);
  const apis: RuntimeAPIs = {
    ...base,
    sourceControl: {
      ...base.sourceControl,
      repositoryBinding: async (directory) => bindings.get(directory) ?? bindingAt('acme', 'app'),
      references: async (_context, query) => {
        reads.push(query);
        return {
          connected: true as const,
          repo: { owner: 'acme', repo: 'app', url: 'https://github.com/acme/app' },
          items: [], cursor: null, hasMore: false, total: 0,
        };
      },
      referencesAcross: async (contexts, query) => {
        acrossReads.push(query);
        return {
          items: [], cursor: null, hasMore: false, total: 0,
          repositories: contexts.map((context) => ({
            directory: context.directory, status: 'included' as const,
            repo: { owner: 'acme', repo: 'app', source: 'origin', url: 'https://github.com/acme/app' },
          })),
        };
      },
    },
  };

  let setBrowserDirectory: ((directory: string) => void) | null = null;

  const Harness: React.FC = () => {
    const [directory, setDirectory] = React.useState(options.directory ?? '/work/app');
    setBrowserDirectory = setDirectory;
    const directories = React.useMemo(() => (options.across ? [directory] : null), [directory]);
    const browser = useReferenceBrowser({
      source: options.source ?? 'repository',
      directory,
      directories,
      isMobile: false,
      initialGitHubKind: options.kind,
    });
    latestBrowser = browser;
    return null;
  };

  latestBrowser = null;
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

  return {
    reads,
    acrossReads,
    openDirectory: async (directory) => {
      await act(async () => { setBrowserDirectory?.(directory); });
      await flush();
    },
  };
};

const currentFilter = () => latestBrowser?.repositoryFilter;

const selectFilter = async (patch: Partial<RepositoryReferenceFilter>) => {
  await act(async () => { latestBrowser?.selectRepositoryFilter(patch); });
  await flush();
};

const selectKind = async (kind: RepositoryReferenceKind) => {
  await act(async () => { latestBrowser?.selectRepositoryKind(kind); });
  await flush();
};

describe('repository filter memory', () => {
  test('a saved filter is applied when the board opens', async () => {
    const saved: RepositoryReferenceFilter = { state: 'closed', people: 'assigned', labels: ['bug'] };
    rememberRepositoryFilter(filterKey('app'), saved);
    const shown = await show({ kind: 'issue' });

    expect(currentFilter()).toEqual(saved);
    expect(shown.reads.filter((query) => query.kind === 'issue').at(-1)).toMatchObject(saved);
  });

  test('changing a filter writes it, an emptied label selection included', async () => {
    await show({ kind: 'issue' });
    expect(currentFilter()).toEqual(DEFAULT_FILTER);

    await selectFilter({ labels: ['bug'] });
    expect(savedRepositoryFilter(filterKey('app'))).toEqual({ ...DEFAULT_FILTER, labels: ['bug'] });

    await selectFilter({ labels: [] });
    expect(savedRepositoryFilter(filterKey('app'))).toEqual({ ...DEFAULT_FILTER, labels: [] });
  });

  test('switching to Pull requests loads that kind\'s saved filter, not the issue one', async () => {
    const issueFilter: RepositoryReferenceFilter = { state: 'closed', people: 'assigned', labels: ['bug'] };
    const pullFilter: RepositoryReferenceFilter = { state: 'merged', people: 'reviewRequested', labels: ['docs'] };
    rememberRepositoryFilter(filterKey('app', 'issue'), issueFilter);
    rememberRepositoryFilter(filterKey('app', 'pull'), pullFilter);
    const shown = await show({ kind: 'issue' });

    expect(currentFilter()).toEqual(issueFilter);
    await selectKind('pull');
    expect(currentFilter()).toEqual(pullFilter);
    const pullReads = shown.reads.filter((query) => query.kind === 'pull');
    expect(pullReads.at(-1)).toMatchObject(pullFilter);
    expect(pullReads.at(-1)?.labels).not.toEqual(issueFilter.labels);
  });

  test('two repositories do not share a filter', async () => {
    const appFilter: RepositoryReferenceFilter = { state: 'closed', people: 'any', labels: ['app-only'] };
    const otherFilter: RepositoryReferenceFilter = { state: 'all', people: 'created', labels: ['other-only'] };
    rememberRepositoryFilter(filterKey('app'), appFilter);
    rememberRepositoryFilter(filterKey('other'), otherFilter);
    const shown = await show({ kind: 'issue' });

    expect(currentFilter()).toEqual(appFilter);
    await shown.openDirectory('/work/other');
    expect(currentFilter()).toEqual(otherFilter);
    expect(shown.reads.filter((query) => query.kind === 'issue').at(-1)).toMatchObject(otherFilter);

    await shown.openDirectory('/work/app');
    expect(currentFilter()).toEqual(appFilter);
  });

  test('the across list neither reads nor writes', async () => {
    const saved: RepositoryReferenceFilter = { state: 'closed', people: 'any', labels: ['memory-only'] };
    rememberRepositoryFilter(filterKey('app'), saved);
    const storedBefore = localStorage.getItem(STORAGE_KEY);
    const shown = await show({ kind: 'issue', across: true });

    expect(shown.acrossReads.length).toBeGreaterThan(0);
    expect(shown.acrossReads.every((query) => query.labels === undefined)).toBe(true);

    await selectFilter({ state: 'closed', labels: ['bug'] });
    expect(localStorage.getItem(STORAGE_KEY)).toBe(storedBefore);
    expect(savedRepositoryFilter(filterKey('app'))).toEqual(saved);
    expect(shown.acrossReads.at(-1)?.labels).toBeUndefined();
  });
});
