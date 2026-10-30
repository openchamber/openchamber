import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import type { Session } from '@/lib/opencode/model';

const browser = new Window({ url: 'http://localhost' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator,
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
globalThis.fetch = (async (input) => {
  const url = new URL(String(input), 'http://localhost');
  if (url.pathname === '/api/config/settings') return Response.json({ projects: [{ id: 'allowed', path: '/allowed' }] });
  return Response.json({
    home: '/home', chatsRoot: '/managed/chats', directory: url.searchParams.get('directory') ?? '/allowed',
    project: { directory: '/allowed' }, data: [], files: [], hits: [], archives: [], actions: [],
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
  useUIStore.setState({ isCommandPaletteOpen: true });
  useProjectsStore.setState({ projects: [{ id: 'allowed', path: '/allowed' }] });
  useSessionUIStore.setState({ availableWorktreesByProject: new Map() });
  useGlobalSessionsStore.setState({ activeSessions: [
    session('allowed', '/allowed', 'Allowed conversation'),
    session('declined', '/declined', 'Declined conversation'),
  ] });
});
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
