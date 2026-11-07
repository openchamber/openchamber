import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { Session } from '@/lib/opencode/model';
import type { SpaceArchive } from '@/lib/spaces/spaces-api';
import { createProjectIdFromPath } from '@/lib/projectId';
const browser = new Window({ url: 'http://localhost' });
let root: Root;
const descriptors = new Map<string, PropertyDescriptor | undefined>();
// React DOM detects input-event support when imported, so install the DOM first.
for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage, Element: browser.Element, HTMLElement: browser.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
  // The row's context menu orders its items and animates its popup.
  Node: browser.Node, MouseEvent: browser.MouseEvent, DOMRect: browser.DOMRect, getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; }, cancelAnimationFrame: () => undefined })) {
  descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true });
}
const PROJECT = { id: createProjectIdFromPath('/workspace'), path: '/workspace' };
let spaceArchives: SpaceArchive[] = [];
let messageSearchRequests: URL[] = [];
let messageSearchResponse: ((url: URL) => object) | null = null;
let expandedRequests: URL[] = [];
let expandedResponse: ((url: URL) => Response | Promise<Response>) | null = null;
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
  const { pathname: path } = url;
  if (path === '/api/openchamber/message-search/sessions') {
    messageSearchRequests.push(url);
    if (messageSearchResponse) {
      const response = await messageSearchResponse(url);
      return response instanceof Response ? response : Response.json(response);
    }
    return Response.json({ status: 'ok', hits: [], next: null, totals: { sessions: 0, byDirectory: {} }, index: { backfill: { state: 'done', total: 0, done: 0 }, sessions: 0, messages: 0, lifecycleComplete: true } });
  }
  if (path === '/api/openchamber/message-search') {
    expandedRequests.push(url);
    if (expandedResponse) return expandedResponse(url);
  }
  if (path === '/api/config/settings') return Response.json({ projects: [PROJECT] });
  if (path.endsWith('/fs/home')) return Response.json({ home: '/home/test' });
  if (path.endsWith('/fs/directory-stats')) return Response.json({ results: [{ path: '/gone/worktree', reason: 'not-found' }, { path: '/untrusted/clone', isDirectory: true }] });
  if (path === '/api/openchamber/spaces/archives') return Response.json({ archives: spaceArchives });
  if (path.endsWith('/archives')) return Response.json({ archives: [] });
  if (path === '/api/config' || path === '/api/project') return Response.json([]);
  if (path.endsWith('/location')) return Response.json({ directory: '/workspace', project: { id: 'project', directory: '/workspace', canonical: '/workspace' } });
  if (path.endsWith('/session/active')) return Response.json({ data: {} });
  if (path.endsWith('/vcs')) return Response.json({ data: { branch: { current: 'main', default: 'main' } } });
  return Response.json({ data: [], cursor: {} });
});
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useUIStore } = await import('@/stores/useUIStore');
const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { useGlobalSyncStore } = await import('@/sync/global-sync-store');
const { ArchiveSessionsView, ArchiveView } = await import('./ArchiveView');
const { refreshSpaceArchives, useSpaceArchivesStore } = await import('@/lib/spaces/space-archives');
const { updateDesktopSettings } = await import('@/lib/persistence');
const navigation = await import('@/lib/router/openSessionFromRoute');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const initialSessionUI = useSessionUIStore.getState();
const testRestorers: Array<() => void> = [];
const initialUI = useUIStore.getState();
const initialSessions = useGlobalSessionsStore.getState();
const initialProjects = useProjectsStore.getState();
const session = (id: string, title: string, archived = 2): Session => ({
  id, title, projectID: 'project', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, directory: '/workspace',
  time: { created: 1, updated: 1, archived },
});

beforeEach(() => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  spaceArchives = [];
  messageSearchRequests = [];
  messageSearchResponse = null;
  expandedRequests = [];
  expandedResponse = null;
  useSpaceArchivesStore.getState().resetForRuntimeSwitch();
  useUIStore.setState({ isArchivePageOpen: true });
  useProjectsStore.setState({ projects: [PROJECT] });
});

afterEach(async () => {
  await act(async () => root.unmount());
  for (const restore of testRestorers.splice(0)) restore();
  useSessionUIStore.setState(initialSessionUI);
  useUIStore.setState(initialUI);
  useGlobalSessionsStore.setState(initialSessions);
  useProjectsStore.setState(initialProjects);
  document.body.replaceChildren();
});

afterAll(async () => {
  await browser.happyDOM.close();
  fetchSpy.mockRestore();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('archive search uses exact IDs and preserves title search and archive membership', async () => {
  const id = 'ses_f88b1a2b3c4d';
  useGlobalSessionsStore.setState({
    archivedSessions: [session(id, 'Release notes'), session('ses_f88b1a2b3c4e', id)],
    activeSessions: [session('ses_active', 'Active session', 0)],
  });
  await act(async () => root.render(<I18nProvider><ArchiveView /></I18nProvider>));
  const input = browser.document.querySelector('input');
  if (!input) throw new Error('Archive search input missing');
  const setValue = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
  if (!setValue) throw new Error('Input value setter missing');
  const search = async (query: string) => {
    await act(async () => {
      setValue.call(input, query);
      input.dispatchEvent(new browser.Event('input', { bubbles: true }));
      input.dispatchEvent(new browser.Event('change', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    return [...document.querySelectorAll('[data-conversation-title], [role="button"] > span:first-child')].map((row) => row.textContent);
  };
  expect(await search(id)).toEqual(['Release notes']);
  expect(await search(`  ${id.toUpperCase()}  `)).toEqual(['Release notes']);
  for (const query of ['ses_', 'ses_f88b', 'ses_f88b1a2b3c4f', `${id}x`, `${id} error`, 'ses_active']) {
    expect(await search(query)).toEqual([]);
  }
  expect(await search('release')).toEqual(['Release notes']);
  expect(await search('releaze')).toEqual([]);
  expect(await search('')).toHaveLength(2);
});

test('a filter-only active project query searches active metadata', async () => {
  useGlobalSessionsStore.setState({
    archivedSessions: [session('ses_archived', 'Archived chat')],
    activeSessions: [session('ses_active', 'Active project chat', 0)],
    status: 'ready',
  });
  await act(async () => root.render(<I18nProvider><ArchiveView /></I18nProvider>));
  const input = browser.document.querySelector('input');
  if (!input) throw new Error('Archive search input missing');
  const setValue = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
  if (!setValue) throw new Error('Input value setter missing');
  await act(async () => {
    setValue.call(input, 'in:active project:workspace');
    input.dispatchEvent(new browser.Event('input', { bubbles: true }));
    input.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  expect(document.querySelector('[data-conversation-result="ses_active"]')).not.toBeNull();
  expect(document.querySelector('[data-conversation-result="ses_archived"]')).toBeNull();
});

test('a typed project filter narrows the content request and deleting a clicked flag releases it', async () => {
  const advance = searchClock();
  const otherProject = { id: createProjectIdFromPath('/other'), path: '/other' };
  useProjectsStore.setState({ projects: [PROJECT, otherProject] });
  useUIStore.setState({ messageSearchEnabled: true });
  useGlobalSessionsStore.setState({
    archivedSessions: [session('ses_workspace', 'Workspace chat'), { ...session('ses_other', 'Other chat'), directory: '/other' }],
    activeSessions: [],
    status: 'ready',
  });
  await act(async () => root.render(<I18nProvider><ArchiveView /></I18nProvider>));
  const search = async (value: string) => {
    await typeSearch(value);
    await advance(250);
  };
  await search('needle project:workspace');
  expect(messageSearchRequests.at(-1)?.searchParams.getAll('directory')).toEqual(['/workspace']);
  const workspaceButton = [...document.querySelectorAll<HTMLButtonElement>('.group\\/dir button')].find((button) => button.textContent?.includes('workspace'));
  if (!workspaceButton) throw new Error('Workspace project filter missing');
  await act(async () => workspaceButton.click());
  expect(browser.document.querySelector('input')?.value).toContain('project:/workspace');
  await search('needle');
  expect(messageSearchRequests.at(-1)?.searchParams.getAll('directory')).toEqual(['/workspace', '/other']);
});

test('search project counts use known totals and omit capped totals', async () => {
  const advance = searchClock();
  useUIStore.setState({ messageSearchEnabled: true });
  useGlobalSessionsStore.setState({ archivedSessions: [session('ses_count', 'Needle archive')], activeSessions: [], status: 'ready' });
  messageSearchResponse = () => ({ status: 'ok', hits: [], next: null, totals: { sessions: 4, byDirectory: { '/workspace': 4 } }, index: { backfill: { state: 'done', total: 0, done: 0 }, sessions: 0, messages: 0, lifecycleComplete: true } });
  await act(async () => root.render(<I18nProvider><ArchiveView /></I18nProvider>));
  const search = async (query: string) => {
    await typeSearch(query);
    await advance(250);
  };
  await search('needle');
  expect([...document.querySelectorAll('.group\\/dir button')].find((button) => button.textContent?.startsWith('workspace'))?.textContent).toContain('5');
  messageSearchResponse = () => ({ status: 'ok', hits: [], next: null, totals: null, index: { backfill: { state: 'done', total: 0, done: 0 }, sessions: 0, messages: 0, lifecycleComplete: true } });
  await search('needles');
  expect([...document.querySelectorAll('.group\\/dir button')].find((button) => button.textContent?.startsWith('workspace'))?.textContent).toBe('workspace');
});

test('archive rows hide unregistered destinations while preserving raw archived records', async () => {
  useGlobalSessionsStore.setState({ archivedSessions: [
    session('kept-archive', 'Kept archive'),
    { ...session('blocked-archive', 'Blocked archive'), directory: '/unregistered' },
  ] });
  await act(async () => root.render(<I18nProvider><ArchiveView /></I18nProvider>));
  expect(document.body.textContent).toContain('Kept archive');
  expect(document.body.textContent).not.toContain('Blocked archive');
  expect(useGlobalSessionsStore.getState().archivedSessions).toHaveLength(2);
});

test('a session of a worktree that is gone is listed, one in an existing folder of the same OpenCode project is not', async () => {
  const syncProjects = useGlobalSyncStore.getState().projects;
  useGlobalSyncStore.setState({ projects: [{ id: 'project', worktree: '/workspace', time: { created: 1, updated: 1 }, sandboxes: [] }] });
  useGlobalSessionsStore.setState({ archivedSessions: [
    { ...session('gone-worktree', 'Gone worktree'), directory: '/gone/worktree' },
    { ...session('untrusted-clone', 'Untrusted clone'), directory: '/untrusted/clone' },
  ] });
  await act(async () => root.render(<I18nProvider><ArchiveView /></I18nProvider>));
  // Directory probes share one request after a short window.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
  expect(document.body.textContent).toContain('Gone worktree');
  expect(document.body.textContent).not.toContain('Untrusted clone');
  useGlobalSyncStore.setState({ projects: syncProjects });
});

test('the chats of a deleted space are grouped under its name and cannot be restored', async () => {
  spaceArchives = [{ spaceId: 'a1b2c3d4e5f6', name: 'Fix login', directory: '/data/spaces/archive/a1b2c3d4e5f6' }];
  useGlobalSessionsStore.setState({
    archivedSessions: [
      { ...session('ses_space1', 'Agent chat'), directory: '/data/spaces/archive/a1b2c3d4e5f6' },
      session('ses_mine1', 'My chat'),
    ],
    activeSessions: [],
  });
  await act(async () => root.render(<I18nProvider><ArchiveView /></I18nProvider>));
  await act(async () => {
    await refreshSpaceArchives();
    await updateDesktopSettings({});
  });
  const groups = [...document.querySelectorAll('.group\\/dir button[title]')].map((button) => button.textContent);
  expect(groups.some((label) => label?.startsWith('Fix login'))).toBe(true);
  expect(document.querySelector('[aria-label="Restore Agent chat"]')).toBeNull();
  expect(document.querySelector('[aria-label="Restore My chat"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="Delete Agent chat"]')).not.toBeNull();
});

test('right-clicking an archived row offers to copy its session ID', async () => {
  useGlobalSessionsStore.setState({
    archivedSessions: [session('ses_copy1', 'Copy me')],
    activeSessions: [],
  });
  await act(async () => root.render(<I18nProvider><ArchiveView /></I18nProvider>));
  const row = [...document.querySelectorAll('[role="button"]')].find((element) => element.textContent?.startsWith('Copy me'));
  if (!row) throw new Error('Archived session row missing');
  await act(async () => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  });
  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  expect(items.map((item) => item.textContent)).toEqual(['Copy session ID', 'Restore', 'Delete']);
  await act(async () => { items[0]?.click(); });
  expect(await browser.navigator.clipboard.readText()).toBe('ses_copy1');
  // Copying keeps the archive open; only a plain click opens the session.
  expect(useUIStore.getState().isArchivePageOpen).toBe(true);
});

test('the mobile layout names each row\'s project, offers Restore without Delete, and leaves when a session opens', async () => {
  useGlobalSessionsStore.setState({
    archivedSessions: [session('ses_mobile1', 'Phone chat')],
    activeSessions: [],
  });
  let left = 0;
  await act(async () => root.render(
    <I18nProvider><ArchiveSessionsView layout="mobile" onLeave={() => { left += 1; }} /></I18nProvider>,
  ));
  expect(document.querySelector('.group\\/dir')).toBeNull();
  expect(document.querySelector('[aria-label="Restore Phone chat"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="Delete Phone chat"]')).toBeNull();
  const row = [...document.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Phone chat'));
  if (!row) throw new Error('Archived session row missing');
  expect(row.textContent).toContain('workspace');
  await act(async () => { row.click(); });
  expect(left).toBe(1);
});

test('the page opens with the query the sidebar handed over, and a plain open starts fresh', async () => {
  useGlobalSessionsStore.setState({
    archivedSessions: [session('ses_a', 'Release notes'), session('ses_b', 'Login fix')],
    activeSessions: [],
    status: 'ready',
  });
  const titles = () => [...document.querySelectorAll('[data-conversation-title], [role="button"] > span:first-child')].map((row) => row.textContent);
  useUIStore.getState().setArchivePageOpen(true, 'release');
  await act(async () => root.render(<I18nProvider><ArchiveView /></I18nProvider>));
  expect(browser.document.querySelector('input')?.value).toBe('release');
  expect(titles()).toEqual(['Release notes']);

  // A second handover while the page is already open replaces the query.
  await act(async () => { useUIStore.getState().setArchivePageOpen(true, 'login'); });
  expect(browser.document.querySelector('input')?.value).toBe('login');
  expect(titles()).toEqual(['Login fix']);

  await act(async () => { useUIStore.getState().setArchivePageOpen(false); });
  expect(browser.document.querySelector('input')).toBeNull();
  await act(async () => { useUIStore.getState().setArchivePageOpen(true); });
  expect(browser.document.querySelector('input')?.value).toBe('');
  expect(titles()).toHaveLength(2);
});

test('a subsession archived while its parent stays active is listed under the parent\'s title', async () => {
  const boss = session('ses_boss', 'Boss', 0);
  const archivedParent = session('ses_old', 'Old run', 5);
  const sub = (id: string, title: string, parentID: string, archived: number): Session => ({ ...session(id, title, archived), parentID });
  useGlobalSessionsStore.getState().applySnapshot(
    [boss],
    [
      session('ses_plain', 'Plain chat', 3),
      sub('ses_fix', 'Fix capture', 'ses_boss', 4),
      sub('ses_review', 'Review fix', 'ses_boss', 1),
      archivedParent,
      sub('ses_old_child', 'Old child', 'ses_old', 5),
    ],
    'ready',
  );
  await act(async () => root.render(<I18nProvider><ArchiveView /></I18nProvider>));
  // The search sits in a column of the same width, so match the list itself.
  const list = document.querySelector('.max-w-3xl.space-y-0\\.5');
  if (!list) throw new Error('Archive list missing');
  const lines = [...list.children].map((element) => (element.tagName === 'P'
    ? `# ${element.textContent}`
    : element.querySelector('span')?.textContent));
  // Both subsessions of the active parent sit together under its title, at the
  // place of the newer one; a subsession of an archived parent stays hidden.
  expect(lines).toEqual(['Old run', '# Boss', 'Fix capture', 'Review fix', 'Plain chat']);
  expect(document.querySelector('[aria-label="Restore Fix capture"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="Restore Old child"]')).toBeNull();
});

test('an empty archive is not reported before the session list has loaded, or after it failed to load', async () => {
  const emptyText = () => document.querySelector('p.font-semibold')?.textContent;
  useGlobalSessionsStore.setState({ archivedSessions: [], activeSessions: [], status: 'loading' });
  await act(async () => root.render(<I18nProvider><ArchiveView /></I18nProvider>));
  expect(emptyText()).toBe('Loading sessions…');
  await act(async () => { useGlobalSessionsStore.setState({ status: 'error' }); });
  expect(emptyText()).toBe('Could not refresh sessions.');
  await act(async () => { useGlobalSessionsStore.setState({ status: 'ready' }); });
  expect(emptyText()).toBe('No archived sessions');
});

// These tests keep the view, input, search hooks and response parsing real.
// Only the network, navigation boundary and debounce clock are controlled.
function searchClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  // SAFETY: the fake records only `run` and `delay`; the code under test never reads `setTimeout.__promisify__`.
  const set = spyOn(window, 'setTimeout').mockImplementation(((run: () => void, delay = 0) => {
    const id = nextId++;
    timers.set(id, { at: now + delay, run });
    return id;
  }) as typeof window.setTimeout);
  const clear = spyOn(window, 'clearTimeout').mockImplementation((id) => { timers.delete(Number(id)); });
  testRestorers.push(() => { set.mockRestore(); clear.mockRestore(); });
  return async (milliseconds: number) => {
    const end = now + milliseconds;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      await act(async () => { next[1].run(); });
    }
    now = end;
  };
}

async function typeSearch(value: string) {
  const input = browser.document.querySelector('input');
  const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
  if (!input || !setter) throw new Error('Archive input missing');
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new browser.Event('input', { bubbles: true }));
  });
}

async function clickSearch(selector: string) {
  const button = document.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`Missing search action ${selector}`);
  await act(async () => { button.click(); });
}

const contentHit = (id: string) => ({
  sessionId: id, sessionTitle: `Conversation ${id}`, directory: '/workspace', archived: true,
  messageId: `msg_${id}`, role: 'user', createdAt: 1, snippet: 'A \uE000needle\uE001 in content', matchCount: 3,
});
const searchIndex = { backfill: { state: 'done', total: 0, done: 0 }, sessions: 2, messages: 4, lifecycleComplete: true };
const contentPage = (ids: string[], next: string | null = null) => ({
  status: 'ok', hits: ids.map(contentHit), next, totals: { sessions: 2, byDirectory: { '/workspace': 2 } }, index: searchIndex,
});
const expandedHit = (id: string) => ({
  id, sessionId: 'ses_content', sessionTitle: 'Ordinary title', directory: '/workspace',
  role: 'user', createdAt: 2, snippet: `${id} has \uE000needle\uE001 text`,
});

async function renderSearch(layout: 'page' | 'mobile' = 'page', onLeave: () => void = () => undefined) {
  useUIStore.setState({ messageSearchEnabled: true, messageSearchReasoningEnabled: false, showReasoningTraces: true });
  useGlobalSessionsStore.setState({ archivedSessions: [session('ses_content', 'Ordinary title')], activeSessions: [], status: 'ready' });
  await act(async () => root.render(<I18nProvider><ArchiveSessionsView layout={layout} onLeave={onLeave} /></I18nProvider>));
}

test('live archive content search debounces without Enter and renders the next conversation page', async () => {
  const advance = searchClock();
  let resolveNext: ((response: Response) => void) | undefined;
  const nextPage = new Promise<Response>((resolve) => { resolveNext = resolve; });
  messageSearchResponse = (url) => url.searchParams.has('before') ? nextPage : contentPage(['ses_content'], 'conversation-page-2');
  await renderSearch();
  await typeSearch('needle');
  await advance(99);
  expect(messageSearchRequests).toHaveLength(0);
  await advance(1);
  expect(document.querySelector('[data-conversation-result]')).toBeNull();
  await advance(149);
  expect(messageSearchRequests).toHaveLength(0);
  await advance(1);
  expect(document.querySelector('[data-conversation-title]')?.textContent).toBe('Conversation ses_content');
  expect(document.querySelector('[data-conversation-excerpt-action] mark')?.textContent).toBe('needle');
  const more = [...document.querySelectorAll<HTMLButtonElement>('[data-archive-search-results] button')].find((button) => button.textContent === 'Show more');
  if (!more) throw new Error('Conversation pager missing');
  await act(async () => more.click());
  expect(messageSearchRequests.at(-1)?.searchParams.get('before')).toBe('conversation-page-2');
  expect(document.querySelector('[data-conversation-result="ses_content"]')).not.toBeNull();
  expect(document.querySelector('[data-conversation-result="ses_second"]')).toBeNull();
  await act(async () => { resolveNext?.(Response.json(contentPage(['ses_second']))); });
  expect([...document.querySelectorAll('[data-conversation-title]')].map((title) => title.textContent)).toEqual(['Conversation ses_content', 'Conversation ses_second']);
});

test('excerpt and expanded message activation focus their message and leave without restoring', async () => {
  const advance = searchClock();
  const open = spyOn(navigation, 'openSessionLink').mockResolvedValue(undefined);
  const restore = spyOn(useSessionUIStore.getState(), 'unarchiveSession').mockResolvedValue(true);
  testRestorers.push(() => { open.mockRestore(); restore.mockRestore(); });
  let left = 0;
  messageSearchResponse = () => contentPage(['ses_content']);
  expandedResponse = () => Response.json({ status: 'ok', hits: [expandedHit('msg_expanded')], next: null, index: searchIndex });
  await renderSearch('page', () => { left += 1; });
  await typeSearch('needle');
  await advance(250);
  await clickSearch('[data-conversation-excerpt-action]');
  expect(open.mock.calls).toEqual([['ses_content', 'msg_ses_content']]);
  expect(left).toBe(1);
  await clickSearch('[data-conversation-more-matches]');
  await clickSearch('[data-archive-other-matches] button');
  expect(open.mock.calls.at(-1)).toEqual(['ses_content', 'msg_expanded']);
  expect(left).toBe(2);
  expect(restore).not.toHaveBeenCalled();
});

test('expanded archive matches retain author policy, highlight snippets and fetch the next message page', async () => {
  const advance = searchClock();
  messageSearchResponse = () => contentPage(['ses_content']);
  expandedResponse = (url) => Response.json({ status: 'ok', hits: [expandedHit(url.searchParams.has('before') ? 'msg_next' : 'msg_first')], next: url.searchParams.has('before') ? null : 'message-page-2', index: searchIndex });
  await renderSearch();
  await typeSearch('needle author:user');
  await advance(250);
  await clickSearch('[data-conversation-more-matches]');
  expect(expandedRequests[0]?.searchParams.get('session')).toBe('ses_content');
  expect(expandedRequests[0]?.searchParams.get('role')).toBe('user');
  expect(expandedRequests[0]?.searchParams.get('reasoning')).toBe('0');
  expect(expandedRequests[0]?.searchParams.get('lifecycle')).toBe('archived');
  expect(document.querySelector('[data-archive-other-matches] mark')?.textContent).toBe('needle');
  expect(/[\uE000\uE001]/.test(document.querySelector('[data-archive-other-matches]')?.textContent ?? '')).toBe(false);
  await clickSearch('[data-archive-other-matches] button:last-child');
  expect(expandedRequests.at(-1)?.searchParams.get('before')).toBe('message-page-2');
  expect(document.querySelector('[data-archive-other-matches]')?.textContent).toContain('msg_first');
  expect(document.querySelector('[data-archive-other-matches]')?.textContent).toContain('msg_next');
});

test('expanded message paging failure preserves hits and displays failure feedback', async () => {
  const advance = searchClock();
  messageSearchResponse = () => contentPage(['ses_content']);
  expandedResponse = (url) => url.searchParams.has('before')
    ? new Response('unavailable', { status: 500 })
    : Response.json({ status: 'ok', hits: [expandedHit('msg_kept')], next: 'failed-page', index: searchIndex });
  await renderSearch();
  await typeSearch('needle');
  await advance(250);
  await clickSearch('[data-conversation-more-matches]');
  await clickSearch('[data-archive-other-matches] button:last-child');
  const matches = document.querySelector('[data-archive-other-matches]');
  expect(expandedRequests.at(-1)?.searchParams.get('before')).toBe('failed-page');
  expect(matches?.textContent).toContain('msg_kept');
  expect(document.querySelector('[data-conversation-result="ses_content"]')).not.toBeNull();
  expect(matches?.querySelector('span.typography-micro')?.textContent?.trim().length ?? 0).toBeGreaterThan(0);
});

test('phone search reports off, request error and indexing states while keeping metadata visible', async () => {
  const advance = searchClock();
  await renderSearch('mobile');
  await act(async () => useUIStore.setState({ messageSearchEnabled: false }));
  await typeSearch('ordinary');
  await advance(250);
  const statusText = () => document.querySelector('[data-search-status-line] span:last-child')?.textContent;
  const off = statusText();
  expect(off?.length).toBeGreaterThan(0);
  expect(document.querySelector('[role="status"]')).not.toBeNull();
  expect(document.querySelector('[data-conversation-result="ses_content"]')).not.toBeNull();
  messageSearchResponse = () => new Response('failed', { status: 500 });
  await act(async () => useUIStore.setState({ messageSearchEnabled: true }));
  await advance(150);
  const error = statusText();
  expect(error?.length).toBeGreaterThan(0);
  expect(error).not.toBe(off);
  messageSearchResponse = () => ({ ...contentPage([]), index: { ...searchIndex, backfill: { state: 'running', done: 3, total: 10 } } });
  await typeSearch('ordinary title');
  await advance(250);
  expect(statusText()?.length).toBeGreaterThan(0);
  expect(statusText()).not.toBe(error);
  expect(document.querySelector('[data-conversation-result="ses_content"]')).not.toBeNull();
});

test('phone search exposes project and worktree sheet choices that update the raw query', async () => {
  const advance = searchClock();
  await renderSearch('mobile');
  await act(async () => {
    useSessionUIStore.setState({ availableWorktreesByProject: new Map([
      ['/workspace', [{ path: '/worktrees/feature', projectDirectory: '/workspace', branch: 'feature', label: 'feature' }]],
    ]) });
    useGlobalSessionsStore.setState({ archivedSessions: [
      session('ses_content', 'Ordinary title'),
      { ...session('ses_feature', 'Ordinary worktree'), directory: '/worktrees/feature' },
    ] });
  });
  await typeSearch('ordinary');
  await advance(250);
  await clickSearch('[data-search-scope-trigger]');
  expect(document.querySelector('[data-search-scope-panel="mobile"]')).not.toBeNull();
  const project = [...document.querySelectorAll<HTMLButtonElement>('[data-search-scope-control="project"] button')].find((button) => button.textContent === 'workspace');
  if (!project) throw new Error('Phone project choice missing');
  await act(async () => project.click());
  expect(browser.document.querySelector('input')?.value).toContain('project:/workspace');
  expect(project.getAttribute('aria-checked') ?? project.getAttribute('aria-pressed')).toBe('true');
  const worktree = [...document.querySelectorAll<HTMLButtonElement>('[data-search-scope-control="worktree"] button')].find((button) => button.textContent === 'feature');
  if (!worktree) throw new Error('Phone worktree choice missing');
  await act(async () => worktree.click());
  expect(browser.document.querySelector('input')?.value).toContain('worktree:feature');
  expect(worktree.getAttribute('aria-checked') ?? worktree.getAttribute('aria-pressed')).toBe('true');
  await advance(150);
  expect(messageSearchRequests.at(-1)?.searchParams.getAll('directory')).toEqual(['/worktrees/feature']);
  expect(document.querySelector('[data-conversation-result="ses_feature"]')).not.toBeNull();
  expect(document.querySelector('[data-conversation-result="ses_content"]')).toBeNull();
});

test('phone search restores through its localized named action and active results offer no Restore', async () => {
  const advance = searchClock();
  const restore = spyOn(useSessionUIStore.getState(), 'unarchiveSession').mockResolvedValue(true);
  testRestorers.push(() => restore.mockRestore());
  await renderSearch('mobile');
  await typeSearch('ordinary');
  await advance(250);
  await clickSearch('[data-conversation-result="ses_content"] button[aria-label="Restore Ordinary title"]');
  expect(restore.mock.calls).toEqual([['ses_content']]);
  await act(async () => useGlobalSessionsStore.setState({ activeSessions: [session('ses_active_result', 'Ordinary active', 0)] }));
  await typeSearch('ordinary in:active');
  await advance(250);
  const active = document.querySelector('[data-conversation-result="ses_active_result"]');
  expect(active).not.toBeNull();
  expect(active?.querySelector('[aria-label^="Restore"]')).toBeNull();
});

test('search metadata retains a standalone child parent title and an unmatched query has an explicit empty state', async () => {
  const advance = searchClock();
  await renderSearch();
  await act(async () => useGlobalSessionsStore.getState().applySnapshot(
    [session('ses_parent', 'Parent caption', 0)],
    [{ ...session('ses_child', 'Child needle'), parentID: 'ses_parent' }], 'ready',
  ));
  await typeSearch('needle');
  await advance(250);
  expect(document.querySelector('[data-conversation-result="ses_child"] [data-conversation-meta]')?.textContent).toContain('Parent caption');
  await typeSearch('unmatched query');
  await advance(250);
  expect(document.querySelector('[data-conversation-result]')).toBeNull();
  expect(document.querySelector('[data-archive-search-results] p')?.textContent?.trim().length).toBeGreaterThan(0);
});
