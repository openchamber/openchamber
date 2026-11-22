import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { opencodeClient, type SessionPage } from '@/lib/opencode/client';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { refreshRecentGlobalSessions, useGlobalSessionsStore } from './useGlobalSessionsStore';

const session = (id: string, updated = 1, archived?: number): Session => {
  const time: Session['time'] = { created: 1, updated };
  if (archived) time.archived = archived;
  return {
    id, title: id, projectID: 'project', directory: '/repo', time,
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
};
const page = (sessions: Session[], next?: string): SessionPage => ({ sessions, cursor: { next } });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

let runtime = 0;

describe('recent sessions for a surface without the complete list', () => {
  let list: ReturnType<typeof spyOn<typeof opencodeClient, 'listSessionsPage'>>;
  let home: ReturnType<typeof spyOn<typeof opencodeClient, 'getFilesystemHomeInfo'>>;
  beforeEach(() => {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://store-recent.test', runtimeKey: `store-recent-${++runtime}` });
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
    useSpacesStore.getState().resetForRuntimeSwitch();
    list = spyOn(opencodeClient, 'listSessionsPage');
    home = spyOn(opencodeClient, 'getFilesystemHomeInfo').mockResolvedValue({ home: '/home/user', chatsRoot: '/srv/chats' });
  });
  afterEach(() => {
    list.mockRestore();
    home.mockRestore();
  });

  test('reads one page and merges it without claiming the complete list', async () => {
    const seeded = session('seeded');
    useGlobalSessionsStore.getState().upsertSession(seeded);
    list.mockResolvedValue(page([session('new', 5), session('done', 4, 4)], 'older'));

    expect(await refreshRecentGlobalSessions()).toBe(true);

    const state = useGlobalSessionsStore.getState();
    expect(list.mock.calls).toHaveLength(1);
    expect(list.mock.calls[0]?.[0]).toMatchObject({ global: true, limit: 50 });
    expect(state.activeSessions.map((item) => item.id).sort()).toEqual(['new', 'seeded']);
    expect(state.archivedSessions.map((item) => item.id)).toEqual(['done']);
    expect(state.hasLoaded).toBe(false);
    expect(state.authoritativeSessions).toBeNull();
    expect(state.status).not.toBe('ready');
  });

  test('a failed read leaves the list as it was', async () => {
    useGlobalSessionsStore.getState().upsertSession(session('kept'));
    const before = useGlobalSessionsStore.getState();
    list.mockRejectedValue(Object.assign(new Error('bad request'), { status: 400 }));

    expect(await refreshRecentGlobalSessions()).toBe(false);

    const after = useGlobalSessionsStore.getState();
    expect(after.activeSessions).toBe(before.activeSessions);
    expect(after.archivedSessions).toBe(before.archivedSessions);
    expect(after.hasLoaded).toBe(false);
  });

  test('a change made while the page was in flight is not overwritten by it', async () => {
    const pending = deferred<SessionPage>();
    list.mockReturnValue(pending.promise);
    const read = refreshRecentGlobalSessions();
    // The read is under way before the user renames and removes sessions.
    await Promise.resolve();
    await Promise.resolve();
    useGlobalSessionsStore.getState().upsertSession({ ...session('renamed', 9), title: 'New title' });
    useGlobalSessionsStore.getState().removeSessions(['removed']);
    pending.resolve(page([session('renamed', 2), session('removed', 2)]));

    expect(await read).toBe(true);

    const state = useGlobalSessionsStore.getState();
    expect(state.entityById.get('renamed')?.title).toBe('New title');
    expect(state.entityById.has('removed')).toBe(false);
  });

  test('a page read on the previous runtime is dropped', async () => {
    const pending = deferred<SessionPage>();
    list.mockReturnValue(pending.promise);
    const read = refreshRecentGlobalSessions();
    await Promise.resolve();
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
    pending.resolve(page([session('foreign')]));

    expect(await read).toBe(false);
    expect(useGlobalSessionsStore.getState().entityById.has('foreign')).toBe(false);
  });

  test('a surface that holds the complete list checks its head', async () => {
    useGlobalSessionsStore.getState().applySnapshot([session('known')], []);
    list.mockResolvedValue(page([session('known')], 'rest'));

    expect(await refreshRecentGlobalSessions()).toBe(true);

    expect(list.mock.calls[0]?.[0]).toMatchObject({ global: true, limit: 20 });
    expect(useGlobalSessionsStore.getState().hasLoaded).toBe(true);
  });
});
