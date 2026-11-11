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
  useUIStore.setState({ isCommandPaletteOpen: true, messageSearchEnabled: false, commandPaletteShowArchivedSessions: false });
  messageSearchRequests.length = 0;
  respondToMessageSearch = async () => Response.json({ status: 'ok', hits: [], next: null, index: null });
  useProjectsStore.setState({ projects: [{ id: 'allowed', path: '/allowed' }] });
  useSessionUIStore.setState({ availableWorktreesByProject: new Map() });
  useGlobalSessionsStore.setState({ archivedSessions: [], activeSessions: [
    session('allowed', '/allowed', 'Allowed conversation'),
    session('declined', '/declined', 'Declined conversation'),
  ] });
  localStorage.removeItem('openchamber.search.filters.v1.palette');
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

test('turning off archived palette results removes stale archived rows immediately', async () => {
  useUIStore.setState({ commandPaletteShowArchivedSessions: true });
  useGlobalSessionsStore.setState({
    activeSessions: [session('active', '/allowed', 'Active conversation')],
    archivedSessions: [session('archived', '/allowed', 'Archived conversation')],
  });
  await act(async () => root.render(<RuntimeAPIProvider apis={apis}><I18nProvider><SyncProvider sdk={sdk} directory="/allowed"><CommandPalette /></SyncProvider></I18nProvider></RuntimeAPIProvider>));
  const input = browser.document.querySelector('input');
  if (!input) throw new Error('Command palette input missing');
  const setValue = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
  if (!setValue) throw new Error('Input value setter missing');
  await act(async () => {
    setValue.call(input, 'Archived');
    input.dispatchEvent(new browser.Event('input', { bubbles: true }));
  });
  expect(document.body.textContent).toContain('Archived conversation');
  await act(async () => useUIStore.setState({ commandPaletteShowArchivedSessions: false }));
  expect(document.body.textContent).not.toContain('Archived conversation');
});

test('a missing explicit project scope does not request unrestricted message content', async () => {
  useUIStore.setState({ messageSearchEnabled: true });
  await act(async () => root.render(<RuntimeAPIProvider apis={apis}><I18nProvider><SyncProvider sdk={sdk} directory="/allowed"><CommandPalette /></SyncProvider></I18nProvider></RuntimeAPIProvider>));
  const input = browser.document.querySelector('input');
  if (!input) throw new Error('Command palette input missing');
  const setValue = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
  if (!setValue) throw new Error('Input value setter missing');
  await act(async () => {
    setValue.call(input, 'needle type:message project:missing');
    input.dispatchEvent(new browser.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
  expect(messageSearchRequests).toEqual([]);
});

test('Tab cycles categories without moving input focus and ignores composition', async () => {
  await act(async () => root.render(<RuntimeAPIProvider apis={apis}><I18nProvider><SyncProvider sdk={sdk} directory="/allowed"><CommandPalette /></SyncProvider></I18nProvider></RuntimeAPIProvider>));
  const input = browser.document.querySelector('input');
  if (!input) throw new Error('Command palette input missing');
  await act(async () => {
    input.focus();
    input.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  });
  expect(document.activeElement).toBe(input);
  expect([...browser.document.querySelectorAll('[role="tab"]')].findIndex((tab) => tab.getAttribute('aria-selected') === 'true')).toBe(1);
  await act(async () => {
    input.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, isComposing: true }));
  });
  expect([...browser.document.querySelectorAll('[role="tab"]')].findIndex((tab) => tab.getAttribute('aria-selected') === 'true')).toBe(1);
  await act(async () => input.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect([...browser.document.querySelectorAll('[role="tab"]')].findIndex((tab) => tab.getAttribute('aria-selected') === 'true')).toBe(0);
});

test('Backspace resets a category after its flag is the only input', async () => {
  await act(async () => root.render(<RuntimeAPIProvider apis={apis}><I18nProvider><SyncProvider sdk={sdk} directory="/allowed"><CommandPalette /></SyncProvider></I18nProvider></RuntimeAPIProvider>));
  const input = browser.document.querySelector('input');
  const messages = browser.document.querySelector('[data-palette-category="messages"]');
  if (!input || !(messages instanceof browser.HTMLButtonElement)) throw new Error('Command palette controls missing');
  await act(async () => messages.click());
  expect(messages.getAttribute('aria-selected')).toBe('true');
  await act(async () => input.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true })));
  expect(browser.document.querySelector('[data-palette-category="all"]')?.getAttribute('aria-selected')).toBe('true');
});

test('remembered palette filters render as chips while opening clears text', async () => {
  localStorage.setItem('openchamber.search.filters.v1.palette', 'in:archived');
  await renderPalette();
  expect(document.querySelector('[data-search-filter-chip="lifecycle"]')).not.toBeNull();
  expect(paletteInput().value).toBe('');
});

test('a finished lifecycle flag becomes a palette chip', async () => {
  await renderPalette();
  await editQuery('in:archived ');
  expect(document.querySelector('[data-search-filter-chip="lifecycle"]')).not.toBeNull();
  expect(paletteInput().value).toBe('');
});

test('legacy content reconciles authoritative lifecycle and rejects unknown sessions when archives are hidden', async () => {
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
  await typeQuery('needle type:message');
  expect(messageSearchRequests.length).toBeGreaterThan(0);
  expect(new URL(messageSearchRequests.at(-1)!).searchParams.get('lifecycle')).toBe('active');
  expect(hitRows().map((row) => row.textContent).join(' ')).toContain('authoritative active excerpt');
  expect(document.body.textContent).not.toContain('legacy archived excerpt');
  expect(document.body.textContent).not.toContain('unknown lifecycle excerpt');
});

test('a delayed prior-query legacy response cannot restore archived content after the preference turns off', async () => {
  let resolvePrior: ((response: Response) => void) | undefined;
  respondToMessageSearch = (url) => url.searchParams.get('q') === 'priorneedle'
    ? new Promise<Response>((resolve) => { resolvePrior = resolve; })
    : Promise.resolve(Response.json({ status: 'ok', hits: [contentHit('active', 'current active excerpt')], next: null, index: null }));
  await renderPalette();
  await act(async () => {
    useUIStore.setState({ messageSearchEnabled: true, commandPaletteShowArchivedSessions: true });
    useGlobalSessionsStore.setState({ activeSessions: [session('active', '/allowed', 'Active title')], archivedSessions: [session('archived', '/allowed', 'Archive title')] });
  });
  await typeQuery('priorneedle type:message');
  expect(resolvePrior).toBeDefined();
  expect(new URL(messageSearchRequests.at(-1)!).searchParams.get('lifecycle')).toBe('all');
  await act(async () => useUIStore.setState({ commandPaletteShowArchivedSessions: false }));
  await typeQuery('currentneedle type:message');
  expect(document.body.textContent).toContain('current active excerpt');
  await act(async () => resolvePrior?.(Response.json({ status: 'ok', hits: [
    contentHit('archived', 'late archived excerpt'), contentHit('unknown', 'late unknown excerpt'),
  ], next: null, index: null })));
  expect(document.body.textContent).toContain('current active excerpt');
  expect(document.body.textContent).not.toContain('late archived excerpt');
  expect(document.body.textContent).not.toContain('late unknown excerpt');
  expect(new URL(messageSearchRequests.at(-1)!).searchParams.get('lifecycle')).toBe('active');
});

test('an unmatched project removes prior content and never sends an unrestricted replacement request', async () => {
  respondToMessageSearch = async () => Response.json({ status: 'ok', hits: [{ ...contentHit('allowed', 'previous scoped excerpt'), archived: false }], next: null, index: null });
  await renderPalette();
  await act(async () => useUIStore.setState({ messageSearchEnabled: true }));
  await typeQuery('needle type:message');
  expect(document.body.textContent).toContain('previous scoped excerpt');
  const previousRequestCount = messageSearchRequests.length;
  await typeQuery('needle type:message project:missing');
  expect(messageSearchRequests).toHaveLength(previousRequestCount);
  expect(document.body.textContent).not.toContain('previous scoped excerpt');
});

test('a cache-empty registered project scopes the content request from registered topology', async () => {
  await renderPalette();
  await act(async () => {
    useUIStore.setState({ messageSearchEnabled: true });
    useProjectsStore.setState({ projects: [{ id: 'allowed', path: '/allowed' }, { id: 'empty', path: '/empty', label: 'EmptyProject' }] });
    useSessionUIStore.setState({ availableWorktreesByProject: new Map([
      ['/empty', [{ path: '/external/empty-task', projectDirectory: '/empty', branch: 'task', label: 'Task' }]],
    ]) });
  });
  await typeQuery('needle type:message project:EmptyProject');
  expect(messageSearchRequests).toHaveLength(1);
  const request = new URL(messageSearchRequests[0]);
  expect(request.searchParams.get('lifecycle')).toBe('active');
  expect(request.searchParams.getAll('directory').sort()).toEqual(['/empty', '/external/empty-task'].sort());
});

test('out-of-tree worktree ownership filters displayed hits and forwards active scope to the next page', async () => {
  respondToMessageSearch = async (url) => Response.json({ status: 'ok', hits: url.searchParams.has('before')
    ? [{ ...contentHit('page-two', 'second scoped excerpt', '/external/task'), archived: false }]
    : [{ ...contentHit('task-session', 'first scoped excerpt', '/external/task'), archived: false },
      { ...contentHit('other', 'wrong project excerpt', '/other'), archived: false }],
  next: url.searchParams.has('before') ? null : 'page-cursor', index: null });
  await renderPalette();
  await act(async () => {
    useUIStore.setState({ messageSearchEnabled: true });
    useProjectsStore.setState({ projects: [{ id: 'allowed', path: '/allowed', label: 'OwningProject' }, { id: 'other', path: '/other' }] });
    useSessionUIStore.setState({ availableWorktreesByProject: new Map([
      ['/allowed', [{ path: '/external/task', projectDirectory: '/allowed', branch: 'task', label: 'Task' }]],
    ]) });
    useGlobalSessionsStore.setState({ activeSessions: [session('task-session', '/external/task', 'Worktree conversation')] });
  });
  await typeQuery('needle type:message project:OwningProject worktree:task');
  expect(document.body.textContent).toContain('first scoped excerpt');
  expect(document.body.textContent).not.toContain('wrong project excerpt');
  const row = hitRows().find((item) => item.textContent?.includes('first scoped excerpt'));
  expect(row?.textContent).toContain('OwningProject');
  const loadMore = document.querySelector<HTMLElement>('[cmdk-item][data-value="message:load-more"]');
  expect(loadMore).not.toBeNull();
  await act(async () => loadMore?.click());
  expect(messageSearchRequests).toHaveLength(2);
  const initialDirectories = new URL(messageSearchRequests[0]).searchParams.getAll('directory');
  expect(initialDirectories).toContain('/external/task');
  expect(initialDirectories).not.toContain('/allowed');
  expect(initialDirectories).not.toContain('/other');
  for (const raw of messageSearchRequests) {
    const request = new URL(raw);
    expect(request.searchParams.get('lifecycle')).toBe('active');
    expect(request.searchParams.getAll('directory')).toEqual(initialDirectories);
  }
  expect(new URL(messageSearchRequests[1]).searchParams.get('before')).toBe('page-cursor');
  expect(document.body.textContent).toContain('second scoped excerpt');
});

test('Backspace removes chips before resetting categories, and reverse Tab wraps categories', async () => {
  await renderPalette();
  await editQuery('type:message project:allowed ');
  const input = paletteInput();
  input.setSelectionRange(0, 0);
  await act(async () => input.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })));
  expect(document.querySelector('[data-search-filter-chip="project"]')).toBeNull();
  expect(document.querySelector('[data-palette-category="messages"]')?.getAttribute('aria-selected')).toBe('true');
  await act(async () => input.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })));
  expect(document.querySelector('[data-palette-category="all"]')?.getAttribute('aria-selected')).toBe('true');
  await act(async () => {
    input.focus();
    input.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  });
  expect(document.querySelector('[data-palette-category="files"]')?.getAttribute('aria-selected')).toBe('true');
  expect(document.activeElement).toBe(input);
  const composing = new browser.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, isComposing: true, bubbles: true, cancelable: true });
  await act(async () => input.dispatchEvent(composing));
  expect(composing.defaultPrevented).toBe(false);
  expect(document.querySelector('[data-palette-category="files"]')?.getAttribute('aria-selected')).toBe('true');
});

test('Alt+ArrowDown routes to the sole filters trigger outside the category tablist and ignores IME', async () => {
  await renderPalette();
  const input = paletteInput();
  const trigger = document.querySelector<HTMLButtonElement>('[data-palette-filters-trigger]');
  expect(trigger).not.toBeNull();
  expect(document.querySelectorAll('[data-palette-filters-trigger]')).toHaveLength(1);
  expect(document.querySelector('[role="tablist"] [data-palette-filters-trigger]')).toBeNull();
  let clicks = 0;
  trigger?.addEventListener('click', () => { clicks += 1; });
  const composing = new browser.KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, isComposing: true, bubbles: true, cancelable: true });
  await act(async () => input.dispatchEvent(composing));
  expect(clicks).toBe(0);
  expect(composing.defaultPrevented).toBe(false);
  const shortcut = new browser.KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true });
  await act(async () => input.dispatchEvent(shortcut));
  expect(clicks).toBe(1);
  expect(shortcut.defaultPrevented).toBe(true);
  // Actual Base UI popup focus/open state needs browser proof; happy-dom only pins parent routing.
});

for (const [state, expectedStatus] of [
  ['off', 'Message search is off.'],
  ['error', "Couldn't search messages."],
  ['incomplete', 'Still reading which conversations are archived'],
] as const) {
test(`All shows ${state} message status without definitive emptiness`, async () => {
  respondToMessageSearch = async () => state === 'error'
    ? new Response('failed', { status: 500 })
    : Response.json({ status: 'ok', hits: [], next: null, index: {
      backfill: { state: 'running', total: 9, done: 2 }, sessions: 2, messages: 3, lifecycleComplete: false,
    } });
  await renderPalette();
  await act(async () => useUIStore.setState({ messageSearchEnabled: state !== 'off' }));
  await typeQuery('unmatchedneedle');
  expect(statusText()).toContain(expectedStatus);
  expect(statusText()).not.toContain('No conversations match');
  expect(document.querySelector('[data-palette-category="all"]')?.getAttribute('aria-selected')).toBe('true');
  if (state === 'off') expect(messageSearchRequests).toEqual([]);
  else expect(messageSearchRequests).toHaveLength(1);
  expect(document.body.textContent).not.toContain('No results found.');
});
}

test('titles-only avoids message requests and minimum-query warnings, and a closed palette starts no requests', async () => {
  await renderPalette();
  await act(async () => useUIStore.setState({ messageSearchEnabled: true }));
  await typeQuery('x search:titles');
  expect(messageSearchRequests).toEqual([]);
  expect(statusText()).toContain('Titles only');
  expect(statusText()).not.toContain('Type 3 or more characters');
  await typeQuery('needle type:message');
  expect(messageSearchRequests).toHaveLength(1);
  await act(async () => useUIStore.setState({ isCommandPaletteOpen: false }));
  await act(async () => useUIStore.setState({ commandPaletteShowArchivedSessions: true }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 240)); });
  expect(messageSearchRequests).toHaveLength(1);
});

const flagCases: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['author:user', ['retained user', 'retained archive']],
  ['author:assistant', ['retained assistant']],
  ['author:reasoning', ['retained reasoning']],
  ['search:titles', []],
  ['in:active', ['retained user', 'retained assistant', 'retained reasoning']],
  ['in:archived', ['retained archive']],
];
for (const [flag, expected] of flagCases) {
test(`current raw ${flag} excludes incompatible retained hits before the content debounce`, async () => {
  respondToMessageSearch = async () => Response.json({ status: 'ok', hits: [
    contentHit('active-user', 'retained user'),
    { ...contentHit('active-assistant', 'retained assistant'), role: 'assistant' },
    { ...contentHit('active-reasoning', 'retained reasoning'), role: 'reasoning' },
    contentHit('archived-user', 'retained archive'),
  ], next: null, index: null });
  await renderPalette();
  await act(async () => {
    useUIStore.setState({ messageSearchEnabled: true, commandPaletteShowArchivedSessions: true, messageSearchReasoningEnabled: true, showReasoningTraces: true });
    useGlobalSessionsStore.setState({ activeSessions: [
      session('active-user', '/allowed', 'User title'), session('active-assistant', '/allowed', 'Assistant title'), session('active-reasoning', '/allowed', 'Reasoning title'),
    ], archivedSessions: [session('archived-user', '/allowed', 'Archive title')] });
  });
  await typeQuery('needle type:message');
  expect(document.querySelectorAll('[cmdk-item][data-value^="message:"]')).toHaveLength(4);
  expect(messageSearchRequests).toHaveLength(1);
  let resolvePending: ((response: Response) => void) | undefined;
  respondToMessageSearch = () => new Promise<Response>((resolve) => { resolvePending = resolve; });
  await editQuery(`needle type:message ${flag}`);
  // No replacement request has started. These are still the previous response's hits.
  expect(messageSearchRequests).toHaveLength(1);
  const visible = [...document.querySelectorAll('[cmdk-item][data-value^="message:"]')].map((row) => row.textContent).join(' ');
  for (const snippet of ['retained user', 'retained assistant', 'retained reasoning', 'retained archive']) {
    expect(visible.includes(snippet)).toBe(expected.includes(snippet));
  }
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 240)); });
  if (flag === 'search:titles') {
    expect(messageSearchRequests).toHaveLength(1);
  } else {
    expect(resolvePending).toBeDefined();
    await act(async () => resolvePending?.(Response.json({ status: 'ok', hits: [], next: null, index: null })));
    expect(document.querySelectorAll('[cmdk-item][data-value^="message:"]')).toHaveLength(0);
  }
});
}

test('turning reasoning display off removes retained reasoning immediately without waiting for the request', async () => {
  respondToMessageSearch = async () => Response.json({ status: 'ok', hits: [
    { ...contentHit('allowed', 'visible reasoning excerpt'), role: 'reasoning' },
    contentHit('allowed', 'visible user excerpt'),
  ], next: null, index: null });
  await renderPalette();
  await act(async () => useUIStore.setState({ messageSearchEnabled: true, messageSearchReasoningEnabled: true, showReasoningTraces: true }));
  await typeQuery('needle type:message');
  expect(document.body.textContent).toContain('visible reasoning excerpt');
  respondToMessageSearch = () => new Promise<Response>(() => {});
  await act(async () => useUIStore.setState({ showReasoningTraces: false }));
  expect(document.body.textContent).not.toContain('visible reasoning excerpt');
  expect(document.body.textContent).toContain('visible user excerpt');
});

const sessionRowTitles = () => [...document.querySelectorAll('[cmdk-item]')]
  .filter((row) => row.getAttribute('data-value')?.startsWith('session:'))
  .map((row) => row.textContent ?? '');

test('titles only leaves out sessions the query finds only in their project, worktree or folder', async () => {
  await renderPalette();
  await act(async () => {
    useProjectsStore.setState({ projects: [{ id: 'allowed', path: '/allowed', label: 'Zephyr' }] });
    useSessionUIStore.setState({ availableWorktreesByProject: new Map([
      ['/allowed', [{ path: '/worktrees/nebula', projectDirectory: '/allowed', branch: 'quasar', label: 'Quasar' }]],
    ]) });
    useGlobalSessionsStore.setState({ archivedSessions: [], activeSessions: [session('plain', '/worktrees/nebula', 'Plain title')] });
  });
  for (const word of ['zephyr', 'quasar', 'nebula']) {
    await editQuery(word);
    expect(sessionRowTitles().join(' ')).toContain('Plain title');
    await editQuery(`${word} search:titles`);
    expect(sessionRowTitles().join(' ')).not.toContain('Plain title');
  }
});

test('a worktree filter selects that worktree, not one whose path starts the same', async () => {
  await renderPalette();
  await act(async () => {
    useSessionUIStore.setState({ availableWorktreesByProject: new Map([
      ['/allowed', [
        { path: '/worktrees/task', projectDirectory: '/allowed', branch: 'task', label: 'task' },
        { path: '/worktrees/task-old', projectDirectory: '/allowed', branch: 'task-old', label: 'task-old' },
      ]],
    ]) });
    useGlobalSessionsStore.setState({ archivedSessions: [], activeSessions: [
      session('task', '/worktrees/task', 'Conversation current'),
      session('task-old', '/worktrees/task-old', 'Conversation stale'),
    ] });
  });
  await editQuery('conversation worktree:/worktrees/task');
  const titles = sessionRowTitles().join(' ');
  expect(titles).toContain('Conversation current');
  expect(titles).not.toContain('Conversation stale');
});

const groupHeadings = () => [...document.querySelectorAll('[cmdk-group-heading]')].map((heading) => heading.textContent ?? '');

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
