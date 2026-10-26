import { describe, expect, it, vi } from 'vitest';
import path from 'path';

import { registerSessionFoldersRoutes } from './routes.js';

const createRouteRegistry = () => {
  const routes = new Map();

  return {
    app: {
      get(routePath, handler) {
        routes.set(`GET ${routePath}`, handler);
      },
      post(routePath, handler) {
        routes.set(`POST ${routePath}`, handler);
      },
      patch(routePath, handler) {
        routes.set(`PATCH ${routePath}`, handler);
      },
    },
    getRoute(method, routePath) {
      return routes.get(`${method} ${routePath}`);
    },
  };
};

const createMockResponse = () => {
  let statusCode = 200;
  let body = null;

  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
};

const missingFile = async () => {
  const error = new Error('missing');
  error.code = 'ENOENT';
  throw error;
};

const folderPayload = (updatedAt) => ({
  version: 1,
  foldersMap: {},
  collapsedFolderIds: [],
  updatedAt,
});

const folder = (id, name, sessionIds) => ({ id, name, sessionIds, createdAt: 1 });

describe('session folders routes', () => {
  it('uses unique temp files for concurrent saves', async () => {
    const { app, getRoute } = createRouteRegistry();
    const tempPaths = [];
    const fsPromises = {
      readFile: vi.fn(missingFile),
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async (tempPath) => {
        tempPaths.push(tempPath);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }),
      rename: vi.fn(async () => {}),
    };

    registerSessionFoldersRoutes(app, {
      fsPromises,
      path,
      openchamberDataDir: '/tmp/openchamber-test',
    });

    const handler = getRoute('POST', '/api/session-folders');

    await Promise.all([
      handler({ body: folderPayload(1) }, createMockResponse()),
      handler({ body: folderPayload(2) }, createMockResponse()),
    ]);

    expect(tempPaths).toHaveLength(2);
    expect(new Set(tempPaths).size).toBe(2);
    expect(tempPaths.every((tempPath) => tempPath.includes('sessions-directories.json.tmp-'))).toBe(true);
  });

  it('removes the temp file when rename fails', async () => {
    const { app, getRoute } = createRouteRegistry();
    const fsPromises = {
      readFile: vi.fn(missingFile),
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
      rename: vi.fn(async () => {
        throw new Error('rename failed');
      }),
      unlink: vi.fn(async () => {}),
    };

    registerSessionFoldersRoutes(app, {
      fsPromises,
      path,
      openchamberDataDir: '/tmp/openchamber-test',
    });

    const handler = getRoute('POST', '/api/session-folders');
    const response = createMockResponse();

    await handler({ body: folderPayload(1) }, response);

    expect(response.statusCode).toBe(500);
    expect(fsPromises.unlink).toHaveBeenCalledWith(expect.stringContaining('sessions-directories.json.tmp-'));
  });

  it('does not present a missing disk file as an authoritative empty snapshot', async () => {
    const { app, getRoute } = createRouteRegistry();
    const fsPromises = { readFile: vi.fn(missingFile) };
    registerSessionFoldersRoutes(app, {
      fsPromises,
      path,
      openchamberDataDir: '/tmp/openchamber-test',
    });

    const response = createMockResponse();
    await getRoute('GET', '/api/session-folders')({}, response);

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ version: 1, exists: false });
  });

  it('rejects malformed disk state instead of clearing valid browser state', async () => {
    const { app, getRoute } = createRouteRegistry();
    const fsPromises = { readFile: vi.fn(async () => '{broken') };
    registerSessionFoldersRoutes(app, {
      fsPromises,
      path,
      openchamberDataDir: '/tmp/openchamber-test',
    });

    const response = createMockResponse();
    await getRoute('GET', '/api/session-folders')({}, response);

    expect(response.statusCode).toBe(500);
  });

  it('rejects structurally invalid folder entries from disk', async () => {
    const { app, getRoute } = createRouteRegistry();
    const malformedPayload = {
      ...folderPayload(10),
      foldersMap: { project: [{ id: 'folder', name: 'Folder', sessionIds: 'session-1', createdAt: 1 }] },
    };
    const fsPromises = { readFile: vi.fn(async () => JSON.stringify(malformedPayload)) };
    registerSessionFoldersRoutes(app, {
      fsPromises,
      path,
      openchamberDataDir: '/tmp/openchamber-test',
    });

    const response = createMockResponse();
    await getRoute('GET', '/api/session-folders')({}, response);

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({ error: 'Stored session folders have an invalid shape' });
  });

  it('merges an older-stamped write without losing either side', async () => {
    const { app, getRoute } = createRouteRegistry();
    let persisted = JSON.stringify({
      ...folderPayload(20),
      foldersMap: { a: [folder('f1', 'One', ['s1'])] },
    });
    const fsPromises = {
      readFile: vi.fn(async () => persisted),
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async (_tempPath, value) => {
        persisted = value;
      }),
      rename: vi.fn(async () => {}),
      unlink: vi.fn(async () => {}),
    };
    registerSessionFoldersRoutes(app, {
      fsPromises,
      path,
      openchamberDataDir: '/tmp/openchamber-test',
    });

    const response = createMockResponse();
    const offlineDevice = {
      ...folderPayload(10),
      foldersMap: { b: [folder('f2', 'Two', ['s2'])] },
    };
    await getRoute('POST', '/api/session-folders')({ body: offlineDevice }, response);

    expect(response.body).toEqual({ success: true });
    const saved = JSON.parse(persisted);
    expect(Object.keys(saved.foldersMap).sort()).toEqual(['a', 'b']);
    // The write changed the folders, so the revision moves past the stored one.
    expect(saved.updatedAt).toBeGreaterThan(20);
  });

  it('announces an older client\'s change with a revision past the stored one', async () => {
    const onChanged = vi.fn();
    const routes = createPersistingRoutes({
      ...folderPayload(5_000),
      foldersMap: { a: [folder('f1', 'One', ['s1'])] },
    }, { onChanged, now: () => 10 });

    // The older client's clock is behind the revision a current client wrote.
    await routes.post({ ...folderPayload(3_000), foldersMap: { a: [folder('f1', 'Renamed', ['s1'])] } });

    expect(onChanged).toHaveBeenCalledWith(5_001);
    expect((await routes.get()).updatedAt).toBe(5_001);
  });

  it('refuses changes on top of a malformed file instead of replacing it', async () => {
    const { app, getRoute } = createRouteRegistry();
    const fsPromises = { readFile: vi.fn(async () => '{broken'), writeFile: vi.fn(), mkdir: vi.fn(), rename: vi.fn() };
    registerSessionFoldersRoutes(app, { fsPromises, path, openchamberDataDir: '/tmp/openchamber-test' });

    const response = createMockResponse();
    await getRoute('PATCH', '/api/session-folders')({
      body: { changes: [{ type: 'create', scopeKey: '/repo', folder: { id: 'f', name: 'F', parentId: null, createdAt: 1 } }] },
    }, response);

    expect(response.statusCode).toBe(500);
    expect(fsPromises.writeFile).not.toHaveBeenCalled();
  });

  it('unions scopes when a duplicate revision carries different data', async () => {
    const { app, getRoute } = createRouteRegistry();
    let persisted = JSON.stringify({
      ...folderPayload(20),
      foldersMap: { existing: [folder('f1', 'Existing', ['s1'])] },
    });
    const fsPromises = {
      readFile: vi.fn(async () => persisted),
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async (_tempPath, value) => {
        persisted = value;
      }),
      rename: vi.fn(async () => {}),
      unlink: vi.fn(async () => {}),
    };
    registerSessionFoldersRoutes(app, {
      fsPromises,
      path,
      openchamberDataDir: '/tmp/openchamber-test',
    });

    const response = createMockResponse();
    const duplicateRevision = {
      ...folderPayload(20),
      foldersMap: { replacement: [folder('f2', 'Replacement', ['s2'])] },
    };
    await getRoute('POST', '/api/session-folders')({ body: duplicateRevision }, response);

    expect(response.body).toEqual({ success: true });
    const saved = JSON.parse(persisted);
    expect(Object.keys(saved.foldersMap).sort()).toEqual(['existing', 'replacement']);
  });

  it('preserves scopes the incoming snapshot never saw', async () => {
    const { app, getRoute } = createRouteRegistry();
    let persisted = JSON.stringify({
      ...folderPayload(20),
      foldersMap: { '/home/ai': [folder('f1', 'coco', ['s1', 's2'])] },
    });
    const fsPromises = {
      readFile: vi.fn(async () => persisted),
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async (_tempPath, value) => {
        persisted = value;
      }),
      rename: vi.fn(async () => {}),
      unlink: vi.fn(async () => {}),
    };
    registerSessionFoldersRoutes(app, {
      fsPromises,
      path,
      openchamberDataDir: '/tmp/openchamber-test',
    });

    const response = createMockResponse();
    const staleDevice = {
      ...folderPayload(30),
      foldersMap: { '/other/project': [folder('f2', 'Other', ['s3'])] },
    };
    await getRoute('POST', '/api/session-folders')({ body: staleDevice }, response);

    expect(response.body).toEqual({ success: true });
    const saved = JSON.parse(persisted);
    expect(saved.foldersMap['/home/ai']).toEqual([folder('f1', 'coco', ['s1', 's2'])]);
    expect(saved.foldersMap['/other/project']).toEqual([folder('f2', 'Other', ['s3'])]);
  });

  it('unions folders within a shared scope and keeps ones the writer dropped', async () => {
    const { app, getRoute } = createRouteRegistry();
    let persisted = JSON.stringify({
      ...folderPayload(20),
      foldersMap: { '/home/ai': [folder('f1', 'Keep', ['s1']), folder('f2', 'Drop', ['s2'])] },
    });
    const fsPromises = {
      readFile: vi.fn(async () => persisted),
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async (_tempPath, value) => {
        persisted = value;
      }),
      rename: vi.fn(async () => {}),
      unlink: vi.fn(async () => {}),
    };
    registerSessionFoldersRoutes(app, {
      fsPromises,
      path,
      openchamberDataDir: '/tmp/openchamber-test',
    });

    const response = createMockResponse();
    const hydratedWriter = {
      ...folderPayload(30),
      foldersMap: { '/home/ai': [folder('f1', 'Keep', ['s1']), folder('f3', 'Add', ['s3'])] },
    };
    await getRoute('POST', '/api/session-folders')({ body: hydratedWriter }, response);

    expect(response.body).toEqual({ success: true });
    const saved = JSON.parse(persisted);
    expect(saved.foldersMap['/home/ai'].map((entry) => entry.id).sort()).toEqual(['f1', 'f2', 'f3']);
  });

  const createPersistingRoutes = (initial, { onChanged, now } = {}) => {
    const { app, getRoute } = createRouteRegistry();
    const state = { persisted: initial === undefined ? null : JSON.stringify(initial) };
    const fsPromises = {
      readFile: vi.fn(async () => {
        if (state.persisted === null) return missingFile();
        return state.persisted;
      }),
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async (_tempPath, value) => {
        state.persisted = value;
      }),
      rename: vi.fn(async () => {}),
      unlink: vi.fn(async () => {}),
    };
    registerSessionFoldersRoutes(app, { fsPromises, path, openchamberDataDir: '/tmp/openchamber-test', onChanged, now });
    const post = async (body) => {
      const response = createMockResponse();
      await getRoute('POST', '/api/session-folders')({ body }, response);
      return response;
    };
    const patch = async (changes) => {
      const response = createMockResponse();
      await getRoute('PATCH', '/api/session-folders')({ body: { changes } }, response);
      return response;
    };
    const get = async () => {
      const response = createMockResponse();
      await getRoute('GET', '/api/session-folders')({}, response);
      return response.body;
    };
    return { post, patch, get, state, fsPromises };
  };

  describe('changes', () => {
    const create = (scopeKey, id, name, parentId = null) => ({ type: 'create', scopeKey, folder: { id, name, parentId, createdAt: 1 } });

    it('applies a create, a move and a rename, and announces each write once', async () => {
      const onChanged = vi.fn();
      const routes = createPersistingRoutes(undefined, { onChanged, now: () => 1_000 });

      const response = await routes.patch([
        create('/repo', 'f1', 'Work'),
        { type: 'assign', scopeKey: '/repo', folderId: 'f1', sessionIds: ['s1', 's2'] },
        { type: 'rename', scopeKey: '/repo', folderId: 'f1', name: 'Done' },
      ]);

      expect(response.statusCode).toBe(200);
      expect(response.body.foldersMap['/repo']).toEqual([{ id: 'f1', name: 'Done', parentId: null, createdAt: 1, sessionIds: ['s1', 's2'] }]);
      expect(response.body.updatedAt).toBe(1_000);
      expect(onChanged).toHaveBeenCalledTimes(1);
      expect(onChanged).toHaveBeenCalledWith(1_000);
      expect((await routes.get()).foldersMap).toEqual(response.body.foldersMap);
    });

    it('moves a chat out of its old folder and keeps a revision that only grows', async () => {
      const routes = createPersistingRoutes({
        ...folderPayload(5_000),
        foldersMap: { '/repo': [folder('a', 'A', ['s1', 's2']), folder('b', 'B', [])] },
      }, { now: () => 10 });

      const response = await routes.patch([{ type: 'assign', scopeKey: '/repo', folderId: 'b', sessionIds: ['s1'] }]);

      expect(response.body.foldersMap['/repo'].map((entry) => [entry.id, entry.sessionIds])).toEqual([['a', ['s2']], ['b', ['s1']]]);
      // The server clock is behind the stored revision; the revision still grows.
      expect(response.body.updatedAt).toBe(5_001);
    });

    it('writes nothing and announces nothing for a change that is already in place', async () => {
      const onChanged = vi.fn();
      const routes = createPersistingRoutes({
        ...folderPayload(20),
        foldersMap: { '/repo': [folder('a', 'A', ['s1'])] },
      }, { onChanged });

      const response = await routes.patch([
        { type: 'assign', scopeKey: '/repo', folderId: 'a', sessionIds: ['s1'] },
        { type: 'rename', scopeKey: '/repo', folderId: 'a', name: 'A' },
        create('/repo', 'a', 'Again'),
      ]);

      expect(response.statusCode).toBe(200);
      expect(response.body.updatedAt).toBe(20);
      expect(routes.fsPromises.writeFile).not.toHaveBeenCalled();
      expect(onChanged).not.toHaveBeenCalled();
    });

    it('ignores a move into a folder another client deleted meanwhile', async () => {
      const routes = createPersistingRoutes({
        ...folderPayload(20),
        foldersMap: { '/repo': [folder('a', 'A', ['s1'])] },
      });

      await routes.patch([{ type: 'delete', scopeKey: '/repo', folderIds: ['a'] }]);
      const response = await routes.patch([
        { type: 'assign', scopeKey: '/repo', folderId: 'a', sessionIds: ['s2'] },
        { type: 'rename', scopeKey: '/repo', folderId: 'a', name: 'Back' },
      ]);

      expect(response.body.foldersMap).toEqual({});
      expect(Object.keys(response.body.deletedFolderIds)).toEqual(['a']);
    });

    it('deletes sub-folders with their folder and leaves a tombstone for older clients', async () => {
      const routes = createPersistingRoutes({
        ...folderPayload(20),
        foldersMap: { '/repo': [folder('a', 'A', []), { ...folder('b', 'B', ['s1']), parentId: 'a' }, folder('c', 'C', [])] },
        collapsedFolderIds: ['b', 'c'],
      }, { now: () => 100 });

      await routes.patch([{ type: 'delete', scopeKey: '/repo', folderIds: ['a'] }]);
      // An older client still holding the deleted folders writes its whole copy.
      await routes.post({
        ...folderPayload(30),
        foldersMap: { '/repo': [folder('a', 'A', []), { ...folder('b', 'B', ['s1']), parentId: 'a' }, folder('c', 'C', [])] },
      });

      const snapshot = await routes.get();
      expect(snapshot.foldersMap['/repo'].map((entry) => entry.id)).toEqual(['c']);
      expect(snapshot.deletedFolderIds).toEqual({ a: 100, b: 100 });
    });

    it('takes a deleted chat out of every folder on the server', async () => {
      const routes = createPersistingRoutes({
        ...folderPayload(20),
        foldersMap: { '/repo': [folder('a', 'A', ['s1', 's2'])], '/wt': [folder('b', 'B', ['s1'])] },
      });

      const response = await routes.patch([{ type: 'forget-sessions', sessionIds: ['s1'] }]);

      expect(response.body.foldersMap).toEqual({ '/repo': [folder('a', 'A', ['s2'])] , '/wt': [folder('b', 'B', [])] });
    });

    it('removes every folder of a closed project', async () => {
      const routes = createPersistingRoutes({
        ...folderPayload(20),
        foldersMap: { '/repo': [folder('a', 'A', ['s1'])], '__archived__:/repo': [folder('z', 'main', ['s9'])], '/other': [folder('o', 'O', [])] },
      }, { now: () => 50 });

      const response = await routes.patch([{ type: 'forget-scopes', scopeKeys: ['/repo', '__archived__:/repo'] }]);

      expect(Object.keys(response.body.foldersMap)).toEqual(['/other']);
      expect(response.body.deletedFolderIds).toEqual({ a: 50, z: 50 });
    });

    it('lets a fixed-id folder be created again after it was deleted', async () => {
      const routes = createPersistingRoutes(undefined);
      await routes.patch([create('/repo', 'archived:main', 'main')]);
      await routes.patch([{ type: 'delete', scopeKey: '/repo', folderIds: ['archived:main'] }]);
      const response = await routes.patch([create('/repo', 'archived:main', 'main')]);
      expect(response.body.foldersMap['/repo'].map((entry) => entry.id)).toEqual(['archived:main']);
      expect(response.body.deletedFolderIds).toEqual({});
    });

    it('rejects a malformed change without writing', async () => {
      const routes = createPersistingRoutes(undefined);
      const response = await routes.patch([{ type: 'assign', scopeKey: '/repo', folderId: 'a', sessionIds: [] }]);
      expect(response.statusCode).toBe(400);
      expect(routes.fsPromises.writeFile).not.toHaveBeenCalled();
    });
  });

  describe('import of folders a device kept on its own', () => {
    const imported = (foldersMap, deletedFolderIds) => [{ type: 'import', foldersMap, deletedFolderIds }];

    it('adds local folders the server does not have and keeps the server ones', async () => {
      const routes = createPersistingRoutes({
        ...folderPayload(20),
        foldersMap: { '/repo': [folder('s', 'Server', ['s1'])] },
      });

      const response = await routes.patch(imported({ '/repo': [folder('l', 'Local', ['s2'])], '/wt': [folder('w', 'Wt', ['s3'])] }));

      expect(response.body.foldersMap['/repo'].map((entry) => [entry.id, entry.name, entry.sessionIds])).toEqual([
        ['s', 'Server', ['s1']],
        ['l', 'Local', ['s2']],
      ]);
      expect(response.body.foldersMap['/wt'].map((entry) => entry.id)).toEqual(['w']);
    });

    it('joins a local folder with a same-name server folder instead of making a duplicate', async () => {
      const routes = createPersistingRoutes({
        ...folderPayload(20),
        foldersMap: { '/repo': [folder('s', 'Bugs', ['s1'])] },
      });

      const response = await routes.patch(imported({ '/repo': [folder('l', 'bugs ', ['s1', 's2'])] }));

      expect(response.body.foldersMap['/repo']).toEqual([folder('s', 'Bugs', ['s1', 's2'])]);
    });

    it('keeps a chat where the server files it and places sub-folders under the joined parent', async () => {
      const routes = createPersistingRoutes({
        ...folderPayload(20),
        foldersMap: { '/repo': [folder('sp', 'Parent', []), folder('other', 'Other', ['s1'])] },
      });

      const response = await routes.patch(imported({
        '/repo': [
          { ...folder('lc', 'Child', ['s1', 's2']), parentId: 'lp' },
          folder('lp', 'parent', []),
        ],
      }));

      const folders = response.body.foldersMap['/repo'];
      expect(folders.find((entry) => entry.id === 'other').sessionIds).toEqual(['s1']);
      expect(folders.find((entry) => entry.id === 'lc')).toEqual({ ...folder('lc', 'Child', ['s2']), parentId: 'sp' });
      expect(folders.some((entry) => entry.id === 'lp')).toBe(false);
    });

    it('is a no-op when the same device imports twice', async () => {
      const onChanged = vi.fn();
      const routes = createPersistingRoutes(undefined, { onChanged });
      const local = { '/repo': [folder('l', 'Local', ['s1'])] };

      await routes.patch(imported(local));
      await routes.patch(imported(local));

      expect(onChanged).toHaveBeenCalledTimes(1);
      expect((await routes.get()).foldersMap).toEqual({ '/repo': [{ ...folder('l', 'Local', ['s1']), parentId: null }] });
    });

    it('drops local folders deleted elsewhere and records the device\'s own deletions', async () => {
      const now = Date.now();
      const routes = createPersistingRoutes({
        ...folderPayload(20),
        foldersMap: { '/repo': [folder('keep', 'Keep', [])] },
        deletedFolderIds: { gone: now - 1_000 },
      });

      const response = await routes.patch(imported(
        { '/repo': [folder('gone', 'Gone', ['s1']), folder('keep', 'Keep', [])] },
        { keep: now },
      ));

      expect(response.body.foldersMap).toEqual({});
      expect(Object.keys(response.body.deletedFolderIds).sort()).toEqual(['gone', 'keep']);
    });
  });

  it('keeps a deleted folder deleted when a stale device sends it again', async () => {
    const now = Date.now();
    const routes = createPersistingRoutes({
      ...folderPayload(10),
      foldersMap: { '/home/ai': [folder('f1', 'Keep', ['s1']), folder('fx', 'Gone', ['s2'])] },
    });

    await routes.post({
      ...folderPayload(20),
      foldersMap: { '/home/ai': [folder('f1', 'Keep', ['s1'])] },
      deletedFolderIds: { fx: now },
    });
    await routes.post({
      ...folderPayload(15),
      foldersMap: { '/home/ai': [folder('f1', 'Keep', ['s1']), folder('fx', 'Gone', ['s2'])] },
      collapsedFolderIds: ['fx'],
    });

    const snapshot = await routes.get();
    expect(snapshot.foldersMap['/home/ai'].map((entry) => entry.id)).toEqual(['f1']);
    expect(snapshot.collapsedFolderIds).toEqual([]);
    expect(snapshot.deletedFolderIds).toEqual({ fx: now });
  });

  it('forgets tombstones older than thirty days', async () => {
    const routes = createPersistingRoutes({
      ...folderPayload(10),
      deletedFolderIds: { old: Date.now() - 31 * 24 * 60 * 60 * 1000 },
    });
    await routes.post({ ...folderPayload(20) });
    expect((await routes.get()).deletedFolderIds).toEqual({});
  });

  it('takes collapse state for a known folder from the writer', async () => {
    const routes = createPersistingRoutes({
      ...folderPayload(10),
      foldersMap: { '/home/ai': [folder('f1', 'One', []), folder('f2', 'Two', [])] },
      collapsedFolderIds: ['f1', 'f2'],
    });
    await routes.post({
      ...folderPayload(20),
      foldersMap: { '/home/ai': [folder('f1', 'One', [])] },
      collapsedFolderIds: [],
    });
    // f1 was expanded by the writer; f2 is unknown to it, so its state stays.
    expect((await routes.get()).collapsedFolderIds).toEqual(['f2']);
  });

  it('rejects a tombstone map with a non-numeric timestamp', async () => {
    const routes = createPersistingRoutes();
    const response = await routes.post({ ...folderPayload(20), deletedFolderIds: { fx: 'yesterday' } });
    expect(response.statusCode).toBe(400);
  });

  it('lets the incoming version win for the same folder id', async () => {
    const { app, getRoute } = createRouteRegistry();
    let persisted = JSON.stringify({
      ...folderPayload(20),
      foldersMap: { '/home/ai': [folder('f1', 'Old name', ['s1'])] },
    });
    const fsPromises = {
      readFile: vi.fn(async () => persisted),
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async (_tempPath, value) => {
        persisted = value;
      }),
      rename: vi.fn(async () => {}),
      unlink: vi.fn(async () => {}),
    };
    registerSessionFoldersRoutes(app, {
      fsPromises,
      path,
      openchamberDataDir: '/tmp/openchamber-test',
    });

    const response = createMockResponse();
    const renamed = {
      ...folderPayload(30),
      foldersMap: { '/home/ai': [folder('f1', 'New name', ['s1', 's4'])] },
    };
    await getRoute('POST', '/api/session-folders')({ body: renamed }, response);

    expect(response.body).toEqual({ success: true });
    const saved = JSON.parse(persisted);
    expect(saved.foldersMap['/home/ai']).toEqual([folder('f1', 'New name', ['s1', 's4'])]);
  });

  it('unions session lists of same-name folders created independently', async () => {
    const { app, getRoute } = createRouteRegistry();
    let persisted = JSON.stringify({
      ...folderPayload(20),
      foldersMap: { '/home/ai': [folder('a1', 'project root', ['s1'])] },
    });
    const fsPromises = {
      readFile: vi.fn(async () => persisted),
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async (_tempPath, value) => {
        persisted = value;
      }),
      rename: vi.fn(async () => {}),
      unlink: vi.fn(async () => {}),
    };
    registerSessionFoldersRoutes(app, {
      fsPromises,
      path,
      openchamberDataDir: '/tmp/openchamber-test',
    });

    const response = createMockResponse();
    const secondDevice = {
      ...folderPayload(30),
      foldersMap: { '/home/ai': [folder('b2', 'Project Root', ['s2'])] },
    };
    await getRoute('POST', '/api/session-folders')({ body: secondDevice }, response);

    expect(response.body).toEqual({ success: true });
    const saved = JSON.parse(persisted);
    expect(saved.foldersMap['/home/ai']).toEqual([folder('b2', 'Project Root', ['s1', 's2'])]);
  });

  it('allows a valid snapshot to repair structurally invalid prior state', async () => {
    const { app, getRoute } = createRouteRegistry();
    const fsPromises = {
      readFile: vi.fn(async () => JSON.stringify({ version: 1, updatedAt: 999, foldersMap: null })),
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
      rename: vi.fn(async () => {}),
      unlink: vi.fn(async () => {}),
    };
    registerSessionFoldersRoutes(app, {
      fsPromises,
      path,
      openchamberDataDir: '/tmp/openchamber-test',
    });

    const response = createMockResponse();
    await getRoute('POST', '/api/session-folders')({ body: folderPayload(10) }, response);

    expect(response.body).toEqual({ success: true });
    expect(fsPromises.writeFile).toHaveBeenCalledTimes(1);
  });
});
