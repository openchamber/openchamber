import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import type { InstalledGuest } from '@/lib/guests/types';

const browser = new Window({ url: 'http://localhost' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, Event: browser.Event, CustomEvent: browser.CustomEvent, Element: browser.Element, HTMLElement: browser.HTMLElement,
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
// SAFETY: the palette and its stores only call fetch(url); the mock answers that call and needs no `preconnect`.
globalThis.fetch = (async (input) => {
  const url = new URL(String(input), 'http://localhost');
  if (url.pathname === '/api/config/settings') return Response.json({ projects: [{ id: 'repo', path: '/repo' }] });
  return Response.json({
    home: '/home', chatsRoot: '/managed/chats', directory: url.searchParams.get('directory') ?? '/repo',
    project: { directory: '/repo' }, data: [], files: [], hits: [], archives: [], actions: [],
    trusted: false, fingerprint: 'untrusted', items: [],
  });
}) as typeof fetch;
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
const { useGuestsStore } = await import('@/lib/guests/store');
const { useInputStore } = await import('@/sync/input-store');
const originalUI = useUIStore.getState();
const originalProjects = useProjectsStore.getState();
const originalSessionUI = useSessionUIStore.getState();
const originalGuests = useGuestsStore.getState();
const originalInput = useInputStore.getState();
const apis = createWebAPIs();
const sdk = OpenCode.make({ baseUrl: 'http://palette.test', fetch: () => new Promise<Response>(() => undefined) });
let root: ReturnType<typeof createRoot>;

const tasks: InstalledGuest = {
  id: 'tasks-demo',
  name: 'Task Board',
  icon: 'task',
  entry: 'panel/index.html',
  capabilities: { requested: [], granted: [] },
  commands: [{ name: 'task', description: 'Attach a task by id' }, { name: 'summary' }],
  actions: [
    { id: 'summarize', label: 'Summarize session', icon: 'chat-history', where: 'session' },
    { id: 'create-task', label: 'Create task from message', icon: 'add-circle', where: 'message' },
  ],
};

const render = async () => {
  await act(async () => root.render(<RuntimeAPIProvider apis={apis}><I18nProvider><SyncProvider sdk={sdk} directory="/repo"><CommandPalette /></SyncProvider></I18nProvider></RuntimeAPIProvider>));
};
const search = async (query: string) => {
  const input = browser.document.querySelector('input');
  if (!input) throw new Error('Command palette input missing');
  const setValue = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
  if (!setValue) throw new Error('Input value setter missing');
  await act(async () => {
    setValue.call(input, query);
    input.dispatchEvent(new browser.Event('input', { bubbles: true }));
    input.dispatchEvent(new browser.Event('change', { bubbles: true }));
  });
};
const listText = () => document.querySelector('[cmdk-list]')?.textContent ?? '';

beforeEach(() => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useUIStore.setState({ isCommandPaletteOpen: true });
  useProjectsStore.setState({ projects: [{ id: 'repo', path: '/repo' }] });
  useSessionUIStore.setState({ availableWorktreesByProject: new Map(), currentSessionId: null });
  useGuestsStore.setState({ status: 'ready', guests: [tasks], runtimeKey: 'test' });
  useInputStore.setState({ pendingInputText: null, pendingInputMode: 'replace', pendingInputTarget: null });
});
afterEach(async () => {
  await act(async () => root.unmount());
  await settleOpenCodeTrust('skip');
  useUIStore.setState(originalUI, true);
  useProjectsStore.setState(originalProjects, true);
  useSessionUIStore.setState(originalSessionUI, true);
  useGuestsStore.setState(originalGuests, true);
  useInputStore.setState(originalInput, true);
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

test('extension commands are found by search and wait in the composer for their argument', async () => {
  await render();
  expect(listText()).not.toContain('/task');

  await search('/task');
  expect(listText()).toContain('/task');
  expect(listText()).toContain('Task Board');
  // Without a current session the session action has nothing to act on.
  expect(listText()).not.toContain('Summarize session');

  // A name the composer runs itself stays the composer's.
  await search('summary');
  expect(listText()).not.toContain('/summary');

  await search('task');
  const item = [...browser.document.querySelectorAll('[cmdk-item]')].find((node) => node.textContent?.includes('/task'));
  if (!item) throw new Error('Extension command row missing');
  await act(async () => item.dispatchEvent(new browser.MouseEvent('click', { bubbles: true })));
  expect(useInputStore.getState().consumePendingInputText()).toEqual({ text: 'task', mode: 'slash-command' });
  expect(useUIStore.getState().isCommandPaletteOpen).toBe(false);
});

test('picking a command over Settings or a page shows the chat it lands in', async () => {
  useUIStore.setState({ openGuestPageId: 'tasks-demo', isSettingsDialogOpen: true });
  await render();
  await search('/task');
  const item = [...browser.document.querySelectorAll('[cmdk-item]')].find((node) => node.textContent?.includes('/task'));
  if (!item) throw new Error('Extension command row missing');
  await act(async () => item.dispatchEvent(new browser.MouseEvent('click', { bubbles: true })));
  expect(useUIStore.getState().openGuestPageId).toBeNull();
  expect(useUIStore.getState().isSettingsDialogOpen).toBe(false);
  expect(useInputStore.getState().pendingInputMode).toBe('slash-command');
});

test('only session actions show, and only while a session is open', async () => {
  useSessionUIStore.setState({ currentSessionId: 'ses_1', currentSessionDirectory: '/repo' });
  await render();
  expect(listText()).not.toContain('Summarize session');

  await search('summar');
  expect(listText()).toContain('Summarize session');
  await search('create task');
  expect(listText()).not.toContain('Create task from message');

  // The command the query names comes before an action found through the extension's name.
  await search('task');
  const rows = [...browser.document.querySelectorAll('[cmdk-item]')].map((node) => node.textContent ?? '');
  expect(rows.slice(0, 2)).toEqual(['/taskTask Board', 'Summarize sessionTask Board']);
  // The description repeats "task", but the highlight stays on the title.
  const command = [...browser.document.querySelectorAll('[cmdk-item]')].find((node) => node.textContent?.startsWith('/task'));
  expect([...(command?.querySelectorAll('mark') ?? [])].map((mark) => mark.textContent)).toEqual(['task']);
});
