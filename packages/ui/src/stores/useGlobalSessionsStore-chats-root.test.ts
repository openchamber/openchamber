import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { opencodeClient } from '@/lib/opencode/client';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { persistSessions, readDirCache } from '@/sync/persist-cache';
import { ensureChatsRootDirectory } from '@/lib/chatDirectories';
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
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const chat = (id: string): Session => ({
  id, slug: id, projectID: 'openchamber:chats', directory: '/srv/chats/day/session-' + id,
  title: id, version: '1', time: { created: 1, updated: 2 },
});
const scope = 'openchamber:managed-chats';
let runtime = 0;
const nextRuntime = () => switchRuntimeEndpoint({ apiBaseUrl: 'https://store-chats.test', runtimeKey: `store-chats-${++runtime}` });
let home = spyOn(opencodeClient, 'getFilesystemHomeInfo');
const originalStorage = globalThis.localStorage;

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new TestStorage() });
  nextRuntime();
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  home = spyOn(opencodeClient, 'getFilesystemHomeInfo').mockResolvedValue({ home: '/home/user', chatsRoot: '/srv/chats' });
});
afterEach(() => {
  home.mockRestore();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage });
});
const seed = async () => {
  persistSessions(scope, [chat('saved')]);
  await new Promise((resolve) => setTimeout(resolve, 70));
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
};

describe('global load owns chats-root readiness', () => {
  test('concurrent loads wait for root, hydrate before request, and preserve saved chats after list failure', async () => {
    await seed();
    const root = deferred<{ home: string; chatsRoot: string }>();
    home.mockImplementationOnce(() => root.promise);
    const list = spyOn(opencodeClient.getSdkClient().experimental.session, 'list').mockImplementation(async () => {
      expect(useGlobalSessionsStore.getState().activeSessions.map((session) => session.id)).toEqual(['saved']);
      throw new Error('offline');
    });
    try {
      const first = useGlobalSessionsStore.getState().loadSessions();
      const second = useGlobalSessionsStore.getState().loadSessions();
      expect(useGlobalSessionsStore.getState().status).toBe('idle');
      expect(list.mock.calls).toHaveLength(0);
      root.resolve({ home: '/home/user', chatsRoot: '/srv/chats' });
      await Promise.all([first, second]);
      expect(home.mock.calls).toHaveLength(1);
      expect(useGlobalSessionsStore.getState().status).toBe('error');
      expect(useGlobalSessionsStore.getState().activeSessions.map((session) => session.id)).toEqual(['saved']);
      expect(readDirCache(scope).sessions?.map((session) => session.id)).toEqual(['saved']);
    } finally { list.mockRestore(); }
  });

  test('root failure keeps the persisted seed and retries without an authoritative empty write', async () => {
    await seed();
    home.mockRejectedValueOnce(new Error('root offline'));
    await useGlobalSessionsStore.getState().loadSessions();
    expect(readDirCache(scope).sessions?.map((session) => session.id)).toEqual(['saved']);
    const list = spyOn(opencodeClient.getSdkClient().experimental.session, 'list').mockResolvedValue({
      data: [{ ...chat('saved'), project: null }], request: new Request('https://store-chats.test'), response: new Response('[]'),
    });
    try {
      await useGlobalSessionsStore.getState().loadSessions();
      expect(useGlobalSessionsStore.getState().status).toBe('ready');
      expect(useGlobalSessionsStore.getState().activeSessions.map((session) => session.id)).toEqual(['saved']);
    } finally { list.mockRestore(); }
  });

  test('local create and delete before initial load preserve the saved seed and their mutations', async () => {
    await seed();
    await ensureChatsRootDirectory();
    useGlobalSessionsStore.getState().upsertSession(chat('created'));
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(readDirCache(scope).sessions?.map((session) => session.id).sort()).toEqual(['created', 'saved']);
    useGlobalSessionsStore.getState().removeSessions(['saved']);
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(readDirCache(scope).sessions?.map((session) => session.id)).toEqual(['created']);
    const list = spyOn(opencodeClient.getSdkClient().experimental.session, 'list').mockRejectedValue(new Error('offline'));
    try {
      await useGlobalSessionsStore.getState().loadSessions();
      expect(useGlobalSessionsStore.getState().activeSessions.map((session) => session.id)).toEqual(['created']);
    } finally { list.mockRestore(); }
  });

  test('a directory refresh before the global load retires the old seed even if the full load fails', async () => {
    await seed();
    const refreshed = { ...chat('refreshed'), directory: chat('saved').directory };
    const list = spyOn(opencodeClient.getSdkClient().experimental.session, 'list').mockResolvedValue({
      data: [{ ...refreshed, project: null }], request: new Request('https://store-chats.test'), response: new Response('[]'),
    });
    try {
      await useGlobalSessionsStore.getState().refreshSessionsForDirectories([refreshed.directory]);
      expect(useGlobalSessionsStore.getState().activeSessions.map((session) => session.id)).toEqual(['refreshed']);
      list.mockRejectedValue(new Error('offline'));
      await useGlobalSessionsStore.getState().loadSessions();
      expect(useGlobalSessionsStore.getState().activeSessions.map((session) => session.id)).toEqual(['refreshed']);
      await new Promise((resolve) => setTimeout(resolve, 70));
      expect(readDirCache(scope).sessions?.map((session) => session.id)).toEqual(['refreshed']);
    } finally { list.mockRestore(); }
  });

  test('hydration retains an archive mutation and its entity index when the initial list fails', async () => {
    await seed();
    const archived = { ...chat('archived'), time: { created: 1, updated: 2, archived: 3 } };
    useGlobalSessionsStore.getState().upsertSession(archived);
    const list = spyOn(opencodeClient.getSdkClient().experimental.session, 'list').mockRejectedValue(new Error('offline'));
    try {
      await useGlobalSessionsStore.getState().loadSessions();
      const state = useGlobalSessionsStore.getState();
      expect(state.activeSessions.map((session) => session.id)).toEqual(['saved']);
      expect(state.archivedSessions).toEqual([archived]);
      expect([...state.entityById.keys()].sort()).toEqual(['archived', 'saved']);
    } finally { list.mockRestore(); }
  });

  test('runtime switch during root wait discards old work before global fetch or hydration', async () => {
    await seed();
    const root = deferred<{ home: string; chatsRoot: string }>();
    home.mockImplementationOnce(() => root.promise);
    const pending = useGlobalSessionsStore.getState().loadSessions();
    nextRuntime();
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
    root.resolve({ home: '/home/user', chatsRoot: '/srv/chats' });
    await pending;
    expect(useGlobalSessionsStore.getState().status).toBe('idle');
    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([]);
    expect(readDirCache(scope).sessions).toBe(undefined);
  });
});
