import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createArchiveStore } from './archive-store.js';

const tempDirs = [];

const makeDataDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-archive-'));
  tempDirs.push(dir);
  return dir;
};

const readFile = (dataDir) => fs.readFileSync(path.join(dataDir, 'sessions-archive.json'), 'utf8');

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('createArchiveStore', () => {
  it('starts empty when the file does not exist', async () => {
    const store = createArchiveStore({ dataDir: makeDataDir() });
    await expect(store.getAll()).resolves.toEqual({});
    await expect(store.isArchived('ses_1')).resolves.toBe(false);
    await expect(store.archivedAt('ses_1')).resolves.toBeNull();
  });

  it('archives a batch, persists it, and reads it back in a fresh store', async () => {
    const dataDir = makeDataDir();
    const store = createArchiveStore({ dataDir, now: () => 1_700_000 });

    const result = await store.archive(['ses_1', 'ses_2']);
    expect(result).toEqual({
      archived: [
        { id: 'ses_1', archivedAt: 1_700_000 },
        { id: 'ses_2', archivedAt: 1_700_000 },
      ],
      failedIds: [],
    });
    expect(JSON.parse(readFile(dataDir))).toEqual({ ses_1: 1_700_000, ses_2: 1_700_000 });

    const reopened = createArchiveStore({ dataDir });
    await expect(reopened.getAll()).resolves.toEqual({ ses_1: 1_700_000, ses_2: 1_700_000 });
    await expect(reopened.isArchived('ses_2')).resolves.toBe(true);
  });

  it('honours an explicit archivedAt and ignores a nonsense one', async () => {
    const store = createArchiveStore({ dataDir: makeDataDir(), now: () => 42 });
    await expect(store.archive(['ses_1'], 999)).resolves.toMatchObject({
      archived: [{ id: 'ses_1', archivedAt: 999 }],
    });
    await expect(store.archive(['ses_2'], -5)).resolves.toMatchObject({
      archived: [{ id: 'ses_2', archivedAt: 42 }],
    });
  });

  it('unarchives a batch and records the explicit unarchive in the file', async () => {
    const dataDir = makeDataDir();
    const store = createArchiveStore({ dataDir, now: () => 1 });
    await store.archive(['ses_1', 'ses_2']);

    await expect(store.unarchive(['ses_1'])).resolves.toEqual({
      restored: [{ id: 'ses_1', archivedAt: null }],
      failedIds: [],
    });
    expect(JSON.parse(readFile(dataDir))).toEqual({ ses_1: null, ses_2: 1 });
    await expect(store.isArchived('ses_1')).resolves.toBe(false);
  });

  it('ignores blank ids and collapses duplicates', async () => {
    const store = createArchiveStore({ dataDir: makeDataDir(), now: () => 7 });
    const result = await store.archive(['ses_1', ' ses_1 ', '', '   ', null, 5]);
    expect(result.archived).toEqual([{ id: 'ses_1', archivedAt: 7 }]);
    await expect(store.archive([])).resolves.toEqual({ archived: [], failedIds: [] });
  });

  it('writes atomically: the final file never contains a partial payload', async () => {
    const dataDir = makeDataDir();
    const seen = [];
    const realRename = fs.promises.rename.bind(fs.promises);
    const fsPromises = {
      ...fs.promises,
      writeFile: async (target, payload, encoding) => {
        // The visible file must still be the previous one at this point.
        seen.push(fs.existsSync(path.join(dataDir, 'sessions-archive.json'))
          ? readFile(dataDir)
          : null);
        return fs.promises.writeFile(target, payload, encoding);
      },
      rename: realRename,
    };
    const store = createArchiveStore({ dataDir, fsPromises, now: () => 3 });

    await store.archive(['ses_1']);
    await store.archive(['ses_2']);

    expect(seen).toEqual([null, JSON.stringify({ ses_1: 3 })]);
    expect(JSON.parse(readFile(dataDir))).toEqual({ ses_1: 3, ses_2: 3 });
  });

  it('treats a malformed file as empty, keeps a backup, and still accepts writes', async () => {
    const dataDir = makeDataDir();
    fs.writeFileSync(path.join(dataDir, 'sessions-archive.json'), '{ not json', 'utf8');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const store = createArchiveStore({ dataDir, now: () => 11 });
    await expect(store.getAll()).resolves.toEqual({});
    await expect(store.archive(['ses_1'])).resolves.toMatchObject({ failedIds: [] });
    expect(JSON.parse(readFile(dataDir))).toEqual({ ses_1: 11 });
    expect(fs.readdirSync(dataDir).some((name) => name.includes('sessions-archive.json.'))).toBe(true);
  });

  it('drops entries that are not positive timestamps', async () => {
    const dataDir = makeDataDir();
    fs.writeFileSync(
      path.join(dataDir, 'sessions-archive.json'),
      JSON.stringify({ ses_ok: 5, ses_zero: 0, ses_text: 'yesterday', ses_float: 1.5 }),
      'utf8',
    );
    const store = createArchiveStore({ dataDir });
    await expect(store.getAll()).resolves.toEqual({ ses_ok: 5 });
  });

  it('refuses to write when the file could not be read, so unknown state is never overwritten', async () => {
    const dataDir = makeDataDir();
    fs.writeFileSync(path.join(dataDir, 'sessions-archive.json'), '{}', 'utf8');
    const unreadable = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const fsPromises = {
      ...fs.promises,
      readFile: async () => { throw unreadable; },
      writeFile: async () => { throw new Error('must not write'); },
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const store = createArchiveStore({ dataDir, fsPromises });
    await expect(store.archive(['ses_1'])).resolves.toEqual({ archived: [], failedIds: ['ses_1'] });
    expect(readFile(dataDir)).toBe('{}');
  });

  it('rolls memory back when persisting fails', async () => {
    const dataDir = makeDataDir();
    const fsPromises = {
      ...fs.promises,
      writeFile: async () => { throw new Error('disk full'); },
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const store = createArchiveStore({ dataDir, fsPromises, now: () => 1 });
    await expect(store.archive(['ses_1'])).resolves.toEqual({ archived: [], failedIds: ['ses_1'] });
    await expect(store.isArchived('ses_1')).resolves.toBe(false);
  });

  it('keeps a later successful batch when an earlier one fails and rolls back', async () => {
    const dataDir = makeDataDir();
    let failNext = true;
    let releaseFailure;
    const failureReleased = new Promise((resolve) => { releaseFailure = resolve; });
    const fsPromises = {
      ...fs.promises,
      writeFile: async (...args) => {
        if (failNext) {
          failNext = false;
          await failureReleased;
          throw new Error('disk full');
        }
        return fs.promises.writeFile(...args);
      },
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createArchiveStore({ dataDir, fsPromises, now: () => 1 });

    const failing = store.archive(['ses_1'], 10);
    const succeeding = store.archive(['ses_1'], 20);
    releaseFailure();

    await expect(failing).resolves.toEqual({ archived: [], failedIds: ['ses_1'] });
    await expect(succeeding).resolves.toEqual({ archived: [{ id: 'ses_1', archivedAt: 20 }], failedIds: [] });
    // The failed batch's rollback must not undo what the later batch committed.
    await expect(store.archivedAt('ses_1')).resolves.toBe(20);
    expect(JSON.parse(readFile(dataDir))).toEqual({ ses_1: 20 });
  });
});
