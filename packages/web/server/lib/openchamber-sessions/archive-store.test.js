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
const writeFile = (dataDir, entries) => fs.writeFileSync(path.join(dataDir, 'sessions-archive.json'), JSON.stringify(entries), 'utf8');

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
    await expect(store.entry('ses_1')).resolves.toBeUndefined();
  });

  it('tells an archive from an explicit unarchive and from a session it does not mention', async () => {
    const dataDir = makeDataDir();
    writeFile(dataDir, { ses_1: 7, ses_3: null });
    const store = createArchiveStore({ dataDir });

    await expect(store.getAll()).resolves.toEqual({ ses_1: 7, ses_3: null });
    await expect(store.entry('ses_1')).resolves.toBe(7);
    await expect(store.entry('ses_3')).resolves.toBeNull();
    await expect(store.entry('ses_4')).resolves.toBeUndefined();
  });

  it('drops entries that are not positive timestamps', async () => {
    const dataDir = makeDataDir();
    writeFile(dataDir, { ses_ok: 5, ses_zero: 0, ses_text: 'yesterday', ses_float: 1.5 });
    const store = createArchiveStore({ dataDir });
    await expect(store.getAll()).resolves.toEqual({ ses_ok: 5 });
  });

  it('treats a malformed file as empty and keeps a backup', async () => {
    const dataDir = makeDataDir();
    fs.writeFileSync(path.join(dataDir, 'sessions-archive.json'), '{ not json', 'utf8');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const store = createArchiveStore({ dataDir, now: () => 11 });
    await expect(store.getAll()).resolves.toEqual({});
    expect(fs.existsSync(path.join(dataDir, 'sessions-archive.json.corrupt-11'))).toBe(true);
  });

  it('forgets entries, ignoring blank and duplicate ids, and the file keeps the rest', async () => {
    const dataDir = makeDataDir();
    writeFile(dataDir, { ses_1: 7, ses_2: 7, ses_3: null });
    const store = createArchiveStore({ dataDir });

    await expect(store.forget(['ses_1', ' ses_1 ', '', null, 'ses_3', 'ses_4'])).resolves.toEqual({ failedIds: [] });
    expect(JSON.parse(readFile(dataDir))).toEqual({ ses_2: 7 });
    await expect(createArchiveStore({ dataDir }).getAll()).resolves.toEqual({ ses_2: 7 });
  });

  it('writes atomically: the visible file is the previous one until the rename', async () => {
    const dataDir = makeDataDir();
    writeFile(dataDir, { ses_1: 3, ses_2: 3 });
    const seen = [];
    const fsPromises = {
      ...fs.promises,
      writeFile: async (target, payload, encoding) => {
        seen.push(readFile(dataDir));
        return fs.promises.writeFile(target, payload, encoding);
      },
    };
    const store = createArchiveStore({ dataDir, fsPromises });

    await store.forget(['ses_1']);

    expect(seen).toEqual([JSON.stringify({ ses_1: 3, ses_2: 3 })]);
    expect(JSON.parse(readFile(dataDir))).toEqual({ ses_2: 3 });
  });

  it('refuses to write when the file could not be read, so unknown state is never overwritten', async () => {
    const dataDir = makeDataDir();
    writeFile(dataDir, { ses_1: 1 });
    const unreadable = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const fsPromises = {
      ...fs.promises,
      readFile: async () => { throw unreadable; },
      writeFile: async () => { throw new Error('must not write'); },
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const store = createArchiveStore({ dataDir, fsPromises });
    await expect(store.forget(['ses_1'])).resolves.toEqual({ failedIds: [] });
    expect(JSON.parse(readFile(dataDir))).toEqual({ ses_1: 1 });
  });

  it('writes nothing to forget a session it does not hold, and restores entries when the write fails', async () => {
    const dataDir = makeDataDir();
    writeFile(dataDir, { ses_1: 7 });
    const store = createArchiveStore({ dataDir });
    await store.getAll();
    const writeSpy = vi.spyOn(fs.promises, 'writeFile');
    await expect(store.forget(['ses_9'])).resolves.toEqual({ failedIds: [] });
    expect(writeSpy).not.toHaveBeenCalled();

    writeSpy.mockRejectedValueOnce(new Error('disk full'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(store.forget(['ses_1'])).resolves.toEqual({ failedIds: ['ses_1'] });
    await expect(store.entry('ses_1')).resolves.toBe(7);
  });
});
