import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type {
  Label,
  RepositoryReferenceFilter,
  RepositoryReferenceQuery,
  RepositoryReferenceKind,
  RuntimeAPIs,
  SourceControlBindingRead,
  SourceControlReadContext,
} from '@/lib/api/types';
import type { ReferencePickerSource } from './referencePickerItems';

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

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  // A closed panel's portal can outlive its root; the next test reads the document.
  document.body.replaceChildren();
});

const ENDPOINT = { displayUrl: 'https://github.com/acme/app', fingerprint: 'origin-fetch' };
// The board hands the same folder list on every render, so the harness does too.
const ACROSS_DIRECTORIES = ['/work/app'];

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

const setProvider = async (advancedSearch = false) => {
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const base = githubLikeDescriptor();
  const descriptor = { ...base, features: { ...base.features, referenceSearch: true, referenceDetail: true, referencesAcross: true, advancedSearch } };
  const state = { ordered: [descriptor], byId: new Map([[descriptor.id, descriptor]]), status: 'ready' as const, holdsList: true };
  useSourceControlProviderRegistry.setState(state);
  Object.assign(useSourceControlProviderRegistry.getInitialState(), state);
};

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};

type Shown = {
  patches: Array<Partial<RepositoryReferenceFilter>>;
  reads: RepositoryReferenceQuery[];
  labelReads: Array<{ context: SourceControlReadContext; project: { owner: string; repo: string } }>;
  acrossReads: RepositoryReferenceQuery[];
  setLabelsMode: (mode: 'ok' | 'fail') => void;
  /** What the host lists from now on, for a label that left the host. */
  setHostLabels: (labels: Label[]) => void;
};

const show = async (options: { kind?: RepositoryReferenceKind; source?: ReferencePickerSource; across?: boolean; advancedSearch?: boolean } = {}): Promise<Shown> => {
  const [{ useReferenceBrowser }, { ReferenceBrowserSearch }, { I18nProvider }, { RuntimeAPIContext }, { createWebAPIs }] = await Promise.all([
    import('./useReferenceBrowser'),
    import('./ReferenceBrowser'),
    import('@/lib/i18n'),
    import('@/contexts/runtimeAPIContext'),
    import('../../../../web/src/api/index'),
  ]);
  await setProvider(options.advancedSearch);
  const base = createWebAPIs();
  const patches: Array<Partial<RepositoryReferenceFilter>> = [];
  const reads: RepositoryReferenceQuery[] = [];
  const labelReads: Shown['labelReads'] = [];
  const acrossReads: RepositoryReferenceQuery[] = [];
  let labelsMode: 'ok' | 'fail' = 'ok';
  let hostLabels = LABELS;
  const apis: RuntimeAPIs = {
    ...base,
    sourceControl: {
      ...base.sourceControl,
      repositoryBinding: async () => bindingRead,
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
      references: async (_context, query) => {
        reads.push(query);
        return {
          connected: true as const,
          repo: { owner: 'acme', repo: 'app', url: 'https://github.com/acme/app' },
          items: [], cursor: null, hasMore: false, total: 0,
        };
      },
      referenceLabels: async (context, project) => {
        labelReads.push({ context, project });
        if (labelsMode === 'fail') throw new Error('This project is not readable');
        return hostLabels;
      },
    },
  };

  const Harness: React.FC = () => {
    const directories = options.across ? ACROSS_DIRECTORIES : null;
    const browser = useReferenceBrowser({
      source: options.source ?? 'repository',
      directory: '/work/app',
      directories,
      isMobile: false,
      initialGitHubKind: options.kind,
    });
    latestBrowser = browser;
    const searchable = {
      ...browser,
      selectRepositoryFilter: (patch: Partial<RepositoryReferenceFilter>) => {
        patches.push(patch);
        browser.selectRepositoryFilter(patch);
      },
    };
    return <ReferenceBrowserSearch browser={searchable} onKeyDown={() => undefined} />;
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
  return {
    patches,
    reads,
    labelReads,
    acrossReads,
    setLabelsMode: (mode) => { labelsMode = mode; },
    setHostLabels: (labels) => { hostLabels = labels; },
  };
};

/** The one filter trigger: the filter, and the applied labels named after it. */
const filterTrigger = () => host.querySelector<HTMLButtonElement>('button[aria-label="Filter"], button[aria-label^="Filter:"]');
/** The open panel; one still animating out is left over in the document. */
const menu = () => [...document.querySelectorAll<HTMLElement>('[role="menu"]')]
  .find((element) => !element.hasAttribute('data-ending-style')) ?? null;
/** One row of the open menu's label list, by the name it shows. */
const labelChoice = (name: string) => [...(menu()?.querySelectorAll<HTMLElement>('[data-slot="command-item"]') ?? [])]
  .find((item) => item.textContent?.trim() === name);
/** The check a chosen label carries. */
const checked = (name: string) => labelChoice(name)?.querySelector('use')?.getAttribute('href') === '#oc-check';
const click = async (element: HTMLElement | null | undefined) => {
  if (!element) throw new Error('Expected the element');
  await act(async () => { element.click(); });
  await flush();
};
const openMenu = () => click(filterTrigger());
/** The trigger closes the panel it opened, so a test can open it afresh. */
const closeMenu = async () => {
  if (menu()) await click(filterTrigger());
};
/** The browser the harness last rendered, for typing the way its field does. */
let latestBrowser: { setQuery: (value: string) => void } | null = null;

/** Types into the search field, as the user would. */
const setSearch = async (value: string) => {
  if (!latestBrowser) throw new Error('Expected the rendered browser');
  await act(async () => { latestBrowser?.setQuery(value); });
  await flush();
};

/** One group's heading in the open panel. */
const groupLabel = (name: string) => [...(menu()?.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-label"]') ?? [])]
  .find((element) => element.textContent?.startsWith(name));

/** Opens the panel, emptying labels an earlier test left: the selection is remembered for the app run. */
const openFiltered = async (shown: Shown) => {
  await openMenu();
  if (!filterTrigger()?.getAttribute('aria-label')?.includes(':')) return;
  await click(labelChoice('Clear'));
  shown.patches.length = 0;
  shown.reads.length = 0;
  shown.labelReads.length = 0;
};
const issueReads = (shown: Shown) => shown.reads.filter((query) => query.kind === 'issue');

describe('the labels filter in the filter menu', () => {
  test('labels are read when the panel opens, and not before', async () => {
    const shown = await show();
    await flush();
    expect(shown.labelReads).toEqual([]);
    await openMenu();
    expect(shown.labelReads.length).toBe(1);
    expect(shown.labelReads[0]?.project).toEqual({ owner: 'acme', repo: 'app' });
    expect(shown.labelReads[0]?.context?.directory).toBe('/work/app');
    await closeMenu();
  });

  test('checking one applies the filter and reads the list again with it', async () => {
    const shown = await show();
    await openFiltered(shown);
    const before = issueReads(shown).length;
    await click(labelChoice('bug'));
    expect(shown.patches).toEqual([{ labels: ['bug'] }]);
    expect(issueReads(shown).length).toBeGreaterThan(before);
    expect(issueReads(shown).at(-1)?.labels).toEqual(['bug']);
    expect(shown.labelReads.length).toBe(1);
    // The panel stays open for the next pick.
    expect(menu()).not.toBeNull();
    expect(checked('bug')).toBe(true);
    await closeMenu();
  });

  test('a second label is added to the first, not put in its place', async () => {
    const shown = await show();
    await openFiltered(shown);
    await click(labelChoice('bug'));
    await click(labelChoice('docs'));
    expect(shown.patches).toEqual([{ labels: ['bug'] }, { labels: ['bug', 'docs'] }]);
    expect(issueReads(shown).at(-1)?.labels).toEqual(['bug', 'docs']);
    await closeMenu();
  });

  test('checking the same label again removes it', async () => {
    const shown = await show();
    await openFiltered(shown);
    await click(labelChoice('bug'));
    await click(labelChoice('bug'));
    expect(shown.patches.at(-1)).toEqual({ labels: [] });
    // An empty selection is left out of the request, so it reads as unset.
    expect(issueReads(shown).at(-1)?.labels ?? []).toEqual([]);
    expect(checked('bug')).toBe(false);
    expect(filterTrigger()?.getAttribute('aria-label')).toBe('Filter');
    await closeMenu();
  });

  test('the one trigger names what is applied, counting past the first', async () => {
    const shown = await show();
    await openFiltered(shown);
    expect(filterTrigger()?.getAttribute('aria-label')).toBe('Filter');
    expect(filterTrigger()?.textContent?.trim()).toBe('Open');
    await click(labelChoice('bug'));
    expect(filterTrigger()?.getAttribute('aria-label')).toBe('Filter: bug');
    expect(filterTrigger()?.textContent?.trim()).toBe('Open · bug');
    expect(filterTrigger()?.getAttribute('title')).toBe('Open · bug');
    await click(labelChoice('docs'));
    expect(filterTrigger()?.getAttribute('aria-label')).toBe('Filter: bug, docs');
    expect(filterTrigger()?.textContent?.trim()).toBe('Open · bug +1');
    // The tooltip still names every applied label.
    expect(filterTrigger()?.getAttribute('title')).toBe('Open · bug, docs');
    await closeMenu();
  });

  test('Clear inside the menu empties the applied labels', async () => {
    const shown = await show();
    await openFiltered(shown);
    await click(labelChoice('bug'));
    await click(labelChoice('docs'));
    await click(labelChoice('Clear'));
    expect(shown.patches.at(-1)).toEqual({ labels: [] });
    expect(filterTrigger()?.getAttribute('aria-label')).toBe('Filter');
    // Nothing to clear once none are chosen.
    expect(labelChoice('Clear')).toBeUndefined();
    await closeMenu();
  });

  test('a label the host stops listing stays checked, and can be unpicked', async () => {
    const shown = await show();
    await openFiltered(shown);
    await click(labelChoice('bug'));
    await closeMenu();
    shown.setHostLabels([{ name: 'docs' }]);
    await openMenu();
    expect(checked('bug')).toBe(true);
    expect(checked('docs')).toBe(false);
    await click(labelChoice('bug'));
    expect(shown.patches.at(-1)).toEqual({ labels: [] });
    await closeMenu();
  });

  test('a failed read keeps the selection and shows the host message', async () => {
    const shown = await show();
    await openFiltered(shown);
    await click(labelChoice('bug'));
    await closeMenu();
    shown.setLabelsMode('fail');
    await openMenu();
    expect(menu()?.textContent).toContain('Could not load labels');
    expect(menu()?.textContent).toContain('This project is not readable');
    // The chosen label stays chosen, and can still be unpicked.
    expect(checked('bug')).toBe(true);
    expect(filterTrigger()?.getAttribute('aria-label')).toBe('Filter: bug');
    expect(shown.patches.at(-1)).toEqual({ labels: ['bug'] });
    await closeMenu();
  });

  test('a list across repositories has no labels section', async () => {
    const shown = await show({ across: true });
    await openMenu();
    expect(menu()?.textContent).toContain('Status');
    expect(menu()?.textContent).not.toContain('Labels');
    expect(labelChoice('bug')).toBeUndefined();
    expect(shown.labelReads).toEqual([]);
    // A set picked in one repository does not name itself on a list that cannot use it.
    expect(filterTrigger()?.getAttribute('aria-label')).toBe('Filter');
    await closeMenu();
  });

  test('a discussion has no labels section, only its status and people', async () => {
    const shown = await show({ kind: 'discussion' });
    await openMenu();
    expect(menu()?.textContent).toContain('People');
    expect(menu()?.textContent).not.toContain('Labels');
    expect(shown.labelReads).toEqual([]);
    expect(filterTrigger()?.getAttribute('aria-label')).toBe('Filter');
    await closeMenu();
  });

  test('a tracker keeps its own filters and no labels', async () => {
    const shown = await show({ source: 'tracker:linear' });
    await openMenu();
    expect(menu()?.textContent).toContain('Status');
    expect(menu()?.textContent).not.toContain('Labels');
    expect(labelChoice('bug')).toBeUndefined();
    expect(shown.labelReads).toEqual([]);
    expect(filterTrigger()?.getAttribute('aria-label')).toBe('Filter');
    await closeMenu();
  });
});

test('an across read sends no labels while a single repository read sends them', async () => {
  const [{ useRepositoryReferenceList, useRepositoryAcrossReferenceList }, { I18nProvider }, { RuntimeAPIContext }, { createWebAPIs }] = await Promise.all([
    import('./referenceSources'),
    import('@/lib/i18n'),
    import('@/contexts/runtimeAPIContext'),
    import('../../../../web/src/api/index'),
  ]);
  await setProvider();
  const base = createWebAPIs();
  const singleQueries: RepositoryReferenceQuery[] = [];
  const acrossQueries: RepositoryReferenceQuery[] = [];
  // The labels this person picked in one repository; the across list has no control for them.
  const filter: RepositoryReferenceFilter = { state: 'closed', people: 'any', labels: ['bug'] };
  const directories = ['/work/app'];
  const apis: RuntimeAPIs = {
    ...base,
    sourceControl: {
      ...base.sourceControl,
      repositoryBinding: async () => bindingRead,
      references: async (_context, query) => {
        singleQueries.push(query);
        return {
          connected: true as const,
          repo: { owner: 'acme', repo: 'app', url: 'https://github.com/acme/app' },
          items: [], cursor: null, hasMore: false, total: 0,
        };
      },
      referencesAcross: async (contexts, query) => {
        acrossQueries.push(query);
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
  const Harness: React.FC = () => {
    useRepositoryReferenceList({ enabled: true, directory: '/work/app', kind: 'issue', filter, query: '' });
    useRepositoryAcrossReferenceList({ enabled: true, directories, kind: 'issue', filter, query: '' });
    return null;
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
  expect(singleQueries.at(-1)?.labels).toEqual(['bug']);
  expect(acrossQueries.length).toBeGreaterThan(0);
  expect(acrossQueries.every((query) => query.labels === undefined)).toBe(true);
});

describe('the GitHub qualifiers the search text carries', () => {
  test('a state qualifier takes the status control over', async () => {
    await show({ advancedSearch: true });
    await setSearch('is:closed');
    expect(host.querySelector('input')?.value).toBe('is:closed');
    await openMenu();
    // The panel names the qualifier that decides the field, not a stale control value.
    expect(groupLabel('Status')?.textContent).toBe('Status · is:closed');
    expect(filterTrigger()?.textContent).toContain('is:closed');
    expect(filterTrigger()?.textContent).not.toContain('Open');
    const group = groupLabel('Status')?.nextElementSibling;
    const items = [...(group?.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-radio-item"]') ?? [])];
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.getAttribute('aria-disabled') === 'true')).toBe(true);
    // Nothing is ticked: the control no longer decides the list.
    expect(items.some((item) => item.getAttribute('aria-checked') === 'true')).toBe(false);
    await closeMenu();
  });

  test('a people qualifier takes the people control over, not the status one', async () => {
    await show({ advancedSearch: true });
    await setSearch('assignee:octocat');
    await openMenu();
    expect(groupLabel('Status')?.textContent).toBe('Status');
    expect(groupLabel('People')?.textContent).toBe('People · assignee:octocat');
    await closeMenu();
  });

  test('plain text leaves both controls as they are', async () => {
    await show({ advancedSearch: true });
    await setSearch('crash on start');
    await openMenu();
    expect(groupLabel('Status')?.textContent).toBe('Status');
    expect(groupLabel('People')?.textContent).toBe('People');
    await closeMenu();
  });

  test('a host that does not parse qualifiers keeps the controls', async () => {
    await show();
    await setSearch('is:closed');
    await openMenu();
    expect(groupLabel('Status')?.textContent).toBe('Status');
    await closeMenu();
  });

  test('the search field names the qualifiers only where they work', async () => {
    await show({ advancedSearch: true });
    expect(host.querySelector('input')?.placeholder).toContain('is: label: author:');
  });
});
