import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  type JsonValue,
  createSessionStateStore,
  isSessionRecordPath,
  mergeMetadataPatch,
  overlaySessionResponseBody,
  type SessionArchiveOnOpenCode,
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
  it('creates the unread baseline once and reads it back, sharing the web server file', async () => {
    const memory = createMemoryFs();
    const store = createSessionStateStore({ dataDir: '/data', fsPromises: memory.fsPromises, now: () => 1000 });
    assert.equal(await store.readUnreadBaseline(), 1000);
    assert.equal(memory.files.get(dataFile('sessions-unread.json')), JSON.stringify({ since: 1000 }));
    const later = createSessionStateStore({ dataDir: '/data', fsPromises: memory.fsPromises, now: () => 9000 });
    assert.equal(await later.readUnreadBaseline(), 1000);
  });

  it('leaves an unreadable unread baseline alone', async () => {
    const memory = createMemoryFs({ [dataFile('sessions-unread.json')]: '{ broken' });
    const store = createSessionStateStore({ dataDir: '/data', fsPromises: memory.fsPromises, now: () => 9000 });
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      assert.equal(await store.readUnreadBaseline(), null);
    } finally {
      console.warn = warn;
    }
    assert.equal(memory.files.get(dataFile('sessions-unread.json')), '{ broken');
  });

  /**
   * OpenCode's archive route; ids in `gone` answer LocationNotFoundError, in
   * `refused` another error. Ids in `movable` move to their project folder.
   */
  const fakeArchive = ({ gone = [] as string[], refused = [] as string[], movable = [] as string[], readEntry = async (_id: string): Promise<JsonValue | undefined> => undefined } = {}) => {
    const calls: Array<[string, boolean]> = [];
    const relocated: Array<[string, boolean]> = [];
    let entryWhenRelocated: JsonValue | undefined;
    const openCode: SessionArchiveOnOpenCode = {
      setArchived: async (sessionID, archived) => {
        calls.push([sessionID, archived]);
        if (gone.includes(sessionID)) throw Object.assign(new Error('gone'), { name: 'LocationNotFoundError' });
        if (refused.includes(sessionID)) throw Object.assign(new Error('missing'), { name: 'SessionNotFoundError' });
      },
      relocate: async (sessionID, archived) => {
        if (!movable.includes(sessionID)) return false;
        relocated.push([sessionID, archived]);
        entryWhenRelocated = await readEntry(sessionID);
        return true;
      },
    };
    return { openCode, calls, relocated, entryWhenRelocated: () => entryWhenRelocated };
  };

  it('moves a session of a removed worktree to its project, archived on file before the move', async () => {
    const memory = createMemoryFs();
    const store = createSessionStateStore({ dataDir: '/data', fsPromises: memory.fsPromises, now: () => 1000 });
    const fake = fakeArchive({ gone: ['ses_wt', 'ses_orphan'], movable: ['ses_wt'], readEntry: async (id) => (await store.readArchived())?.[id] });

    assert.deepEqual(await store.archive(['ses_wt', 'ses_orphan'], null, fake.openCode), {
      archived: [{ id: 'ses_wt', archivedAt: 1000 }, { id: 'ses_orphan', archivedAt: 1000 }],
      failedIds: [],
    });
    assert.equal(fake.entryWhenRelocated(), 1000);
    assert.deepEqual(fake.relocated, [['ses_wt', true]]);
    // Only the session with no folder to move to stays on file.
    assert.deepEqual(await store.readArchived(), { ses_orphan: 1000 });

    const restoring = fakeArchive({ gone: ['ses_orphan'], movable: [] });
    assert.deepEqual(await store.unarchive(['ses_orphan'], restoring.openCode), { restored: [{ id: 'ses_orphan', archivedAt: null }], failedIds: [] });
    assert.deepEqual(await store.readArchived(), { ses_orphan: null });
  });

  it('archives on OpenCode and writes the file only for a session whose directory is gone', async () => {
    const memory = createMemoryFs();
    const store = createSessionStateStore({ dataDir: '/data', fsPromises: memory.fsPromises, now: () => 1000 });
    const { openCode, calls } = fakeArchive({ gone: ['ses_gone'], refused: ['ses_missing'] });
    // ses_gone has no project folder to move to, so it stays on file.

    assert.deepEqual(await store.archive(['ses_a', 'ses_gone', 'ses_missing', 'ses_a'], null, openCode), {
      archived: [{ id: 'ses_a', archivedAt: 1000 }, { id: 'ses_gone', archivedAt: 1000 }],
      failedIds: ['ses_missing'],
    });
    assert.deepEqual(calls, [['ses_a', true], ['ses_gone', true], ['ses_missing', true]]);
    assert.deepEqual(await store.readArchived(), { ses_gone: 1000 });
    // Every write went through a temp file that was renamed into place.
    assert.equal(memory.writes.every((filePath) => filePath.endsWith('.tmp')), true);

    assert.deepEqual(await store.unarchive(['ses_gone'], openCode), { restored: [{ id: 'ses_gone', archivedAt: null }], failedIds: [] });
    // The unarchive stays on file: it overrides an archived stamp OpenCode may carry.
    assert.deepEqual(await store.readArchived(), { ses_gone: null });
  });

  it('drops the entry of a session OpenCode now holds, and writes nothing when there is none', async () => {
    const memory = createMemoryFs({ [dataFile('sessions-archive.json')]: JSON.stringify({ ses_a: 500, ses_c: 2000 }) });
    const store = createSessionStateStore({ dataDir: '/data', fsPromises: memory.fsPromises, now: () => 1000 });
    const { openCode } = fakeArchive();

    await store.unarchive(['ses_a'], openCode);
    assert.deepEqual(await store.readArchived(), { ses_c: 2000 });
    const writes = memory.writes.length;
    await store.archive(['ses_b'], null, openCode);
    assert.equal(memory.writes.length, writes);
  });

  it('keeps OpenCode changes when the archive file cannot be read, and fails only the file\'s sessions', async () => {
    const memory = createMemoryFs();
    memory.fsPromises.readFile = async () => { throw new Error('EACCES'); };
    const store = createSessionStateStore({ dataDir: '/data', fsPromises: memory.fsPromises, now: () => 1000 });
    const { openCode } = fakeArchive({ gone: ['ses_gone'] });
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      assert.deepEqual(await store.archive(['ses_a', 'ses_gone'], null, openCode), {
        archived: [{ id: 'ses_a', archivedAt: 1000 }],
        failedIds: ['ses_gone'],
      });
    } finally {
      console.warn = warn;
    }
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

  it('serves turns that ended before the unread baseline as seen', () => {
    const list: JsonValue = {
      data: [
        { id: 'ses_old', time: { created: 1, idle: 100 } },
        { id: 'ses_new', time: { created: 1, idle: 900, viewed: 50 } },
      ],
    };
    assert.deepEqual(overlaySessionResponseBody(list, null, null, 500), {
      data: [
        { id: 'ses_old', time: { created: 1, idle: 100, viewed: 100 } },
        { id: 'ses_new', time: { created: 1, idle: 900, viewed: 50 } },
      ],
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
