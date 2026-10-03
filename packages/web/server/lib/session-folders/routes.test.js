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
    expect(saved.updatedAt).toBe(20);
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

  const createPersistingRoutes = (initial) => {
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
    registerSessionFoldersRoutes(app, { fsPromises, path, openchamberDataDir: '/tmp/openchamber-test' });
    const post = async (body) => {
      const response = createMockResponse();
      await getRoute('POST', '/api/session-folders')({ body }, response);
      return response;
    };
    const get = async () => {
      const response = createMockResponse();
      await getRoute('GET', '/api/session-folders')({}, response);
      return response.body;
    };
    return { post, get };
  };

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
