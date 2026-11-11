import React, { act } from 'react';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createRoot, type Root } from 'react-dom/client';
import { searchFixture } from './sidebarSearch.fixture';
import { resolveSidebarSearchScope, sidebarSearchMetadata, projectSidebarSearchGroups, projectSidebarSearchResults, isSidebarSearchActive } from './sidebarConversationSearch';
import { buildSessionSidebarRowModel } from './sessionSidebarRowModel';
import { parseOmniQuery, setOmniFlag } from '@/lib/search/omniQuery';
import type { OmniFilters } from '@/lib/search/omniQuery';
import type { WorktreeMetadata } from '@/types/worktree';
import type { searchConversations } from '@/lib/messageSearch';
import type { VSCodeBootstrapConfig } from '@/lib/vscodeBootstrap';

type GroupedSearchPage = Extract<Awaited<ReturnType<typeof searchConversations>>, { status: 'ok' }>;

let dom: Window;
let root: Root;
let originals: Map<string, PropertyDescriptor | undefined>;
let requests: URL[];
let response: GroupedSearchPage;
let failRequest: boolean;
let searchTimers: Map<ReturnType<Window['setTimeout']>, () => void>;
let setQuery: (query: string) => void;
let changeFilter: (key: keyof OmniFilters, value: string | null) => void;
let I18nProvider: typeof import('@/lib/i18n').I18nProvider;
let useConversationSearch: typeof import('@/hooks/useConversationSearch').useConversationSearch;
let SearchStatusLine: typeof import('@/components/search/SearchStatusLine').SearchStatusLine;
let SearchScopeMenu: typeof import('@/components/search/SearchScopeMenu').SearchScopeMenu;
let SearchFilterChips: typeof import('@/components/search/SearchFilterChips').SearchFilterChips;
let useOmniSearchState: typeof import('@/lib/search/omniSearchState').useOmniSearchState;
let readRememberedFilters: typeof import('@/lib/search/omniSearchState').readRememberedFilters;
let rememberFilters: typeof import('@/lib/search/omniSearchState').rememberFilters;
let SessionSearchInput: typeof import('@/components/session/SessionSearchInput').SessionSearchInput;
let SidebarConversationRow: typeof import('./SidebarConversationRow').SidebarConversationRow;
let SidebarSearchMore: typeof import('./SidebarConversationRow').SidebarSearchMore;
let useUIStore: typeof import('@/stores/useUIStore').useUIStore;
let EMPTY_CONVERSATION_CONTEXT: typeof import('@/components/search/conversationResultContext').EMPTY_CONVERSATION_CONTEXT;

beforeEach(async () => {
  dom = new Window({ url: 'http://localhost' });
  requests = [];
  response = { status: 'ok', hits: [], next: null, totals: null, index: null };
  failRequest = false;
  searchTimers = new Map();
  const originalSetTimeout = dom.setTimeout.bind(dom);
  const originalClearTimeout = dom.clearTimeout.bind(dom);
  dom.setTimeout = (callback, delay, ...args) => {
    if (delay === 150) {
      const id = originalSetTimeout(() => {}, 0);
      originalClearTimeout(id);
      searchTimers.set(id, () => callback(...args));
      return id;
    }
    return originalSetTimeout(callback, delay, ...args);
  };
  dom.clearTimeout = (id) => { if (!searchTimers.delete(id)) originalClearTimeout(id); };
  const globals = { window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage, location: dom.location,
    HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent,
    MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent, KeyboardEvent: dom.KeyboardEvent,
    ResizeObserver: dom.ResizeObserver, getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true, fetch: async (input: RequestInfo | URL) => { requests.push(new URL(String(input), 'http://localhost')); if (failRequest) throw new Error('offline'); return Response.json(response); },
  };
  originals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  ({ I18nProvider } = await import('@/lib/i18n'));
  ({ useConversationSearch } = await import('@/hooks/useConversationSearch'));
  ({ SearchStatusLine } = await import('@/components/search/SearchStatusLine'));
  ({ SearchScopeMenu } = await import('@/components/search/SearchScopeMenu'));
  ({ SearchFilterChips } = await import('@/components/search/SearchFilterChips'));
  ({ useOmniSearchState, readRememberedFilters, rememberFilters } = await import('@/lib/search/omniSearchState'));
  ({ SessionSearchInput } = await import('@/components/session/SessionSearchInput'));
  ({ SidebarConversationRow, SidebarSearchMore } = await import('./SidebarConversationRow'));
  ({ useUIStore } = await import('@/stores/useUIStore'));
  ({ EMPTY_CONVERSATION_CONTEXT } = await import('@/components/search/conversationResultContext'));
  useUIStore.setState({ messageSearchEnabled: false });
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  await dom.happyDOM.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const fixture = searchFixture(4);
const sessions = fixture.sections.flatMap((section) => section.groups.flatMap((group) => group.sessions.map((node) => node.session)));
sessions[1]!.time.archived = 2;
const projects = fixture.sections.map((section) => section.project);
const worktrees = new Map<string, WorktreeMetadata[]>();
const knownDirectories = new Set(['/repo/a', '/repo/b']);

function ScopedProjection({ mobile = false, vscode = false }: { mobile?: boolean; vscode?: boolean }) {
  const [raw, update] = React.useState('needle project:a');
  setQuery = update;
  changeFilter = (key, value) => update((raw) => setOmniFlag(raw, key, value));
  const query = React.useMemo(() => parseOmniQuery(raw), [raw]);
  const lifecycle = query.filters.lifecycle ?? 'active';
  const scope = React.useMemo(() => resolveSidebarSearchScope({ filters: query.filters, projects, worktrees, activeProjectId: 'a',
    knownDirectories, owners: fixture.sessionOwnerById, sessions, isVSCode: vscode }), [query, vscode]);
  const metadata = React.useMemo(() => sidebarSearchMetadata({ sessions, lifecycle, isAdmitted: scope.isAdmitted, owners: fixture.sessionOwnerById, projects, worktrees }), [lifecycle, scope]);
  const active = isSidebarSearchActive(query);
  const search = useConversationSearch({ enabled: active && scope.available, text: query.text, lifecycle, searchIn: 'everything', author: 'any', metadataItems: metadata, directories: scope.directories, isAdmitted: scope.isAdmitted });
  const { results, totalCount } = projectSidebarSearchResults({ metadata, results: search.results, text: query.text, totalCount: search.totalCount });
  const model = buildSessionSidebarRowModel({ ...fixture, mode: active ? 'search' : 'normal', contentSearchResults: results,
    hasMoreSearchResults: search.contentStatus.kind === 'ready' && search.contentStatus.hasMore,
    searchIncomplete: search.contentStatus.kind === 'loading' || (search.contentStatus.kind === 'ready' && Boolean(search.contentStatus.indexing)),
    groupSearchDataByGroup: projectSidebarSearchGroups(fixture.sections.flatMap((section) => section.groups), new Set(results.map((result) => result.sessionId))),
  });
  return <div data-exact-directories={JSON.stringify(scope.directories)} data-content-status={search.contentStatus.kind} data-search-total={JSON.stringify(totalCount)}>
    <SearchScopeMenu filters={query.filters} defaults={{ lifecycle: 'active', searchIn: 'everything' }} options={{ lifecycle: true, project: null, searchIn: true, author: false }}
      projectOptions={projects.map((project) => ({ value: project.normalizedPath, label: project.label ?? project.id }))}
      onChange={changeFilter} resultCount={totalCount} layout={mobile ? 'mobile' : 'sidebar'} />
    <SearchStatusLine status={search.contentStatus} count={totalCount} />
    {model.rows.map((row) => row.kind === 'session' && row.searchResult ? <SidebarConversationRow key={row.key} result={row.searchResult} context={row.context ?? EMPTY_CONVERSATION_CONTEXT} mobile={mobile} />
      : row.kind === 'search-result' ? <SidebarConversationRow key={row.key} result={row.result} context={row.context} mobile={mobile} />
      : row.kind === 'search-more' ? <SidebarSearchMore key={row.key} mobile={mobile} onLoadMore={search.loadMore} />
      : row.kind === 'empty' ? <div key={row.key} data-search-empty /> : null)}
  </div>;
}

function RememberedSidebarSearch() {
  const [open, setOpen] = React.useState(true);
  const search = useOmniSearchState({
    surface: 'sidebar',
    defaults: { lifecycle: 'active', searchIn: 'everything', author: 'any' },
    projects: [{ value: '/repo/a', label: 'a' }],
  });
  return open ? <div data-sidebar-search-open>
    <button type="button" data-close-sidebar-search onClick={() => { search.clearText(); setOpen(false); }}>Close search</button>
    <SessionSearchInput
      value={search.text}
      onSearch={search.setText}
      onClose={() => { search.clearText(); setOpen(false); }}
      placeholder="Search sessions"
      clearLabel="Clear search"
      chips={<SearchFilterChips filters={search.filters} defaults={{ lifecycle: 'active', searchIn: 'everything', author: 'any' }} projectOptions={[{ value: '/repo/a', label: 'a' }]} onRemove={search.removeFilter} />}
      onClearFilters={search.clearAll}
      onCommit={(text) => search.setText(text, { commit: true })}
    />
  </div> : <div data-sidebar-normal data-query="">
    <button type="button" onClick={() => setOpen(true)}>Open search</button>
  </div>;
}

test('remembered sidebar filters survive closing, then chip removal updates storage', async () => {
  rememberFilters('sidebar', { lifecycle: 'archived', project: '/repo/a' });
  await act(async () => root.render(<I18nProvider><RememberedSidebarSearch /></I18nProvider>));
  expect(document.querySelector('[data-search-filter-chip="lifecycle"]')).not.toBeNull();
  expect(document.querySelector('[data-search-filter-chip="project"]')).not.toBeNull();

  await act(async () => document.querySelector<HTMLElement>('[data-close-sidebar-search]')!.click());
  expect(document.querySelector('[data-sidebar-normal]')?.getAttribute('data-query')).toBe('');
  expect(readRememberedFilters('sidebar')).toEqual({ lifecycle: 'archived', project: '/repo/a' });

  await act(async () => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Open search')!.click());
  await act(async () => document.querySelector<HTMLElement>('[data-search-filter-chip-remove="project"]')!.click());
  expect(document.querySelector('[data-search-filter-chip="project"]')).toBeNull();
  expect(readRememberedFilters('sidebar')).toEqual({ lifecycle: 'archived' });
  rememberFilters('sidebar', {});
});

for (const mobile of [false, true]) test(`${mobile ? 'phone' : 'desktop'} active/archive/all scopes render matching metadata through the production projection`, async () => {
  await act(async () => root.render(<I18nProvider><ScopedProjection mobile={mobile} /></I18nProvider>));
  const ids = () => [...document.querySelectorAll('[data-conversation-result]')].map((element) => element.getAttribute('data-conversation-result'));
  expect(ids()).toEqual(['a-0']);
  await act(async () => changeFilter('lifecycle', 'archived'));
  expect(ids()).toEqual(['a-1']);
  expect(document.querySelector('[data-conversation-archived]')).not.toBeNull();
  await act(async () => changeFilter('lifecycle', 'all'));
  expect(ids()).toEqual(['a-0', 'a-1']);
  expect(document.querySelector('[data-content-status]')?.getAttribute('data-content-status')).toBe('off');
  expect(document.querySelector('[role="status"]')?.textContent?.length).toBeGreaterThan(0);
  expect(requests).toHaveLength(0);
});

test('live filter changes and typed flags feed the same exact directory scope to metadata and the hook', async () => {
  useUIStore.setState({ messageSearchEnabled: true });
  await act(async () => root.render(<I18nProvider><ScopedProjection /></I18nProvider>));
  await act(async () => document.querySelector<HTMLElement>('[data-search-scope-trigger]')!.click());
  await act(async () => document.querySelector<HTMLElement>('[data-search-scope-option="project:/repo/b"]')!.click());
  const menuDirectories = document.querySelector('[data-exact-directories]')?.getAttribute('data-exact-directories');
  expect(menuDirectories).toBe('["/repo/b"]');
  expect(document.querySelectorAll('[data-conversation-result]')).toHaveLength(2);
  await act(async () => { const timers = [...searchTimers.values()]; searchTimers.clear(); timers.forEach((run) => run()); await new Promise<void>((resolve) => setImmediate(resolve)); });
  expect(requests.at(-1)?.searchParams.getAll('directory')).toEqual(['/repo/b']);
  await act(async () => setQuery('needle project:/repo/b in:all'));
  expect(document.querySelector('[data-exact-directories]')?.getAttribute('data-exact-directories')).toBe(menuDirectories);
  await act(async () => { const timers = [...searchTimers.values()]; searchTimers.clear(); timers.forEach((run) => run()); await new Promise<void>((resolve) => setImmediate(resolve)); });
  expect(requests.at(-1)?.searchParams.getAll('directory')).toEqual(['/repo/b']);
  expect(requests.at(-1)?.searchParams.get('lifecycle')).toBe('all');
  const requestCount = requests.length;
  await act(async () => setQuery('needle worktree:missing'));
  expect(document.querySelector('[data-exact-directories]')?.getAttribute('data-exact-directories')).toBe('[]');
  expect(document.querySelectorAll('[data-conversation-result]')).toHaveLength(0);
  expect(requests).toHaveLength(requestCount);
});

test('VS Code metadata remains usable with unsupported status and no content request', async () => {
  Object.defineProperty(window, '__VSCODE_CONFIG__', { configurable: true, value: {
    workspaceFolder: '/repo/a', workspaceFolders: ['/repo/a'], panelType: 'chat',
  } satisfies VSCodeBootstrapConfig });
  useUIStore.setState({ messageSearchEnabled: true });
  await act(async () => root.render(<I18nProvider><ScopedProjection vscode /></I18nProvider>));
  expect(document.querySelector('[data-content-status]')?.getAttribute('data-content-status')).toBe('unsupported');
  expect(document.querySelector('[role="status"]')?.textContent?.length).toBeGreaterThan(0);
  expect(document.querySelectorAll('[data-conversation-result]')).toHaveLength(1);
  expect(requests).toHaveLength(0);
});

test('the phone project filter updates the committed scope without Enter', async () => {
  await act(async () => root.render(<I18nProvider><ScopedProjection mobile /></I18nProvider>));
  await act(async () => document.querySelector<HTMLElement>('[data-search-scope-trigger]')!.click());
  const choice = [...document.querySelectorAll<HTMLElement>('[data-search-scope-control="project"] button')].find((button) => button.textContent === 'b');
  expect(choice).toBeDefined();
  await act(async () => choice!.click());
  expect(document.querySelector('[data-exact-directories]')?.getAttribute('data-exact-directories')).toBe('["/repo/b"]');
  expect([...document.querySelectorAll('[data-conversation-result]')].map((element) => element.getAttribute('data-conversation-result'))).toEqual(['b-0', 'b-1']);
});

for (const mobile of [false, true]) test(`${mobile ? 'phone' : 'desktop'} shows partial-index status and pages past an entirely unadmitted content page`, async () => {
  useUIStore.setState({ messageSearchEnabled: true });
  response = { status: 'ok', hits: [{ sessionId: 'outside', sessionTitle: 'Outside', directory: '/outside', archived: false, messageId: 'm1', role: 'user', createdAt: 1, snippet: 'target', matchCount: 1 }],
    next: '1:outside', totals: null, index: { backfill: { state: 'running', done: 3, total: 10 }, sessions: 10, messages: 3, lifecycleComplete: true } };
  await act(async () => root.render(<I18nProvider><ScopedProjection mobile={mobile} /></I18nProvider>));
  await act(async () => setQuery('target project:a'));
  await act(async () => { const timers = [...searchTimers.values()]; searchTimers.clear(); timers.forEach((run) => run()); await new Promise<void>((resolve) => setImmediate(resolve)); });
  expect(document.querySelector('[data-content-status]')?.getAttribute('data-content-status')).toBe('ready');
  expect(document.querySelectorAll('[data-conversation-result]')).toHaveLength(0);
  expect(document.querySelector('[role="status"]')?.textContent).toContain('3');
  expect(document.querySelector('[role="status"]')?.textContent).toContain('10');
  expect(document.querySelector('[data-search-empty]')).toBeNull();
  expect(requests.at(-1)?.searchParams.getAll('directory')).toEqual(['/repo/a']);
  response = { status: 'ok', hits: [], next: null, totals: null, index: null };
  await act(async () => { document.querySelector<HTMLElement>('[data-sidebar-search-more]')!.click(); await new Promise<void>((resolve) => setImmediate(resolve)); });
  expect(requests.at(-1)?.searchParams.get('before')).toBe('1:outside');
  expect(document.querySelector('[data-sidebar-search-more]')).toBeNull();
});

test('request errors keep metadata rows usable and expose an error status', async () => {
  useUIStore.setState({ messageSearchEnabled: true });
  failRequest = true;
  await act(async () => root.render(<I18nProvider><ScopedProjection /></I18nProvider>));
  await act(async () => { const timers = [...searchTimers.values()]; searchTimers.clear(); timers.forEach((run) => run()); await new Promise<void>((resolve) => setImmediate(resolve)); });
  expect(document.querySelector('[data-content-status]')?.getAttribute('data-content-status')).toBe('error');
  expect(document.querySelectorAll('[data-conversation-result]')).toHaveLength(1);
  expect(document.querySelector('[role="status"]')?.textContent?.length).toBeGreaterThan(0);
});

for (const mobile of [false, true]) test(`${mobile ? 'phone' : 'desktop'} filter-only lifecycle and project queries project the whole admitted scope`, async () => {
  await act(async () => root.render(<I18nProvider><ScopedProjection mobile={mobile} /></I18nProvider>));
  const ids = () => [...document.querySelectorAll('[data-conversation-result]')].map((element) => element.getAttribute('data-conversation-result'));
  await act(async () => setQuery('in:archived'));
  expect(ids()).toEqual(['a-1']);
  await act(async () => setQuery('project:/repo/b'));
  expect(ids()).toEqual(['b-0', 'b-1']);
  expect(requests).toHaveLength(0);
});

test('a capped unknown total stays null with 20 loaded results, while known zero stays zero', async () => {
  useUIStore.setState({ messageSearchEnabled: true });
  response = { status: 'ok', hits: Array.from({ length: 20 }, (_, index) => ({ sessionId: `content-${index}`, sessionTitle: 'Target', directory: '/repo/a', archived: false, messageId: `m-${index}`, role: 'user', createdAt: 1, snippet: 'target', matchCount: 1 })), next: null, totals: null, index: null };
  await act(async () => root.render(<I18nProvider><ScopedProjection /></I18nProvider>));
  await act(async () => setQuery('target project:a'));
  await act(async () => { const timers = [...searchTimers.values()]; searchTimers.clear(); timers.forEach((run) => run()); await new Promise<void>((resolve) => setImmediate(resolve)); });
  expect(document.querySelectorAll('[data-conversation-result]')).toHaveLength(20);
  expect(document.querySelector('[data-search-total]')?.getAttribute('data-search-total')).toBe('null');
  expect(document.querySelector('[data-search-scope-count]')?.textContent).toBe('');
  response = { status: 'ok', hits: [], next: null, totals: { sessions: 0, byDirectory: {} }, index: null };
  await act(async () => setQuery('missing project:a'));
  await act(async () => { const timers = [...searchTimers.values()]; searchTimers.clear(); timers.forEach((run) => run()); await new Promise<void>((resolve) => setImmediate(resolve)); });
  expect(document.querySelector('[data-search-total]')?.getAttribute('data-search-total')).toBe('0');
  expect(document.querySelector('[data-search-scope-count]')?.textContent).toBe('0');
});
