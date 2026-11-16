import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createArchiveStore } from './archive-store.js';
import { createOpenCodeClient } from './opencode-client.js';
import { createOpenCodeSessionArchive, createSessionArchive } from './session-archive.js';

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
  vi.unstubAllGlobals();
});

const tagged = (tag) => Object.assign(new Error(tag), { _tag: tag });

/**
 * OpenCode as `session-archive.js` sees it: `failures` maps a session to an
 * error tag for every call.
 */
const fakeOpenCode = ({ failures = {}, archived = {} } = {}) => {
  const state = { ...archived };
  const log = [];
  return {
    state,
    log,
    setArchived: vi.fn(async (id, value) => {
      if (failures[id]) throw tagged(failures[id]);
      log.push(['set', id, value]);
      state[id] = value ? 1 : null;
    }),
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

  it('keeps the file entry when OpenCode refuses, and reports the session failed', async () => {
    const store = makeStore({ ses_a: 500 });
    const announce = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const archive = createSessionArchive({ store, openCode: fakeOpenCode({ failures: { ses_a: 'UnknownError' } }), announce });

    await expect(archive.unarchive(['ses_a'])).resolves.toEqual({ restored: [], failedIds: ['ses_a'] });
    await expect(store.getAll()).resolves.toEqual({ ses_a: 500 });
    expect(announce).not.toHaveBeenCalled();
  });

  it('migrates the legacy file in one pass and keeps what failed for the next start', async () => {
    const store = makeStore({ ses_live: 100, ses_restored: null, ses_missing: 400, ses_flaky: 500 });
    const openCode = fakeOpenCode({ failures: { ses_missing: 'SessionNotFoundError', ses_flaky: 'UnknownError' } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const archive = createSessionArchive({ store, openCode });

    await expect(archive.migrateLegacy()).resolves.toBe(1);

    expect(openCode.log).toEqual(expect.arrayContaining([
      ['set', 'ses_live', true],
      ['set', 'ses_restored', false],
    ]));
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

  it('tells archived, active and unknown apart for a caller that would wake the session', async () => {
    const store = makeStore({ ses_file: 500, ses_restored: null });
    const openCode = fakeOpenCode({ archived: { ses_upstream: 900, ses_active: null }, failures: { ses_down: 'Unavailable' } });
    const archive = createSessionArchive({ store, openCode });
    const { signal } = new AbortController();

    await expect(archive.archiveState('ses_file')).resolves.toBe('archived');
    await expect(archive.archiveState('ses_restored')).resolves.toBe('active');
    await expect(archive.archiveState('ses_upstream', { signal })).resolves.toBe('archived');
    await expect(archive.archiveState('ses_active')).resolves.toBe('active');
    // OpenCode does not know it: nothing to wake, the delivery hears 404.
    await expect(archive.archiveState('ses_unknown')).resolves.toBe('active');
    await expect(archive.archiveState('ses_down')).resolves.toBe('unknown');
    expect(openCode.readArchivedAt).toHaveBeenCalledWith('ses_upstream', { signal });
  });

  it('cancels a stalled OpenCode read through the caller\'s signal, and calls it unknown', async () => {
    const entered = Promise.withResolvers();
    vi.stubGlobal('fetch', vi.fn(async (_input, init) => {
      entered.resolve(init.signal);
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    }));
    const archive = createSessionArchive({
      store: makeStore(),
      openCode: createOpenCodeSessionArchive({ clientFor: () => createOpenCodeClient({ baseUrl: 'http://opencode.test', headers: {} }) }),
    });
    const controller = new AbortController();
    const state = archive.archiveState('ses_hanging', { signal: controller.signal });
    const signal = await entered.promise;
    controller.abort(new DOMException('Archive read timed out', 'TimeoutError'));
    await expect(state).resolves.toBe('unknown');
    expect(signal.aborted).toBe(true);
  });
});
