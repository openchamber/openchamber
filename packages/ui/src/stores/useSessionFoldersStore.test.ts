import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const storage = new Map<string, string>();
let storageSetCount = 0;
let runtimeKey = 'local';
const runtimeListeners = new Set<(detail: { runtimeKey: string; previousRuntimeKey: string }) => void>();
const events = new EventTarget();
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

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
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storageSetCount += 1;
    storage.set(key, value);
  },
  removeItem: (key: string) => {
    storage.delete(key);
  },
  clear: () => {
    storage.clear();
  },
  key: (index: number) => Array.from(storage.keys())[index] ?? null,
  get length() {
    return storage.size;
  },
} as Storage;

mock.module('./utils/safeStorage', () => ({
  getDeferredSafeStorage: () => safeStorage,
  getSafeStorage: () => safeStorage,
}));

mock.module('@/lib/desktop', () => ({
  isVSCodeRuntime: () => false,
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } })),
}));

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => runtimeKey,
  subscribeRuntimeEndpointChanged: (listener: (detail: { runtimeKey: string; previousRuntimeKey: string }) => void) => {
    runtimeListeners.add(listener);
    return () => runtimeListeners.delete(listener);
  },
}));

const { useSessionFoldersStore } = await import('./useSessionFoldersStore');

const waitForPersist = () => new Promise((resolve) => setTimeout(resolve, 350));
const scopedKey = (key: string, targetRuntimeKey = runtimeKey): string => `${key}:${encodeURIComponent(targetRuntimeKey)}`;
const emitRuntimeEndpointChanged = (nextRuntimeKey: string, previousRuntimeKey = runtimeKey): void => {
  runtimeKey = nextRuntimeKey;
  runtimeListeners.forEach((listener) => listener({ runtimeKey: nextRuntimeKey, previousRuntimeKey }));
};

describe('useSessionFoldersStore folder assignments', () => {
  beforeEach(() => {
    storage.clear();
    storageSetCount = 0;
    runtimeKey = 'local';
    useSessionFoldersStore.setState({
      foldersMap: {},
      collapsedFolderIds: new Set<string>(),
    });
  });

  afterAll(() => {
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  });

  test('repeated addSessionToFolder to the same folder preserves foldersMap reference', async () => {
    const store = useSessionFoldersStore.getState();
    const folder = store.createFolder('/workspace/project', 'Work');
    store.addSessionToFolder('/workspace/project', folder.id, 'ses_1');
    await waitForPersist();
    storageSetCount = 0;

    const before = useSessionFoldersStore.getState().foldersMap;
    useSessionFoldersStore.getState().addSessionToFolder('/workspace/project', folder.id, 'ses_1');
    await waitForPersist();

    expect(useSessionFoldersStore.getState().foldersMap).toBe(before);
    expect(storageSetCount).toBe(0);
  });

  test('repeated addSessionsToFolder to the same folder preserves foldersMap reference', async () => {
    const store = useSessionFoldersStore.getState();
    const folder = store.createFolder('/workspace/project', 'Batch');
    store.addSessionsToFolder('/workspace/project', folder.id, ['ses_1', 'ses_2']);
    await waitForPersist();
    storageSetCount = 0;

    const before = useSessionFoldersStore.getState().foldersMap;
    useSessionFoldersStore.getState().addSessionsToFolder('/workspace/project', folder.id, ['ses_1', 'ses_2']);
    await waitForPersist();

    expect(useSessionFoldersStore.getState().foldersMap).toBe(before);
    expect(storageSetCount).toBe(0);
  });

  test('isolates folder assignments and collapse state across runtime switches', () => {
    runtimeKey = 'runtime-a';
    const projectScope = '/workspace/project';
    useSessionFoldersStore.setState({
      foldersMap: {
        [projectScope]: [{ id: 'shared-folder', name: 'Runtime A', sessionIds: ['shared-session'], createdAt: 1 }],
      },
      collapsedFolderIds: new Set(['shared-folder']),
    });
    storage.set('oc.sessions.folders', JSON.stringify({
      [projectScope]: [{ id: 'legacy-folder', name: 'Legacy', sessionIds: ['shared-session'], createdAt: 1 }],
    }));
    storage.set(scopedKey('oc.sessions.folders', 'runtime-b'), JSON.stringify({
      [projectScope]: [{ id: 'shared-folder', name: 'Runtime B', sessionIds: ['shared-session'], createdAt: 2 }],
    }));
    storage.set(scopedKey('oc.sessions.folderCollapse', 'runtime-b'), JSON.stringify([]));

    emitRuntimeEndpointChanged('runtime-b', 'runtime-a');

    expect(useSessionFoldersStore.getState().foldersMap).toEqual({
      [projectScope]: [{
        id: 'shared-folder',
        name: 'Runtime B',
        sessionIds: ['shared-session'],
        createdAt: 2,
        parentId: null,
      }],
    });
    expect(useSessionFoldersStore.getState().collapsedFolderIds).toEqual(new Set());
  });

  test('writes folder state under the current runtime key', async () => {
    runtimeKey = 'runtime-a';
    const folder = useSessionFoldersStore.getState().createFolder('/workspace/project', 'Scoped');
    useSessionFoldersStore.getState().toggleFolderCollapse(folder.id);

    await waitForPersist();

    expect(storage.get(scopedKey('oc.sessions.folders', 'runtime-a'))).toContain('Scoped');
    expect(storage.get(scopedKey('oc.sessions.folderCollapse', 'runtime-a'))).toBe(JSON.stringify([folder.id]));
    expect(storage.get('oc.sessions.folders')).toBeUndefined();
    expect(storage.get('oc.sessions.folderCollapse')).toBeUndefined();
  });

  test('uses legacy folder state only for the local runtime', () => {
    const projectScope = '/workspace/project';
    storage.set('oc.sessions.folders', JSON.stringify({
      [projectScope]: [{ id: 'legacy-folder', name: 'Legacy', sessionIds: ['legacy-session'], createdAt: 1 }],
    }));
    storage.set('oc.sessions.folderCollapse', JSON.stringify(['legacy-folder']));

    emitRuntimeEndpointChanged('remote-runtime', 'local');
    expect(useSessionFoldersStore.getState().foldersMap).toEqual({});
    expect(useSessionFoldersStore.getState().collapsedFolderIds).toEqual(new Set());

    emitRuntimeEndpointChanged('local', 'remote-runtime');
    expect(useSessionFoldersStore.getState().foldersMap).toEqual({
      [projectScope]: [{
        id: 'legacy-folder',
        name: 'Legacy',
        sessionIds: ['legacy-session'],
        createdAt: 1,
        parentId: null,
      }],
    });
    expect(useSessionFoldersStore.getState().collapsedFolderIds).toEqual(new Set(['legacy-folder']));
  });

  test('rejects delayed folder and collapse callbacks after an A-to-B-to-A switch', () => {
    runtimeKey = 'runtime-a';
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const activeTimers = new Map<number, () => void>();
    const cancelledTimers = new Map<number, () => void>();
    let nextTimerId = 0;

    globalThis.setTimeout = ((callback: () => void) => {
      nextTimerId += 1;
      activeTimers.set(nextTimerId, callback);
      return nextTimerId;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((timer: unknown) => {
      const timerId = Number(timer);
      const callback = activeTimers.get(timerId);
      if (callback) {
        activeTimers.delete(timerId);
        cancelledTimers.set(timerId, callback);
      }
    }) as unknown as typeof clearTimeout;

    try {
      const oldFolder = useSessionFoldersStore.getState().createFolder('/workspace/project', 'Old');
      useSessionFoldersStore.getState().toggleFolderCollapse(oldFolder.id);

      emitRuntimeEndpointChanged('runtime-b', 'runtime-a');
      emitRuntimeEndpointChanged('runtime-a', 'runtime-b');
      const staleCallbacks = Array.from(cancelledTimers.values());

      const currentFolder = useSessionFoldersStore.getState().createFolder('/workspace/project', 'Current');
      useSessionFoldersStore.getState().toggleFolderCollapse(currentFolder.id);
      storageSetCount = 0;

      staleCallbacks.forEach((callback) => callback());
      expect(storageSetCount).toBe(0);
      expect(storage.get(scopedKey('oc.sessions.folders', 'runtime-a'))).toBeUndefined();
      expect(storage.get(scopedKey('oc.sessions.folderCollapse', 'runtime-a'))).toBeUndefined();

      Array.from(activeTimers.values()).forEach((callback) => callback());
      expect(storage.get(scopedKey('oc.sessions.folders', 'runtime-a'))).toContain('Current');
      expect(storage.get(scopedKey('oc.sessions.folderCollapse', 'runtime-a'))).toBe(JSON.stringify([currentFolder.id]));
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
});
