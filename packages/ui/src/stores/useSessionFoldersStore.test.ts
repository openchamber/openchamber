import { beforeEach, describe, expect, mock, test } from 'bun:test';

const storage = new Map<string, string>();
let storageSetCount = 0;
let runtimeKey = 'runtime-a';
let diskResponseBody: Record<string, unknown> = { version: 1, exists: false };

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

const postedBodies: string[] = [];

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async (_path: string, init?: RequestInit) => {
    if (init?.method === 'POST') postedBodies.push(String(init.body));
    return new Response(JSON.stringify(diskResponseBody), { headers: { 'Content-Type': 'application/json' } });
  }),
}));
mock.module('@/lib/runtime-switch', () => ({ getRuntimeKey: () => runtimeKey }));

const { useSessionFoldersStore } = await import('./useSessionFoldersStore');

const waitForPersist = () => new Promise((resolve) => setTimeout(resolve, 350));

describe('useSessionFoldersStore folder assignments', () => {
  beforeEach(() => {
    storage.clear();
    storageSetCount = 0;
    runtimeKey = 'runtime-a';
    diskResponseBody = { version: 1, exists: false };
    useSessionFoldersStore.getState().resetForRuntimeSwitch(runtimeKey);
    useSessionFoldersStore.setState({
      foldersMap: {},
      collapsedFolderIds: new Set<string>(),
    });
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

  test('bulk cross-scope move clears the former folder membership before assigning the target', () => {
    const store = useSessionFoldersStore.getState();
    const source = store.createFolder('/workspace/project', 'Source');
    const target = store.createFolder('/workspace/project-worktree', 'Target');
    store.addSessionsToFolder('/workspace/project', source.id, ['ses_1', 'ses_2']);

    store.removeSessionsFromFolders('/workspace/project', ['ses_1', 'ses_2']);
    store.addSessionsToFolder('/workspace/project-worktree', target.id, ['ses_1', 'ses_2']);

    expect(useSessionFoldersStore.getState().getFoldersForScope('/workspace/project')[0]?.sessionIds).toEqual([]);
    expect(useSessionFoldersStore.getState().getFoldersForScope('/workspace/project-worktree')[0]?.sessionIds).toEqual(['ses_1', 'ses_2']);
  });

  test('restores independent folder snapshots across runtime switches', async () => {
    useSessionFoldersStore.getState().createFolder('/workspace/project', 'Runtime A');
    await waitForPersist();

    runtimeKey = 'runtime-b';
    useSessionFoldersStore.getState().resetForRuntimeSwitch(runtimeKey);
    expect(useSessionFoldersStore.getState().getFoldersForScope('/workspace/project')).toEqual([]);
    useSessionFoldersStore.getState().createFolder('/workspace/project', 'Runtime B');
    await waitForPersist();

    runtimeKey = 'runtime-a';
    useSessionFoldersStore.getState().resetForRuntimeSwitch(runtimeKey);
    expect(useSessionFoldersStore.getState().getFoldersForScope('/workspace/project').map((folder) => folder.name)).toEqual(['Runtime A']);
  });

  test('flushes the outgoing runtime before a debounced browser write can be lost', () => {
    useSessionFoldersStore.getState().createFolder('/workspace/project', 'Runtime A pending');

    runtimeKey = 'runtime-b';
    useSessionFoldersStore.getState().resetForRuntimeSwitch(runtimeKey);
    runtimeKey = 'runtime-a';
    useSessionFoldersStore.getState().resetForRuntimeSwitch(runtimeKey);

    expect(useSessionFoldersStore.getState().getFoldersForScope('/workspace/project').map((folder) => folder.name)).toEqual(['Runtime A pending']);
  });

  test('does not replace browser folders when the server has no disk snapshot', async () => {
    useSessionFoldersStore.getState().createFolder('/workspace/project', 'Browser folder');
    runtimeKey = 'runtime-b';
    useSessionFoldersStore.getState().resetForRuntimeSwitch(runtimeKey);
    runtimeKey = 'runtime-a';
    useSessionFoldersStore.getState().resetForRuntimeSwitch(runtimeKey);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useSessionFoldersStore.getState().getFoldersForScope('/workspace/project').map((folder) => folder.name)).toEqual(['Browser folder']);
  });

  // Server persistence and hydration only run in a browser.
  const withWindow = (run: () => Promise<void>) => async () => {
    const original = globalThis.window;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
    try {
      await run();
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: original });
    }
  };

  test('sends a deleted folder as a tombstone and clears it once the server stores it', withWindow(async () => {
    const folder = useSessionFoldersStore.getState().createFolder('/workspace/project', 'Gone');
    await waitForPersist();
    postedBodies.length = 0;

    useSessionFoldersStore.getState().deleteFolder('/workspace/project', folder.id);
    await waitForPersist();

    expect(postedBodies).toHaveLength(1);
    expect(Object.keys(JSON.parse(postedBodies[0]).deletedFolderIds)).toEqual([folder.id]);
    expect(Array.from(storage.keys()).some((key) => key.startsWith('oc.sessions.folderDeletions'))).toBe(false);
  }));

  test('drops a folder another device deleted even when the browser copy is newer', withWindow(async () => {
    const folder = useSessionFoldersStore.getState().createFolder('/workspace/project', 'Deleted elsewhere');
    useSessionFoldersStore.getState().createFolder('/workspace/project', 'Kept');
    diskResponseBody = {
      version: 1,
      exists: true,
      foldersMap: {},
      collapsedFolderIds: [],
      deletedFolderIds: { [folder.id]: Date.now() },
      updatedAt: 1,
    };

    runtimeKey = 'runtime-b';
    useSessionFoldersStore.getState().resetForRuntimeSwitch(runtimeKey);
    runtimeKey = 'runtime-a';
    useSessionFoldersStore.getState().resetForRuntimeSwitch(runtimeKey);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useSessionFoldersStore.getState().getFoldersForScope('/workspace/project').map((entry) => entry.name)).toEqual(['Kept']);
  }));

  test('does not silently evict folder state from older runtimes', () => {
    for (let index = 0; index < 10; index += 1) {
      runtimeKey = `runtime-${index}`;
      useSessionFoldersStore.getState().resetForRuntimeSwitch(runtimeKey);
      useSessionFoldersStore.getState().createFolder('/workspace/project', `Folder ${index}`);
    }

    runtimeKey = 'runtime-0';
    useSessionFoldersStore.getState().resetForRuntimeSwitch(runtimeKey);
    expect(useSessionFoldersStore.getState().getFoldersForScope('/workspace/project').map((folder) => folder.name)).toEqual(['Folder 0']);
  });
});
