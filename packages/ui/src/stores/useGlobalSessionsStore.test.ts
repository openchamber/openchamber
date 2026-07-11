import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { OpencodeClient, Session } from '@opencode-ai/sdk/v2';

import {
  mergeLiveSessionWithGlobalSession,
  refreshStartupGlobalSessionsForDirectories,
  resolveGlobalSessionDirectory,
  useGlobalSessionsStore,
} from './useGlobalSessionsStore';
import { opencodeClient } from '@/lib/opencode/client';
import { resetOpenCodeReadiness } from '@/lib/runtime-readiness';

type SessionExtra = Partial<Session> & {
  directory?: string | null;
  project?: { worktree?: string | null } | null;
};

const buildSession = (shareUrl: string, extra: SessionExtra = {}): Session => ({
  id: 'ses_1',
  title: 'Shared session',
  time: { created: 1, updated: 2 },
  share: { url: shareUrl },
  ...extra,
} as Session);

describe('useGlobalSessionsStore', () => {
  let restoreGetSdkClient: (() => void) | null = null;
  let restoreCheckHealth: (() => void) | null = null;

  beforeEach(() => {
    resetOpenCodeReadiness();
    const originalCheckHealth = opencodeClient.checkHealth;
    opencodeClient.checkHealth = async () => true;
    restoreCheckHealth = () => { opencodeClient.checkHealth = originalCheckHealth; };
    useGlobalSessionsStore.setState({
      activeSessions: [],
      archivedSessions: [],
      sessionsByDirectory: new Map(),
      loadedDirectories: new Set(),
      loadingDirectories: new Set(),
      refreshingDirectories: new Set(),
      archivedLoadedDirectories: new Set(),
      archivedLoadingDirectories: new Set(),
      activePaginationByDirectory: new Map(),
      cachedDirectories: new Set(),
      hasHydratedSessionIndex: false,
      hasCachedSessionIndex: false,
      sessionIndexSyncByDirectory: new Map(),
      hasLoadedFullCatalog: false,
      hasLoaded: false,
      status: 'idle',
      startupSyncProgress: { active: false, phase: 'idle', completed: 0, total: 0 },
    });
  });

  afterEach(() => {
    restoreGetSdkClient?.();
    restoreGetSdkClient = null;
    restoreCheckHealth?.();
    restoreCheckHealth = null;
    resetOpenCodeReadiness();
  });

  test('gates concurrent directory refreshes behind one runtime readiness probe', async () => {
    let healthCalls = 0;
    let releaseHealth: (ready: boolean) => void = () => undefined;
    opencodeClient.checkHealth = () => {
      healthCalls += 1;
      return new Promise<boolean>((resolve) => { releaseHealth = resolve; });
    };
    const listCalls: Array<Record<string, unknown>> = [];
    const list = async (input: Record<string, unknown>) => {
      listCalls.push(input);
      return { data: [], error: undefined, response: new Response(null, { status: 200 }) };
    };
    const sdk = { experimental: { session: { list } } } as unknown as OpencodeClient;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    opencodeClient.getSdkClient = () => sdk;
    restoreGetSdkClient = () => { opencodeClient.getSdkClient = originalGetSdkClient; };

    const refresh = useGlobalSessionsStore.getState().refreshSessionsForDirectories(['/repo/a', '/repo/b']);
    await Promise.resolve();

    expect(healthCalls).toBe(1);
    expect(listCalls).toHaveLength(0);
    releaseHealth(true);
    await refresh;
    expect(listCalls).toHaveLength(2);
  });

  test('starts no more than seven cold directory summaries at once', async () => {
    type ListResult = { data: Session[]; error: undefined; response: Response };
    const resolvers: Array<(value: ListResult) => void> = [];
    const listCalls: Array<Record<string, unknown>> = [];
    const list = (input: Record<string, unknown>) => new Promise<ListResult>((resolve) => {
      listCalls.push(input);
      resolvers.push(resolve);
    });
    const sdk = { experimental: { session: { list } } } as unknown as OpencodeClient;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    opencodeClient.getSdkClient = () => sdk;
    restoreGetSdkClient = () => { opencodeClient.getSdkClient = originalGetSdkClient; };

    const refresh = useGlobalSessionsStore.getState().refreshSessionsForDirectories(
      Array.from({ length: 8 }, (_, index) => `/repo/${index}`),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(listCalls).toHaveLength(7);
    resolvers.splice(0).forEach((resolve) => resolve({ data: [], error: undefined, response: new Response(null, { status: 200 }) }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listCalls).toHaveLength(8);
    resolvers.splice(0).forEach((resolve) => resolve({ data: [], error: undefined, response: new Response(null, { status: 200 }) }));
    await refresh;
  });

  test('reports blocking cold-start progress as each project directory settles', async () => {
    type ListResult = { data: Session[]; error: undefined; response: Response };
    const resolvers: Array<(value: ListResult) => void> = [];
    const list = () => new Promise<ListResult>((resolve) => {
      resolvers.push(resolve);
    });
    const sdk = { experimental: { session: { list } } } as unknown as OpencodeClient;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    opencodeClient.getSdkClient = () => sdk;
    restoreGetSdkClient = () => { opencodeClient.getSdkClient = originalGetSdkClient; };

    const refresh = refreshStartupGlobalSessionsForDirectories([
      '/repo/a',
      '/repo/b',
      '/repo/c',
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useGlobalSessionsStore.getState().startupSyncProgress).toEqual({
      active: true,
      phase: 'syncing',
      completed: 0,
      total: 3,
    });

    resolvers[0]?.({ data: [], error: undefined, response: new Response(null, { status: 200 }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useGlobalSessionsStore.getState().startupSyncProgress.completed).toBe(1);

    resolvers.slice(1).forEach((resolve) => resolve({
      data: [],
      error: undefined,
      response: new Response(null, { status: 200 }),
    }));
    await refresh;

    expect(useGlobalSessionsStore.getState().startupSyncProgress).toEqual({
      active: false,
      phase: 'idle',
      completed: 3,
      total: 3,
    });
  });

  test('keeps a first run blocked until its initial root-session refresh settles', async () => {
    type ListResult = { data: Session[]; error: undefined; response: Response };
    let resolveList: (value: ListResult) => void = () => undefined;
    const list = () => new Promise<ListResult>((resolve) => { resolveList = resolve; });
    const sdk = { experimental: { session: { list } } } as unknown as OpencodeClient;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    opencodeClient.getSdkClient = () => sdk;
    restoreGetSdkClient = () => { opencodeClient.getSdkClient = originalGetSdkClient; };

    let finished = false;
    const startup = useGlobalSessionsStore.getState().startSessionIndexStartup(['/repo/first-run'])
      .then(() => { finished = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(finished).toBe(false);
    expect(useGlobalSessionsStore.getState().startupSyncProgress.phase).toBe('syncing');

    resolveList({ data: [], error: undefined, response: new Response(null, { status: 200 }) });
    await startup;
    expect(finished).toBe(true);
  });

  test('retries failed first-run directories after adaptive concurrency drops', async () => {
    let calls = 0;
    const list = async () => {
      calls += 1;
      if (calls <= 2) {
        return {
          data: undefined,
          error: { message: 'service unavailable' },
          response: new Response(null, { status: 503 }),
        };
      }
      return {
        data: [buildSession('https://share.example/retry', { directory: '/repo/retry' })],
        error: undefined,
        response: new Response(null, { status: 200 }),
      };
    };
    const sdk = { experimental: { session: { list } } } as unknown as OpencodeClient;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    opencodeClient.getSdkClient = () => sdk;
    restoreGetSdkClient = () => { opencodeClient.getSdkClient = originalGetSdkClient; };

    await useGlobalSessionsStore.getState().startSessionIndexStartup(['/repo/retry']);

    expect(calls).toBe(3);
    expect(useGlobalSessionsStore.getState().loadedDirectories.has('/repo/retry')).toBe(true);
    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/retry')).toHaveLength(1);
  });

  test('releases startup after the local restore while OpenCode validation continues in background', async () => {
    type ListResult = { data: Session[]; error: undefined; response: Response };
    let resolveList: (value: ListResult) => void = () => undefined;
    const list = () => new Promise<ListResult>((resolve) => { resolveList = resolve; });
    const sdk = { experimental: { session: { list } } } as unknown as OpencodeClient;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    opencodeClient.getSdkClient = () => sdk;
    restoreGetSdkClient = () => { opencodeClient.getSdkClient = originalGetSdkClient; };
    useGlobalSessionsStore.setState({
      cachedDirectories: new Set(['/repo/cached']),
      hasCachedSessionIndex: true,
    });

    let finished = false;
    await useGlobalSessionsStore.getState().startSessionIndexStartup(['/repo/cached'])
      .then(() => { finished = true; });

    expect(finished).toBe(true);
    expect(useGlobalSessionsStore.getState().startupSyncProgress.active).toBe(true);
    expect(useGlobalSessionsStore.getState().startupSyncProgress.phase).toBe('syncing');

    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveList({ data: [], error: undefined, response: new Response(null, { status: 200 }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test('uses the Electron server job without issuing browser-side OpenCode session lists', async () => {
    const originalWindow = globalThis.window;
    const originalFetch = globalThis.fetch;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    let sdkListCalls = 0;
    const requests: string[] = [];
    const cached = buildSession('https://share.example/server-cache', { directory: '/repo/server' });
    const snapshot = {
      revision: 1,
      sync: {
        active: false,
        completed: 1,
        total: 1,
        pendingDirectories: [],
        completedDirectories: ['/repo/server'],
        failedDirectories: [],
      },
      directories: [{
        directory: '/repo/server',
        cursor: 2,
        hasMore: false,
        lastSyncedAt: 1000,
        lastFullSyncedAt: 1000,
        lastAccessedAt: 1000,
        sessions: [cached],
      }],
    };
    try {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'http://localhost', href: 'http://localhost/' } },
      });
      globalThis.fetch = async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        requests.push(new URL(url, 'http://localhost').pathname);
        const isSnapshot = requests.length === 1;
        return new Response(JSON.stringify(isSnapshot ? { available: true, ...snapshot } : snapshot), {
          status: isSnapshot ? 200 : 202,
          headers: { 'Content-Type': 'application/json' },
        });
      };
      opencodeClient.getSdkClient = () => ({
        experimental: { session: { list: async () => {
          sdkListCalls += 1;
          return { data: [], error: undefined, response: new Response(null, { status: 200 }) };
        } } },
      } as unknown as OpencodeClient);

      await useGlobalSessionsStore.getState().startSessionIndexStartup(['/repo/server']);

      expect(sdkListCalls).toBe(0);
      expect(requests).toEqual([
        '/api/openchamber/session-index',
        '/api/openchamber/session-index/sync',
      ]);
      expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/server')).toEqual([cached]);
    } finally {
      opencodeClient.getSdkClient = originalGetSdkClient;
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      globalThis.fetch = originalFetch;
    }
  });

  test('coalesces overlapping active refreshes by directory and keeps a cached snapshot visible', async () => {
    type ListResult = { data?: Session[]; error?: { message: string }; response: Response };
    let resolveList: (value: ListResult) => void = () => undefined;
    const calls: Array<Record<string, unknown>> = [];
    const list = (input: Record<string, unknown>) => new Promise<ListResult>((resolve) => {
      calls.push(input);
      resolveList = resolve;
    });
    const sdk = { experimental: { session: { list } } } as unknown as OpencodeClient;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    opencodeClient.getSdkClient = () => sdk;
    restoreGetSdkClient = () => { opencodeClient.getSdkClient = originalGetSdkClient; };

    const cached = buildSession('https://share.example/a', { directory: '/repo/app' });
    useGlobalSessionsStore.setState({
      activeSessions: [cached],
      sessionsByDirectory: new Map([['/repo/app', [cached]]]),
      loadedDirectories: new Set(['/repo/app']),
      hasLoaded: true,
      status: 'ready',
    });

    const first = useGlobalSessionsStore.getState().refreshSessionsForDirectories(['/repo/app']);
    const second = useGlobalSessionsStore.getState().refreshSessionsForDirectories(['/repo/app']);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({ directory: '/repo/app', archived: false, roots: true, limit: 20 });
    expect(useGlobalSessionsStore.getState().activeSessions[0]?.id).toBe('ses_1');
    expect(useGlobalSessionsStore.getState().loadingDirectories.has('/repo/app')).toBe(false);
    expect(useGlobalSessionsStore.getState().refreshingDirectories.has('/repo/app')).toBe(true);

    resolveList({
      data: [{ ...cached, title: 'Fresh session', time: { created: 1, updated: 3 } }],
      error: undefined,
      response: new Response(null, { status: 200 }),
    });
    await Promise.all([first, second]);

    expect(calls.length).toBe(1);
    expect(useGlobalSessionsStore.getState().activeSessions[0]?.title).toBe('Fresh session');
    expect(useGlobalSessionsStore.getState().refreshingDirectories.has('/repo/app')).toBe(false);
  });

  test('merges an incremental start-window response without erasing cached sessions', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const list = async (input: Record<string, unknown>) => {
      calls.push(input);
      return { data: [], error: undefined, response: new Response(null, { status: 200 }) };
    };
    const sdk = { experimental: { session: { list } } } as unknown as OpencodeClient;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    opencodeClient.getSdkClient = () => sdk;
    restoreGetSdkClient = () => { opencodeClient.getSdkClient = originalGetSdkClient; };
    const cached = buildSession('https://share.example/cached', { directory: '/repo/incremental' });
    useGlobalSessionsStore.setState({
      activeSessions: [cached],
      sessionsByDirectory: new Map([['/repo/incremental', [cached]]]),
    });

    await useGlobalSessionsStore.getState().refreshSessionsForDirectories(
      ['/repo/incremental'],
      undefined,
      { persist: false, incrementalStart: 1234 },
    );

    expect(calls[0]).toEqual({
      directory: '/repo/incremental',
      archived: false,
      roots: true,
      start: 1234,
      limit: 20,
    });
    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/incremental')).toEqual([cached]);
  });

  test('does not advance startup progress for a cached directory whose incremental refresh failed', async () => {
    const list = async () => ({
      data: undefined,
      error: { message: 'bad request' },
      response: new Response(null, { status: 400 }),
    });
    const sdk = { experimental: { session: { list } } } as unknown as OpencodeClient;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    opencodeClient.getSdkClient = () => sdk;
    restoreGetSdkClient = () => { opencodeClient.getSdkClient = originalGetSdkClient; };
    const cached = buildSession('https://share.example/cached-failure', { directory: '/repo/cached-failure' });
    useGlobalSessionsStore.setState({
      activeSessions: [cached],
      sessionsByDirectory: new Map([['/repo/cached-failure', [cached]]]),
      loadedDirectories: new Set(['/repo/cached-failure']),
      hasLoaded: true,
      status: 'ready',
    });

    await refreshStartupGlobalSessionsForDirectories(
      ['/repo/cached-failure'],
      [cached],
      { incrementalStartByDirectory: new Map([['/repo/cached-failure', 1234]]) },
    );

    expect(useGlobalSessionsStore.getState().startupSyncProgress.completed).toBe(0);
    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/cached-failure')).toEqual([cached]);
  });

  test('loads archived sessions through the independent lazy path', async () => {
    const archived = buildSession('https://share.example/a', {
      directory: '/repo/app',
      time: { created: 1, updated: 2, archived: 3 },
    });
    const calls: Array<Record<string, unknown>> = [];
    const list = async (input: Record<string, unknown>) => {
      calls.push(input);
      return {
      data: [archived],
      error: undefined,
      response: new Response(null, { status: 200 }),
      };
    };
    const sdk = { experimental: { session: { list } } } as unknown as OpencodeClient;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    opencodeClient.getSdkClient = () => sdk;
    restoreGetSdkClient = () => { opencodeClient.getSdkClient = originalGetSdkClient; };

    await useGlobalSessionsStore.getState().refreshArchivedSessionsForDirectories(['/repo/app']);

    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({ directory: '/repo/app', archived: true, roots: true, limit: 20 });
    expect(useGlobalSessionsStore.getState().archivedSessions[0]?.id).toBe('ses_1');
    expect(useGlobalSessionsStore.getState().archivedLoadedDirectories.has('/repo/app')).toBe(true);
    expect(useGlobalSessionsStore.getState().archivedLoadingDirectories.has('/repo/app')).toBe(false);
  });

  test('preserves cached active sessions and clears refresh state after a fetch failure', async () => {
    const cached = buildSession('https://share.example/a', { directory: '/repo/app' });
    const list = async () => ({
      data: undefined,
      error: { message: 'bad request' },
      response: new Response(null, { status: 400 }),
    });
    const sdk = { experimental: { session: { list } } } as unknown as OpencodeClient;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    opencodeClient.getSdkClient = () => sdk;
    restoreGetSdkClient = () => { opencodeClient.getSdkClient = originalGetSdkClient; };
    useGlobalSessionsStore.setState({
      activeSessions: [cached],
      sessionsByDirectory: new Map([['/repo/app', [cached]]]),
      loadedDirectories: new Set(['/repo/app']),
      hasLoaded: true,
      status: 'ready',
    });

    await useGlobalSessionsStore.getState().refreshSessionsForDirectories(['/repo/app']);

    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([cached]);
    expect(useGlobalSessionsStore.getState().loadingDirectories.has('/repo/app')).toBe(false);
    expect(useGlobalSessionsStore.getState().refreshingDirectories.has('/repo/app')).toBe(false);
  });

  test('loads the next 20 root sessions from the stored cursor and appends them', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const makePage = (start: number) => Array.from({ length: 20 }, (_, index) => ({
      id: `ses_${start + index}`,
      title: `Session ${start + index}`,
      directory: '/repo/app',
      time: { created: 100 - start - index, updated: 100 - start - index },
    } as Session));
    const list = async (input: Record<string, unknown>) => {
      calls.push(input);
      return {
        data: input.cursor === undefined ? makePage(0) : makePage(20),
        error: undefined,
        response: new Response(null, { status: 200 }),
      };
    };
    const sdk = { experimental: { session: { list } } } as unknown as OpencodeClient;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    opencodeClient.getSdkClient = () => sdk;
    restoreGetSdkClient = () => { opencodeClient.getSdkClient = originalGetSdkClient; };

    await useGlobalSessionsStore.getState().refreshSessionsForDirectories(['/repo/app']);
    await useGlobalSessionsStore.getState().loadMoreSessionsForDirectory('/repo/app');

    expect(calls.length).toBe(2);
    expect(calls[1]).toEqual({
      directory: '/repo/app',
      archived: false,
      roots: true,
      cursor: 81,
      limit: 20,
    });
    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/app')?.length).toBe(40);
    expect(useGlobalSessionsStore.getState().activePaginationByDirectory.get('/repo/app')).toEqual({
      cursor: 61,
      hasMore: true,
      loadingMore: false,
    });
  });

  test('aborts an in-flight directory request on runtime reset', async () => {
    let requestSignal: AbortSignal | undefined;
    const list = (_input: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
      requestSignal = options?.signal;
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    };
    const sdk = { experimental: { session: { list } } } as unknown as OpencodeClient;
    const originalGetSdkClient = opencodeClient.getSdkClient;
    opencodeClient.getSdkClient = () => sdk;
    restoreGetSdkClient = () => { opencodeClient.getSdkClient = originalGetSdkClient; };

    const refresh = useGlobalSessionsStore.getState().refreshSessionsForDirectories(['/repo/app']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
    await refresh;

    expect(requestSignal?.aborted).toBe(true);
    expect(useGlobalSessionsStore.getState().status).toBe('idle');
    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([]);
  });

  test('updates an existing session when the share URL changes', () => {
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/a'));
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/b'));

    expect(useGlobalSessionsStore.getState().activeSessions[0]?.share?.url).toBe('https://share.example/b');
  });

  test('preserves directory metadata when a live update omits it', () => {
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/a', { directory: '/repo/app' }));
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/b', {
      time: { created: 1, updated: 3 },
    }));

    const session = useGlobalSessionsStore.getState().activeSessions[0];
    expect(resolveGlobalSessionDirectory(session)).toBe('/repo/app');
    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/app')?.[0]?.id).toBe('ses_1');
  });

  test('preserves raw directory metadata when a live update only has project worktree', () => {
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/a', { directory: '/repo/app' }));
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/b', {
      project: { worktree: '/repo/app' },
      time: { created: 1, updated: 3 },
    }));

    const session = useGlobalSessionsStore.getState().activeSessions[0] as Session & { directory?: string | null };
    expect(session.directory).toBe('/repo/app');
    expect(resolveGlobalSessionDirectory(session)).toBe('/repo/app');
  });

  test('trusts explicit incoming raw directory metadata', () => {
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/a', { directory: '/repo/app' }));
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/b', {
      directory: '/repo/app-worktree',
      time: { created: 1, updated: 3 },
    }));

    expect(resolveGlobalSessionDirectory(useGlobalSessionsStore.getState().activeSessions[0])).toBe('/repo/app-worktree');
    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/app')).toBe(undefined);
    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/app-worktree')?.[0]?.id).toBe('ses_1');
  });

  test('preserves directory metadata when moving a session to archived', () => {
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/a', { directory: '/repo/app' }));
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/b', {
      time: { created: 1, updated: 3, archived: 4 },
    }));

    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([]);
    expect(resolveGlobalSessionDirectory(useGlobalSessionsStore.getState().archivedSessions[0])).toBe('/repo/app');
  });
});

describe('mergeLiveSessionWithGlobalSession', () => {
  test('preserves global share over live share', () => {
    const live = buildSession('https://live.example/s', { time: { created: 1, updated: 5 } });
    const global = buildSession('https://global.example/s', { time: { created: 1, updated: 3 } });

    const merged = mergeLiveSessionWithGlobalSession(live, global);
    expect(merged.share?.url).toBe('https://global.example/s');
    expect(merged.time?.updated).toBe(5);
  });

  test('preserves directory from global when live omits it', () => {
    const live = buildSession('https://live.example/s', { time: { created: 1, updated: 5 } });
    const global = buildSession('https://global.example/s', { directory: '/repo/app' });

    const merged = mergeLiveSessionWithGlobalSession(live, global);
    expect(resolveGlobalSessionDirectory(merged)).toBe('/repo/app');
  });

  test('live directory takes precedence over global when present', () => {
    const live = buildSession('https://live.example/s', { directory: '/repo/worktree' });
    const global = buildSession('https://global.example/s', { directory: '/repo/app' });

    const merged = mergeLiveSessionWithGlobalSession(live, global);
    expect(resolveGlobalSessionDirectory(merged)).toBe('/repo/worktree');
  });
});
