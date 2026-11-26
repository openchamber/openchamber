import { afterAll, beforeEach, expect, test } from 'bun:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import type { Session } from '@/lib/opencode/model';

// Run the real session actions on Android through the real Capacitor plugin
// proxy, against an in-memory native bridge and notification shade, as
// mobileHeaderStorage.test.ts does. This file runs in its own process.
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalCapacitor = Object.getOwnPropertyDescriptor(globalThis, 'Capacitor');
const originalFetch = globalThis.fetch;

type Banner = { id: number; tag: string; data: Record<string, string> };
type SeenBanner = { tag?: string; id: number; nid: string };

let shade: Banner[] = [];
let onRemoval: (() => void) | null = null;
let replaceBeforeRemoval: Banner | null = null;
const storage = new Map<string, string>();
const localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
};
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });

const sameSlot = (left: { tag?: string; id: number }, right: { tag?: string; id: number }) => left.tag === right.tag && left.id === right.id;

type CapacitorGlobal = {
  PluginHeaders: Array<{ name: string; methods: Array<{ name: string; rtype: string }> }>;
  nativePromise: (plugin: string, method: string, options: { banners?: SeenBanner[] }) => Promise<{ notifications: Banner[] } | undefined>;
  getPlatform?: () => string;
  isNativePlatform?: () => boolean;
};

// The core module fills in the platform methods on this object when it loads.
const capacitorGlobal: CapacitorGlobal = {
  PluginHeaders: [
    { name: 'PushNotifications', methods: [{ name: 'getDeliveredNotifications', rtype: 'promise' }] },
    { name: 'PushBanners', methods: [{ name: 'remove', rtype: 'promise' }] },
  ],
  nativePromise: async (plugin: string, method: string, options: { banners?: SeenBanner[] }) => {
    if (plugin === 'PushNotifications' && method === 'getDeliveredNotifications') return { notifications: [...shade] };
    if (plugin === 'PushBanners' && method === 'remove') {
      // A newer push lands in a listed slot before the native side removes it.
      if (replaceBeforeRemoval) {
        const replacement = replaceBeforeRemoval;
        shade = [...shade.filter((shown) => !sameSlot(shown, replacement)), replacement];
        replaceBeforeRemoval = null;
      }
      // As PushBannersPlugin: a banner goes only while it shows the push the view listed.
      const seen = options.banners ?? [];
      shade = shade.filter((shown) => !seen.some((banner) => sameSlot(banner, shown) && banner.nid === shown.data['openchamber.nid']));
      onRemoval?.();
      return;
    }
    throw new Error(`${plugin}.${method} is not implemented on android`);
  },
};
Object.defineProperty(globalThis, 'Capacitor', { configurable: true, writable: true, value: capacitorGlobal });
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: Object.assign(new EventTarget(), {
    Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
    location: { protocol: 'capacitor:', origin: 'capacitor://localhost' },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    localStorage,
  }),
});
// The view the server would answer with a clearing push fails; the stores'
// own startup reads never answer, so they stay quiet.
const viewRequests: string[] = [];
globalThis.fetch = Object.assign((input: string | URL | Request) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.endsWith('/view')) return new Promise<Response>(() => {});
  viewRequests.push(url);
  return Promise.reject(new TypeError('fetch failed'));
}, { preconnect: () => {} });

storage.set('openchamber.mobile.connections.v1', JSON.stringify([
  { id: 'a', label: 'A', candidates: [{ kind: 'direct', url: 'https://a.example' }], serverId: 'srv_a', lastUsedAt: 2 },
  { id: 'b', label: 'B', candidates: [{ kind: 'direct', url: 'https://b.example' }], serverId: 'srv_b', lastUsedAt: 1 },
]));
const { initializeRuntimeEndpoint } = await import('@/lib/runtime-switch');
initializeRuntimeEndpoint({ apiBaseUrl: 'https://a.example', runtimeKey: 'server:srv_a' });
const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
const { markAllSessionsViewed, markSessionViewed } = await import('@/sync/notification-store');
const { hasNativeSessionNotifications } = await import('./nativeNotifications');
const { getKnownSessionIds } = await import('@/sync/session-unread');
const { useHasNativeSessionBanners } = await import('@/hooks/useHasNativeSessionBanners');

afterAll(() => {
  globalThis.fetch = originalFetch;
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  if (originalCapacitor) Object.defineProperty(globalThis, 'Capacitor', originalCapacitor);
  else Reflect.deleteProperty(globalThis, 'Capacitor');
});

const session = (id: string, extra: Partial<Session> = {}): Session => ({
  id, directory: '/repo', projectID: 'project', title: id, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  ...extra,
});
const linked = (id: string, kind: string, parentID: string) => session(id, { metadata: { openchamber: { kind, parentID } } });

let nextNid = 1;
const banner = (sessionId: string, serverId = 'srv_a'): Banner => ({
  id: 0,
  tag: `ready-${sessionId}@${serverId}`,
  data: { sessionId, serverId, 'openchamber.nid': String(nextNid++) },
});
const pullRequestAlert: Banner = { id: 0, tag: 'pr-12', data: { serverId: 'srv_a', 'openchamber.nid': '900' } };

const nextRemoval = () => new Promise<void>((resolve) => {
  onRemoval = resolve;
});
const shownSessions = () => shade.map((shown) => `${shown.data.sessionId ?? shown.tag}@${shown.data.serverId}`).sort();

beforeEach(() => {
  shade = [];
  replaceBeforeRemoval = null;
  useGlobalSessionsStore.getState().applySnapshot([
    session('parent'),
    session('subagent', { parentID: 'parent' }),
    linked('workflow', 'workflow-agent', 'parent'),
    linked('operator', 'operator-child', 'workflow'),
    session('nested', { parentID: 'operator' }),
    session('review', { metadata: { openchamber: { kind: 'review', originalSessionID: 'parent' } } }),
    session('other'),
  ], [], 'ready');
});

test('opening a session clears its own and its children\'s banners from this server only', async () => {
  shade = ['parent', 'subagent', 'workflow', 'operator', 'nested', 'review', 'other'].map((id) => banner(id));
  shade.push(banner('parent', 'srv_b'), pullRequestAlert);

  const removal = nextRemoval();
  markSessionViewed('parent');
  await removal;

  expect(shownSessions()).toEqual(['other@srv_a', 'parent@srv_b', 'pr-12@srv_a', 'review@srv_a']);
  expect(viewRequests.some((url) => url.endsWith('/api/sessions/parent/view'))).toBe(true);
});

test('opening a session clears an archived child\'s banner and one linked through it', async () => {
  useGlobalSessionsStore.getState().applySnapshot([
    session('parent'),
    session('grandchild', { parentID: 'archived' }),
    session('other'),
  ], [session('archived', { parentID: 'parent', time: { created: 1, updated: 1, archived: 2 } })], 'ready');
  shade = ['parent', 'archived', 'grandchild', 'other'].map((id) => banner(id));

  const removal = nextRemoval();
  markSessionViewed('parent');
  await removal;

  expect(shownSessions()).toEqual(['other@srv_a']);
});

test('a newer push that replaced a listed banner survives the clear', async () => {
  const listed = banner('parent');
  shade = [listed];
  const replacement = { ...banner('parent'), tag: listed.tag, id: listed.id };
  replaceBeforeRemoval = replacement;

  const removal = nextRemoval();
  markSessionViewed('parent');
  await removal;

  expect(shade).toEqual([replacement]);
});

test('mark all as read reaches a banner whose session has no unread mark and leaves pull requests', async () => {
  shade = [banner('other'), pullRequestAlert];

  expect(await hasNativeSessionNotifications(getKnownSessionIds())).toBe(true);
  const removal = nextRemoval();
  markAllSessionsViewed();
  await removal;

  expect(shade).toEqual([pullRequestAlert]);
  expect(await hasNativeSessionNotifications(getKnownSessionIds())).toBe(false);
});

test('mark all as read turns on when a banner\'s session loads while the menu is open', async () => {
  useGlobalSessionsStore.getState().applySnapshot([], [], 'loading');
  shade = [banner('late'), pullRequestAlert];
  const dom = installHookTestDom();
  // With window now the global object, the hook and the connection reads ask
  // the Capacitor global for the platform.
  const { getPlatform, isNativePlatform } = capacitorGlobal;
  capacitorGlobal.getPlatform = () => 'android';
  capacitorGlobal.isNativePlatform = () => true;
  const seen: boolean[] = [];
  const MenuItemProbe = () => {
    seen.push(useHasNativeSessionBanners());
    return null;
  };
  const root = createRoot(dom.container);
  try {
    await act(async () => root.render(<MenuItemProbe />));
    expect(seen.at(-1)).toBe(false);

    await act(async () => {
      useGlobalSessionsStore.getState().applySnapshot([session('late')], [], 'ready');
    });
    expect(seen.at(-1)).toBe(true);

    const removal = nextRemoval();
    markAllSessionsViewed();
    await removal;
    expect(shade).toEqual([pullRequestAlert]);
  } finally {
    await act(async () => root.unmount());
    Object.assign(capacitorGlobal, { getPlatform, isNativePlatform });
    dom.restore();
  }
});
