import { afterAll, expect, test } from 'bun:test';

import type { Session } from '@/lib/opencode/model';

// Run the real session action on iOS through the real Capacitor plugin proxy,
// against an in-memory native bridge and Notification Center, as
// nativeNotifications.plugin.test.tsx does for Android. iOS keeps the push's
// own `nid` in userInfo, and the push plugin refuses to list until APNs
// registration ran, which never happens while the server is unreachable.
// This file runs in its own process.
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalCapacitor = Object.getOwnPropertyDescriptor(globalThis, 'Capacitor');
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalFetch = globalThis.fetch;

type Delivered = { id: string; data: Record<string, string> };

let notificationCenter: Delivered[] = [];
let onRemoval: (() => void) | null = null;
const storage = new Map<string, string>();
const localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
};
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });

Object.defineProperty(globalThis, 'Capacitor', {
  configurable: true,
  writable: true,
  value: {
    PluginHeaders: [
      { name: 'PushNotifications', methods: [{ name: 'getDeliveredNotifications', rtype: 'promise' }] },
      { name: 'PushBanners', methods: [{ name: 'list', rtype: 'promise' }, { name: 'remove', rtype: 'promise' }] },
    ],
    nativePromise: async (plugin: string, method: string, options: { banners?: Array<{ id: string; nid: string }> }) => {
      if (plugin === 'PushNotifications') throw new Error('event capacitorDidRegisterForRemoteNotifications not called.');
      if (plugin === 'PushBanners' && method === 'list') return { notifications: [...notificationCenter] };
      if (plugin === 'PushBanners' && method === 'remove') {
        const seen = options.banners ?? [];
        notificationCenter = notificationCenter.filter((shown) => !seen.some((banner) => banner.id === shown.id && banner.nid === shown.data.nid));
        onRemoval?.();
        return undefined;
      }
      throw new Error(`${plugin}.${method} is not implemented on ios`);
    },
  },
});
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: Object.assign(new EventTarget(), {
    Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
    location: { protocol: 'capacitor:', origin: 'capacitor://localhost' },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    localStorage,
  }),
});
// The server is unreachable: the view request fails and startup reads never answer.
globalThis.fetch = Object.assign((input: string | URL | Request) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.endsWith('/view')) return new Promise<Response>(() => {});
  return Promise.reject(new TypeError('fetch failed'));
}, { preconnect: () => {} });

storage.set('openchamber.mobile.connections.v1', JSON.stringify([
  { id: 'a', label: 'A', candidates: [{ kind: 'direct', url: 'https://a.example' }], serverId: 'srv_a', lastUsedAt: 1 },
]));
const { initializeRuntimeEndpoint } = await import('@/lib/runtime-switch');
initializeRuntimeEndpoint({ apiBaseUrl: 'https://a.example', runtimeKey: 'server:srv_a' });
const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
const { markSessionViewed } = await import('@/sync/notification-store');

afterAll(() => {
  globalThis.fetch = originalFetch;
  for (const [key, original] of [['localStorage', originalLocalStorage], ['window', originalWindow], ['Capacitor', originalCapacitor]] as const) {
    if (original) Object.defineProperty(globalThis, key, original);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const session = (id: string): Session => ({
  id, directory: '/repo', projectID: 'project', title: id, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
});

test('opening a session on iOS clears its banners while the server is unreachable and leaves the rest', async () => {
  useGlobalSessionsStore.getState().applySnapshot([session('seen'), session('other')], [], 'ready');
  const seen = { id: 'ready-seen', data: { sessionId: 'seen', serverId: 'srv_a', tag: 'ready-seen', nid: '7' } };
  const other = { id: 'ready-other', data: { sessionId: 'other', serverId: 'srv_a', tag: 'ready-other', nid: '8' } };
  const pullRequest = { id: 'pr-12', data: { serverId: 'srv_a', tag: 'pr-12', nid: '9' } };
  notificationCenter = [seen, other, pullRequest];

  const removal = new Promise<void>((resolve) => { onRemoval = resolve; });
  markSessionViewed('seen');
  await removal;

  expect(notificationCenter).toEqual([other, pullRequest]);
});
