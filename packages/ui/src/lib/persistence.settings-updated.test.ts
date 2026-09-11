import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import type { RuntimeAPIs, SettingsPayload } from '@/lib/api/types';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useUIStore } from '@/stores/useUIStore';
import type { SettingsSyncedDetail } from './persistence';
import { invalidateSettingsCache, syncDesktopSettings, updateDesktopSettings } from './persistence';

type TestWindow = {
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  dispatchEvent: (event: Event) => boolean;
};

let createdWindow = false;
let createdLocalStorage = false;

const ensureLocalStorage = (): void => {
  if (typeof localStorage !== 'undefined') {
    return;
  }

  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
      clear: () => {
        values.clear();
      },
    },
    configurable: true,
    writable: true,
  });
  createdLocalStorage = true;
};

const getWindow = (): TestWindow => {
  if (typeof window === 'undefined') {
    Object.defineProperty(globalThis, 'window', {
      value: {},
      configurable: true,
      writable: true,
    });
    createdWindow = true;
  }
  const testWindow = window as unknown as Partial<TestWindow>;
  if (!testWindow.addEventListener || !testWindow.removeEventListener) {
    const eventTarget = new EventTarget();
    testWindow.addEventListener = eventTarget.addEventListener.bind(eventTarget);
    testWindow.removeEventListener = eventTarget.removeEventListener.bind(eventTarget);
    testWindow.dispatchEvent = eventTarget.dispatchEvent.bind(eventTarget);
  }
  ensureLocalStorage();
  return testWindow as TestWindow;
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type SettingsLoadResult = { settings: SettingsPayload; source: 'web' | 'vscode' };
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolveFn) => {
    resolve = resolveFn;
  });
  return { promise, resolve };
};

const registerSettingsApi = (
  save: (changes: Partial<SettingsPayload>) => Promise<SettingsPayload>,
  load: () => Promise<{ settings: SettingsPayload; source: 'web' | 'vscode' }>,
): void => {
  registerRuntimeAPIs({
    runtime: { platform: 'web', isDesktop: false, isVSCode: false },
    settings: { load, save },
  } as unknown as RuntimeAPIs);
};

const listenForSynced = (): { synced: SettingsSyncedDetail[]; stop: () => void } => {
  const synced: SettingsSyncedDetail[] = [];
  const handler = (event: Event) => {
    synced.push((event as CustomEvent<SettingsSyncedDetail>).detail);
  };
  getWindow().addEventListener('openchamber:settings-synced', handler);
  return {
    synced,
    stop: () => getWindow().removeEventListener('openchamber:settings-synced', handler),
  };
};

afterAll(() => {
  registerRuntimeAPIs(null);
  if (createdWindow) {
    delete (globalThis as { window?: unknown }).window;
  }
  if (createdLocalStorage) {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

describe('external settings reconciliation', () => {
  beforeEach(() => {
    getWindow();
    registerRuntimeAPIs(null);
    invalidateSettingsCache();
  });

  test('openchamber:settings-updated refetches authoritative settings and applies them without adopting workspace state', async () => {
    let loadCalls = 0;
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsApi(
      async (changes) => {
        saveCalls.push(changes);
        return changes as SettingsPayload;
      },
      async () => {
        loadCalls += 1;
        return {
          settings: {
            showToolFileIcons: loadCalls === 1,
            draftStartersCraftGoalAdded: true,
            draftStartersScheduleTaskAdded: true,
          } as SettingsPayload,
          source: 'web',
        };
      },
    );
    const { synced, stop } = listenForSynced();

    try {
      await syncDesktopSettings();
      expect(loadCalls).toBe(1);
      expect(useUIStore.getState().showToolFileIcons).toBe(true);

      // The server broadcast for an external persist.
      getWindow().dispatchEvent(new CustomEvent('openchamber:settings-updated'));
      await delay(20);

      expect(loadCalls).toBe(2);
      expect(useUIStore.getState().showToolFileIcons).toBe(false);
      // The reconcile must not adopt another window's active project or theme:
      // bootstrap and adoptTheme both stay off for the external refetch.
      expect(synced.at(-1)?.settings.showToolFileIcons).toBe(false);
      expect(synced.at(-1)?.bootstrap).toBe(false);
      expect(synced.at(-1)?.adoptTheme).toBe(false);
      expect(saveCalls).toHaveLength(0);
    } finally {
      stop();
    }
  });

  test('echo of this window own save reconciles without a write loop', async () => {
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    let loadCalls = 0;
    registerSettingsApi(
      async (changes) => {
        saveCalls.push(changes);
        return {
          ...changes,
          draftStartersCraftGoalAdded: true,
          draftStartersScheduleTaskAdded: true,
        } as SettingsPayload;
      },
      async () => {
        loadCalls += 1;
        return {
          settings: {
            showToolFileIcons: false,
            draftStartersCraftGoalAdded: true,
            draftStartersScheduleTaskAdded: true,
          } as SettingsPayload,
          source: 'web',
        };
      },
    );

    await updateDesktopSettings({ showToolFileIcons: false });
    expect(saveCalls).toHaveLength(1);

    // The server broadcast caused by this window's own successful persist.
    getWindow().dispatchEvent(new CustomEvent('openchamber:settings-updated'));
    await delay(20);
    await delay(300);

    expect(loadCalls).toBe(1);
    expect(saveCalls).toHaveLength(1);
  });

  test('repeated external events coalesce into one follow-up load and apply idempotently without writes', async () => {
    let loadCalls = 0;
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsApi(
      async (changes) => {
        saveCalls.push(changes);
        return changes as SettingsPayload;
      },
      async () => {
        loadCalls += 1;
        return {
          settings: {
            showToolFileIcons: true,
            draftStartersCraftGoalAdded: true,
            draftStartersScheduleTaskAdded: true,
          } as SettingsPayload,
          source: 'web',
        };
      },
    );

    // Install the settings lifecycle listener through the public sync path so
    // this test also passes standalone (the listener is otherwise only
    // registered by a previous test's sync/write call).
    await syncDesktopSettings();
    const loadCallsAfterSync = loadCalls;

    getWindow().dispatchEvent(new CustomEvent('openchamber:settings-updated'));
    getWindow().dispatchEvent(new CustomEvent('openchamber:settings-updated'));
    await delay(20);

    expect(useUIStore.getState().showToolFileIcons).toBe(true);
    expect(saveCalls).toHaveLength(0);
    // The first event starts a load; the second event lands while that load is
    // in flight and coalesces into a single follow-up load (no per-event fanout).
    expect(loadCalls).toBe(loadCallsAfterSync + 2);

    getWindow().dispatchEvent(new CustomEvent('openchamber:settings-updated'));
    await delay(20);
    expect(saveCalls).toHaveLength(0);
    expect(loadCalls).toBe(loadCallsAfterSync + 3);
  });

  test('an external event during a slow in-flight load refetches before applying', async () => {
    const pendingLoads: Array<Deferred<SettingsLoadResult>> = [];
    let loadCalls = 0;
    registerSettingsApi(
      async (changes) => changes as SettingsPayload,
      () => {
        loadCalls += 1;
        const pending = deferred<SettingsLoadResult>();
        pendingLoads.push(pending);
        return pending.promise;
      },
    );
    const { synced, stop } = listenForSynced();

    try {
      const initialSync = syncDesktopSettings();
      expect(loadCalls).toBe(1);

      // The server broadcast lands while the pre-event load is still in flight.
      getWindow().dispatchEvent(new CustomEvent('openchamber:settings-updated'));

      pendingLoads[0].resolve({
        settings: {
          showToolFileIcons: true,
          draftStartersCraftGoalAdded: true,
          draftStartersScheduleTaskAdded: true,
        } as SettingsPayload,
        source: 'web',
      });
      await delay(0);

      // Exactly one follow-up load starts after the event, and the stale
      // pre-event snapshot is never applied.
      expect(loadCalls).toBe(2);
      expect(synced).toHaveLength(0);

      pendingLoads[1].resolve({
        settings: {
          showToolFileIcons: false,
          draftStartersCraftGoalAdded: true,
          draftStartersScheduleTaskAdded: true,
        } as SettingsPayload,
        source: 'web',
      });
      await initialSync;
      await delay(20);

      expect(loadCalls).toBe(2);
      expect(useUIStore.getState().showToolFileIcons).toBe(false);
      expect(synced.length).toBeGreaterThan(0);
      expect(synced.every((entry) => entry.settings.showToolFileIcons === false)).toBe(true);

      // A follow-up load does not start another one on its own.
      await delay(20);
      expect(loadCalls).toBe(2);
    } finally {
      stop();
    }
  });

  test('multiple external events during one in-flight load coalesce into a single follow-up load', async () => {
    const pendingLoads: Array<Deferred<SettingsLoadResult>> = [];
    let loadCalls = 0;
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsApi(
      async (changes) => {
        saveCalls.push(changes);
        return changes as SettingsPayload;
      },
      () => {
        loadCalls += 1;
        const pending = deferred<SettingsLoadResult>();
        pendingLoads.push(pending);
        return pending.promise;
      },
    );

    const initialSync = syncDesktopSettings();
    expect(loadCalls).toBe(1);

    getWindow().dispatchEvent(new CustomEvent('openchamber:settings-updated'));
    getWindow().dispatchEvent(new CustomEvent('openchamber:settings-updated'));

    pendingLoads[0].resolve({
      settings: {
        showToolFileIcons: true,
        draftStartersCraftGoalAdded: true,
        draftStartersScheduleTaskAdded: true,
      } as SettingsPayload,
      source: 'web',
    });
    await delay(0);

    // Both events coalesce into one follow-up request rather than one per event.
    expect(loadCalls).toBe(2);

    pendingLoads[1].resolve({
      settings: {
        showToolFileIcons: false,
        draftStartersCraftGoalAdded: true,
        draftStartersScheduleTaskAdded: true,
      } as SettingsPayload,
      source: 'web',
    });
    await initialSync;
    await delay(20);

    expect(loadCalls).toBe(2);
    expect(useUIStore.getState().showToolFileIcons).toBe(false);
    expect(saveCalls).toHaveLength(0);

    // The follow-up load does not chain into another one without a new event.
    await delay(20);
    expect(loadCalls).toBe(2);
  });

  test('an in-flight load without an external event applies once and does not refetch', async () => {
    const pendingLoads: Array<Deferred<SettingsLoadResult>> = [];
    let loadCalls = 0;
    registerSettingsApi(
      async (changes) => changes as SettingsPayload,
      () => {
        loadCalls += 1;
        const pending = deferred<SettingsLoadResult>();
        pendingLoads.push(pending);
        return pending.promise;
      },
    );

    const sync = syncDesktopSettings();
    expect(loadCalls).toBe(1);

    pendingLoads[0].resolve({
      settings: {
        showToolFileIcons: true,
        draftStartersCraftGoalAdded: true,
        draftStartersScheduleTaskAdded: true,
      } as SettingsPayload,
      source: 'web',
    });
    await sync;
    await delay(20);

    expect(loadCalls).toBe(1);
    expect(useUIStore.getState().showToolFileIcons).toBe(true);
  });
});
