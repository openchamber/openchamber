import { beforeEach, describe, expect, test } from 'bun:test';
import { directoryEnvironment } from './test-support/directoryEnvironment';
import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import type { SessionPage } from '@/lib/opencode/client';

const environment = directoryEnvironment({ home: '/home/test', lastDirectory: '/a/1' });
const calls: Array<{ runtime: string; directory?: string | null }> = [];
let listPage: (directory?: string | null) => Promise<SessionPage> = async () => ({ sessions: [], cursor: {} });
environment.respond(async (url) => {
  if (url.pathname === '/api/session') {
    const directory = url.searchParams.get('directory');
    if (!directory) return Response.json({ data: [], cursor: {} });
    calls.push({ runtime: getRuntimeKey(), directory });
    const page = await listPage(directory);
    return Response.json({ data: page.sessions, cursor: page.cursor });
  }
  if (url.pathname === '/api/fs/home') return Response.json({ home: '/home/test', chatsRoot: '/chats' });
  if (url.pathname === '/api/fs/directory-stats') return Response.json({ results: [{ path: '/a/1', isDirectory: true }] });
  if (url.pathname === '/api/location') return Response.json({}, { status: 401 });
  throw new Error(`Unexpected request: ${url}`);
});
const { opencodeClient } = await import('@/lib/opencode/client');
const { useGlobalSessionsStore } = await import('./useGlobalSessionsStore');
const { flushPendingSessionWrites } = await import('@/sync/persist-cache');
const deferred = () => {
  let resolve = (_page: SessionPage) => {};
  const promise = new Promise<SessionPage>(done => { resolve = done; });
  return { promise, resolve };
};
const empty: SessionPage = { sessions: [], cursor: {} };
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const switchTo = (key: string, transport = key) => {
  switchRuntimeEndpoint({ apiBaseUrl: `http://${transport}.test`, runtimeKey: key });
  opencodeClient.reconnectToRuntimeBaseUrl();
};
beforeEach(() => {
  flushPendingSessionWrites();
  calls.length = 0;
  switchTo('a');
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
});

describe('directory refresh instance ownership', () => {
  test('a multi-directory refresh never starts its remaining directory after an instance round trip', async () => {
    const held = deferred();
    listPage = async () => {
      return calls.length <= 2 ? held.promise : empty;
    };
    const loading = useGlobalSessionsStore.getState().refreshSessionsForDirectories(['/a/1', '/a/2', '/a/3']);
    await flush();
    expect(calls.map(call => call.directory)).toEqual(['/a/1', '/a/2']);
    switchTo('b');
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
    switchTo('a');
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
    held.resolve(empty);
    await loading;
    expect(calls.map(call => call.directory)).toEqual(['/a/1', '/a/2']);
  });

  test('new-instance refreshes start before old requests settle and keep their own capacity', async () => {
    const oldGate = deferred();
    const newGate = deferred();
    listPage = async (directory) => {
      return directory?.startsWith('/a/') ? oldGate.promise : newGate.promise;
    };
    const old = useGlobalSessionsStore.getState().refreshSessionsForDirectories(['/a/1', '/a/2', '/a/3']);
    await flush();
    const queuedOld = useGlobalSessionsStore.getState().refreshSessionsForDirectories(['/a/4']);
    let oldSettled = false;
    void Promise.all([old, queuedOld]).then(() => { oldSettled = true; });
    await flush();
    switchTo('b');
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
    const current = useGlobalSessionsStore.getState().refreshSessionsForDirectories(['/b/1', '/b/2']);
    let third: Promise<unknown> = Promise.resolve();
    try {
      await flush();
      expect(calls).toEqual([
        { runtime: 'a', directory: '/a/1' }, { runtime: 'a', directory: '/a/2' },
        { runtime: 'b', directory: '/b/1' }, { runtime: 'b', directory: '/b/2' },
      ]);
      oldGate.resolve(empty);
      await flush();
      expect(oldSettled).toBe(true);
      third = useGlobalSessionsStore.getState().refreshSessionsForDirectories(['/b/3']);
      await flush();
      expect(calls.map(call => call.directory)).toEqual(['/a/1', '/a/2', '/b/1', '/b/2']);
    } finally {
      oldGate.resolve(empty); newGate.resolve(empty);
      await Promise.all([old, queuedOld, current, third]);
    }
    expect(calls.at(-1)).toEqual({ runtime: 'b', directory: '/b/3' });
  });

  test('same-instance transport changes retain the directory concurrency limit', async () => {
    const held = deferred();
    listPage = async () => {
      return held.promise;
    };
    const first = useGlobalSessionsStore.getState().refreshSessionsForDirectories(['/a/1', '/a/2']);
    await flush();
    switchTo('a', 'other-transport');
    const third = useGlobalSessionsStore.getState().refreshSessionsForDirectories(['/a/3']);
    try {
      await flush();
      expect(calls.map(call => call.directory)).toEqual(['/a/1', '/a/2']);
    } finally {
      held.resolve(empty);
      await Promise.all([first, third]);
    }
    expect(calls.map(call => call.directory)).toEqual(['/a/1', '/a/2', '/a/3']);
  });
});
