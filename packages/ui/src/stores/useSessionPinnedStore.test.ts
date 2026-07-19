import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

type RuntimeEndpointDetail = {
  runtimeKey: string;
  previousRuntimeKey: string;
};

const PINNED_KEY = 'oc.sessions.pinned';
const storageValues = new Map<string, string>();
const runtimeListeners = new Set<(detail: RuntimeEndpointDetail) => void>();
const events = new EventTarget();
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
let runtimeKey = 'local';

const runtimeWindow = {
  addEventListener: events.addEventListener.bind(events),
  removeEventListener: events.removeEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
};

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: runtimeWindow,
});

const safeStorage = {
  getItem: (key: string) => storageValues.get(key) ?? null,
  setItem: (key: string, value: string) => storageValues.set(key, value),
  removeItem: (key: string) => storageValues.delete(key),
  clear: () => storageValues.clear(),
  key: (index: number) => Array.from(storageValues.keys())[index] ?? null,
  get length() {
    return storageValues.size;
  },
} as Storage;

mock.module('./utils/safeStorage', () => ({
  getDeferredSafeStorage: () => safeStorage,
}));

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => runtimeKey,
  subscribeRuntimeEndpointChanged: (listener: (detail: RuntimeEndpointDetail) => void) => {
    runtimeListeners.add(listener);
    return () => runtimeListeners.delete(listener);
  },
}));

const { useSessionPinnedStore } = await import('./useSessionPinnedStore');

const scopedKey = (targetRuntimeKey = runtimeKey): string => `${PINNED_KEY}:${encodeURIComponent(targetRuntimeKey)}`;

const emitRuntimeEndpointChanged = (nextRuntimeKey: string, previousRuntimeKey = runtimeKey): void => {
  runtimeKey = nextRuntimeKey;
  runtimeListeners.forEach((listener) => listener({ runtimeKey: nextRuntimeKey, previousRuntimeKey }));
};

describe('useSessionPinnedStore runtime persistence', () => {
  beforeEach(() => {
    storageValues.clear();
    runtimeKey = 'local';
    useSessionPinnedStore.setState({ ids: new Set<string>() });
  });

  afterAll(() => {
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  });

  test('stores and restores pinned sessions by runtime identity', () => {
    runtimeKey = 'runtime-a';
    useSessionPinnedStore.getState().setIds(new Set(['shared-session']));
    storageValues.set(scopedKey('runtime-b'), JSON.stringify(['remote-session']));
    storageValues.set(PINNED_KEY, JSON.stringify(['legacy-session']));

    emitRuntimeEndpointChanged('runtime-b', 'runtime-a');

    expect(storageValues.get(scopedKey('runtime-a'))).toBe(JSON.stringify(['shared-session']));
    expect(storageValues.get(PINNED_KEY)).toBe(JSON.stringify(['legacy-session']));
    expect(useSessionPinnedStore.getState().ids).toEqual(new Set(['remote-session']));
  });

  test('uses the legacy pinned value only when returning to local', () => {
    storageValues.set(PINNED_KEY, JSON.stringify(['local-session']));
    runtimeKey = 'remote-runtime';

    emitRuntimeEndpointChanged('local', 'remote-runtime');

    expect(useSessionPinnedStore.getState().ids).toEqual(new Set(['local-session']));
  });

  test('does not use the legacy pinned value for a remote runtime without scoped state', () => {
    storageValues.set(PINNED_KEY, JSON.stringify(['local-session']));

    emitRuntimeEndpointChanged('remote-runtime', 'local');

    expect(useSessionPinnedStore.getState().ids).toEqual(new Set());
  });
});
