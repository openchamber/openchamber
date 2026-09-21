import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { opencodeClient } from '@/lib/opencode/client';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from './session-ui-store';
import { replaceGlobalSessionStatusById } from './global-session-status';
import { buildSessionRetentionCandidates, runSessionRetentionCleanup, useSessionRetentionRunStore } from './session-retention';

const now = Date.now();
const day = 86_400_000;
const session = (id: string, patch: Partial<Session> = {}): Session => ({
  id, slug: id, projectID: 'project', directory: '/retention-project', title: id, version: '1',
  time: { created: now - 60 * day, updated: now - 40 * day }, ...patch,
});
const recent = Array.from({ length: 5 }, (_, index) => session(`recent-${index}`, {
  time: { created: now - day, updated: now - day },
}));
const archived = (id: string, patch: Partial<Session> = {}): Session => session(id, {
  time: { created: now - 60 * day, updated: now - 40 * day, archived: now - 40 * day }, ...patch,
});
const recentArchived = recent.map((item) => ({ ...item, id: `archived-${item.id}`, time: { ...item.time, archived: now - day } }));
const candidates = (sessions: Session[], action: 'archive' | 'delete' = 'delete') => buildSessionRetentionCandidates({
  sessions: [...recent, ...sessions], cutoffDays: 30, currentSessionId: null, action, activeSessionIds: new Set(), now,
});
const seed = (sessions: Session[]) => useGlobalSessionsStore.getState().applySnapshot(
  [...recent, ...sessions.filter((item) => !item.time.archived)],
  sessions.filter((item) => item.time.archived),
);

beforeEach(() => {
  switchRuntimeEndpoint({ apiBaseUrl: 'https://retention.test', runtimeKey: 'retention-test' });
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  useSessionUIStore.setState({ currentSessionId: null, isLoading: false });
  replaceGlobalSessionStatusById(new Map());
  useUIStore.setState({ autoDeleteEnabled: true, autoDeleteAfterDays: 30, sessionRetentionAction: 'delete', sessionRetentionOnlyArchived: false, autoDeleteLastRunAt: 0 });
  spyOn(useGlobalSessionsStore.getState(), 'loadSessions').mockImplementation(async () => {
    const state = useGlobalSessionsStore.getState();
    return { activeSessions: state.activeSessions, archivedSessions: state.archivedSessions };
  });
  spyOn(opencodeClient, 'getSession').mockImplementation(async (id) => {
    const item = useGlobalSessionsStore.getState().entityById.get(id);
    if (!item) throw Object.assign(new Error('not found'), { status: 404 });
    return item;
  });
  spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { mock.restore(); });

describe('retention eligibility', () => {
  test('retains recent, current, shared, archived and running sessions', () => {
    const sessions = [
      session('old'), session('current'), session('shared', { share: { url: 'https://share.test' } }),
      session('archived', { time: { created: 1, updated: 2, archived: 3 } }), session('busy'),
    ];
    expect(buildSessionRetentionCandidates({
      sessions: [...recent, ...sessions], cutoffDays: 30, currentSessionId: 'current', action: 'delete',
      activeSessionIds: new Set(['busy']), now,
    })).toEqual(['old']);
  });

  test('protects every ancestor of a recent, shared or archived child from cascade deletion', () => {
    for (const child of [recent[0], session('shared', { share: { url: 'https://share.test' } }),
      session('archived', { time: { created: 1, updated: 2, archived: 3 } })]) {
      expect(candidates([
        session('root'), session('middle', { parentID: 'root' }), { ...child, parentID: 'middle' }, session('unrelated'),
      ])).toEqual(['unrelated']);
    }
  });

  test('archives old parents independently because archiving does not cascade', () => {
    expect(candidates([session('root'), { ...recent[0], parentID: 'root' }], 'archive')).toEqual(['root']);
  });

  test('retains parents with an attached side conversation for either action', () => {
    const parent = session('parent', { metadata: { openchamber: { btwSessionID: 'side' } } });
    expect(candidates([parent])).toEqual([]);
    expect(candidates([parent], 'archive')).toEqual([]);
  });

  test('orders descendants before ancestors regardless of timestamps or list order', () => {
    expect(candidates([session('root'), session('child', { parentID: 'root' }), session('leaf', { parentID: 'child' })]))
      .toEqual(['leaf', 'child', 'root']);
  });

  test('rejects invalid retention periods and cycles', () => {
    for (const cutoffDays of [0, -1, NaN, Infinity]) {
      expect(buildSessionRetentionCandidates({
        sessions: [session('old')], cutoffDays, currentSessionId: null, action: 'delete', activeSessionIds: new Set(), now,
      })).toEqual([]);
    }
    expect(candidates([session('a', { parentID: 'b' }), session('b', { parentID: 'a' })])).toEqual([]);
  });
});

describe('retention execution', () => {
  test('claims the shared lock before loading and releases it after failure', async () => {
    let finish!: () => void;
    const loading = new Promise<void>((resolve) => { finish = resolve; });
    seed([session('old')]);
    const load = spyOn(useGlobalSessionsStore.getState(), 'loadSessions').mockImplementation(async () => {
      await loading;
      throw new Error('offline');
    });
    const first = runSessionRetentionCleanup({ force: true });
    expect(useSessionRetentionRunStore.getState().isRunning).toBe(true);
    expect((await runSessionRetentionCleanup({ force: true })).skippedReason).toBe('running');
    expect(load.mock.calls).toHaveLength(1);
    finish();
    await expect(first).rejects.toThrow('offline');
    expect(useSessionRetentionRunStore.getState().isRunning).toBe(false);
  });

  test('refuses a failed global load even when fallback sessions remain', async () => {
    seed([session('old')]);
    useGlobalSessionsStore.setState({ status: 'error' });
    const remove = spyOn(opencodeClient, 'deleteSession');
    await expect(runSessionRetentionCleanup({ force: true })).rejects.toThrow('complete session list');
    expect(remove.mock.calls).toHaveLength(0);
    expect(useGlobalSessionsStore.getState().entityById.has('old')).toBe(true);
  });

  test('requests fresh authority instead of relying on a previously loaded candidate', async () => {
    seed([session('old')]);
    const remove = spyOn(opencodeClient, 'deleteSession');
    spyOn(useGlobalSessionsStore.getState(), 'loadSessions').mockImplementation(async () => {
      seed([session('old', { time: { created: now - 60 * day, updated: now } })]);
      const state = useGlobalSessionsStore.getState();
      return { activeSessions: state.activeSessions, archivedSessions: state.archivedSessions };
    });
    expect((await runSessionRetentionCleanup({ force: true })).skippedReason).toBe('no-candidates');
    expect(remove.mock.calls).toHaveLength(0);
  });

  test('treats an authoritative 404 as completed and removes stale cached state', async () => {
    seed([session('gone')]);
    spyOn(opencodeClient, 'deleteSession').mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    const result = await runSessionRetentionCleanup({ force: true });
    expect(result.completedIds).toEqual(['gone']);
    expect(result.failedIds).toEqual([]);
    expect(useGlobalSessionsStore.getState().entityById.has('gone')).toBe(false);
  });

  test('does not accept a false delete confirmation, and preserves unrelated successes', async () => {
    seed([session('bad'), session('good')]);
    spyOn(opencodeClient, 'deleteSession').mockImplementation(async (id) => id !== 'bad');
    const result = await runSessionRetentionCleanup({ force: true });
    expect(result.completedIds).toEqual(['good']);
    expect(result.failedIds).toEqual(['bad']);
    expect(useGlobalSessionsStore.getState().entityById.has('bad')).toBe(true);
    expect(useGlobalSessionsStore.getState().entityById.has('good')).toBe(false);
  });

  test('keeps a failed child and its ancestors without preventing unrelated deletion', async () => {
    seed([session('root'), session('child', { parentID: 'root' }), session('leaf', { parentID: 'child' }), session('other')]);
    const remove = spyOn(opencodeClient, 'deleteSession').mockImplementation(async (id) => id !== 'leaf');
    const result = await runSessionRetentionCleanup({ force: true });
    expect(result.completedIds).toEqual(['other']);
    expect(result.failedIds).toEqual(['leaf', 'child', 'root']);
    expect(remove.mock.calls.map(([id]) => id)).toEqual(['leaf', 'other']);
  });

  test('rechecks selection, recent activity and new descendants during the batch', async () => {
    seed([session('first'), session('selected'), session('updated'), session('parent')]);
    const remove = spyOn(opencodeClient, 'deleteSession').mockImplementation(async () => {
      useSessionUIStore.setState({ currentSessionId: 'selected' });
      useGlobalSessionsStore.getState().upsertSessions([
        session('updated', { time: { created: 1, updated: now } }),
        session('new-child', { parentID: 'parent', time: { created: now, updated: now } }),
      ]);
      return true;
    });
    expect((await runSessionRetentionCleanup({ force: true })).completedIds).toEqual(['first']);
    expect(remove.mock.calls).toHaveLength(1);
    expect(useGlobalSessionsStore.getState().entityById.has('parent')).toBe(true);
  });

  test('stops at a runtime switch without reconciling the destination or its cooldown', async () => {
    seed([session('first'), session('second')]);
    const remove = spyOn(opencodeClient, 'deleteSession').mockImplementation(async () => {
      switchRuntimeEndpoint({ apiBaseUrl: 'https://retention-other.test', runtimeKey: 'retention-other' });
      seed([session('first'), session('second')]);
      useUIStore.setState({ autoDeleteLastRunAt: 123 });
      return true;
    });
    const result = await runSessionRetentionCleanup({ force: true });
    expect(result.completedIds).toEqual([]);
    expect(result.failedIds).toEqual(['first', 'second']);
    expect(remove.mock.calls).toHaveLength(1);
    expect(useGlobalSessionsStore.getState().entityById.has('first')).toBe(true);
    expect(useUIStore.getState().autoDeleteLastRunAt).toBe(123);
  });

  test('archives through the canonical action and retains the returned server record', async () => {
    seed([session('old')]);
    useUIStore.setState({ sessionRetentionAction: 'archive' });
    const archived = session('old', { time: { created: 1, updated: now, archived: now } });
    spyOn(opencodeClient, 'updateSession').mockResolvedValue(archived);
    expect((await runSessionRetentionCleanup({ force: true })).completedIds).toEqual(['old']);
    expect(useGlobalSessionsStore.getState().archivedSessions).toEqual([archived]);
  });

  test('processes 850 hierarchical sessions with one confirmed delete per candidate', async () => {
    const sessions = Array.from({ length: 850 }, (_, index) => {
      const item = session(`old-${index}`);
      if (index % 10) item.parentID = `old-${index - index % 10}`;
      return item;
    });
    seed(sessions);
    const existing = new Set(sessions.map((item) => item.id));
    const remove = spyOn(opencodeClient, 'deleteSession').mockImplementation(async (id) => {
      if (!existing.has(id)) throw Object.assign(new Error('cascade already deleted'), { status: 404 });
      existing.delete(id);
      for (const child of sessions) if (child.parentID === id) existing.delete(child.id);
      return true;
    });
    const result = await runSessionRetentionCleanup({ force: true });
    expect(result.completedIds).toHaveLength(850);
    expect(result.failedIds).toEqual([]);
    expect(remove.mock.calls).toHaveLength(850);
    expect(existing.size).toBe(0);
    expect(useGlobalSessionsStore.getState().activeSessions).toHaveLength(5);
  });
});

describe('archived-only retention', () => {
  const archivedCandidates = (sessions: Session[]) => buildSessionRetentionCandidates({
    sessions: [...recentArchived, ...sessions], cutoffDays: 30, currentSessionId: null,
    action: 'archive', onlyArchived: true, activeSessionIds: new Set(), now,
  });

  test('filters only archived sessions and uses archive time instead of last activity', () => {
    expect(archivedCandidates([
      archived('old-archive', { time: { created: 1, updated: now, archived: now - 40 * day } }),
      archived('new-archive', { time: { created: 1, updated: 2, archived: now - 2 * day } }),
      session('unarchived'),
      session('restored', { time: { created: 1, updated: 2, archived: 0 } }),
    ])).toEqual(['old-archive']);
  });

  test('preserves the five most recently archived sessions even when all are expired', () => {
    const sessions = Array.from({ length: 7 }, (_, index) => archived(`archived-${index}`, {
      time: { created: 1, updated: now, archived: now - (40 + index) * day },
    }));
    expect(buildSessionRetentionCandidates({
      sessions, cutoffDays: 30, currentSessionId: null, action: 'delete', onlyArchived: true, activeSessionIds: new Set(), now,
    })).toEqual(['archived-5', 'archived-6']);
  });

  test('protects shared archives and parents of unarchived or recently archived descendants', () => {
    expect(archivedCandidates([
      archived('parent'), session('active-child', { parentID: 'parent' }),
      archived('recent-parent'), { ...recentArchived[0], parentID: 'recent-parent' },
      archived('shared', { share: { url: 'https://share.test' } }),
      archived('unrelated'),
    ])).toEqual(['unrelated']);
  });

  test('forces deletion in core even if a stale setting still requests archive', async () => {
    seed([...recentArchived, archived('parent'), archived('child', { parentID: 'parent' }), session('unarchived')]);
    useUIStore.setState({ sessionRetentionOnlyArchived: true, sessionRetentionAction: 'archive' });
    const remove = spyOn(opencodeClient, 'deleteSession').mockResolvedValue(true);
    const update = spyOn(opencodeClient, 'updateSession');
    const result = await runSessionRetentionCleanup({ force: true });
    expect(result.action).toBe('delete');
    expect(result.completedIds).toEqual(['child', 'parent']);
    expect(result.failedIds).toEqual([]);
    expect(remove.mock.calls.map(([id]) => id)).toEqual(['child', 'parent']);
    expect(update.mock.calls).toHaveLength(0);
    expect(useGlobalSessionsStore.getState().entityById.has('unarchived')).toBe(true);
    expect(useGlobalSessionsStore.getState().archivedSessions).toHaveLength(5);
  });

  test('keeps failed archived descendants and reports their blocked ancestors', async () => {
    seed([...recentArchived, archived('parent'), archived('child', { parentID: 'parent' }), archived('other')]);
    useUIStore.getState().setSessionRetentionOnlyArchived(true);
    const remove = spyOn(opencodeClient, 'deleteSession').mockImplementation(async (id) => id !== 'child');
    const result = await runSessionRetentionCleanup({ force: true });
    expect(result.completedIds).toEqual(['other']);
    expect(result.failedIds).toEqual(['child', 'parent']);
    expect(remove.mock.calls.map(([id]) => id)).toEqual(['child', 'other']);
    expect(useGlobalSessionsStore.getState().entityById.has('parent')).toBe(true);
  });

  test('skips sessions restored during cleanup and parents with newly archived children', async () => {
    seed([...recentArchived, archived('first'), archived('restored'), archived('parent')]);
    useUIStore.getState().setSessionRetentionOnlyArchived(true);
    const remove = spyOn(opencodeClient, 'deleteSession').mockImplementation(async () => {
      useGlobalSessionsStore.getState().upsertSessions([
        session('restored', { time: { created: 1, updated: 2, archived: 0 } }),
        archived('new-child', { parentID: 'parent', time: { created: now, updated: now, archived: now } }),
      ]);
      return true;
    });
    const result = await runSessionRetentionCleanup({ force: true });
    expect(result.completedIds).toEqual(['first']);
    expect(result.failedIds).toEqual([]);
    expect(remove.mock.calls).toHaveLength(1);
    expect(useGlobalSessionsStore.getState().entityById.has('parent')).toBe(true);
    expect(useGlobalSessionsStore.getState().entityById.has('restored')).toBe(true);
  });
});
