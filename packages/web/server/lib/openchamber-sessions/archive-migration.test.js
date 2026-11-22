import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createArchiveStore } from './archive-store.js';
import { createSessionArchive } from './session-archive.js';
import { createArchiveMigration, MIGRATED_ARCHIVE_FILE_NAME } from './archive-migration.js';

// Oracle: the archive file as written (the ids and their kind, archived or
// explicitly restored) against the state a fake OpenCode holds afterwards.
// The fake follows OpenCode's archive API as 2.3.x serves it: update with
// archived true/false stamps or clears time.archived, a session it does not
// have answers SessionNotFoundError, and a read returns time.archived.

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.chmodSync(dir, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

const archiveFile = (entries) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-archive-migration-'));
  tempDirs.push(dataDir);
  const filePath = path.join(dataDir, 'sessions-archive.json');
  if (entries !== undefined) fs.writeFileSync(filePath, typeof entries === 'string' ? entries : JSON.stringify(entries));
  return { dataDir, filePath };
};

/** A store over the file that counts the times it replaces the file. */
const openStore = (dataDir) => {
  let writes = 0;
  const fsPromises = { ...fs.promises, rename: async (...args) => { writes += 1; return fs.promises.rename(...args); } };
  return { store: createArchiveStore({ dataDir, fsPromises }), writes: () => writes };
};

const tagged = (tag) => Object.assign(new Error(tag), { _tag: tag });

const fakeOpenCode = ({ sessions, failFor = () => null, applies = true, takesTime = false } = {}) => {
  const archivedAt = new Map(sessions.map((id) => [id, null]));
  let clock = 1_000;
  const openCode = {
    archivedAt,
    setArchived: vi.fn(async (id, archived) => {
      const failure = failFor(id);
      if (failure) throw tagged(failure);
      if (!archivedAt.has(id)) throw tagged('SessionNotFoundError');
      if (applies) archivedAt.set(id, archived ? (clock += 1) : null);
    }),
    readArchivedAt: vi.fn(async (id) => (archivedAt.has(id) ? archivedAt.get(id) : undefined)),
  };
  // archiveAt as OpenCode with #2686 serves it (takesTime) or as an older one that ignores the time.
  openCode.archiveAt = vi.fn(async (id, at) => {
    const failure = failFor(id);
    if (failure) throw tagged(failure);
    if (!archivedAt.has(id)) throw tagged('SessionNotFoundError');
    if (archivedAt.get(id) !== null) return;
    if (applies) archivedAt.set(id, takesTime ? at : (clock += 1));
  });
  return openCode;
};

const idsOf = (count, prefix = 'ses_') => Array.from({ length: count }, (_, index) => `${prefix}${String(index).padStart(6, '0')}`);
const fileOf = (ids, value = (index) => 1_700_000_000_000 + index) => Object.fromEntries(ids.map((id, index) => [id, value(index)]));
const archivedIn = (openCode) => [...openCode.archivedAt].filter(([, at]) => at !== null).map(([id]) => id);

describe('archive migration into OpenCode', () => {
  it('carries every archived id into OpenCode, restores explicit unarchives, and empties the file in batched writes', async () => {
    const archived = idsOf(2_000);
    const restored = idsOf(5, 'ses_restored_');
    const { dataDir, filePath } = archiveFile({ ...fileOf(archived), ...Object.fromEntries(restored.map((id) => [id, null])) });
    const openCode = fakeOpenCode({ sessions: [...archived, ...restored] });
    for (const id of restored) openCode.archivedAt.set(id, 5);
    const { store, writes } = openStore(dataDir);

    await expect(createSessionArchive({ store, openCode }).migrateLegacy()).resolves.toBe(0);

    expect(archivedIn(openCode).sort()).toEqual(archived);
    expect(restored.map((id) => openCode.archivedAt.get(id))).toEqual(restored.map(() => null));
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({});
    // One write per 250 confirmed entries plus the tail, never one per session.
    expect(writes()).toBeLessThanOrEqual(Math.ceil(2_005 / 250) + 6);
  });

  it('is idempotent across restarts: a second start pushes nothing and changes nothing', async () => {
    const ids = idsOf(300);
    const { dataDir } = archiveFile(fileOf(ids));
    const openCode = fakeOpenCode({ sessions: ids });
    await createSessionArchive({ store: openStore(dataDir).store, openCode }).migrateLegacy();
    const after = new Map(openCode.archivedAt);
    openCode.setArchived.mockClear();
    openCode.archiveAt.mockClear();

    await expect(createSessionArchive({ store: openStore(dataDir).store, openCode }).migrateLegacy()).resolves.toBe(0);

    expect(openCode.setArchived).not.toHaveBeenCalled();
    expect(openCode.archiveAt).not.toHaveBeenCalled();
    expect(openCode.archivedAt).toEqual(after);
  });

  it('keeps what OpenCode refused, retries it once in the same run, and finishes on the next start', async () => {
    const ids = idsOf(600);
    const { dataDir, filePath } = archiveFile(fileOf(ids));
    const attempts = new Map();
    const down = new Set(ids.slice(100, 200));
    const flaky = new Set(ids.slice(300, 320));
    const openCode = fakeOpenCode({
      sessions: ids,
      failFor: (id) => {
        attempts.set(id, (attempts.get(id) ?? 0) + 1);
        if (down.has(id)) return 'UnknownError';
        return flaky.has(id) && attempts.get(id) === 1 ? 'UnknownError' : null;
      },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(createSessionArchive({ store: openStore(dataDir).store, openCode }).migrateLegacy()).resolves.toBe(100);
    // The flaky twenty landed on the in-run retry; the hundred that stayed down are still in the file, with their stamps.
    expect([...flaky].every((id) => openCode.archivedAt.get(id) !== null)).toBe(true);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual(fileOf(ids.slice(100, 200), (index) => 1_700_000_000_100 + index));

    down.clear();
    await expect(createSessionArchive({ store: openStore(dataDir).store, openCode }).migrateLegacy()).resolves.toBe(0);
    expect(archivedIn(openCode)).toHaveLength(600);
  });

  it('finishes after a restart in the middle of a run without losing an entry', async () => {
    const ids = idsOf(900);
    const { dataDir } = archiveFile(fileOf(ids));
    let calls = 0;
    // OpenCode goes away after 400 updates, as if the server stopped mid-run.
    const openCode = fakeOpenCode({ sessions: ids, failFor: () => ((calls += 1) > 400 ? 'ConnectionRefused' : null) });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const leftAfterFirst = await createSessionArchive({ store: openStore(dataDir).store, openCode }).migrateLegacy();
    expect(leftAfterFirst).toBeGreaterThan(0);
    expect(archivedIn(openCode).length + leftAfterFirst).toBe(900);

    calls = -Infinity;
    await expect(createSessionArchive({ store: openStore(dataDir).store, openCode }).migrateLegacy()).resolves.toBe(0);
    expect(archivedIn(openCode)).toHaveLength(900);
  });

  it('keeps an entry OpenCode accepts but does not apply, as OpenCode 2.0.x did', async () => {
    const ids = idsOf(50);
    const { dataDir, filePath } = archiveFile(fileOf(ids));
    const before = fs.readFileSync(filePath, 'utf8');
    const openCode = fakeOpenCode({ sessions: ids, applies: false });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(createSessionArchive({ store: openStore(dataDir).store, openCode }).migrateLegacy()).resolves.toBe(50);

    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
  });

  it('forgets an entry only once OpenCode says the session does not exist', async () => {
    const present = idsOf(40);
    const gone = idsOf(10, 'ses_deleted_');
    const { dataDir, filePath } = archiveFile({ ...fileOf(present), ...fileOf(gone) });
    const openCode = fakeOpenCode({ sessions: present });

    await expect(createSessionArchive({ store: openStore(dataDir).store, openCode }).migrateLegacy()).resolves.toBe(0);

    expect(archivedIn(openCode)).toHaveLength(40);
    expect(gone.every((id) => !openCode.archivedAt.has(id))).toBe(true);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({});
  });

  it('unarchives nothing and pushes nothing when the file cannot be read', async () => {
    const ids = idsOf(30);
    const { dataDir, filePath } = archiveFile(fileOf(ids));
    const before = fs.readFileSync(filePath, 'utf8');
    fs.chmodSync(filePath, 0o000);
    const openCode = fakeOpenCode({ sessions: ids });
    for (const id of ids) openCode.archivedAt.set(id, 7);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await createSessionArchive({ store: openStore(dataDir).store, openCode }).migrateLegacy();

    expect(openCode.setArchived).not.toHaveBeenCalled();
    expect(openCode.archiveAt).not.toHaveBeenCalled();
    fs.chmodSync(filePath, 0o644);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
  });

  it('pushes nothing for a malformed file and keeps its bytes aside', async () => {
    const { dataDir } = archiveFile('{"ses_a": 17000');
    const openCode = fakeOpenCode({ sessions: ['ses_a'] });
    openCode.archivedAt.set('ses_a', 9);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await createSessionArchive({ store: openStore(dataDir).store, openCode }).migrateLegacy();

    expect(openCode.setArchived).not.toHaveBeenCalled();
    expect(openCode.archiveAt).not.toHaveBeenCalled();
    expect(openCode.archivedAt.get('ses_a')).toBe(9);
    const kept = fs.readdirSync(dataDir).filter((name) => name !== 'sessions-archive.json');
    expect(kept.map((name) => fs.readFileSync(path.join(dataDir, name), 'utf8'))).toContain('{"ses_a": 17000');
  });
  it('keeps the original file read-only beside it before forgetting anything, and never replaces that copy', async () => {
    const ids = idsOf(400);
    const { dataDir, filePath } = archiveFile(fileOf(ids));
    const original = fs.readFileSync(filePath, 'utf8');
    const copyPath = path.join(dataDir, MIGRATED_ARCHIVE_FILE_NAME);
    const openCode = fakeOpenCode({ sessions: [...ids, 'ses_later'] });

    await createSessionArchive({ store: openStore(dataDir).store, openCode }).migrateLegacy();
    expect(fs.readFileSync(copyPath, 'utf8')).toBe(original);
    expect(fs.statSync(copyPath).mode & 0o777).toBe(0o444);

    // A later start with a different file keeps the first copy, the one with the original times.
    fs.writeFileSync(filePath, JSON.stringify({ ses_later: 1_800_000_000_000 }));
    await createSessionArchive({ store: openStore(dataDir).store, openCode }).migrateLegacy();
    expect(fs.readFileSync(copyPath, 'utf8')).toBe(original);
    expect(JSON.parse(fs.readFileSync(copyPath, 'utf8'))).toEqual(fileOf(ids));
  });

  it('pushes and forgets nothing when the copy cannot be written', async () => {
    const ids = idsOf(20);
    const { dataDir, filePath } = archiveFile(fileOf(ids));
    const before = fs.readFileSync(filePath, 'utf8');
    const openCode = fakeOpenCode({ sessions: ids });
    const store = openStore(dataDir).store;
    const fsPromises = { ...fs.promises, writeFile: async () => { throw Object.assign(new Error('read-only volume'), { code: 'EROFS' }); } };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const migrate = createArchiveMigration({ store, openCode, runForSession: (_id, work) => work(), fsPromises });

    await expect(migrate()).resolves.toMatchObject({ remaining: 20, confirmed: 0 });

    expect(openCode.setArchived).not.toHaveBeenCalled();
    expect(openCode.archiveAt).not.toHaveBeenCalled();
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(dataDir, MIGRATED_ARCHIVE_FILE_NAME))).toBe(false);
  });
  it('archives each session at its original time where OpenCode takes one, so the archive view keeps its order', async () => {
    const ids = idsOf(500);
    // Original times out of id order, as in a real archive.
    const original = fileOf(ids, (index) => 1_700_000_000_000 + ((index * 7919) % 500) * 60_000);
    const restored = idsOf(3, 'ses_restored_');
    const { dataDir } = archiveFile({ ...original, ...Object.fromEntries(restored.map((id) => [id, null])) });
    const openCode = fakeOpenCode({ sessions: [...ids, ...restored], takesTime: true });
    for (const id of restored) openCode.archivedAt.set(id, 9);
    const migrate = createArchiveMigration({ store: openStore(dataDir).store, openCode, runForSession: (_id, work) => work() });

    // An explicit unarchive is confirmed as restored and never counted as a kept time.
    await expect(migrate()).resolves.toMatchObject({ remaining: 0, confirmed: 503, timeKept: 500 });

    for (const id of restored) openCode.archivedAt.delete(id);
    expect(Object.fromEntries(openCode.archivedAt)).toEqual(original);
    // The archive view sorts by time.archived, newest first (ArchiveView.tsx sortedSessions).
    const byArchived = (times) => Object.entries(times).sort(([, a], [, b]) => b - a).map(([id]) => id);
    expect(byArchived(Object.fromEntries(openCode.archivedAt))).toEqual(byArchived(original));
  });

  it('still archives through an OpenCode that ignores the time, and says the times were not kept', async () => {
    const ids = idsOf(30);
    const { dataDir } = archiveFile(fileOf(ids));
    const openCode = fakeOpenCode({ sessions: ids, takesTime: false });
    const migrate = createArchiveMigration({ store: openStore(dataDir).store, openCode, runForSession: (_id, work) => work() });

    await expect(migrate()).resolves.toMatchObject({ remaining: 0, confirmed: 30, timeKept: 0 });
    expect(archivedIn(openCode)).toHaveLength(30);
  });
});
