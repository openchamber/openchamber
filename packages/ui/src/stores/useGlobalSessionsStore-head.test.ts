import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { opencodeClient, type SessionPage } from '@/lib/opencode/client';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { useGlobalSessionsStore } from './useGlobalSessionsStore';

const session = (id: string, updated = 1, archived?: number): Session => {
  const time: Session['time'] = { created: 1, updated };
  if (archived) time.archived = archived;
  return {
    id, title: id, projectID: 'project', directory: '/repo', time,
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
};
const page = (sessions: Session[], next?: string): SessionPage => ({ sessions, cursor: { next } });

describe('global session head checks', () => {
  let list: ReturnType<typeof spyOn<typeof opencodeClient, 'listSessionsPage'>>;
  beforeEach(() => {
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
    useSpacesStore.getState().resetForRuntimeSwitch();
    list = spyOn(opencodeClient, 'listSessionsPage');
  });
  afterEach(() => list.mockRestore());

  test('merges new and updated records, splits archive state and retains absent sessions', async () => {
    const existing = session('updated');
    const absent = session('absent');
    const archived = session('archived');
    useGlobalSessionsStore.getState().applySnapshot([existing, absent, archived], []);
    const authoritative = useGlobalSessionsStore.getState().authoritativeSessions;
    list.mockResolvedValue(page([session('new', 4), session('updated', 3), session('archived', 2, 2), absent], 'older'));
    expect(await useGlobalSessionsStore.getState().refreshSessionHead()).toBe(true);
    const state = useGlobalSessionsStore.getState();
    expect(state.entityById.get('updated')?.time.updated).toBe(3);
    expect(state.entityById.has('new')).toBe(true);
    expect(state.entityById.get('absent')).toBe(absent);
    expect(state.archivedSessions.map((item) => item.id)).toEqual(['archived']);
    expect(state.authoritativeSessions).toBe(authoritative);
    expect(list.mock.calls).toHaveLength(1);
    expect(list.mock.calls[0]?.[0]).toMatchObject({ global: true, limit: 20 });
    // Even if the complete load's visible records match the head merge, it must
    // publish fresh authority so cleanup can advance its complete baseline.
    state.applySnapshot(state.activeSessions, state.archivedSessions);
    expect(useGlobalSessionsStore.getState().authoritativeSessions).not.toBe(authoritative);
    expect(useGlobalSessionsStore.getState().authoritativeSessions?.some((item) => item.id === 'new')).toBe(true);
  });

  test('continues through wholly new or changed pages and stops at a known unchanged record', async () => {
    useGlobalSessionsStore.getState().applySnapshot([session('known'), session('changed'), session('absent')], []);
    list.mockResolvedValueOnce(page([session('new'), session('changed', 2)], 'second'))
      .mockResolvedValueOnce(page([session('known'), session('also-new')], 'third'));
    await useGlobalSessionsStore.getState().refreshSessionHead();
    expect(list.mock.calls).toHaveLength(2);
    expect(list.mock.calls[1]?.[0]).toMatchObject({ cursor: 'second', limit: 20 });
    expect(useGlobalSessionsStore.getState().entityById.has('also-new')).toBe(true);
    expect(useGlobalSessionsStore.getState().entityById.has('absent')).toBe(true);
  });

  test('an empty head preserves the complete cache and its authority snapshot', async () => {
    useGlobalSessionsStore.getState().applySnapshot([session('kept')], []);
    const before = useGlobalSessionsStore.getState();
    list.mockResolvedValue(page([]));
    await useGlobalSessionsStore.getState().refreshSessionHead();
    expect(useGlobalSessionsStore.getState()).toBe(before);
  });

  test('a successful empty complete snapshot replaces authority and runtime reset retires it', () => {
    useGlobalSessionsStore.getState().applySnapshot([session('old')], []);
    useGlobalSessionsStore.getState().applySnapshot([], []);
    expect(useGlobalSessionsStore.getState().authoritativeSessions).toEqual([]);
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
    expect(useGlobalSessionsStore.getState().authoritativeSessions).toBeNull();
  });

  test('an unchanged head at production scale requests just 20 records and publishes no state', async () => {
    const sessions = Array.from({ length: 3_400 }, (_, index) => session(`session-${index}`, 3_400 - index));
    useGlobalSessionsStore.getState().applySnapshot(sessions, []);
    const before = useGlobalSessionsStore.getState();
    list.mockResolvedValue(page(sessions.slice(0, 20), 'rest'));
    await useGlobalSessionsStore.getState().refreshSessionHead();
    expect(list.mock.calls).toHaveLength(1);
    expect(useGlobalSessionsStore.getState()).toBe(before);
  });

  test('a failed later page preserves the cache and complete-snapshot authority', async () => {
    useGlobalSessionsStore.getState().applySnapshot([session('known')], []);
    const before = useGlobalSessionsStore.getState();
    const warning = spyOn(console, 'warn').mockImplementation(() => undefined);
    list.mockResolvedValueOnce(page([session('partial-new')], 'unavailable'))
      .mockRejectedValue(new Error('offline'));
    try {
      expect(await useGlobalSessionsStore.getState().refreshSessionHead()).toBe(false);
      expect(useGlobalSessionsStore.getState()).toBe(before);
      expect(useGlobalSessionsStore.getState().entityById.has('partial-new')).toBe(false);
    } finally {
      warning.mockRestore();
    }
  });

  test('unchanged isolated-space marks do not trigger policy refresh subscriptions', async () => {
    const mark = { id: '012345abcdef', name: 'Space', state: 'complete' as const, projectDirectory: '/repo', directory: '/workspace' };
    useSpacesStore.getState().applyMarks([mark]);
    useGlobalSessionsStore.getState().applySnapshot([session('known')], []);
    const spaces = useSpacesStore.getState().spaces;
    list.mockResolvedValue({ ...page([session('known')]), spaces: [{ ...mark }] });
    await useGlobalSessionsStore.getState().refreshSessionHead();
    expect(useSpacesStore.getState().spaces).toBe(spaces);
  });

  test('a mutation during the read wins and a partial head cannot resurrect a deleted session', async () => {
    const stale = session('deleted');
    useGlobalSessionsStore.getState().applySnapshot([stale, session('changed')], []);
    let resolve!: (value: SessionPage) => void;
    const response = new Promise<SessionPage>((done) => { resolve = done; });
    list.mockReturnValue(response);
    const checking = useGlobalSessionsStore.getState().refreshSessionHead();
    useGlobalSessionsStore.getState().removeSessions(['deleted']);
    useGlobalSessionsStore.getState().upsertSession(session('changed', 9));
    resolve(page([stale, session('changed', 2)]));
    await checking;
    expect(useGlobalSessionsStore.getState().entityById.has('deleted')).toBe(false);
    expect(useGlobalSessionsStore.getState().entityById.get('changed')?.time.updated).toBe(9);
  });

  test('a retired runtime head cannot publish into its replacement', async () => {
    useGlobalSessionsStore.getState().applySnapshot([session('known')], []);
    let resolve!: (value: SessionPage) => void;
    const response = new Promise<SessionPage>((done) => { resolve = done; });
    list.mockReturnValue(response);
    const checking = useGlobalSessionsStore.getState().refreshSessionHead();
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
    useGlobalSessionsStore.getState().applySnapshot([session('replacement')], []);
    resolve(page([session('stale')]));
    expect(await checking).toBe(false);
    expect(useGlobalSessionsStore.getState().entityById.has('stale')).toBe(false);
  });
});
