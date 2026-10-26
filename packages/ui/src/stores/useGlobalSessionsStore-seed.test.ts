import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { flushPendingSessionWrites, persistGlobalSessionSnapshot, readGlobalSessionSnapshot } from '@/sync/persist-cache';
import { clearLastActiveSession, persistLastActiveSession, readLastActiveSession } from '@/sync/last-session-cache';
import { restoreLastActiveSession } from '@/sync/last-session-restore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionsStore } from './useGlobalSessionsStore';

class TestStorage implements Storage {
  readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

/** A session as OpenCode lists it, with the fields the persisted seed leaves out. */
const session = (id: string, directory: string, updated: number): Session => ({
  id,
  projectID: 'project',
  directory,
  title: id,
  cost: 0.5,
  tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
  permissions: [{ action: 'bash', resource: '*', effect: 'allow' }],
  time: { created: updated - 1, updated },
});

const worktree = session('ses_worktree', '/repo/.worktrees/feature', 30);
const otherProject = session('ses_other', '/other-project', 20);
const deletedElsewhere = session('ses_deleted', '/third-project', 10);

let runtime = 0;
const nextRuntime = () => switchRuntimeEndpoint({ apiBaseUrl: 'https://store-seed.test', runtimeKey: `store-seed-${++runtime}` });
const originalStorage = globalThis.localStorage;
let home = spyOn(opencodeClient, 'getFilesystemHomeInfo');

/** Persist a snapshot for the active runtime and start the store from it, as module init does. */
const startFromSnapshot = (sessions: Session[]) => {
  persistGlobalSessionSnapshot(sessions);
  flushPendingSessionWrites();
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
};

const ids = (sessions: readonly Session[]) => sessions.map((item) => item.id).sort();

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new TestStorage() });
  nextRuntime();
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  home = spyOn(opencodeClient, 'getFilesystemHomeInfo').mockResolvedValue({ home: '/home/user', chatsRoot: '/srv/chats' });
});

afterEach(() => {
  home.mockRestore();
  clearLastActiveSession(getRuntimeKey());
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage });
});

describe('persisted global session seed', () => {
  test('paints sessions of directories that have no directory store, without authority', () => {
    startFromSnapshot([worktree, otherProject]);

    const state = useGlobalSessionsStore.getState();
    expect(ids(state.activeSessions)).toEqual(['ses_other', 'ses_worktree']);
    expect([...state.sessionsByDirectory.keys()].sort()).toEqual(['/other-project', '/repo/.worktrees/feature']);
    expect(state.hasLoaded).toBe(false);
    expect(state.status).toBe('idle');
    expect(state.activeSessions[0]).not.toHaveProperty('permissions');
  });

  test('a failed load keeps the seed visible but gives cleanup and last-session restore no authority', async () => {
    startFromSnapshot([worktree, otherProject]);
    persistLastActiveSession(getRuntimeKey(), { sessionId: 'ses_gone', directory: '/repo' });
    const originalSetCurrentSession = useSessionUIStore.getState().setCurrentSession;
    useSessionUIStore.setState({ currentSessionId: null, setCurrentSession: () => undefined });
    const list = spyOn(opencodeClient, 'listSessionsPage').mockRejectedValue(new Error('OpenCode is starting'));
    try {
      expect(await restoreLastActiveSession({ refresh: false })).toBe('failed');
      const state = useGlobalSessionsStore.getState();
      // Authoritative cleanup runs only on `ready`.
      expect(state.status).toBe('error');
      expect(state.hasLoaded).toBe(false);
      expect(ids(state.activeSessions)).toEqual(['ses_other', 'ses_worktree']);
      // The pointer to a session the seed does not hold survives for a later attempt.
      expect(readLastActiveSession(getRuntimeKey())?.sessionId).toBe('ses_gone');
    } finally {
      list.mockRestore();
      useSessionUIStore.setState({ setCurrentSession: originalSetCurrentSession });
    }
  });

  test('the first complete list replaces the seed: deleted sessions go, unchanged lists keep their reference', async () => {
    startFromSnapshot([worktree, otherProject, deletedElsewhere]);
    const list = spyOn(opencodeClient, 'listSessionsPage').mockResolvedValue({ sessions: [worktree, otherProject], cursor: {} });
    try {
      await useGlobalSessionsStore.getState().loadSessions();
      const loaded = useGlobalSessionsStore.getState();
      expect(loaded.status).toBe('ready');
      expect(loaded.hasLoaded).toBe(true);
      expect(ids(loaded.activeSessions)).toEqual(['ses_other', 'ses_worktree']);
      // Seed records lack fields the sidebar does not paint; the complete ones replace them.
      expect(loaded.entityById.get('ses_worktree')?.cost).toBe(0.5);

      await useGlobalSessionsStore.getState().loadSessions();
      const reloaded = useGlobalSessionsStore.getState();
      expect(reloaded.activeSessions).toBe(loaded.activeSessions);
      expect(reloaded.sessionsByDirectory).toBe(loaded.sessionsByDirectory);

      flushPendingSessionWrites();
      expect(ids(readGlobalSessionSnapshot())).toEqual(['ses_other', 'ses_worktree']);
    } finally {
      list.mockRestore();
    }
  });

  test('a session deleted while the first list loads is not brought back by it or by the snapshot', async () => {
    startFromSnapshot([worktree, otherProject]);
    const page = deferred<{ sessions: Session[]; cursor: Record<string, never> }>();
    const list = spyOn(opencodeClient, 'listSessionsPage').mockImplementation(() => page.promise);
    try {
      const load = useGlobalSessionsStore.getState().loadSessions();
      await new Promise((resolve) => setTimeout(resolve, 0));
      useGlobalSessionsStore.getState().removeSessions(['ses_other']);
      flushPendingSessionWrites();
      // Before the first complete list the snapshot is the seed plus that deletion.
      expect(ids(readGlobalSessionSnapshot())).toEqual(['ses_worktree']);

      page.resolve({ sessions: [worktree, otherProject], cursor: {} });
      await load;
      expect(ids(useGlobalSessionsStore.getState().activeSessions)).toEqual(['ses_worktree']);
      flushPendingSessionWrites();
      expect(ids(readGlobalSessionSnapshot())).toEqual(['ses_worktree']);
    } finally {
      list.mockRestore();
    }
  });

  test('a live update before the first list replaces a seed record with the same signature', () => {
    startFromSnapshot([worktree]);
    useGlobalSessionsStore.getState().upsertSession(worktree);

    expect(useGlobalSessionsStore.getState().entityById.get('ses_worktree')?.cost).toBe(0.5);
  });

  test('a runtime switch starts from that runtime\'s own snapshot', () => {
    startFromSnapshot([worktree]);
    const first = getRuntimeKey();

    nextRuntime();
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([]);

    switchRuntimeEndpoint({ apiBaseUrl: 'https://store-seed.test', runtimeKey: first });
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
    expect(ids(useGlobalSessionsStore.getState().activeSessions)).toEqual(['ses_worktree']);
    expect(useGlobalSessionsStore.getState().hasLoaded).toBe(false);
  });
});
