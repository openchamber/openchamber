import React, { act } from 'react';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createRoot, type Root } from 'react-dom/client';
import { searchFixture } from './sidebarSearch.fixture';
import { resolveSidebarSearchScope, sidebarSearchMetadata } from './sidebarConversationSearch';
import { ARCHIVED_SEARCH_INITIAL, buildSessionSidebarRowModel } from './sessionSidebarRowModel';
import { searchScopeQuery, type SearchScope } from '@/lib/search/omniQuery';
import type { Session } from '@/lib/opencode/model';
import type { WorktreeMetadata } from '@/types/worktree';
import type { searchConversations } from '@/lib/messageSearch';
import type { VSCodeBootstrapConfig } from '@/lib/vscodeBootstrap';

type GroupedSearchPage = Extract<Awaited<ReturnType<typeof searchConversations>>, { status: 'ok' }>;

let dom: Window;
let root: Root;
let originals: Map<string, PropertyDescriptor | undefined>;
let requests: URL[];
// What the active block's request answers with, and the archived block's.
let response: GroupedSearchPage;
let archivedResponse: GroupedSearchPage;
let failRequest: boolean;
let searchTimers: Map<ReturnType<Window['setTimeout']>, () => void>;
let setQuery: (query: string) => void;
let setScope: (scope: SearchScope) => void;
let I18nProvider: typeof import('@/lib/i18n').I18nProvider;
let useSidebarConversationSearch: typeof import('./useSidebarConversationSearch').useSidebarConversationSearch;
let SidebarConversationRow: typeof import('./SidebarConversationRow').SidebarConversationRow;
let SidebarSearchMore: typeof import('./SidebarConversationRow').SidebarSearchMore;
let SidebarSearchArchivedCaption: typeof import('./SidebarConversationRow').SidebarSearchArchivedCaption;
let SidebarSearchShowMore: typeof import('./SidebarConversationRow').SidebarSearchShowMore;
let useUIStore: typeof import('@/stores/useUIStore').useUIStore;

beforeEach(async () => {
  dom = new Window({ url: 'http://localhost' });
  requests = [];
  response = { status: 'ok', hits: [], next: null, totals: null, index: null };
  archivedResponse = { status: 'ok', hits: [], next: null, totals: { sessions: 0, byDirectory: {} }, index: null };
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
    IS_REACT_ACT_ENVIRONMENT: true, fetch: async (input: RequestInfo | URL) => { const url = new URL(String(input), 'http://localhost'); requests.push(url); if (failRequest) throw new Error('offline'); return Response.json(url.searchParams.get('lifecycle') === 'archived' ? archivedResponse : response); },
  };
  originals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  ({ I18nProvider } = await import('@/lib/i18n'));
  ({ useSidebarConversationSearch } = await import('./useSidebarConversationSearch'));
  ({ SidebarConversationRow, SidebarSearchMore, SidebarSearchArchivedCaption, SidebarSearchShowMore } = await import('./SidebarConversationRow'));
  ({ useUIStore } = await import('@/stores/useUIStore'));
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
// Old conversations of project a, archived, that the tree does not list.
// SAFETY: search metadata reads only identity, location, title and lifecycle.
const archivedSessions = Array.from({ length: ARCHIVED_SEARCH_INITIAL + 2 }, (_, index) => ({ id: `old-${index}`, title: `Legacy plan ${index}`, directory: '/repo/a', time: { created: 1, updated: 1, archived: 2 } } as Session));
const projects = fixture.sections.map((section) => section.project);
const worktrees = new Map<string, WorktreeMetadata[]>();
const knownDirectories = new Set(['/repo/a', '/repo/b']);

// The collection's own wiring: scope, metadata, the shared hook, the row model, the rows.
function Search({ mobile = false, vscode = false }: { mobile?: boolean; vscode?: boolean }) {
  const [text, updateText] = React.useState('needle');
  const [scopeChoice, updateScope] = React.useState<SearchScope>('everything');
  const [archivedShown, setArchivedShown] = React.useState(false);
  setQuery = updateText;
  setScope = updateScope;
  const scope = React.useMemo(() => resolveSidebarSearchScope({ projects, worktrees, knownDirectories: vscode ? new Set(['/repo/a']) : knownDirectories, isVSCode: vscode }), [vscode]);
  const metadata = React.useMemo(() => sidebarSearchMetadata({ sessions: [...sessions, ...archivedSessions], isAdmitted: scope.isAdmitted, owners: fixture.sessionOwnerById, projects, worktrees }), [scope]);
  const query = searchScopeQuery(scopeChoice);
  const search = useSidebarConversationSearch({ enabled: scope.available, text, searchIn: query.searchIn, author: query.author, metadataItems: metadata, directories: scope.directories, isAdmitted: scope.isAdmitted });
  const model = buildSessionSidebarRowModel({ ...fixture, mode: 'search', contentSearchResults: search.results, revealedSearchSections: archivedShown ? new Set(['archived'] as const) : undefined,
    searchSectionsWithMore: search.sectionsWithMore,
    searchIncomplete: search.contentStatus.kind === 'loading' || (search.contentStatus.kind === 'ready' && Boolean(search.contentStatus.indexing)),
  });
  const presentation = { query: text, author: query.author, searchIn: query.searchIn, loadMore: search.loadMore, showMore: () => setArchivedShown(true) };
  return <div data-content-status={search.contentStatus.kind} data-search-total={JSON.stringify(search.totalCount)} data-row-kinds={model.rows.map((row) => row.kind).join(' ')}>
    {model.rows.map((row) => row.kind === 'search-result' ? <SidebarConversationRow key={row.key} result={row.result} context={row.context} mobile={mobile} search={presentation} />
      : row.kind === 'search-archived-caption' ? <SidebarSearchArchivedCaption key={row.key} />
      : row.kind === 'search-show-more' ? <SidebarSearchShowMore key={row.key} mobile={mobile} section={row.section} hidden={row.hidden} onShow={presentation.showMore} />
      : row.kind === 'search-more' ? <SidebarSearchMore key={row.key} mobile={mobile} onLoadMore={() => search.loadMore(row.section)} />
      : row.kind === 'empty' ? <div key={row.key} data-search-empty /> : null)}
  </div>;
}

const render = (node: React.ReactNode) => act(async () => root.render(<I18nProvider>{node}</I18nProvider>));
// What the list shows, top to bottom.
const listed = () => [...document.querySelectorAll('[data-conversation-result], [data-sidebar-search-archived], [data-sidebar-search-show-more], [data-sidebar-search-more]')].map((element) => (
  element.getAttribute('data-conversation-result') ?? (element.hasAttribute('data-sidebar-search-archived') ? 'ARCHIVED' : element.hasAttribute('data-sidebar-search-show-more') ? 'SHOW-ARCHIVED' : 'MORE')
));
const status = () => document.querySelector('[data-content-status]')?.getAttribute('data-content-status');
const runContentSearch = () => act(async () => { const timers = [...searchTimers.values()]; searchTimers.clear(); timers.forEach((run) => run()); await new Promise<void>((resolve) => setImmediate(resolve)); });
const contentHit = (sessionId: string, overrides: Partial<GroupedSearchPage['hits'][number]> = {}): GroupedSearchPage['hits'][number] => ({
  sessionId, sessionTitle: 'Release notes', directory: '/repo/b', archived: false, messageId: `m-${sessionId}`, role: 'assistant', createdAt: 1, snippet: 'a needle here', matchCount: 1, ...overrides,
});

for (const mobile of [false, true]) test(`${mobile ? 'phone' : 'desktop'} lists title matches of every project flat, archived ones after their caption, with no content request while message search is off`, async () => {
  await render(<Search mobile={mobile} />);

  expect(listed()).toEqual(['a-0', 'b-0', 'b-1', 'ARCHIVED', 'a-1']);
  expect(document.querySelector('[data-row-kinds]')?.getAttribute('data-row-kinds')).toBe('search-result search-result search-result search-archived-caption search-result');
  expect(status()).toBe('off');
  expect(requests).toHaveLength(0);
});

for (const mobile of [false, true]) test(`${mobile ? 'phone' : 'desktop'} shows the first archived matches and the rest once asked for`, async () => {
  await render(<Search mobile={mobile} />);
  await act(async () => setQuery('legacy'));

  expect(listed()).toEqual(['ARCHIVED', 'old-0', 'old-1', 'old-2', 'old-3', 'old-4', 'SHOW-ARCHIVED']);
  expect(document.querySelector('[data-sidebar-search-show-more]')?.textContent).toBe('Show 2 more');

  await act(async () => document.querySelector<HTMLElement>('[data-sidebar-search-show-more]')!.click());
  expect(listed()).toEqual(['ARCHIVED', 'old-0', 'old-1', 'old-2', 'old-3', 'old-4', 'old-5', 'old-6']);
});

test('a conversation found only by its messages joins the list with its excerpt, and a title match gains one', async () => {
  useUIStore.setState({ messageSearchEnabled: true });
  response = { status: 'ok', hits: [contentHit('a-0', { directory: '/repo/a', sessionTitle: 'Needle conversation 0', matchCount: 3 }), contentHit('by-message')], next: null, totals: null, index: null };
  await render(<Search />);
  await runContentSearch();

  expect(status()).toBe('ready');
  expect(listed()).toEqual(['a-0', 'b-0', 'b-1', 'by-message', 'ARCHIVED', 'a-1']);
  const row = (id: string) => document.querySelector(`[data-conversation-result="${id}"]`)!;
  expect(row('by-message').querySelector('[data-conversation-excerpt-author]')?.textContent).toBe('Agent:');
  expect(row('by-message').querySelector('[data-conversation-excerpt-action] mark')?.textContent).toBe('needle');
  expect(row('a-0').querySelector('[data-conversation-excerpt-action]')).not.toBeNull();
  expect(row('a-0').querySelector('[data-conversation-more-matches]')?.textContent).toBe('+2');
  expect(row('b-0').querySelector('[data-conversation-excerpt-action]')).toBeNull();
  // Each block asks for its own lifecycle, in every directory.
  expect(requests.map((request) => request.searchParams.get('lifecycle'))).toEqual(['active', 'archived']);
  expect(requests.at(-1)?.searchParams.getAll('directory')).toEqual([]);
});

for (const mobile of [false, true]) test(`${mobile ? 'phone' : 'desktop'} lists an archived conversation found by a message at once, however many active ones match, and pages each block on its own`, async () => {
  useUIStore.setState({ messageSearchEnabled: true });
  response = { status: 'ok', hits: [contentHit('by-message')], next: '1:by-message', totals: null, index: null };
  archivedResponse = { status: 'ok', hits: [contentHit('old-by-message', { archived: true })], next: '1:old-by-message', totals: null, index: null };
  await render(<Search mobile={mobile} />);
  await runContentSearch();

  expect(listed()).toEqual(['a-0', 'b-0', 'b-1', 'by-message', 'MORE', 'ARCHIVED', 'a-1', 'old-by-message', 'MORE']);

  archivedResponse = { status: 'ok', hits: [contentHit('older-by-message', { archived: true })], next: null, totals: null, index: null };
  await act(async () => { [...document.querySelectorAll<HTMLElement>('[data-sidebar-search-more]')].at(-1)!.click(); await new Promise<void>((resolve) => setImmediate(resolve)); });
  expect(requests.at(-1)?.searchParams.get('lifecycle')).toBe('archived');
  expect(requests.at(-1)?.searchParams.get('before')).toBe('1:old-by-message');
  expect(listed()).toEqual(['a-0', 'b-0', 'b-1', 'by-message', 'MORE', 'ARCHIVED', 'a-1', 'old-by-message', 'older-by-message']);
});

test('a listed conversation whose title does not match is found by its message, once', async () => {
  useUIStore.setState({ messageSearchEnabled: true });
  response = { status: 'ok', hits: [contentHit('a-0', { directory: '/repo/a' }), contentHit('a-1', { directory: '/repo/a' })], next: null, totals: null, index: null };
  // Archived a moment ago: the index lists it under both lifecycles for a beat.
  archivedResponse = { status: 'ok', hits: [contentHit('a-1', { directory: '/repo/a', archived: true })], next: null, totals: null, index: null };
  await render(<Search />);
  await act(async () => setQuery('target'));
  await runContentSearch();

  expect(listed()).toEqual(['a-0', 'a-1']);
});

test('a content hit outside the admitted directories is left out', async () => {
  useUIStore.setState({ messageSearchEnabled: true });
  response = { status: 'ok', hits: [contentHit('outside', { directory: '/outside' }), contentHit('nested', { directory: '/repo/b/packages/ui' })], next: null, totals: null, index: null };
  await render(<Search />);
  await runContentSearch();

  expect(listed()).toEqual(['a-0', 'b-0', 'b-1', 'nested', 'ARCHIVED', 'a-1']);
});

test('the scope picks where the words are looked for: titles alone ask for no messages, an author leaves titles out', async () => {
  useUIStore.setState({ messageSearchEnabled: true });
  response = { status: 'ok', hits: [contentHit('by-message', { role: 'user' })], next: null, totals: null, index: null };
  await render(<Search />);
  await act(async () => setScope('titles'));
  await runContentSearch();
  expect(listed()).toEqual(['a-0', 'b-0', 'b-1', 'ARCHIVED', 'a-1']);
  expect(status()).toBe('idle');
  expect(requests).toHaveLength(0);

  await act(async () => setScope('user'));
  await runContentSearch();
  expect(requests.at(-1)?.searchParams.get('role')).toBe('user');
  expect(listed()).toEqual(['by-message']);
});

test('VS Code searches its workspace titles, with message search unsupported and no content request', async () => {
  Object.defineProperty(window, '__VSCODE_CONFIG__', { configurable: true, value: {
    workspaceFolder: '/repo/a', workspaceFolders: ['/repo/a'], panelType: 'chat',
  } satisfies VSCodeBootstrapConfig });
  useUIStore.setState({ messageSearchEnabled: true });
  await render(<Search vscode />);

  expect(status()).toBe('unsupported');
  expect(listed()).toEqual(['a-0', 'ARCHIVED', 'a-1']);
  expect(requests).toHaveLength(0);
});

for (const mobile of [false, true]) test(`${mobile ? 'phone' : 'desktop'} never claims empty while indexing, and pages past an entirely unadmitted content page`, async () => {
  useUIStore.setState({ messageSearchEnabled: true });
  response = { status: 'ok', hits: [contentHit('outside', { directory: '/outside' })],
    next: '1:outside', totals: null, index: { backfill: { state: 'running', done: 3, total: 10 }, sessions: 10, messages: 3, lifecycleComplete: true } };
  await render(<Search mobile={mobile} />);
  await act(async () => setQuery('target'));
  await runContentSearch();

  expect(status()).toBe('ready');
  expect(listed()).toEqual(['MORE']);
  expect(document.querySelector('[data-search-empty]')).toBeNull();

  response = { status: 'ok', hits: [], next: null, totals: null, index: null };
  await act(async () => { document.querySelector<HTMLElement>('[data-sidebar-search-more]')!.click(); await new Promise<void>((resolve) => setImmediate(resolve)); });
  expect(requests.at(-1)?.searchParams.get('before')).toBe('1:outside');
  expect(listed()).toEqual([]);
});

test('a failed content request keeps the title matches and reports the error', async () => {
  useUIStore.setState({ messageSearchEnabled: true });
  failRequest = true;
  await render(<Search />);
  await runContentSearch();

  expect(status()).toBe('error');
  expect(listed()).toEqual(['a-0', 'b-0', 'b-1', 'ARCHIVED', 'a-1']);
});

test('a capped total stays unknown with a full page loaded, while a known zero is zero', async () => {
  useUIStore.setState({ messageSearchEnabled: true });
  response = { status: 'ok', hits: Array.from({ length: 20 }, (_, index) => contentHit(`content-${index}`, { directory: '/repo/a' })), next: '20:content', totals: null, index: null };
  await render(<Search />);
  await act(async () => setQuery('target'));
  await runContentSearch();
  expect(document.querySelectorAll('[data-conversation-result]')).toHaveLength(20);
  expect(document.querySelector('[data-search-total]')?.getAttribute('data-search-total')).toBe('null');

  response = { status: 'ok', hits: [], next: null, totals: { sessions: 0, byDirectory: {} }, index: null };
  await act(async () => setQuery('missing'));
  await runContentSearch();
  expect(document.querySelector('[data-search-total]')?.getAttribute('data-search-total')).toBe('0');
});
