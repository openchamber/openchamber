import { beforeEach, describe, expect, mock, test } from 'bun:test';

const storage = new Map<string, string>();
let storageSetCount = 0;
let runtimeKey = 'runtime-a';
type TestFolder = { id: string; name: string; sessionIds: string[]; createdAt: number; parentId: string | null };
type TestFoldersMap = { [scopeKey: string]: TestFolder[] };
/** Whatever the fake server answers: a folder snapshot, a write result or an error. */
type ServerAnswer = {
  version?: number;
  exists?: boolean;
  foldersMap?: TestFoldersMap;
  collapsedFolderIds?: string[];
  updatedAt?: number;
  success?: boolean;
  error?: string;
};
let diskResponseBody: ServerAnswer = { version: 1, exists: false };

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

type ServerRequest = { method: string; body: unknown };
const requests: ServerRequest[] = [];
// What the fake server answers; a function sees the request.
let respond: (request: ServerRequest) => Response = () => json(diskResponseBody);
const json = (body: ServerAnswer, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async (_path: string, init?: RequestInit) => {
    const request = { method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null };
    requests.push(request);
    return respond(request);
  }),
}));
mock.module('@/lib/runtime-switch', () => ({ getRuntimeKey: () => runtimeKey }));

const { useSessionFoldersStore, handleSessionFoldersChanged, handleSessionFoldersStreamReady } = await import('./useSessionFoldersStore');

const waitForPersist = () => new Promise((resolve) => setTimeout(resolve, 350));

describe('useSessionFoldersStore folder assignments', () => {
  beforeEach(() => {
    storage.clear();
    storageSetCount = 0;
    runtimeKey = 'runtime-a';
    diskResponseBody = { version: 1, exists: false };
    requests.length = 0;
    respond = () => json(diskResponseBody);
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

  const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
  const folder = (id: string, name: string, sessionIds: string[] = []) => ({ id, name, sessionIds, createdAt: 1, parentId: null });
  const names = (scopeKey = '/repo') => useSessionFoldersStore.getState().getFoldersForScope(scopeKey).map((entry) => entry.name);
  /** Start on a fresh server connection with this device's copy already in storage. */
  const connect = async (local: TestFoldersMap | null, shared: boolean) => {
    if (local) storage.set('oc.sessions.folders.v2:runtime-a', JSON.stringify(local));
    if (shared) storage.set('oc.sessions.foldersShared.v2:runtime-a', '1');
    useSessionFoldersStore.getState().resetForRuntimeSwitch(runtimeKey);
    await settle();
    await settle();
  };

  test('hands this device\'s own folders to the server once, then shows the server\'s', withWindow(async () => {
    storage.set('oc.sessions.folderDeletions.v2:runtime-a', JSON.stringify({ gone: 5 }));
    respond = (request) => (request.method === 'PATCH'
      ? json({ exists: true, foldersMap: { '/repo': [folder('s', 'Server'), folder('l', 'Local', ['ses_1'])] }, updatedAt: 10 })
      : json({ exists: true, foldersMap: { '/repo': [folder('s', 'Server'), folder('l', 'Local', ['ses_1'])] }, updatedAt: 10 }));

    await connect({ '/repo': [folder('l', 'Local', ['ses_1'])] }, false);

    expect(requests[0]).toEqual({ method: 'PATCH', body: { changes: [{ type: 'import', foldersMap: { '/repo': [folder('l', 'Local', ['ses_1'])] }, deletedFolderIds: { gone: 5 } }] } });
    expect(names()).toEqual(['Server', 'Local']);
    expect(storage.get('oc.sessions.foldersShared.v2:runtime-a')).toBe('1');
    expect(storage.has('oc.sessions.folderDeletions.v2:runtime-a')).toBe(false);

    requests.length = 0;
    await connect(null, false);
    expect(requests.map((request) => request.method)).toEqual(['GET']);
  }));

  test('a folder made before the first contact is not sent again after the hand-over joined it', withWindow(async () => {
    const joined = { exists: true, foldersMap: { '/repo': [folder('s', 'Bugs', ['ses_1'])] }, updatedAt: 10 };
    respond = () => json(joined);

    useSessionFoldersStore.getState().resetForRuntimeSwitch(runtimeKey);
    // Before the store reached the server, as the archive filing does on a fresh device.
    const local = useSessionFoldersStore.getState().createFolder('/repo', 'Bugs');
    useSessionFoldersStore.getState().addSessionToFolder('/repo', local.id, 'ses_1');
    await settle();
    await settle(250);

    const patches = requests.filter((request) => request.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0]?.body).toMatchObject({ changes: [{ type: 'import' }] });
    expect(names()).toEqual(['Bugs']);
    expect(storage.has('oc.sessions.folderChanges.v2:runtime-a')).toBe(false);
  }));

  test('sends a long queue in parts the server accepts', withWindow(async () => {
    respond = (request) => (request.method === 'GET'
      ? json({ exists: true, foldersMap: { '/repo': [folder('a', 'A'), folder('b', 'B')] }, updatedAt: 10 })
      : json({ exists: true, foldersMap: { '/repo': [folder('a', 'A'), folder('b', 'B')] }, updatedAt: 11 }));
    await connect(null, true);
    // Offline: nothing goes out until the queue is long.
    respond = (request) => (request.method === 'GET'
      ? json({ exists: true, foldersMap: { '/repo': [folder('a', 'A'), folder('b', 'B')] }, updatedAt: 10 })
      : json({ error: 'down' }, 503));
    for (let index = 0; index < 1_100; index += 1) {
      useSessionFoldersStore.getState().addSessionToFolder('/repo', index % 2 === 0 ? 'a' : 'b', 'ses_1');
    }
    respond = () => json({ exists: true, foldersMap: { '/repo': [folder('a', 'A'), folder('b', 'B', ['ses_1'])] }, updatedAt: 12 });
    requests.length = 0;
    handleSessionFoldersStreamReady();
    await settle(800);

    const sizes = requests.filter((request) => request.method === 'PATCH').map((request) => JSON.stringify(request.body).split('"assign"').length - 1);
    expect(sizes.every((size) => size <= 500)).toBe(true);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(1_100);
  }));

  test('keeps this device\'s folders and retries when the hand-over fails', withWindow(async () => {
    respond = () => json({ error: 'down' }, 503);

    await connect({ '/repo': [folder('l', 'Local')] }, false);

    expect(requests.map((request) => request.method)).toEqual(['PATCH']);
    expect(names()).toEqual(['Local']);
    expect(storage.has('oc.sessions.foldersShared.v2:runtime-a')).toBe(false);
  }));

  test('sends each change to the server and keeps it until the server stored it', withWindow(async () => {
    let fail = true;
    respond = (request) => {
      if (request.method === 'GET') return json({ exists: false });
      if (fail) return json({ error: 'down' }, 503);
      return json({ exists: true, foldersMap: { '/repo': [folder('f', 'Work')] }, updatedAt: 20 });
    };
    await connect(null, true);

    useSessionFoldersStore.getState().createFolder('/repo', 'Work', null, 'f');
    await settle(200);

    const patch = requests.find((request) => request.method === 'PATCH');
    expect(patch?.body).toMatchObject({ changes: [{ type: 'create', scopeKey: '/repo', folder: { id: 'f', name: 'Work', parentId: null } }] });
    expect(storage.get('oc.sessions.folderChanges.v2:runtime-a')).toContain('"create"');

    // A reload before the server took it still sends it.
    fail = false;
    requests.length = 0;
    await connect(null, true);
    await settle(200);
    expect(requests.filter((request) => request.method === 'PATCH')).toHaveLength(1);
    expect(storage.has('oc.sessions.folderChanges.v2:runtime-a')).toBe(false);
  }));

  test('shows another client\'s change and lays its own pending changes over it', withWindow(async () => {
    let server = { exists: true, foldersMap: { '/repo': [folder('a', 'A')] }, updatedAt: 10 };
    respond = (request) => (request.method === 'GET' ? json(server) : json({ error: 'down' }, 503));
    await connect(null, true);
    expect(names()).toEqual(['A']);

    // Not stored yet: the server is down for writes.
    useSessionFoldersStore.getState().renameFolder('/repo', 'a', 'Mine');
    server = { exists: true, foldersMap: { '/repo': [folder('a', 'A'), folder('b', 'From the phone')] }, updatedAt: 11 };
    handleSessionFoldersChanged(11);
    await settle();
    await settle();

    expect(names()).toEqual(['Mine', 'From the phone']);
  }));

  test('skips the read for a change it already shows and ignores an older answer', withWindow(async () => {
    respond = () => json({ exists: true, foldersMap: { '/repo': [folder('a', 'A')] }, updatedAt: 10 });
    await connect(null, true);
    requests.length = 0;

    handleSessionFoldersChanged(10);
    await settle();
    expect(requests).toHaveLength(0);

    respond = () => json({ exists: true, foldersMap: {}, updatedAt: 9 });
    handleSessionFoldersStreamReady();
    await settle();
    await settle();
    expect(names()).toEqual(['A']);
  }));

  test('a failed read keeps the folders on screen', withWindow(async () => {
    respond = () => json({ exists: true, foldersMap: { '/repo': [folder('a', 'A')] }, updatedAt: 10 });
    await connect(null, true);

    respond = () => json({ error: 'Stored session folders are malformed' }, 500);
    handleSessionFoldersChanged(11);
    await settle();
    await settle();
    expect(names()).toEqual(['A']);
  }));

  test('writes the whole copy to a server from before shared folders', withWindow(async () => {
    respond = (request) => {
      if (request.method === 'PATCH') return json({ error: 'not found' }, 404);
      if (request.method === 'POST') return json({ success: true });
      return json({ exists: true, foldersMap: { '/repo': [folder('a', 'A')] }, collapsedFolderIds: [], updatedAt: 10 });
    };
    await connect(null, true);

    useSessionFoldersStore.getState().deleteFolder('/repo', 'a');
    await settle(200);

    const post = requests.find((request) => request.method === 'POST');
    expect(post?.body).toMatchObject({ version: 1, foldersMap: { '/repo': [] } });
    expect(post?.body).toHaveProperty('deletedFolderIds.a');
    expect(storage.has('oc.sessions.folderChanges.v2:runtime-a')).toBe(false);
  }));

  test('a deleted chat leaves its folders on the server too, and collapsing stays on this device', withWindow(async () => {
    respond = (request) => (request.method === 'GET'
      ? json({ exists: true, foldersMap: { '/repo': [folder('a', 'A', ['ses_1'])] }, updatedAt: 10 })
      : json({ exists: true, foldersMap: { '/repo': [folder('a', 'A')] }, updatedAt: 11 }));
    await connect(null, true);
    requests.length = 0;

    useSessionFoldersStore.getState().toggleFolderCollapse('a');
    useSessionFoldersStore.getState().removeSessionEverywhere(runtimeKey, 'ses_1');
    await settle(200);

    expect(requests.map((request) => request.body)).toEqual([{ changes: [{ type: 'forget-sessions', sessionIds: ['ses_1'] }] }]);
    expect(useSessionFoldersStore.getState().collapsedFolderIds.has('a')).toBe(true);
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
