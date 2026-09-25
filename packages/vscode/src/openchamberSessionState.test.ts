import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  type JsonValue,
  createSessionStateStore,
  isSessionRecordPath,
  mergeMetadataPatch,
  overlaySessionResponseBody,
  type SessionMetadata,
  type SessionMetadataOnOpenCode,
  type SessionStateFs,
} from './openchamberSessionState';

/** OpenCode's side: `write` replaces the whole object, as PATCH does. */
const createFakeOpenCode = (records: Record<string, SessionMetadata> = {}) => {
  const sessions = new Map(Object.entries(records));
  const openCode: SessionMetadataOnOpenCode = {
    read: async (id) => sessions.get(id) ?? null,
    write: async (id, metadata) => {
      if (!sessions.has(id)) throw new Error('not found');
      sessions.set(id, metadata);
    },
  };
  return { openCode, sessions };
};

/** The store joins its file names with the platform separator. */
const dataFile = (name: string) => path.join('/data', name);

/** In-memory file system: the store must read before every write and rename atomically. */
const createMemoryFs = (initial: Record<string, string> = {}) => {
  const files = new Map(Object.entries(initial));
  const writes: string[] = [];
  const fsPromises: SessionStateFs = {
    readFile: async (filePath) => {
      const content = files.get(filePath);
      if (content === undefined) {
        const error = new Error('missing') as Error & { code?: string };
        error.code = 'ENOENT';
        throw error;
      }
      return content;
    },
    writeFile: async (filePath, data) => {
      files.set(filePath, data);
      writes.push(filePath);
    },
    rename: async (from, to) => {
      const content = files.get(from);
      if (content === undefined) throw new Error(`rename source missing: ${from}`);
      files.delete(from);
      files.set(to, content);
    },
    mkdir: async () => undefined,
  };
  return { fsPromises, files, writes };
};

describe('openchamber session state store', () => {
  it('archives and unarchives a batch and reads the flags back from disk', async () => {
    const memory = createMemoryFs();
    const store = createSessionStateStore({ dataDir: '/data', fsPromises: memory.fsPromises, now: () => 1000 });

    assert.deepEqual(await store.archive(['ses_a', 'ses_b', 'ses_a'], null), {
      archived: [{ id: 'ses_a', archivedAt: 1000 }, { id: 'ses_b', archivedAt: 1000 }],
      failedIds: [],
    });
    assert.deepEqual(await store.readArchived(), { ses_a: 1000, ses_b: 1000 });
    assert.equal(memory.files.has(store.archivePath), true);
    // Every write went through a temp file that was renamed into place.
    assert.equal(memory.writes.every((filePath) => filePath.endsWith('.tmp')), true);

    assert.deepEqual(await store.unarchive(['ses_a']), { restored: [{ id: 'ses_a', archivedAt: null }], failedIds: [] });
    // The unarchive stays on file: it overrides an archived stamp OpenCode may still carry.
    assert.deepEqual(await store.readArchived(), { ses_a: null, ses_b: 1000 });
  });

  it('keeps a change another process made between two of its own writes', async () => {
    const memory = createMemoryFs();
    const store = createSessionStateStore({ dataDir: '/data', fsPromises: memory.fsPromises, now: () => 1000 });
    await store.archive(['ses_a']);
    // The desktop app archives ses_c in the same file.
    memory.files.set(store.archivePath, JSON.stringify({ ses_a: 1000, ses_c: 2000 }));

    await store.archive(['ses_b']);

    assert.deepEqual(await store.readArchived(), { ses_a: 1000, ses_b: 1000, ses_c: 2000 });
  });

  it('reports every id as failed when the archive file cannot be read', async () => {
    const memory = createMemoryFs();
    memory.fsPromises.readFile = async () => { throw new Error('EACCES'); };
    const store = createSessionStateStore({ dataDir: '/data', fsPromises: memory.fsPromises });

    assert.deepEqual(await store.archive(['ses_a']), { archived: [], failedIds: ['ses_a'] });
    assert.equal(await store.readArchived(), null);
    assert.deepEqual(memory.writes, []);
  });

  it('moves an unreadable file aside instead of overwriting it', async () => {
    const memory = createMemoryFs({ [dataFile('sessions-archive.json')]: '{not json' });
    const store = createSessionStateStore({ dataDir: '/data', fsPromises: memory.fsPromises, now: () => 5 });

    assert.deepEqual(await store.readArchived(), {});
    assert.equal(memory.files.get(dataFile('sessions-archive.json.corrupt-5')), '{not json');
  });

  it('merges metadata patches on OpenCode per key and deletes on null', async () => {
    const memory = createMemoryFs();
    const store = createSessionStateStore({ dataDir: '/data', fsPromises: memory.fsPromises });
    const { openCode, sessions } = createFakeOpenCode({ ses_a: { kind: 'review' } });

    await store.setMetadata('ses_a', { openchamber: { goal: { objective: 'ship' }, assist: { recap: 'r' } } }, openCode);
    const merged = await store.setMetadata('ses_a', { openchamber: { goal: null, pinned: true } }, openCode);

    assert.deepEqual(merged, { kind: 'review', openchamber: { assist: { recap: 'r' }, pinned: true } });
    assert.deepEqual(sessions.get('ses_a'), merged);
    assert.deepEqual(await store.getMetadata('ses_a', openCode), merged);
    assert.deepEqual(await store.getMetadata('ses_missing', openCode), {});
    await assert.rejects(store.setMetadata('ses_missing', { a: 1 }, openCode));
    // Nothing touches the legacy file.
    assert.equal(memory.files.has(dataFile('sessions-metadata.json')), false);
  });

  it('folds a legacy entry into the first write, then drops it from the file', async () => {
    const memory = createMemoryFs({
      [dataFile('sessions-metadata.json')]: JSON.stringify({ ses_a: { openchamber: { goal: { id: 'g1' } } }, ses_b: { x: 1 } }),
    });
    const store = createSessionStateStore({ dataDir: '/data', fsPromises: memory.fsPromises });
    const { openCode, sessions } = createFakeOpenCode({ ses_a: { kind: 'review' } });

    assert.deepEqual(await store.getMetadata('ses_a', openCode), { kind: 'review', openchamber: { goal: { id: 'g1' } } });
    await store.setMetadata('ses_a', { openchamber: { pinned: true } }, openCode);

    assert.deepEqual(sessions.get('ses_a'), { kind: 'review', openchamber: { goal: { id: 'g1' }, pinned: true } });
    assert.deepEqual(await store.readMetadata(), { ses_b: { x: 1 } });
  });
});

describe('mergeMetadataPatch', () => {
  it('replaces non-object values and recurses into objects', () => {
    assert.deepEqual(mergeMetadataPatch({ a: { b: 1, c: 2 }, d: 'x' }, { a: { b: null, e: 3 }, d: ['y'] }), {
      a: { c: 2, e: 3 },
      d: ['y'],
    });
  });
});

describe('overlaySessionResponseBody', () => {
  const archived = { ses_a: 1234 };
  const stored = { ses_a: { openchamber: { pinned: true } } };

  it('folds archive time and stored metadata onto list and detail envelopes', () => {
    const list: JsonValue = {
      data: [
        { id: 'ses_a', time: { created: 1 }, metadata: { seed: 1 } },
        { id: 'ses_b', time: { created: 2, archived: 99 } },
        { id: 'ses_c', time: { created: 3, archived: 77 } },
      ],
      cursor: {},
    };
    assert.deepEqual(overlaySessionResponseBody(list, { ...archived, ses_b: null }, stored), {
      data: [
        { id: 'ses_a', time: { created: 1, archived: 1234 }, metadata: { seed: 1, openchamber: { pinned: true } } },
        // An explicit unarchive drops the stamp OpenCode still carries.
        { id: 'ses_b', time: { created: 2 } },
        // A session the file does not mention keeps what OpenCode says (migrated v1 archive).
        { id: 'ses_c', time: { created: 3, archived: 77 } },
      ],
      cursor: {},
    });
    assert.deepEqual(overlaySessionResponseBody({ data: { id: 'ses_a', time: {} } }, archived, null), {
      data: { id: 'ses_a', time: { archived: 1234 } },
    });
  });

  it('leaves the body alone when nothing is known', () => {
    const body = { data: [{ id: 'ses_a', time: { archived: 7 } }] };
    assert.equal(overlaySessionResponseBody(body, null, null), body);
    assert.equal(overlaySessionResponseBody('not json', archived, stored), 'not json');
  });

  it('matches only the list and single-record session paths', () => {
    assert.equal(isSessionRecordPath('/api/session'), true);
    assert.equal(isSessionRecordPath('/api/session/ses_a'), true);
    assert.equal(isSessionRecordPath('/api/session/ses_a/message'), false);
  });
});
