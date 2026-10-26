import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createArchiveStore } from './archive-store.js';
import { createSessionArchive } from './session-archive.js';

const tempDirs = [];

const makeStore = (entries) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-session-archive-'));
  tempDirs.push(dataDir);
  if (entries) fs.writeFileSync(path.join(dataDir, 'sessions-archive.json'), JSON.stringify(entries));
  return createArchiveStore({ dataDir });
};

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  vi.restoreAllMocks();
});

const tagged = (tag) => Object.assign(new Error(tag), { _tag: tag });

/**
 * OpenCode as `session-archive.js` sees it. Sessions live in `/live` (running)
 * unless `places` says otherwise; a session in a `deleted` directory answers
 * LocationNotFoundError until it moves; `failures` maps a session to an error
 * tag for every call; project `proj` has its main folder at `/repo`.
 */
const fakeOpenCode = ({ failures = {}, archived = {}, places = {}, deleted = [], loaded = ['/live'], folders = { proj: '/repo' } } = {}) => {
  const state = { ...archived };
  const where = new Map(Object.entries(places));
  const log = [];
  const placeOf = (id) => where.get(id) ?? { directory: '/live', projectID: 'proj' };
  return {
    state,
    log,
    setArchived: vi.fn(async (id, value) => {
      if (failures[id]) throw tagged(failures[id]);
      if (deleted.includes(placeOf(id).directory)) throw tagged('LocationNotFoundError');
      log.push(['set', id, value]);
      state[id] = value ? 1 : null;
    }),
    move: vi.fn(async (id, directory) => {
      log.push(['move', id, directory]);
      where.set(id, { ...placeOf(id), directory });
    }),
    unload: vi.fn(async () => undefined),
    listLoadedDirectories: vi.fn(async () => loaded),
    readProjectFolders: vi.fn(async () => new Map(Object.entries(folders))),
    readPlace: vi.fn(async (id) => (failures[id] === 'SessionNotFoundError' ? undefined : placeOf(id))),
    readArchivedAt: vi.fn(async (id) => {
      if (failures[id] === 'Unavailable') throw tagged('Unavailable');
      return id in state ? state[id] : undefined;
    }),
  };
};

describe('session archive', () => {
  it('archives on OpenCode and stays quiet when the file had nothing to say', async () => {
    const store = makeStore();
    const announce = vi.fn();
    const openCode = fakeOpenCode();
    const archive = createSessionArchive({ store, openCode, announce });

    await expect(archive.archive(['ses_a'], 1700)).resolves.toEqual({ archived: [{ id: 'ses_a', archivedAt: 1700 }], failedIds: [] });
    expect(openCode.state.ses_a).toBe(1);
    expect(announce).not.toHaveBeenCalled();
  });

  it('announces a restore that only drops a file entry, since OpenCode has nothing to announce', async () => {
    const store = makeStore({ ses_a: 500 });
    const announce = vi.fn();
    const archive = createSessionArchive({ store, openCode: fakeOpenCode(), announce });

    await archive.unarchive(['ses_a']);
    await expect(store.getAll()).resolves.toEqual({});
    expect(announce.mock.calls).toEqual([['ses_a', null]]);
  });

  it('archives a session of a removed worktree in the file first, then moves it to the project folder', async () => {
    const store = makeStore();
    const announce = vi.fn();
    const openCode = fakeOpenCode({ places: { ses_wt: { directory: '/repo-wt', projectID: 'proj' } }, deleted: ['/repo-wt'] });
    let entryWhenMoved;
    openCode.move.mockImplementation(async (id, directory) => {
      entryWhenMoved = await store.entry(id);
      openCode.log.push(['move', id, directory]);
    });
    openCode.readPlace.mockImplementation(async () => ({ directory: '/repo-wt', projectID: 'proj' }));
    openCode.setArchived.mockImplementation(async (id, value) => {
      // Fails in the deleted folder until the move happened.
      if (!openCode.log.some(([kind]) => kind === 'move')) throw tagged('LocationNotFoundError');
      openCode.state[id] = value ? 1 : null;
    });
    const archive = createSessionArchive({ store, openCode, announce });

    await expect(archive.archive(['ses_wt'], 1700)).resolves.toEqual({ archived: [{ id: 'ses_wt', archivedAt: 1700 }], failedIds: [] });

    // Archived on screen before OpenCode announced the move.
    expect(entryWhenMoved).toBe(1700);
    expect(announce.mock.calls).toEqual([['ses_wt', 1700]]);
    expect(openCode.move).toHaveBeenCalledWith('ses_wt', '/repo');
    expect(openCode.state.ses_wt).toBe(1);
    await expect(store.getAll()).resolves.toEqual({});
  });

  it('restores a session of a removed worktree in the project folder, or in the file when there is none', async () => {
    const store = makeStore({ ses_wt: 500, ses_orphan: 600 });
    const announce = vi.fn();
    const openCode = fakeOpenCode({
      places: { ses_wt: { directory: '/repo-wt', projectID: 'proj' }, ses_orphan: { directory: '/gone', projectID: 'gone_proj' } },
      deleted: ['/repo-wt', '/gone'],
    });
    const archive = createSessionArchive({ store, openCode, announce });

    await expect(archive.unarchive(['ses_wt', 'ses_orphan'])).resolves.toEqual({
      restored: [{ id: 'ses_wt', archivedAt: null }, { id: 'ses_orphan', archivedAt: null }],
      failedIds: [],
    });
    expect(openCode.log).toContainEqual(['move', 'ses_wt', '/repo']);
    expect(openCode.log).toContainEqual(['set', 'ses_wt', false]);
    await expect(store.getAll()).resolves.toEqual({ ses_orphan: null });
    expect(announce.mock.calls).toEqual(expect.arrayContaining([['ses_wt', null], ['ses_orphan', null]]));
  });

  it('migrates the legacy file in one pass and unloads what it started', async () => {
    const store = makeStore({ ses_live: 100, ses_restored: null, ses_closed: 200, ses_wt: 300, ses_missing: 400, ses_flaky: 500 });
    const openCode = fakeOpenCode({
      places: {
        ses_closed: { directory: '/closed', projectID: 'proj' },
        ses_wt: { directory: '/repo-wt', projectID: 'proj' },
      },
      deleted: ['/repo-wt'],
      failures: { ses_missing: 'SessionNotFoundError', ses_flaky: 'UnknownError' },
      loaded: ['/live'],
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const archive = createSessionArchive({ store, openCode });

    await expect(archive.migrateLegacy()).resolves.toBe(1);

    expect(openCode.log).toEqual(expect.arrayContaining([
      ['set', 'ses_live', true],
      ['set', 'ses_restored', false],
      ['set', 'ses_closed', true],
      ['move', 'ses_wt', '/repo'],
      ['set', 'ses_wt', true],
    ]));
    // `/closed` and `/repo` were started by the pass; `/live` was running before.
    expect(openCode.unload.mock.calls.map(([directory]) => directory).sort()).toEqual(['/closed', '/repo']);
    await expect(store.getAll()).resolves.toEqual({ ses_flaky: 500 });
  });

  it('does not let a migration push land after the user changed the session', async () => {
    const store = makeStore({ ses_a: 100 });
    let release;
    const openCode = fakeOpenCode();
    openCode.setArchived.mockImplementationOnce(async (id, value) => {
      await new Promise((resolve) => { release = resolve; });
      openCode.state[id] = value ? 1 : null;
    });
    const archive = createSessionArchive({ store, openCode });

    const restoring = archive.unarchive(['ses_a']);
    const migrating = archive.migrateLegacy();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    await expect(restoring).resolves.toEqual({ restored: [{ id: 'ses_a', archivedAt: null }], failedIds: [] });
    await expect(migrating).resolves.toBe(0);

    // The migration found the entry gone and pushed nothing of its own.
    expect(openCode.setArchived.mock.calls).toEqual([['ses_a', false]]);
    expect(openCode.state.ses_a).toBeNull();
  });

  it('answers from the file first, then OpenCode, and calls an unknown answer active', async () => {
    const store = makeStore({ ses_file: 500, ses_restored: null });
    const openCode = fakeOpenCode({ archived: { ses_upstream: 900, ses_restored: 800 }, failures: { ses_down: 'Unavailable' } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const archive = createSessionArchive({ store, openCode });

    await expect(archive.archivedAt('ses_file')).resolves.toBe(500);
    await expect(archive.archivedAt('ses_restored')).resolves.toBeNull();
    await expect(archive.archivedAt('ses_upstream')).resolves.toBe(900);
    await expect(archive.isArchived('ses_unknown')).resolves.toBe(false);
    await expect(archive.isArchived('ses_down')).resolves.toBe(false);
    expect(openCode.readArchivedAt).not.toHaveBeenCalledWith('ses_file');
  });
});
