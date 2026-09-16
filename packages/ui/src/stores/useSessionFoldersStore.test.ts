import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { getSessionFolderIdentityKey } from '@/lib/sessionFolderIdentity';

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

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async () => new Response(JSON.stringify(diskResponseBody), { headers: { 'Content-Type': 'application/json' } })),
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

  test('reconciles archived membership in one idempotent scope batch', async () => {
    const archivedScope = '__archived__:/workspace';
    const archivedFolder = {
      id: 'worktree-folder',
      name: 'Worktree',
      sessionIds: ['archived-1', 'archived-1', 'restored', 'manual-id'],
      createdAt: 1,
      parentId: null,
    };
    const duplicateFolder = {
      id: 'duplicate-folder',
      name: 'worktree',
      sessionIds: ['archived-2', 'duplicate-unknown'],
      createdAt: 2,
      parentId: null,
    };
    const ordinaryFolder = {
      id: 'ordinary-folder',
      name: 'Ordinary',
      sessionIds: ['restored'],
      createdAt: 3,
      parentId: null,
    };
    useSessionFoldersStore.setState({
      foldersMap: {
        [archivedScope]: [archivedFolder, duplicateFolder],
        '/workspace': [ordinaryFolder],
      },
      collapsedFolderIds: new Set([getSessionFolderIdentityKey(archivedScope, archivedFolder.id)]),
    });
    const beforeOrdinaryFolders = useSessionFoldersStore.getState().foldersMap['/workspace'];

    useSessionFoldersStore.getState().reconcileArchivedFolders(archivedScope, [
      { name: 'Worktree', sessionIds: ['archived-1', ' archived-1 ', 'archived-2'] },
      { name: 'Project root', sessionIds: ['archived-3'] },
      { name: 'Empty assignment', sessionIds: [] },
    ], ['archived-1', 'archived-2', 'archived-3', 'restored']);
    await waitForPersist();

    const afterFirstReconcile = useSessionFoldersStore.getState().foldersMap;
    const reconciledFolders = afterFirstReconcile[archivedScope] ?? [];
    expect(reconciledFolders).toHaveLength(3);
    expect(reconciledFolders[0]?.id).toBe('worktree-folder');
    expect(reconciledFolders[1]?.id).toBe('duplicate-folder');
    expect(reconciledFolders[2]?.id).toBeTruthy();
    expect(reconciledFolders[0]?.sessionIds).toEqual(['archived-1', 'manual-id', 'archived-2']);
    expect(reconciledFolders[1]?.sessionIds).toEqual(['duplicate-unknown']);
    expect(reconciledFolders[2]?.name).toBe('Project root');
    expect(reconciledFolders[2]?.sessionIds).toEqual(['archived-3']);
    expect(useSessionFoldersStore.getState().collapsedFolderIds).toEqual(new Set([
      getSessionFolderIdentityKey(archivedScope, archivedFolder.id),
    ]));
    expect(afterFirstReconcile['/workspace']).toBe(beforeOrdinaryFolders);
    expect(afterFirstReconcile['/workspace']?.[0]?.sessionIds).toEqual(['restored']);

    storageSetCount = 0;
    const beforeNoOp = useSessionFoldersStore.getState().foldersMap;
    useSessionFoldersStore.getState().reconcileArchivedFolders(archivedScope, [
      { name: 'Worktree', sessionIds: ['archived-1', 'archived-2'] },
      { name: 'Project root', sessionIds: ['archived-3'] },
    ], ['archived-1', 'archived-2', 'archived-3', 'restored']);
    await waitForPersist();

    expect(useSessionFoldersStore.getState().foldersMap).toBe(beforeNoOp);
    expect(storageSetCount).toBe(0);
  });

  test('does not reconcile ordinary scopes and keeps archived folder definitions during cleanup', async () => {
    const archivedScope = '__archived__:/workspace';
    const archivedFolder = {
      id: 'archived-folder',
      name: 'Archived',
      sessionIds: ['session-1'],
      createdAt: 1,
      parentId: null,
    };
    const ordinaryFolder = {
      id: 'ordinary-folder',
      name: 'Ordinary',
      sessionIds: ['session-1'],
      createdAt: 2,
      parentId: null,
    };
    useSessionFoldersStore.setState({
      foldersMap: {
        [archivedScope]: [archivedFolder],
        '/workspace': [ordinaryFolder],
      },
      collapsedFolderIds: new Set(),
    });

    const beforeOrdinary = useSessionFoldersStore.getState().foldersMap['/workspace'];
    const beforeArchived = useSessionFoldersStore.getState().foldersMap[archivedScope];
    useSessionFoldersStore.getState().reconcileArchivedFolders('/workspace', [
      { name: 'Should not exist', sessionIds: ['session-2'] },
    ], ['session-1', 'session-2']);
    expect(useSessionFoldersStore.getState().foldersMap).toBeDefined();
    expect(useSessionFoldersStore.getState().foldersMap['/workspace']).toBe(beforeOrdinary);

    useSessionFoldersStore.getState().removeSessionEverywhere('runtime-a', 'session-1');
    await waitForPersist();

    expect(useSessionFoldersStore.getState().foldersMap[archivedScope]).not.toBe(beforeArchived);
    expect(useSessionFoldersStore.getState().foldersMap[archivedScope]?.[0]?.sessionIds).toEqual([]);
    expect(useSessionFoldersStore.getState().foldersMap[archivedScope]?.[0]?.id).toBe('archived-folder');
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

  test('keeps collapse state independent when folder ids repeat across scopes', async () => {
    const sharedFolder = { id: 'shared', name: 'Shared', sessionIds: [], createdAt: 1 };
    useSessionFoldersStore.setState({
      foldersMap: {
        '/workspace/project': [sharedFolder],
        '/workspace/project-worktree': [sharedFolder],
      },
      collapsedFolderIds: new Set(),
    });

    const store = useSessionFoldersStore.getState();
    store.toggleFolderCollapse('/workspace/project', sharedFolder.id);

    expect(useSessionFoldersStore.getState().collapsedFolderIds).toEqual(new Set([
      getSessionFolderIdentityKey('/workspace/project', sharedFolder.id),
    ]));

    store.toggleFolderCollapse('/workspace/project-worktree', sharedFolder.id);
    expect(useSessionFoldersStore.getState().collapsedFolderIds).toEqual(new Set([
      getSessionFolderIdentityKey('/workspace/project', sharedFolder.id),
      getSessionFolderIdentityKey('/workspace/project-worktree', sharedFolder.id),
    ]));

    await waitForPersist();
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
