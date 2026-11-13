import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';

import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { I18nProvider } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { opencodeClient } from '@/lib/opencode/client';
import { SyncProvider } from '@/sync/sync-context';
import { GuestHosts } from '@/components/layout/GuestHosts';
import { PluginPane } from '@/components/layout/PluginPane';
import { automaticBackgrounds } from './automatic-backgrounds';
import { useGuestsStore } from './store';
import { useGuestBadgeStore } from './badge-store';
import { getGuestResolver } from './resolve';
import type { InstalledGuest } from './types';

const guest: InstalledGuest = {
  id: 'automatic', name: 'Automatic', icon: 'window', entry: 'panel/index.html',
  backgroundEntry: 'background/index.html', backgroundStart: 'automatic', panelBadge: 'count', version: '1',
  capabilities: { requested: ['loopback'], granted: ['loopback'] },
};
let dom: Window;
let root: Root;
let container: HTMLElement;
let restoreFetch = () => {};
let runtimeKey = '';
const originals = new Map<string, PropertyDescriptor | undefined>();
const theme = getDefaultTheme(false);
const themeContext: ThemeContextValue = {
  currentTheme: theme, availableThemes: [theme], customThemeIds: [], setTheme: () => {}, customThemesLoading: false,
  reloadCustomThemes: async () => {}, importTheme: async () => theme, deleteImportedTheme: async () => {},
  isSystemPreference: false, setSystemPreference: () => {}, themeMode: 'light', setThemeMode: () => {},
  lightThemeId: theme.metadata.id, darkThemeId: theme.metadata.id, setLightThemePreference: () => {}, setDarkThemePreference: () => {},
};
const respond = async (input: RequestInfo | URL): Promise<Response> => {
  const path = String(input instanceof Request ? input.url : input);
  if (path.includes('/frame-grant')) return Response.json({ grant: 'frame-fixture', expiresAt: Date.now() + 60_000 });
  if (path.includes('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
  if (path.endsWith('/api/config') || path.endsWith('/api/project')) return Response.json([]);
  if (path.includes('/session/active')) return Response.json({ data: {} });
  if (path.includes('/session-warming')) return Response.json({ revision: 0, enabled: false, minutes: 15, sessions: [] });
  if (path.includes('/location')) return Response.json({ directory: '/fixture', project: { id: 'p', directory: '/fixture', canonical: '/fixture' } });
  return Response.json({ data: [] });
};
const sdk = OpenCode.make({ baseUrl: 'https://sync.test', fetch: respond });
const render = async (panel = false) => {
  await act(async () => root.render(<React.StrictMode><I18nProvider><ThemeSystemContext.Provider value={themeContext}>
    <SyncProvider sdk={sdk} directory="/fixture"><GuestHosts />{panel ? <PluginPane mode="plugin:automatic" /> : null}</SyncProvider>
  </ThemeSystemContext.Provider></I18nProvider></React.StrictMode>));
};
const frames = () => container.querySelectorAll('iframe');
const mount = async () => {
  // Lazy imports settle before React's act finishes; preloading the real module above avoids polling.
  await render();
  await act(async () => { await import('@/components/layout/PluginPane'); });
};

beforeEach(() => {
  dom = new Window({ url: 'https://host.test', settings: { disableIframePageLoading: true } });
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator,
    localStorage: dom.localStorage, getComputedStyle: dom.getComputedStyle.bind(dom), Event: dom.Event,
    MessageEvent: dom.MessageEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(respond);
  restoreFetch = () => fetch.mockRestore();
  opencodeClient.reconnectToRuntimeBaseUrl();
  runtimeKey = getRuntimeKey();
  useGuestsStore.getState().resetForRuntimeSwitch(runtimeKey);
  useGuestsStore.getState().replaceCatalog([guest], runtimeKey);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  restoreFetch();
  await dom.happyDOM.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  originals.clear();
});

test('mounts one background without claiming commands or clearing the badge when the catalog loads', async () => {
  // Given
  useGuestBadgeStore.getState().setBadge(guest.id, 5);
  // When
  await mount();
  // Then
  expect(frames()).toHaveLength(1);
  expect(frames()[0]?.src).toContain('/background/index.html');
  expect(frames()[0]?.closest('[inert]')).not.toBeNull();
  expect(useGuestBadgeStore.getState().countByGuest[guest.id]).toBe(5);
  expect(getGuestResolver(guest.id)).toBeNull();
});

test('retains the same background document when catalog metadata changes', async () => {
  // Given
  await mount();
  const previous = frames()[0];
  // When
  await act(async () => useGuestsStore.getState().replaceCatalog([{ ...guest, update: { version: '2' } }], runtimeKey));
  // Then
  expect(frames()).toHaveLength(1);
  expect(frames()[0]).toBe(previous);
});

test('retires the old document before the new package mounts', async () => {
  // Given
  await mount();
  const previous = frames()[0];
  // When
  await act(async () => useGuestsStore.getState().replaceCatalog([{ ...guest, version: '2' }], runtimeKey));
  // Then
  expect(previous?.isConnected).toBe(false);
  expect(frames()).toHaveLength(1);
  expect(frames()[0]).not.toBe(previous);
});

for (const reason of ['disable', 'revoke', 'uninstall', 'runtime'] as const) {
  test(`unmounts the automatic frame when ${reason} retires its owner`, async () => {
    // Given
    await mount();
    // When
    await act(async () => {
      switch (reason) {
        case 'disable': useGuestsStore.getState().replaceCatalog([{ ...guest, enabled: false }], runtimeKey); break;
        case 'revoke': useGuestsStore.getState().replaceCatalog([{ ...guest, capabilities: { requested: ['loopback'], granted: [] } }], runtimeKey); break;
        case 'uninstall': useGuestsStore.getState().replaceCatalog([], runtimeKey); break;
        case 'runtime': useGuestsStore.getState().resetForRuntimeSwitch('other-runtime'); break;
        default: { const exhaustive: never = reason; throw new Error(exhaustive); }
      }
    });
    // Then
    expect(frames()).toHaveLength(0);
  });
}

test('keeps the automatic frame and count when the visible panel opens', async () => {
  // Given
  await mount();
  const previous = frames()[0];
  useGuestBadgeStore.getState().setBadge(guest.id, 5);
  // When
  await render(true);
  // Then
  expect(frames()).toHaveLength(2);
  expect(frames()[0]).toBe(previous);
  expect(useGuestBadgeStore.getState().countByGuest[guest.id]).toBe(5);
});

test('mounts nothing when start is omitted or on-demand', async () => {
  // Given
  useGuestsStore.getState().replaceCatalog([{ ...guest, backgroundStart: undefined }, { ...guest, id: 'demand', backgroundStart: 'on-demand' }], runtimeKey);
  // When
  await mount();
  // Then
  expect(frames()).toHaveLength(0);
});

test('selects only one owner when the catalog repeats a guest', () => {
  // Given / When
  const selected = automaticBackgrounds([guest, guest], 'runtime');
  // Then
  expect(selected).toHaveLength(1);
});
