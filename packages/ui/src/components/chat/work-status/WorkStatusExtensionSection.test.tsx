import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { OpenCode } from '@opencode/client';
import { Window } from 'happy-dom';
import { hostMessageSchema } from '@openchamber/sdk/schemas';
import type { GuestMessage, HostMessage } from '@openchamber/sdk';

import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { I18nProvider } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useGuestsStore } from '@/lib/guests/store';
import type { InstalledGuest } from '@/lib/guests/types';
import { SyncProvider } from '@/sync/sync-context';
import { useUIStore } from '@/stores/useUIStore';
import { WorkStatusExtensionSection } from './WorkStatusExtensionSection';

test('a status-only extension loads its section entry, sizes the frame within range, and unmounts it when folded', async () => {
  const dom = new Window({ url: 'http://guest.test', settings: { disableIframePageLoading: true } });
  const guestWindow = new Window();
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator,
    localStorage: dom.localStorage, getComputedStyle: dom.getComputedStyle.bind(dom), Event: dom.Event, MessageEvent: dom.MessageEvent,
    IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const target = String(input instanceof Request ? input.url : input);
    if (target.includes('/auth/url-token')) return Response.json({ token: 'scoped-test', expiresAt: Date.now() + 60_000 });
    if (target.includes('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    if (target.includes('/session/active')) return Response.json({});
    if (target.includes('/location')) return Response.json({ directory: '/visible', project: { id: 'project', directory: '/visible', canonical: '/visible' } });
    return Response.json({ data: [] });
  });
  const sdk = OpenCode.make({ baseUrl: 'http://sync.test', fetch: async (request) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
    if (path.endsWith('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    const body = path.endsWith('/location')
      ? { directory: '/visible', project: { id: 'project', directory: '/visible', canonical: '/visible' } }
      : path.endsWith('/session/active') ? {} : { data: [] };
    return Response.json(body);
  } });
  const theme = getDefaultTheme(false);
  const themeContext: ThemeContextValue = {
    currentTheme: theme, availableThemes: [theme], customThemeIds: [], setTheme: () => {}, customThemesLoading: false,
    reloadCustomThemes: async () => {}, importTheme: async () => theme, deleteImportedTheme: async () => {},
    isSystemPreference: false, setSystemPreference: () => {}, themeMode: 'light', setThemeMode: () => {},
    lightThemeId: theme.metadata.id, darkThemeId: theme.metadata.id, setLightThemePreference: () => {}, setDarkThemePreference: () => {},
  };
  const guest: InstalledGuest = {
    id: 'git-graph', name: 'Git graph', icon: 'git-commit', statusEntry: 'status/index.html', statusTitle: 'Recent commits', statusHeight: 140,
    capabilities: { requested: [], granted: [] },
  };
  const runtimeKey = getRuntimeKey();
  useGuestsStore.getState().resetForRuntimeSwitch(runtimeKey);
  useGuestsStore.getState().replaceCatalog([guest], runtimeKey);
  useUIStore.setState({ workStatusExpandedSections: {} });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const messages: HostMessage[] = [];
  let restorePost = () => {};
  try {
    await act(async () => root.render(<I18nProvider><ThemeSystemContext.Provider value={themeContext}>
      <SyncProvider sdk={sdk} directory="/visible"><WorkStatusExtensionSection guest={guest} /></SyncProvider>
    </ThemeSystemContext.Provider></I18nProvider>));
    for (let attempt = 0; attempt < 100 && !container.querySelector('iframe'); attempt++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    const frame = container.querySelector<HTMLIFrameElement>('iframe');
    if (!frame) throw new Error('Status frame did not mount');
    expect(container.textContent).toContain('Recent commits');
    expect(frame.src.includes('/api/guests/git-graph/status/index.html')).toBe(true);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    const box = frame.parentElement;
    if (!box) throw new Error('Frame box missing');
    expect(box.style.height).toBe('140px');

    Object.defineProperty(frame, 'contentWindow', { configurable: true, value: guestWindow });
    const source = frame.contentWindow;
    if (!source) throw new Error('Guest window is missing');
    const post = spyOn(source, 'postMessage').mockImplementation((data) => { messages.push(hostMessageSchema.parse(data)); });
    restorePost = () => post.mockRestore();
    const send = (message: GuestMessage) => window.dispatchEvent(new MessageEvent('message', { source, data: message }));
    await act(async () => { send({ channel: 'openchamber.sdk', v: 1, type: 'hello' }); });
    expect(messages.find((message) => message.type === 'ready')).toMatchObject({ payload: { surface: 'status', item: null } });

    await act(async () => { send({ channel: 'openchamber.sdk', v: 1, type: 'resize', id: 'h-1', payload: { height: 96 } }); });
    expect(box.style.height).toBe('96px');
    await act(async () => { send({ channel: 'openchamber.sdk', v: 1, type: 'resize', id: 'h-2', payload: { height: 2000 } }); });
    expect(box.style.height).toBe('320px');
    expect(messages.some((message) => message.type === 'result' && message.id === 'h-2' && message.ok)).toBe(true);
    // Status-only: the catalog has no panel entry, and that must not tear the section down.
    expect(container.querySelector('iframe')).not.toBeNull();

    const header = container.querySelector<HTMLButtonElement>('button[aria-expanded]');
    if (!header) throw new Error('Section header missing');
    await act(async () => header.click());
    expect(container.querySelector('iframe')).toBeNull();
    // Reopening starts at the height the page last asked for, not the manifest default.
    await act(async () => header.click());
    expect(container.querySelector('iframe')?.parentElement?.style.height).toBe('320px');
  } finally {
    restorePost();
    await act(async () => root.unmount());
    fetch.mockRestore();
    useGuestsStore.getState().resetForRuntimeSwitch(runtimeKey);
    await dom.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
