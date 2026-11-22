import { describe, expect, it, vi } from 'vitest';

import {
  createIdleSessionReaper,
  IDLE_SESSION_MAX_AGE_MS,
  IDLE_SESSION_SWEEP_INTERVAL_MS,
} from './idle-session-reaper.js';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

/** In-memory archive store honouring the real store's contract: a failed batch applies nothing. */
const makeArchiveStore = ({ fail = false } = {}) => {
  const archived = new Map();
  return {
    archived,
    archive: vi.fn(async (ids) => {
      if (fail) return { archived: [], failedIds: [...ids] };
      const stamp = NOW;
      for (const id of ids) archived.set(id, stamp);
      return { archived: ids.map((id) => ({ id, archivedAt: stamp })), failedIds: [] };
    }),
  };
};

const session = (id, { status = 'idle', updated = NOW - 3 * HOUR, created = NOW - 4 * HOUR, archived = undefined } = {}) => {
  const record = { id, status, time: { created, updated } };
  if (archived !== undefined) record.time.archived = archived;
  return record;
};

const makeReaper = ({ sessions, store = makeArchiveStore(), ...rest } = {}) =>
  createIdleSessionReaper({
    archiveStore: store,
    listSessions: async () => sessions,
    now: () => NOW,
    log: () => {},
    ...rest,
  });

describe('createIdleSessionReaper', () => {
  it('archives a finished idle session older than the threshold', async () => {
    const store = makeArchiveStore();
    const reaper = makeReaper({ sessions: [session('ses_old')], store });

    const result = await reaper.sweep();

    expect(result).toEqual({ skipped: null, liveIdle: 1, reaped: ['ses_old'], failedIds: [] });
    expect(store.archived.has('ses_old')).toBe(true);
  });

  it('never reaps a session the user pinned or marked In work', async () => {
    const store = makeArchiveStore();
    const pinned = session('ses_pinned');
    pinned.metadata = { openchamber: { pinned: { at: NOW - HOUR } } };
    const inWork = session('ses_work');
    inWork.metadata = { openchamber: { work: { state: 'open', openedAt: NOW - HOUR } } };
    const doneWork = session('ses_done_work');
    doneWork.metadata = { openchamber: { work: { state: 'done', openedAt: NOW - 4 * HOUR, doneAt: NOW - 3 * HOUR } } };
    const reaper = makeReaper({ sessions: [pinned, inWork, doneWork], store });

    const result = await reaper.sweep();

    expect(result.reaped).toEqual(['ses_done_work']);
    expect(store.archived.has('ses_pinned')).toBe(false);
    expect(store.archived.has('ses_work')).toBe(false);
  });

  it('keeps linked btw and review sessions live while reaping a plain idle session', async () => {
    const store = makeArchiveStore();
    const btwFork = session('ses_btw_fork');
    btwFork.metadata = { openchamber: { kind: 'btw', originalSessionID: 'ses_btw_parent' } };
    const btwParent = session('ses_btw_parent');
    btwParent.metadata = { openchamber: { btwSessionID: 'ses_btw_fork' } };
    const reviewFork = session('ses_review_fork');
    reviewFork.metadata = { openchamber: { kind: 'review', originalSessionID: 'ses_review_parent' } };
    const reviewParent = session('ses_review_parent');
    reviewParent.metadata = { openchamber: { reviewSessionID: 'ses_review_fork' } };
    const plain = session('ses_plain');
    const reaper = makeReaper({ sessions: [btwFork, btwParent, reviewFork, reviewParent, plain], store });

    const result = await reaper.sweep();

    expect(result.reaped).toEqual(['ses_plain']);
    expect(store.archived.has('ses_btw_fork')).toBe(false);
    expect(store.archived.has('ses_btw_parent')).toBe(false);
    expect(store.archived.has('ses_review_fork')).toBe(false);
    expect(store.archived.has('ses_review_parent')).toBe(false);
    expect(store.archived.has('ses_plain')).toBe(true);
  });

  it('never reaps a session an enabled scheduled task targets', async () => {
    const store = makeArchiveStore();
    const reaper = makeReaper({
      sessions: [session('ses_target'), session('ses_plain')],
      store,
      getProtectedSessionIds: async () => new Set(['ses_target']),
    });

    const result = await reaper.sweep();

    expect(result.reaped).toEqual(['ses_plain']);
    expect(store.archived.has('ses_target')).toBe(false);
  });

  it('reaps nothing when the protected set cannot be read', async () => {
    const store = makeArchiveStore();
    const reaper = makeReaper({
      sessions: [session('ses_old')],
      store,
      getProtectedSessionIds: async () => null,
    });

    const result = await reaper.sweep();

    expect(result.skipped).toBe('protected-unknown');
    expect(result.reaped).toEqual([]);
    expect(store.archive).not.toHaveBeenCalled();
  });

  it('drops a candidate that became active again while the sweep probed', async () => {
    const store = makeArchiveStore();
    const resumed = session('ses_resumed');
    let listings = 0;
    const reaper = makeReaper({
      sessions: [],
      store,
      listSessions: async () => {
        listings += 1;
        // Second listing (the pre-commit revalidation): the user resumed
        // the session, so its activity stamp moved past the threshold.
        return [listings === 1 ? resumed : { ...resumed, time: { ...resumed.time, updated: NOW } }];
      },
    });

    const result = await reaper.sweep();

    expect(result.reaped).toEqual([]);
    expect(store.archive).not.toHaveBeenCalled();
  });

  it('publishes the archived entries through onArchived', async () => {
    const store = makeArchiveStore();
    const onArchived = vi.fn();
    const reaper = makeReaper({ sessions: [session('ses_old')], store, onArchived });

    await reaper.sweep();

    expect(onArchived).toHaveBeenCalledWith([{ id: 'ses_old', archivedAt: NOW }]);
  });

  it('never archives a busy or retrying session, however old', async () => {
    const store = makeArchiveStore();
    const reaper = makeReaper({
      sessions: [session('ses_busy', { status: 'busy' }), session('ses_retry', { status: { type: 'retry' } })],
      store,
    });

    const result = await reaper.sweep();

    expect(result.liveIdle).toBe(0);
    expect(result.reaped).toEqual([]);
    expect(store.archive).not.toHaveBeenCalled();
  });

  it('does not archive a recently active idle session', async () => {
    const store = makeArchiveStore();
    const reaper = makeReaper({ sessions: [session('ses_recent', { updated: NOW - 5 * 60 * 1000 })], store });

    const result = await reaper.sweep();

    expect(result.liveIdle).toBe(1);
    expect(result.reaped).toEqual([]);
    expect(store.archive).not.toHaveBeenCalled();
  });

  it('leaves the session live when the archive write fails', async () => {
    const store = makeArchiveStore({ fail: true });
    const reaper = makeReaper({ sessions: [session('ses_old')], store });

    const result = await reaper.sweep();

    expect(result.reaped).toEqual([]);
    expect(result.failedIds).toEqual(['ses_old']);
    expect(store.archived.has('ses_old')).toBe(false);
  });

  it('skips sessions with no known status or no usable timestamp', async () => {
    const store = makeArchiveStore();
    const reaper = makeReaper({
      sessions: [
        { id: 'ses_unknown', time: { created: NOW - 4 * HOUR, updated: NOW - 3 * HOUR } },
        session('ses_no_time', { updated: 0, created: 0 }),
      ],
      store,
    });

    const result = await reaper.sweep();

    // ses_no_time is idle (counts as live idle) but has no usable timestamp,
    // so it is counted, never reaped; ses_unknown has no status at all.
    expect(result.liveIdle).toBe(1);
    expect(result.reaped).toEqual([]);
    expect(store.archive).not.toHaveBeenCalled();
  });

  it('uses the status provider over the record and counts live idle before reaping', async () => {
    const store = makeArchiveStore();
    const lines = [];
    const reaper = makeReaper({
      sessions: [
        session('ses_old', { status: undefined }),
        session('ses_recent', { status: undefined, updated: NOW - 60 * 1000 }),
        session('ses_done', { status: undefined, archived: NOW - HOUR }),
      ],
      store,
      getSessionStatuses: async () => ({ ses_old: { type: 'idle' }, ses_recent: { type: 'idle' }, ses_done: { type: 'idle' } }),
      log: (line) => lines.push(line),
    });

    const result = await reaper.sweep();

    expect(result.liveIdle).toBe(3);
    expect(result.reaped).toEqual(['ses_old']);
    expect(lines).toEqual([
      `[openchamber-sessions] idle-session sweep: live-idle=3 reaped=1 failed=0 threshold-ms=${IDLE_SESSION_MAX_AGE_MS}`,
    ]);
  });

  it('keeps a session with pending or unknown pending work live', async () => {
    const store = makeArchiveStore();
    const sessions = [session('ses_parent'), session('ses_unknown'), session('ses_clear')];
    const reaper = makeReaper({
      sessions,
      store,
      hasPendingWork: async (s) => (s.id === 'ses_parent' ? true : s.id === 'ses_unknown' ? null : false),
    });

    const result = await reaper.sweep();

    expect(result.reaped).toEqual(['ses_clear']);
  });

  it('does not reap a session the archive store already holds', async () => {
    const store = makeArchiveStore();
    store.isArchived = async (id) => id === 'ses_held';
    const reaper = makeReaper({ sessions: [session('ses_held'), session('ses_free')], store });

    const result = await reaper.sweep();

    expect(result.reaped).toEqual(['ses_free']);
  });

  it('honours a configured threshold', async () => {
    const store = makeArchiveStore();
    const reaper = makeReaper({
      sessions: [session('ses_mid', { updated: NOW - 30 * 60 * 1000 })],
      store,
      maxIdleAgeMs: 15 * 60 * 1000,
    });

    const result = await reaper.sweep();
    expect(result.reaped).toEqual(['ses_mid']);
    expect(reaper.maxIdleAgeMs).toBe(15 * 60 * 1000);
  });

  it('starts and stops the periodic sweep once', async () => {
    vi.useFakeTimers();
    try {
      const store = makeArchiveStore();
      const reaper = makeReaper({ sessions: [session('ses_old')], store });
      expect(reaper.start(1000)).toBe(true);
      expect(reaper.start(1000)).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(store.archived.has('ses_old')).toBe(true);
      expect(reaper.stop()).toBe(true);
      expect(reaper.stop()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exports the named defaults the packet requires', () => {
    expect(IDLE_SESSION_MAX_AGE_MS).toBe(2 * HOUR);
    expect(IDLE_SESSION_SWEEP_INTERVAL_MS).toBe(15 * 60 * 1000);
  });
});
