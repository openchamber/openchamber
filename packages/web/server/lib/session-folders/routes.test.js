import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'path';

import { MAX_STORED_SNAPSHOT_BYTES, registerSessionFoldersRoutes } from './routes.js';

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


// A bounded-reader fake backed by a test's readFile mock, mirroring the
// real reader's answers: ENOENT -> missing, over-cap -> too-large, and
// anything else the mock returns becomes the file buffer.
const fakeBoundedReaderFor = (mockFs) => async (filePath, maxBytes) => {
  let raw;
  try {
    raw = await mockFs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: false, reason: 'missing' };
    throw error;
  }
  const buffer = Buffer.from(String(raw), 'utf8');
  if (buffer.length > maxBytes) return { ok: false, reason: 'too-large', size: buffer.length, limit: maxBytes };
  return { ok: true, buffer, size: buffer.length };
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

    registerSessionFoldersRoutes(app, { readBoundedFile: fakeBoundedReaderFor(fsPromises),
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

    registerSessionFoldersRoutes(app, { readBoundedFile: fakeBoundedReaderFor(fsPromises),
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
    registerSessionFoldersRoutes(app, { readBoundedFile: fakeBoundedReaderFor(fsPromises),
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
    registerSessionFoldersRoutes(app, { readBoundedFile: fakeBoundedReaderFor(fsPromises),
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
    registerSessionFoldersRoutes(app, { readBoundedFile: fakeBoundedReaderFor(fsPromises),
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
    registerSessionFoldersRoutes(app, { readBoundedFile: fakeBoundedReaderFor(fsPromises),
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

  it('announces a collapse-only legacy POST and advances the revision (#2162)', async () => {
    const onChanged = vi.fn();
    const routes = createPersistingRoutes({
      ...folderPayload(5_000),
      foldersMap: { a: [folder('f1', 'One', ['s1'])] },
    }, { onChanged, now: () => 10 });

    await routes.post({
      ...folderPayload(3_000),
      foldersMap: { a: [folder('f1', 'One', ['s1'])] },
      collapsedFolderIds: ['f1'],
    });

    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledWith(5_001);
    const after = await routes.get();
    expect(after.collapsedFolderIds).toEqual(['f1']);
    expect(after.updatedAt).toBe(5_001);
  });

  it('announces a tombstone-only legacy POST and advances the revision (#2162)', async () => {
    const onChanged = vi.fn();
    const routes = createPersistingRoutes({
      ...folderPayload(5_000),
      foldersMap: { a: [folder('f1', 'One', ['s1'])] },
    }, { onChanged, now: () => 10 });

    await routes.post({
      ...folderPayload(3_000),
      foldersMap: { a: [folder('f1', 'One', ['s1'])] },
      deletedFolderIds: { gone: 2_500 },
    });

    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledWith(5_001);
    const after = await routes.get();
    expect(after.deletedFolderIds).toEqual({ gone: 2_500 });
    expect(after.updatedAt).toBe(5_001);
  });

  it('stays silent for a no-op legacy POST (#2162)', async () => {
    const onChanged = vi.fn();
    const snapshot = {
      ...folderPayload(5_000),
      foldersMap: { a: [folder('f1', 'One', ['s1'])] },
      collapsedFolderIds: ['f1'],
    };
    const routes = createPersistingRoutes(snapshot, { onChanged, now: () => 10 });

    await routes.post(snapshot);

    expect(onChanged).not.toHaveBeenCalled();
    expect((await routes.get()).updatedAt).toBe(5_000);
  });

  it('refuses changes on top of a malformed file instead of replacing it', async () => {
    const { app, getRoute } = createRouteRegistry();
    const fsPromises = { readFile: vi.fn(async () => '{broken'), writeFile: vi.fn(), mkdir: vi.fn(), rename: vi.fn() };
    registerSessionFoldersRoutes(app, { readBoundedFile: fakeBoundedReaderFor(fsPromises), fsPromises, path, openchamberDataDir: '/tmp/openchamber-test' });

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
    registerSessionFoldersRoutes(app, { readBoundedFile: fakeBoundedReaderFor(fsPromises),
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
    registerSessionFoldersRoutes(app, { readBoundedFile: fakeBoundedReaderFor(fsPromises),
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
    registerSessionFoldersRoutes(app, { readBoundedFile: fakeBoundedReaderFor(fsPromises),
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

  it('refuses a POST whose merged snapshot would exceed the stored read cap, without writing (#1761)', async () => {
    const { app, getRoute } = createRouteRegistry();
    // Seed the store just under the read cap, in the persisted pretty form.
    const seedFolder = folder('big', '', ['s1']);
    const seed = { ...folderPayload(20), foldersMap: { '/big': [seedFolder] } };
    const baseBytes = Buffer.byteLength(JSON.stringify(seed, null, 2), 'utf8');
    seedFolder.name = 'x'.repeat(MAX_STORED_SNAPSHOT_BYTES - 256 - baseBytes);
    let persisted = JSON.stringify(seed, null, 2);
    expect(Buffer.byteLength(persisted, 'utf8')).toBeLessThanOrEqual(MAX_STORED_SNAPSHOT_BYTES);
    const fsPromises = {
      readFile: vi.fn(async () => persisted),
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async (_tempPath, value) => {
        persisted = value;
      }),
      rename: vi.fn(async () => {}),
      unlink: vi.fn(async () => {}),
    };
    registerSessionFoldersRoutes(app, { readBoundedFile: fakeBoundedReaderFor(fsPromises),
      fsPromises,
      path,
      openchamberDataDir: '/tmp/openchamber-test',
    });

    // A disjoint, itself well-under-cap POST: the incoming body passes the
    // body check, but the merged snapshot would cross the read cap.
    const postResponse = createMockResponse();
    await getRoute('POST', '/api/session-folders')({
      body: {
        ...folderPayload(30),
        foldersMap: { '/other': [folder('f2', 'y'.repeat(1024), ['s3'])] },
      },
    }, postResponse);

    expect(postResponse.statusCode).toBe(413);
    expect(fsPromises.writeFile).not.toHaveBeenCalled();
    expect(persisted).toBe(JSON.stringify(seed, null, 2));

    // GET still serves the pre-POST state (the store was not poisoned).
    const getResponse = createMockResponse();
    await getRoute('GET', '/api/session-folders')({}, getResponse);
    expect(getResponse.statusCode).toBe(200);
    expect(Object.keys(getResponse.body.foldersMap)).toEqual(['/big']);

    // PATCH still serves the pre-POST state too: unassigning a session that
    // is not assigned anywhere is a no-op that answers with the snapshot.
    const patchResponse = createMockResponse();
    await getRoute('PATCH', '/api/session-folders')({
      body: { changes: [{ type: 'unassign', scopeKey: '/big', sessionIds: ['not-a-session'] }] },
    }, patchResponse);
    expect(patchResponse.statusCode).toBe(200);
    expect(Object.keys(patchResponse.body.foldersMap)).toEqual(['/big']);
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
    registerSessionFoldersRoutes(app, { readBoundedFile: fakeBoundedReaderFor(fsPromises), fsPromises, path, openchamberDataDir: '/tmp/openchamber-test', onChanged, now });
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

  it('refuses a PATCH whose persisted (pretty) form would exceed the write cap, without writing (#1745)', async () => {
    // One folder holding 1,000,000 copies of a 1-char session id: the
    // compact serialization is just under MAX_BODY_BYTES (4 MiB), so the
    // old compact-measuring PATCH guard let it through, while the pretty
    // form writeSnapshot persists is ~15 MB - over the 8 MiB read cap,
    // after which the store read back as malformed forever.
    const heavy = {
      ...folderPayload(20),
      foldersMap: { '/repo': [folder('f1', 'Heavy', Array(1_000_000).fill('a'))] },
    };
    expect(Buffer.byteLength(JSON.stringify(heavy), 'utf8')).toBeLessThan(4 * 1024 * 1024);
    expect(Buffer.byteLength(JSON.stringify(heavy, null, 2), 'utf8')).toBeGreaterThan(MAX_STORED_SNAPSHOT_BYTES);
    const routes = createPersistingRoutes(heavy, { now: () => 1_000 });

    const response = await routes.patch([
      { type: 'assign', scopeKey: '/repo', folderId: 'f1', sessionIds: ['b'] },
    ]);

    expect(response.statusCode).toBe(413);
    // Nothing was written: the seeded (compact, under the read cap)
    // snapshot is still the stored file, and GET still serves it.
    expect(routes.state.persisted).toBe(JSON.stringify(heavy));
    const after = await routes.get();
    expect(after.foldersMap['/repo'][0].sessionIds).toHaveLength(1_000_000);
  });

  it('accepts a PATCH whose persisted form is over the body cap but under the stored cap (#1745)', async () => {
    // 500,000 1-char session ids: pretty ~7.5 MB - over MAX_BODY_BYTES
    // (4 MiB) but under MAX_STORED_SNAPSHOT_BYTES (8 MiB), the size a
    // POST merge may legitimately have written (#1761). Such a store
    // must stay PATCHable: the PATCH guard judges the persisted form
    // against the stored cap, not the body cap.
    const heavy = {
      ...folderPayload(20),
      foldersMap: { '/repo': [folder('f1', 'Heavy', Array(500_000).fill('a'))] },
    };
    expect(Buffer.byteLength(JSON.stringify(heavy, null, 2), 'utf8')).toBeGreaterThan(4 * 1024 * 1024);
    expect(Buffer.byteLength(JSON.stringify(heavy, null, 2), 'utf8')).toBeLessThan(MAX_STORED_SNAPSHOT_BYTES);
    const routes = createPersistingRoutes(heavy, { now: () => 1_000 });

    const response = await routes.patch([
      { type: 'assign', scopeKey: '/repo', folderId: 'f1', sessionIds: ['b'] },
    ]);

    expect(response.statusCode).toBe(200);
    expect(Buffer.byteLength(routes.state.persisted, 'utf8')).toBeLessThanOrEqual(MAX_STORED_SNAPSHOT_BYTES);
    const after = await routes.get();
    expect(after.foldersMap['/repo'][0].sessionIds).toHaveLength(500_001);
  });

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

    it('rejects a create whose id is already used in another scope', async () => {
      const routes = createPersistingRoutes({
        ...folderPayload(20),
        foldersMap: { '/repo': [folder('shared', 'Keep', ['s1'])] },
        collapsedFolderIds: ['shared'],
      });

      const response = await routes.patch([create('/worktree', 'shared', 'Collision')]);

      expect(response.body.foldersMap).toEqual({ '/repo': [folder('shared', 'Keep', ['s1'])] });
      expect(response.body.collapsedFolderIds).toEqual(['shared']);
      expect(response.body.updatedAt).toBe(20);
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

    it('remaps an imported id already used in another scope, keeping its chats and children', async () => {
      const routes = createPersistingRoutes({
        ...folderPayload(20),
        foldersMap: { '/repo': [folder('shared', 'Keep', ['s1'])] },
        collapsedFolderIds: ['shared'],
      });

      const child = { id: 'kid', name: 'Kid', sessionIds: ['s3'], createdAt: 1, parentId: 'shared' };
      const response = await routes.patch(imported({ '/worktree': [folder('shared', 'Collision', ['s2']), child] }));

      expect(response.body.foldersMap).toEqual({
        '/repo': [folder('shared', 'Keep', ['s1'])],
        '/worktree': [
          { id: 'shared--imported', name: 'Collision', sessionIds: ['s2'], createdAt: 1, parentId: null },
          { id: 'kid', name: 'Kid', sessionIds: ['s3'], createdAt: 1, parentId: 'shared--imported' },
        ],
      });
      expect(response.body.collapsedFolderIds).toEqual(['shared']);
    });

    it('skips a tombstoned replacement id when remapping an imported collision', async () => {
      const routes = createPersistingRoutes({
        ...folderPayload(20),
        foldersMap: { '/repo': [folder('shared', 'Keep', ['s1'])] },
        collapsedFolderIds: ['shared'],
        deletedFolderIds: { 'shared--imported': 99_000 },
      }, { now: () => 100_000 });

      const response = await routes.patch(imported({ '/worktree': [folder('shared', 'Collision', ['s2'])] }));

      expect(response.body.foldersMap).toEqual({
        '/repo': [folder('shared', 'Keep', ['s1'])],
        '/worktree': [{ id: 'shared--imported-2', name: 'Collision', sessionIds: ['s2'], createdAt: 1, parentId: null }],
      });
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
    registerSessionFoldersRoutes(app, { readBoundedFile: fakeBoundedReaderFor(fsPromises),
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
    registerSessionFoldersRoutes(app, { readBoundedFile: fakeBoundedReaderFor(fsPromises),
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
    registerSessionFoldersRoutes(app, { readBoundedFile: fakeBoundedReaderFor(fsPromises),
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

describe('session folders bounded store reads (real reader, real temp dir)', () => {
  const setupRealRoutes = async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-session-folders-'));
    const { app, getRoute } = createRouteRegistry();
    registerSessionFoldersRoutes(app, {
      fsPromises: fs,
      path,
      openchamberDataDir: dir,
    });
    const call = async (method, body) => {
      const response = createMockResponse();
      await getRoute(method, '/api/session-folders')(body === undefined ? {} : { body }, response);
      return response;
    };
    return { dir, file: path.join(dir, 'sessions-directories.json'), call };
  };

  const paddedSnapshot = (totalBytes) => {
    const base = { version: 1, foldersMap: { '/repo': [{ id: 'f1', name: '', sessionIds: [], createdAt: 1 }] }, collapsedFolderIds: [], updatedAt: 5 };
    const baseBytes = Buffer.byteLength(JSON.stringify(base), 'utf8');
    base.foldersMap['/repo'][0].name = 'x'.repeat(totalBytes - baseBytes);
    return JSON.stringify(base);
  };

  it('refuses an oversized stored file with 500 on GET and PATCH, without parsing it whole', async () => {
    const { dir, file, call } = await setupRealRoutes();
    try {
      await fs.writeFile(file, paddedSnapshot(MAX_STORED_SNAPSHOT_BYTES + 1024), 'utf8');
      const getResponse = await call('GET');
      expect(getResponse.statusCode).toBe(500);
      const patchResponse = await call('PATCH', { changes: [{ type: 'create', scopeKey: '/repo', folder: { id: 'f2', name: 'New', parentId: null, createdAt: 1 } }] });
      expect(patchResponse.statusCode).toBe(500);
      expect(patchResponse.body.error).toContain('malformed');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('refuses a FIFO promptly on GET and PATCH, and the save queue still completes a later save', async () => {
    const { dir, file, call } = await setupRealRoutes();
    try {
      execFileSync('mkfifo', [file]);
      const getResponse = await call('GET');
      expect(getResponse.statusCode).toBe(500);
      const patchResponse = await call('PATCH', { changes: [{ type: 'create', scopeKey: '/repo', folder: { id: 'f2', name: 'New', parentId: null, createdAt: 1 } }] });
      expect(patchResponse.statusCode).toBe(500);
      // The queue is not wedged: once the FIFO is gone, a save completes.
      await fs.rm(file, { force: true });
      const later = await call('PATCH', { changes: [{ type: 'create', scopeKey: '/repo', folder: { id: 'f2', name: 'New', parentId: null, createdAt: 1 } }] });
      expect(later.statusCode).toBe(200);
      expect(fsSync.existsSync(file)).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps missing, empty, and at-cap files behaving exactly as before', async () => {
    const { dir, file, call } = await setupRealRoutes();
    try {
      const missing = await call('GET');
      expect(missing.statusCode).toBe(200);
      expect(missing.body).toEqual({ version: 1, exists: false });

      await fs.writeFile(file, '', 'utf8');
      const empty = await call('GET');
      expect(empty.statusCode).toBe(200);
      expect(empty.body).toEqual({ version: 1, exists: false });

      await fs.writeFile(file, paddedSnapshot(MAX_STORED_SNAPSHOT_BYTES), 'utf8');
      const atCap = await call('GET');
      expect(atCap.statusCode).toBe(200);
      expect(atCap.body.exists).toBe(true);
      expect(atCap.body.foldersMap['/repo'][0].id).toBe('f1');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
