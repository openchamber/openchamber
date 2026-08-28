import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const clearCalls: string[] = [];
const snapshotCalls: Array<{
  reject?: boolean;
  pending?: boolean;
  commit?: boolean;
  delayMs?: number;
  sessions: Array<{ id: string; directory?: string | null }>;
}> = [];
let storeStatus: 'idle' | 'loading' | 'ready' | 'error' = 'ready';
let committedSessions: Array<{ id: string; directory?: string | null }> = [];

type SnapshotResult = { activeSessions: Array<{ id: string; directory?: string | null }> };

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => 'test-runtime',
}));

mock.module('@/sync/last-session-cache', () => ({
  readLastActiveSession: (key: string) => {
    if (key !== 'test-runtime') return null;
    return (globalThis as { __persisted?: { sessionId: string; directory: string | null } | null }).__persisted ?? null;
  },
  clearLastActiveSession: (key: string) => {
    clearCalls.push(key);
  },
  readMostRecentLastActiveSession: () => null,
}));

let sdkConnected = true;

mock.module('@/stores/useConfigStore', () => ({
  useConfigStore: {
    getState: () => ({ isConnected: sdkConnected }),
  },
}));

mock.module('@/stores/useGlobalSessionsStore', () => ({
  refreshGlobalSessions: async (): Promise<SnapshotResult> => {
    const next = snapshotCalls.shift();
    if (next?.pending) return new Promise<SnapshotResult>(() => undefined);
    if (next?.reject) {
      storeStatus = 'error';
      throw new Error('network down');
    }
    // A successful load commits its snapshot into the store and flips the
    // status to 'ready' (mirrors `loadSessions`). Pass `commit: false` to
    // simulate a generation-stale result that returns without touching the
    // store (the runtime-switch mismatch case); `delayMs` defers the commit so
    // the caller can observe the store being still non-ready.
    if (next?.commit === false) {
      return { activeSessions: next?.sessions ?? [] };
    }
    const apply = () => {
      committedSessions = next?.sessions ?? [];
      storeStatus = 'ready';
    };
    if (next?.delayMs) {
      setTimeout(apply, next.delayMs);
    } else {
      apply();
    }
    return { activeSessions: next?.sessions ?? [] };
  },
  resolveGlobalSessionDirectory: (session: { directory?: string | null; project?: { worktree?: string | null } | null }) =>
    session.directory ?? session.project?.worktree ?? null,
  useGlobalSessionsStore: {
    getState: () => ({ status: storeStatus, activeSessions: committedSessions }),
  },
}));

const setPersisted = (sessionId: string | null, directory: string | null = null) => {
  (globalThis as { __persisted?: unknown }).__persisted =
    sessionId === null ? null : { sessionId, directory };
};

const queueSnapshot = (
  sessions: Array<{ id: string; directory?: string | null }>,
  options: { commit?: boolean; delayMs?: number } = {},
) => {
  snapshotCalls.push({ sessions, commit: options.commit, delayMs: options.delayMs });
};

beforeEach(() => {
  setPersisted(null);
  clearCalls.length = 0;
  snapshotCalls.length = 0;
  committedSessions = [];
  storeStatus = 'ready';
  sdkConnected = true;
});

afterEach(() => {
  delete (globalThis as { __persisted?: unknown }).__persisted;
});

describe('resolveRecentSession', () => {
  test('returns null when nothing was persisted', async () => {
    const { resolveRecentSession } = await import('./recentSession');
    expect(await resolveRecentSession()).toBeNull();
    expect(snapshotCalls).toEqual([]);
  });

  test('returns the persisted session confirmed by the snapshot', async () => {
    setPersisted('ses_active', '/repo/a');
    committedSessions = [
      { id: 'ses_other', directory: '/repo/b' },
      { id: 'ses_active', directory: '/repo/c' },
    ];
    queueSnapshot([...committedSessions]);
    const { resolveRecentSession } = await import('./recentSession');
    const resolved = await resolveRecentSession();
    expect(resolved).toEqual({ sessionId: 'ses_active', directory: '/repo/c' });
    expect(clearCalls).toEqual([]);
  });

  test('falls back to the persisted directory when the committed entry lacks one', async () => {
    setPersisted('ses_active', '/repo/a');
    committedSessions = [{ id: 'ses_active', directory: null }];
    queueSnapshot([...committedSessions]);
    const { resolveRecentSession } = await import('./recentSession');
    const resolved = await resolveRecentSession();
    expect(resolved).toEqual({ sessionId: 'ses_active', directory: '/repo/a' });
  });

  test('drops the stale pointer and returns null when the session is gone', async () => {
    setPersisted('ses_gone', '/repo/a');
    committedSessions = [{ id: 'ses_other', directory: '/repo/b' }];
    queueSnapshot([...committedSessions]);
    const { resolveRecentSession } = await import('./recentSession');
    expect(await resolveRecentSession()).toBeNull();
    expect(clearCalls).toEqual(['test-runtime']);
  });

  test('returns null when the snapshot fetch fails', async () => {
    setPersisted('ses_active', '/repo/a');
    storeStatus = 'error';
    snapshotCalls.push({ reject: true, sessions: [] });
    const { resolveRecentSession } = await import('./recentSession');
    expect(await resolveRecentSession()).toBeNull();
    expect(clearCalls).toEqual([]);
  });

  test('keeps the pointer when the store reports a failed snapshot', async () => {
    setPersisted('ses_active', '/repo/a');
    storeStatus = 'error';
    queueSnapshot([], { commit: false });
    const { resolveRecentSession } = await import('./recentSession');
    expect(await resolveRecentSession()).toBeNull();
    expect(clearCalls).toEqual([]);
  });

  test('keeps the pointer when the snapshot is not authoritative (non-ready store status)', async () => {
    setPersisted('ses_active', '/repo/a');
    storeStatus = 'idle';
    queueSnapshot([], { commit: false });
    const { resolveRecentSession } = await import('./recentSession');
    expect(await resolveRecentSession()).toBeNull();
    expect(clearCalls).toEqual([]);
  }, 10_000);

  test('restores from the committed store even when the refresh returns a stale empty snapshot', async () => {
    setPersisted('ses_active', '/repo/a');
    committedSessions = [{ id: 'ses_active', directory: '/repo/c' }];
    storeStatus = 'ready';
    queueSnapshot([], { commit: false });
    const { resolveRecentSession } = await import('./recentSession');
    const resolved = await resolveRecentSession();
    expect(resolved).toEqual({ sessionId: 'ses_active', directory: '/repo/c' });
    expect(clearCalls).toEqual([]);
  });

  test('returns when snapshot resolution exceeds the startup timeout', async () => {
    setPersisted('ses_active', '/repo/a');
    storeStatus = 'loading';
    snapshotCalls.push({ reject: false, pending: true, sessions: [] });
    const { resolveRecentSession } = await import('./recentSession');
    const startedAt = Date.now();
    expect(await resolveRecentSession()).toBeNull();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(5_900);
    expect(clearCalls).toEqual([]);
  }, 10_000);

  test('keeps waiting past the deadline while the SDK is not connected yet', async () => {
    setPersisted('ses_active', '/repo/a');
    storeStatus = 'loading';
    sdkConnected = false;
    setTimeout(() => {
      sdkConnected = true;
      committedSessions = [{ id: 'ses_active', directory: '/repo/c' }];
      storeStatus = 'ready';
    }, 50);
    queueSnapshot([], { commit: false });
    const { resolveRecentSession } = await import('./recentSession');
    const resolved = await resolveRecentSession();
    expect(resolved).toEqual({ sessionId: 'ses_active', directory: '/repo/c' });
    expect(clearCalls).toEqual([]);
  }, 10_000);

  test('recovers from a transient boot error once the SDK connects', async () => {
    setPersisted('ses_active', '/repo/a');
    storeStatus = 'error';
    sdkConnected = false;
    queueSnapshot([{ id: 'ses_active', directory: '/repo/c' }], { commit: false });
    setTimeout(() => {
      sdkConnected = true;
      storeStatus = 'ready';
      committedSessions = [{ id: 'ses_active', directory: '/repo/c' }];
    }, 50);
    const { resolveRecentSession } = await import('./recentSession');
    const resolved = await resolveRecentSession();
    expect(resolved).toEqual({ sessionId: 'ses_active', directory: '/repo/c' });
    expect(clearCalls).toEqual([]);
  }, 10_000);

  test('still gives up once connected when the snapshot never becomes ready', async () => {
    setPersisted('ses_active', '/repo/a');
    storeStatus = 'loading';
    snapshotCalls.push({ reject: false, pending: true, sessions: [] });
    const { resolveRecentSession } = await import('./recentSession');
    const startedAt = Date.now();
    expect(await resolveRecentSession()).toBeNull();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(5_900);
    expect(clearCalls).toEqual([]);
  }, 10_000);
});

describe('resolveRouteSessionToken', () => {
  test('passes a plain session ID through with its directory hint', async () => {
    const { resolveRouteSessionToken } = await import('./recentSession');
    const resolved = await resolveRouteSessionToken(
      'ses_plain',
      async () => ({ sessionId: 'ses_recent', directory: '/repo/x' }),
      (sessionId) => (sessionId === 'ses_plain' ? '/repo/plain' : null),
    );
    expect(resolved).toEqual({ sessionId: 'ses_plain', directoryHint: '/repo/plain' });
  });

  test('resolves the recent token to the last active session', async () => {
    const { resolveRouteSessionToken } = await import('./recentSession');
    const resolved = await resolveRouteSessionToken(
      'recent',
      async () => ({ sessionId: 'ses_active', directory: '/repo/a' }),
      () => null,
    );
    expect(resolved).toEqual({ sessionId: 'ses_active', directoryHint: '/repo/a' });
  });

  test('falls through to the draft when the recent token resolves to nothing', async () => {
    const { resolveRouteSessionToken } = await import('./recentSession');
    const resolved = await resolveRouteSessionToken('recent', async () => null, () => null);
    expect(resolved).toBeNull();
  });

  test('does not resolve the recent token when the route uses a plain session ID', async () => {
    const { resolveRouteSessionToken } = await import('./recentSession');
    let recentResolutionAttempted = false;
    await resolveRouteSessionToken(
      'ses_plain',
      async () => {
        recentResolutionAttempted = true;
        return null;
      },
      () => null,
    );
    expect(recentResolutionAttempted).toBe(false);
  });
});
