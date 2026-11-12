import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import type { Session } from '@/lib/opencode/model';

const browser = new Window({ url: 'http://localhost' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: browser, document: browser.document, Event: browser.Event, CustomEvent: browser.CustomEvent, navigator: browser.navigator,
  localStorage: browser.localStorage, Element: browser.Element, HTMLElement: browser.HTMLElement,
  Node: browser.Node, Text: browser.Text, Document: browser.Document, DocumentFragment: browser.DocumentFragment,
  ShadowRoot: browser.ShadowRoot, MutationObserver: browser.MutationObserver, SVGElement: browser.SVGElement,
  ResizeObserver: browser.ResizeObserver, getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true });
}
const originalFetch = globalThis.fetch;
const messageSearchRequests: string[] = [];
let respondToMessageSearch: (url: URL) => Promise<Response> = async () => Response.json({ status: 'ok', hits: [], next: null, index: null });
const fakeFetch = async (input: RequestInfo | URL): Promise<Response> => {
  const url = new URL(String(input), 'http://localhost');
  if (url.pathname === '/api/openchamber/message-search') {
    messageSearchRequests.push(url.toString());
    return respondToMessageSearch(url);
  }
  if (url.pathname === '/api/config/settings') return Response.json({ projects: [{ id: 'allowed', path: '/allowed' }] });
  return Response.json({
    home: '/home', chatsRoot: '/managed/chats', directory: url.searchParams.get('directory') ?? '/allowed',
    project: { directory: '/allowed' }, data: [], files: [], hits: [], archives: [], actions: [],
    trusted: false, fingerprint: 'untrusted', items: [],
  });
};
globalThis.fetch = fakeFetch;
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { RuntimeAPIProvider } = await import('@/contexts/RuntimeAPIProvider');
const { createWebAPIs } = await import('../../../../web/src/api');
const { CommandPalette } = await import('./CommandPalette');
const { SyncProvider } = await import('@/sync/sync-context');
const { OpenCode } = await import('@opencode/client');
const { settleOpenCodeTrust } = await import('@/lib/opencodeTrust');
const { useUIStore } = await import('@/stores/useUIStore');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
const { ensureHomeDirectoryResolved } = await import('@/stores/useDirectoryStore');
const { updateDesktopSettings } = await import('@/lib/persistence');
const originalUI = useUIStore.getState();
const originalProjects = useProjectsStore.getState();
const originalSessions = useGlobalSessionsStore.getState();
const originalSessionUI = useSessionUIStore.getState();
const apis = createWebAPIs();
const sdk = OpenCode.make({ baseUrl: 'http://palette.test', fetch: () => new Promise<Response>(() => undefined) });
let root: ReturnType<typeof createRoot>;
const session = (id: string, directory: string, title: string): Session => ({
  id, directory, title, projectID: id, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
});

beforeEach(() => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useUIStore.setState({ isCommandPaletteOpen: true, messageSearchEnabled: false });
  messageSearchRequests.length = 0;
  respondToMessageSearch = async () => Response.json({ status: 'ok', hits: [], next: null, index: null });
  useProjectsStore.setState({ projects: [{ id: 'allowed', path: '/allowed' }] });
  useSessionUIStore.setState({ availableWorktreesByProject: new Map() });
  useGlobalSessionsStore.setState({ archivedSessions: [], activeSessions: [
    session('allowed', '/allowed', 'Allowed conversation'),
    session('declined', '/declined', 'Declined conversation'),
  ] });
});

const renderPalette = async () => {
  await act(async () => root.render(<RuntimeAPIProvider apis={apis}><I18nProvider><SyncProvider sdk={sdk} directory="/allowed"><CommandPalette /></SyncProvider></I18nProvider></RuntimeAPIProvider>));
  await act(async () => {
    await ensureHomeDirectoryResolved();
    await updateDesktopSettings({});
  });
};
const paletteInput = () => {
  const input = browser.document.querySelector('input');
  if (!input) throw new Error('Command palette input missing');
  return input;
};
const editQuery = async (value: string) => {
  const input = paletteInput();
  const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('Input value setter missing');
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new browser.Event('input', { bubbles: true }));
  });
};
const typeQuery = async (value: string) => {
  await editQuery(value);
  // Commit the input update before waiting for its debounce effect.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 240)); });
};
const contentHit = (sessionId: string, snippet: string, directory = '/allowed') => ({
  id: `message-${sessionId}`, sessionId, role: 'user', createdAt: 1,
  sessionTitle: `Content ${sessionId}`, directory, snippet,
});
const hitRows = () => [...document.querySelectorAll('[cmdk-item]')].filter((row) => row.getAttribute('data-value')?.startsWith('message:user:'));
const statusText = () => [...document.querySelectorAll('[role="status"]')].map((status) => status.textContent).join(' ');
afterEach(async () => {
  await act(async () => root.unmount());
  await settleOpenCodeTrust('skip');
  useUIStore.setState(originalUI, true);
  useProjectsStore.setState(originalProjects, true);
  useGlobalSessionsStore.setState(originalSessions, true);
  useSessionUIStore.setState(originalSessionUI, true);
  document.body.replaceChildren();
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('recent sessions and name search exclude declined folders and react to admission', async () => {
  await act(async () => root.render(<RuntimeAPIProvider apis={apis}><I18nProvider><SyncProvider sdk={sdk} directory="/allowed"><CommandPalette /></SyncProvider></I18nProvider></RuntimeAPIProvider>));
  await act(async () => {
    // Settle the startup echo before simulating a new server-confirmed project.
    await ensureHomeDirectoryResolved();
    await updateDesktopSettings({});
  });
  expect(document.body.textContent).toContain('Allowed conversation');
  expect(document.body.textContent).not.toContain('Declined conversation');
  const input = browser.document.querySelector('input');
  if (!input) throw new Error('Command palette input missing');
  const setValue = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
  if (!setValue) throw new Error('Input value setter missing');
  await act(async () => {
    setValue.call(input, 'Declined');
    input.dispatchEvent(new browser.Event('input', { bubbles: true }));
    input.dispatchEvent(new browser.Event('change', { bubbles: true }));
  });
  expect(document.body.textContent).not.toContain('Allowed conversation');
  expect(document.body.textContent).not.toContain('Declined conversation');
  await act(async () => useProjectsStore.setState({ projects: [
    { id: 'allowed', path: '/allowed' }, { id: 'declined', path: '/declined' },
  ] }));
  expect(document.body.textContent).toContain('Declined conversation');
  expect(useGlobalSessionsStore.getState().activeSessions).toHaveLength(2);
});

const sessionRowTitles = () => [...document.querySelectorAll('[cmdk-item]')]
  .filter((row) => row.getAttribute('data-value')?.startsWith('session:'))
  .map((row) => row.textContent ?? '');
const groupHeadings = () => [...document.querySelectorAll('[cmdk-group-heading]')].map((heading) => heading.textContent ?? '');
const lastRequest = () => new URL(messageSearchRequests.at(-1)!);
const item = (value: string) => document.querySelector<HTMLElement>(`[cmdk-item][data-value="${value}"]`);

test('archived sessions matching by title form their own group after the active ones, with no setting', async () => {
  await renderPalette();
  await act(async () => useGlobalSessionsStore.setState({
    activeSessions: [session('active', '/allowed', 'Release notes draft')],
    archivedSessions: [
      session('archived', '/allowed', 'Release notes archive'),
      session('archived-declined', '/declined', 'Release notes elsewhere'),
    ],
  }));
  expect(document.body.textContent).not.toContain('Release notes archive');
  await editQuery('release notes');
  const headings = groupHeadings();
  expect(headings.indexOf('Sessions')).toBeGreaterThanOrEqual(0);
  expect(headings.indexOf('Archived')).toBe(headings.indexOf('Sessions') + 1);
  const rows = [...document.querySelectorAll('[cmdk-item]')].map((row) => row.getAttribute('data-value'));
  expect(rows.indexOf('session:active')).toBeLessThan(rows.indexOf('session:archived'));
  expect(rows).not.toContain('session:archived-declined');
});

test('opening an archived session selects it and leaves it archived', async () => {
  await renderPalette();
  await act(async () => useGlobalSessionsStore.setState({ activeSessions: [], archivedSessions: [session('archived', '/allowed', 'Shelved conversation')] }));
  await editQuery('shelved');
  expect(groupHeadings()).toContain('Archived');
  await act(async () => item('session:archived')?.click());
  expect(useSessionUIStore.getState().currentSessionId).toBe('archived');
  expect(useGlobalSessionsStore.getState().archivedSessions.map((entry) => entry.id)).toEqual(['archived']);
  expect(useGlobalSessionsStore.getState().activeSessions).toEqual([]);
});

test('text that looks like a filter flag is searched as plain text', async () => {
  await renderPalette();
  await act(async () => {
    useUIStore.setState({ messageSearchEnabled: true });
    useGlobalSessionsStore.setState({ archivedSessions: [], activeSessions: [session('flags', '/allowed', 'Parse in:archived flags')] });
  });
  await typeQuery('in:archived project:missing');
  expect(paletteInput().value).toBe('in:archived project:missing');
  expect(document.querySelector('[data-search-filter-chip]')).toBeNull();
  expect(messageSearchRequests).toHaveLength(1);
  expect(lastRequest().searchParams.get('q')).toBe('in:archived project:missing');
  expect(lastRequest().searchParams.get('lifecycle')).toBe('all');
  expect(lastRequest().searchParams.getAll('directory')).toEqual([]);
  await editQuery('in:archived');
  expect(sessionRowTitles().join(' ')).toContain('Parse in:archived flags');
});

test('the palette is an input and a list: no tabs, no filters, and Tab and Alt+ArrowDown are left alone', async () => {
  await renderPalette();
  expect(document.querySelector('[role="tab"]')).toBeNull();
  expect(document.querySelector('[data-palette-filters-trigger]')).toBeNull();
  const input = paletteInput();
  for (const init of [{ key: 'Tab' }, { key: 'Tab', shiftKey: true }, { key: 'ArrowDown', altKey: true }]) {
    const event = new browser.KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
    await act(async () => input.dispatchEvent(event));
    if (init.key === 'Tab') expect(event.defaultPrevented).toBe(false);
  }
  expect(document.querySelector('[role="tab"]')).toBeNull();
  expect(input.getAttribute('placeholder')).not.toBe('Search messages…');
});

test('Show all drills into the message hits of the same query, and Escape, Backspace or Back return', async () => {
  respondToMessageSearch = async (url) => Response.json({ status: 'ok', hits: url.searchParams.has('before')
    ? [contentHit('page-two', 'second page excerpt')]
    : [contentHit('allowed', 'first page excerpt')],
  next: url.searchParams.has('before') ? null : 'page-cursor', index: null });
  await renderPalette();
  await act(async () => useUIStore.setState({ messageSearchEnabled: true }));
  await typeQuery('needle');
  expect(lastRequest().searchParams.get('limit')).toBe('3');
  expect(groupHeadings()).toContain('Messages');
  expect(item('message:load-more')).toBeNull();

  const drillIn = async () => {
    await act(async () => item('message:show-all')?.click());
    await act(async () => { await Promise.resolve(); });
    expect(paletteInput().getAttribute('placeholder')).toBe('Search messages…');
    expect(paletteInput().value).toBe('needle');
    expect(groupHeadings()).toEqual([]);
    expect(lastRequest().searchParams.get('limit')).toBe('30');
  };
  const expectFullList = () => {
    expect(paletteInput().getAttribute('placeholder')).not.toBe('Search messages…');
    expect(document.querySelector('[data-palette-messages-back]')).toBeNull();
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(true);
  };

  await drillIn();
  await act(async () => item('message:load-more')?.click());
  expect(lastRequest().searchParams.get('before')).toBe('page-cursor');
  expect(lastRequest().searchParams.get('lifecycle')).toBe('all');
  expect(document.body.textContent).toContain('second page excerpt');
  await act(async () => paletteInput().dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expectFullList();
  expect(paletteInput().value).toBe('needle');
  expect(groupHeadings()).toContain('Messages');

  await drillIn();
  await act(async () => document.querySelector<HTMLElement>('[data-palette-messages-back]')?.click());
  expectFullList();

  await drillIn();
  // Backspace edits a query that has text; on an empty input it leaves the view.
  const editing = new browser.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
  await act(async () => paletteInput().dispatchEvent(editing));
  expect(editing.defaultPrevented).toBe(false);
  expect(paletteInput().getAttribute('placeholder')).toBe('Search messages…');
  await editQuery('');
  await act(async () => paletteInput().dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })));
  expectFullList();
});

test('message hits from archived sessions are listed, and a server without lifecycle fields reads as active', async () => {
  respondToMessageSearch = async () => Response.json({ status: 'ok', hits: [
    contentHit('active', 'authoritative active excerpt'),
    contentHit('archived', 'legacy archived excerpt'),
    contentHit('unknown', 'unknown lifecycle excerpt'),
  ], next: null, index: null });
  await renderPalette();
  await act(async () => {
    useUIStore.setState({ messageSearchEnabled: true });
    useGlobalSessionsStore.setState({ activeSessions: [session('active', '/allowed', 'Active title')], archivedSessions: [session('archived', '/allowed', 'Archive title')] });
  });
  await typeQuery('needle');
  expect(lastRequest().searchParams.get('lifecycle')).toBe('all');
  const rows = hitRows().map((row) => row.textContent ?? '');
  expect(rows).toHaveLength(3);
  expect(rows.find((row) => row.includes('legacy archived excerpt'))).toContain('Archived');
  expect(rows.find((row) => row.includes('authoritative active excerpt'))).not.toContain('Archived');
  expect(rows.find((row) => row.includes('unknown lifecycle excerpt'))).not.toContain('Archived');
});

test('a delayed response to an earlier query cannot replace the current results', async () => {
  let resolvePrior: ((response: Response) => void) | undefined;
  respondToMessageSearch = (url) => url.searchParams.get('q') === 'priorneedle'
    ? new Promise<Response>((resolve) => { resolvePrior = resolve; })
    : Promise.resolve(Response.json({ status: 'ok', hits: [contentHit('allowed', 'current excerpt')], next: null, index: null }));
  await renderPalette();
  await act(async () => useUIStore.setState({ messageSearchEnabled: true }));
  await typeQuery('priorneedle');
  expect(resolvePrior).toBeDefined();
  await typeQuery('currentneedle');
  expect(document.body.textContent).toContain('current excerpt');
  await act(async () => resolvePrior?.(Response.json({ status: 'ok', hits: [contentHit('allowed', 'late excerpt')], next: null, index: null })));
  expect(document.body.textContent).toContain('current excerpt');
  expect(document.body.textContent).not.toContain('late excerpt');
});

test('message hits follow folder admission: a worktree outside the project tree is listed, an unregistered folder is not', async () => {
  respondToMessageSearch = async () => Response.json({ status: 'ok', hits: [
    contentHit('task-session', 'worktree excerpt', '/external/task'),
    contentHit('other', 'unregistered excerpt', '/other'),
  ], next: null, index: null });
  await renderPalette();
  await act(async () => {
    useUIStore.setState({ messageSearchEnabled: true });
    useProjectsStore.setState({ projects: [{ id: 'allowed', path: '/allowed', label: 'OwningProject' }] });
    useSessionUIStore.setState({ availableWorktreesByProject: new Map([
      ['/allowed', [{ path: '/external/task', projectDirectory: '/allowed', branch: 'task', label: 'Task' }]],
    ]) });
  });
  await typeQuery('needle');
  expect(document.body.textContent).not.toContain('unregistered excerpt');
  expect(hitRows().find((row) => row.textContent?.includes('worktree excerpt'))?.textContent).toContain('OwningProject');
  await act(async () => useProjectsStore.setState({ projects: [{ id: 'allowed', path: '/allowed', label: 'OwningProject' }, { id: 'other', path: '/other' }] }));
  expect(document.body.textContent).toContain('unregistered excerpt');
});

test('with message search off the palette says nothing about messages', async () => {
  await renderPalette();
  await act(async () => useUIStore.setState({ messageSearchEnabled: false }));
  await typeQuery('unmatchedneedle');
  expect(messageSearchRequests).toEqual([]);
  expect(groupHeadings()).not.toContain('Messages');
  expect(document.body.textContent).not.toContain('Message search is off');
  expect(document.body.textContent).toContain('No results found.');
});

for (const [state, expectedStatus] of [
  ['error', "Couldn't search messages."],
  ['indexing', 'Still indexing older conversations: 2 of 9.'],
] as const) {
test(`the full list shows the ${state} message status without definitive emptiness`, async () => {
  respondToMessageSearch = async () => state === 'error'
    ? new Response('failed', { status: 500 })
    : Response.json({ status: 'ok', hits: [], next: null, index: {
      backfill: { state: 'running', total: 9, done: 2 }, sessions: 2, messages: 3,
    } });
  await renderPalette();
  await act(async () => useUIStore.setState({ messageSearchEnabled: true }));
  await typeQuery('unmatchedneedle');
  expect(statusText()).toContain(expectedStatus);
  expect(statusText()).not.toContain('No conversations match');
  expect(messageSearchRequests).toHaveLength(1);
  expect(document.body.textContent).not.toContain('No results found.');
});
}

test('a finished search with no message hits adds no Messages group, and a closed palette starts no requests', async () => {
  await renderPalette();
  await act(async () => useUIStore.setState({ messageSearchEnabled: true }));
  await typeQuery('unmatchedneedle');
  expect(messageSearchRequests).toHaveLength(1);
  expect(groupHeadings()).not.toContain('Messages');
  expect(document.body.textContent).toContain('No results found.');
  await act(async () => useUIStore.setState({ isCommandPaletteOpen: false }));
  await act(async () => useUIStore.setState({ showReasoningTraces: !useUIStore.getState().showReasoningTraces }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 240)); });
  expect(messageSearchRequests).toHaveLength(1);
});

test('turning reasoning display off removes retained reasoning immediately without waiting for the request', async () => {
  respondToMessageSearch = async () => Response.json({ status: 'ok', hits: [
    { ...contentHit('allowed', 'visible reasoning excerpt'), role: 'reasoning' },
    contentHit('allowed', 'visible user excerpt'),
  ], next: null, index: null });
  await renderPalette();
  await act(async () => useUIStore.setState({ messageSearchEnabled: true, messageSearchReasoningEnabled: true, showReasoningTraces: true }));
  await typeQuery('needle');
  expect(document.body.textContent).toContain('visible reasoning excerpt');
  respondToMessageSearch = () => new Promise<Response>(() => {});
  await act(async () => useUIStore.setState({ showReasoningTraces: false }));
  expect(document.body.textContent).not.toContain('visible reasoning excerpt');
  expect(document.body.textContent).toContain('visible user excerpt');
});

test('a session named what you typed ranks above a weaker project match, and a folder-only session below commands', async () => {
  await renderPalette();
  await act(async () => useGlobalSessionsStore.setState({ archivedSessions: [], activeSessions: [session('named', '/allowed', 'Allowed')] }));
  await editQuery('allowed');
  let headings = groupHeadings();
  expect(headings.indexOf('Projects')).toBeGreaterThanOrEqual(0);
  expect(headings.indexOf('Sessions')).toBeGreaterThanOrEqual(0);
  expect(headings.indexOf('Sessions')).toBeLessThan(headings.indexOf('Projects'));

  await act(async () => {
    useProjectsStore.setState({ projects: [{ id: 'allowed', path: '/allowed', label: 'Terminal tools' }] });
    useGlobalSessionsStore.setState({ archivedSessions: [], activeSessions: [session('plain', '/allowed', 'Plain')] });
  });
  await editQuery('terminal');
  headings = groupHeadings();
  expect(sessionRowTitles().join(' ')).toContain('Plain');
  expect(headings.indexOf('Commands')).toBeGreaterThanOrEqual(0);
  expect(headings.indexOf('Commands')).toBeLessThan(headings.indexOf('Sessions'));
});

test('among titles that hold the word, the most recently changed session lists first', async () => {
  await renderPalette();
  await act(async () => useGlobalSessionsStore.setState({
    activeSessions: [
      { ...session('old-exact', '/allowed', 'Agent'), time: { created: 1, updated: 10 } },
      { ...session('new-inside', '/allowed', 'Review agent tool'), time: { created: 1, updated: 90 } },
    ],
    archivedSessions: [],
  }));
  await editQuery('agent');
  const rows = [...document.querySelectorAll('[cmdk-item]')].map((row) => row.getAttribute('data-value'));
  expect(rows.indexOf('session:new-inside')).toBeGreaterThanOrEqual(0);
  expect(rows.indexOf('session:new-inside')).toBeLessThan(rows.indexOf('session:old-exact'));
});
