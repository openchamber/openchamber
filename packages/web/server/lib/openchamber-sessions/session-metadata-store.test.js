import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionMetadataStore, mergeMetadataPatch } from './session-metadata-store.js';

const tempDirs = [];

const makeDataDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-metadata-'));
  tempDirs.push(dir);
  return dir;
};


afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('mergeMetadataPatch', () => {
  it('merges nested objects key by key instead of replacing them', () => {
    const current = { openchamber: { goal: { id: 'g1', status: 'active' }, assist: { recap: 'r' } } };
    const merged = mergeMetadataPatch(current, { openchamber: { goal: { status: 'complete' } } });

    expect(merged).toEqual({
      openchamber: { goal: { id: 'g1', status: 'complete' }, assist: { recap: 'r' } },
    });
    // The input is untouched: callers keep whatever they already held.
    expect(current.openchamber.goal.status).toBe('active');
  });

  it('deletes a key when its patch value is null', () => {
    expect(mergeMetadataPatch({ a: 1, b: 2 }, { b: null })).toEqual({ a: 1 });
    expect(mergeMetadataPatch({ openchamber: { goal: {}, assist: {} } }, { openchamber: { assist: null } }))
      .toEqual({ openchamber: { goal: {} } });
  });

  it('replaces arrays and scalars rather than merging into them', () => {
    expect(mergeMetadataPatch({ pins: ['a', 'b'] }, { pins: ['c'] })).toEqual({ pins: ['c'] });
    expect(mergeMetadataPatch({ a: { nested: true } }, { a: 'flat' })).toEqual({ a: 'flat' });
  });

  it('treats a missing or non-object base as empty', () => {
    expect(mergeMetadataPatch(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(mergeMetadataPatch('nope', { a: 1 })).toEqual({ a: 1 });
    expect(mergeMetadataPatch({ a: 1 }, 'nope')).toEqual({ a: 1 });
  });
});

const legacyFile = (dataDir) => path.join(dataDir, 'sessions-metadata.json');
const writeLegacy = (dataDir, content) => {
  fs.writeFileSync(legacyFile(dataDir), typeof content === 'string' ? content : JSON.stringify(content));
};

const notFound = () => Object.assign(new Error('Session not found'), { _tag: 'SessionNotFoundError' });

/**
 * OpenCode's side: records by session id. A `write` replaces the whole object,
 * which is what `PATCH /api/session/{id}` does with `metadata`.
 */
const createFakeOpenCode = (records = {}) => {
  const sessions = new Map(Object.entries(records));
  const fake = {
    sessions,
    writes: [],
    failRead: null,
    failWrite: null,
    read: vi.fn(async (id) => {
      if (fake.failRead) throw fake.failRead;
      return sessions.has(id) ? structuredClone(sessions.get(id)) : null;
    }),
    write: vi.fn(async (id, metadata) => {
      // Yield first so concurrent writers really overlap.
      await Promise.resolve();
      if (fake.failWrite) throw fake.failWrite;
      if (!sessions.has(id)) throw notFound();
      fake.writes.push([id, metadata]);
      sessions.set(id, structuredClone(metadata));
    }),
  };
  return fake;
};

const makeStore = (openCode, dataDir = makeDataDir()) => ({
  dataDir,
  store: createSessionMetadataStore({ dataDir, openCode }),
});

describe('createSessionMetadataStore', () => {
  it('reads metadata from OpenCode, and a session OpenCode does not know as empty', async () => {
    const openCode = createFakeOpenCode({ ses_1: { openchamber: { goal: { id: 'g1' } } } });
    const { store } = makeStore(openCode);

    await expect(store.get('ses_1')).resolves.toEqual({ openchamber: { goal: { id: 'g1' } } });
    await expect(store.get('ses_missing')).resolves.toEqual({});
  });

  it('surfaces a failed read instead of answering empty', async () => {
    const openCode = createFakeOpenCode({ ses_1: { a: 1 } });
    openCode.failRead = new Error('connection refused');
    const { store } = makeStore(openCode);

    await expect(store.get('ses_1')).rejects.toThrow('connection refused');
  });

  it('merges a patch onto the OpenCode record and writes the whole result back', async () => {
    const openCode = createFakeOpenCode({
      ses_1: { openchamber: { kind: 'review', assist: { recap: 'r' } } },
    });
    const { store } = makeStore(openCode);

    const merged = await store.setSessionMetadata('ses_1', { openchamber: { goal: { status: 'active' } } });

    expect(merged).toEqual({ openchamber: { kind: 'review', assist: { recap: 'r' }, goal: { status: 'active' } } });
    expect(openCode.sessions.get('ses_1')).toEqual(merged);
    await store.setSessionMetadata('ses_1', { openchamber: { assist: null } });
    expect(openCode.sessions.get('ses_1')).toEqual({ openchamber: { kind: 'review', goal: { status: 'active' } } });
  });

  it('keeps both of two concurrent patches to the same session', async () => {
    const openCode = createFakeOpenCode({ ses_1: {} });
    const { store } = makeStore(openCode);

    await Promise.all([
      store.setSessionMetadata('ses_1', { openchamber: { goal: { status: 'active' } } }),
      store.setSessionMetadata('ses_1', { openchamber: { assist: { recap: 'r' } } }),
    ]);

    expect(openCode.sessions.get('ses_1')).toEqual({
      openchamber: { goal: { status: 'active' }, assist: { recap: 'r' } },
    });
  });

  it('writes nothing when the current record cannot be read or the session is gone', async () => {
    const openCode = createFakeOpenCode({ ses_1: { keep: true } });
    const { store } = makeStore(openCode);

    openCode.failRead = new Error('timeout');
    await expect(store.setSessionMetadata('ses_1', { a: 1 })).rejects.toThrow('timeout');
    openCode.failRead = null;
    await expect(store.setSessionMetadata('ses_missing', { a: 1 })).rejects.toThrow('not found');

    expect(openCode.write).not.toHaveBeenCalled();
    expect(openCode.sessions.get('ses_1')).toEqual({ keep: true });
  });

  it('rejects a missing id or a non-object patch', async () => {
    const { store } = makeStore(createFakeOpenCode());
    await expect(store.setSessionMetadata('', { a: 1 })).rejects.toThrow();
    await expect(store.setSessionMetadata('ses_1', ['a'])).rejects.toThrow();
  });

  describe('legacy sessions-metadata.json', () => {
    it('serves a legacy entry over the OpenCode record until it is migrated', async () => {
      const openCode = createFakeOpenCode({ ses_1: { openchamber: { kind: 'review' } } });
      const dataDir = makeDataDir();
      writeLegacy(dataDir, { ses_1: { openchamber: { kind: 'review', goal: { id: 'g1' } } } });
      const { store } = makeStore(openCode, dataDir);

      await expect(store.get('ses_1')).resolves.toEqual({ openchamber: { kind: 'review', goal: { id: 'g1' } } });
      await expect(store.listUnmigrated()).resolves.toEqual({
        ses_1: { openchamber: { kind: 'review', goal: { id: 'g1' } } },
      });
      expect(openCode.read).not.toHaveBeenCalled();
    });

    it('migrates a legacy entry on its first write, merged with the patch', async () => {
      const openCode = createFakeOpenCode({ ses_1: { stale: true }, ses_2: {} });
      const dataDir = makeDataDir();
      writeLegacy(dataDir, { ses_1: { openchamber: { goal: { id: 'g1' } } }, ses_2: { notes: ['n'] } });
      const { store } = makeStore(openCode, dataDir);

      await store.setSessionMetadata('ses_1', { openchamber: { assist: { recap: 'r' } } });

      // The legacy record is the newer one: it wins over what OpenCode held.
      expect(openCode.sessions.get('ses_1')).toEqual({ openchamber: { goal: { id: 'g1' }, assist: { recap: 'r' } } });
      expect(JSON.parse(fs.readFileSync(legacyFile(dataDir), 'utf8'))).toEqual({ ses_2: { notes: ['n'] } });
      await expect(store.listUnmigrated()).resolves.toEqual({ ses_2: { notes: ['n'] } });
    });

    it('pushes every entry, drops sessions OpenCode no longer has, and retires the file', async () => {
      const openCode = createFakeOpenCode({ ses_1: { stale: true }, ses_2: { stale: true } });
      const dataDir = makeDataDir();
      // `{}` is a cleared record: it must clear OpenCode's copy too.
      writeLegacy(dataDir, { ses_1: { openchamber: { goal: { id: 'g1' } } }, ses_2: {}, ses_gone: { a: 1 } });
      const { store } = makeStore(openCode, dataDir);

      await expect(store.migrateLegacy()).resolves.toBe(0);

      expect(openCode.sessions.get('ses_1')).toEqual({ openchamber: { goal: { id: 'g1' } } });
      expect(openCode.sessions.get('ses_2')).toEqual({});
      expect(fs.existsSync(legacyFile(dataDir))).toBe(false);
      expect(JSON.parse(fs.readFileSync(`${legacyFile(dataDir)}.migrated`, 'utf8'))).toMatchObject({ ses_gone: { a: 1 } });
      await expect(store.get('ses_1')).resolves.toEqual({ openchamber: { goal: { id: 'g1' } } });
    });

    it('keeps an entry OpenCode could not take for the next sweep', async () => {
      const openCode = createFakeOpenCode({ ses_1: {} });
      const dataDir = makeDataDir();
      writeLegacy(dataDir, { ses_1: { a: 1 } });
      const { store } = makeStore(openCode, dataDir);

      openCode.failWrite = new Error('connection refused');
      await expect(store.migrateLegacy()).resolves.toBe(1);
      expect(JSON.parse(fs.readFileSync(legacyFile(dataDir), 'utf8'))).toEqual({ ses_1: { a: 1 } });
      await expect(store.get('ses_1')).resolves.toEqual({ a: 1 });

      openCode.failWrite = null;
      await expect(store.migrateLegacy()).resolves.toBe(0);
      expect(openCode.sessions.get('ses_1')).toEqual({ a: 1 });
    });

    it('does not push a legacy entry over a write that migrated it first', async () => {
      const openCode = createFakeOpenCode({ ses_1: {} });
      const dataDir = makeDataDir();
      writeLegacy(dataDir, { ses_1: { a: 1 } });
      const { store } = makeStore(openCode, dataDir);

      await Promise.all([store.setSessionMetadata('ses_1', { b: 2 }), store.migrateLegacy()]);

      expect(openCode.sessions.get('ses_1')).toEqual({ a: 1, b: 2 });
    });

    it('moves a malformed file aside and has nothing to migrate', async () => {
      const openCode = createFakeOpenCode({ ses_1: { a: 1 } });
      const dataDir = makeDataDir();
      writeLegacy(dataDir, '{ not json');
      const { store } = makeStore(openCode, dataDir);

      await expect(store.get('ses_1')).resolves.toEqual({ a: 1 });
      expect(fs.readdirSync(dataDir).some((name) => name.startsWith('sessions-metadata.json.corrupt-'))).toBe(true);
    });

    it('refuses to write while the file cannot be read, then recovers', async () => {
      const openCode = createFakeOpenCode({ ses_1: {} });
      const dataDir = makeDataDir();
      const readFile = vi.fn(async () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      });
      const store = createSessionMetadataStore({
        dataDir,
        openCode,
        fsPromises: { ...fs.promises, readFile },
      });

      await expect(store.setSessionMetadata('ses_1', { a: 1 })).rejects.toThrow('permission denied');
      expect(openCode.write).not.toHaveBeenCalled();

      readFile.mockImplementation(async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      });
      await expect(store.setSessionMetadata('ses_1', { a: 1 })).resolves.toEqual({ a: 1 });
    });
  });
});
