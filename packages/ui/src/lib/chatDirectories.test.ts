import { beforeEach, describe, expect, mock, test } from 'bun:test';

const createdDirectories: string[] = [];
const createDirectoryOptions: Array<{ allowOutsideWorkspace?: boolean } | undefined> = [];
const deletedDirectories: string[] = [];

// Null models an older server whose /api/fs/home answers without chatsRoot.
let serverChatsRoot: string | null = null;
// Queued outcomes for getFilesystemChatsRoot; an Error models a failed root
// fetch, which must not be mistaken for an older server without chatsRoot.
const chatsRootOutcomes: Array<Error | string | null> = [];
const homeRequests: string[] = [];
let testRuntimeKey = 'runtime-0';

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getFilesystemHome: mock(async () => {
      homeRequests.push('/Users/tester');
      return '/Users/tester';
    }),
    getFilesystemChatsRoot: mock(async () => {
      const outcome = chatsRootOutcomes.shift();
      if (outcome instanceof Error) throw outcome;
      return outcome !== undefined ? outcome : serverChatsRoot;
    }),
    createDirectory: mock(async (path: string, options?: { allowOutsideWorkspace?: boolean }) => {
      createdDirectories.push(path);
      createDirectoryOptions.push(options);
      return { success: true, path };
    }),
  },
}));

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => testRuntimeKey,
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async (_path: string, init?: RequestInit) => {
    deletedDirectories.push(JSON.parse(String(init?.body)).path);
    return new Response(null, { status: 200 });
  }),
}));

const { createChatDirectory, deleteChatDirectory, getChatsRootForHome, getChatsRootFromDirectory, isChatDirectoryForHome, isChatDirectoryPath, warmChatsRootDirectory } = await import('./chatDirectories');

describe('chat directories', () => {
  beforeEach(() => {
    createdDirectories.length = 0;
    createDirectoryOptions.length = 0;
    deletedDirectories.length = 0;
    serverChatsRoot = null;
    chatsRootOutcomes.length = 0;
    homeRequests.length = 0;
    testRuntimeKey = `runtime-${Math.random().toString(36).slice(2)}`;
  });

  test('creates one isolated directory beneath the dated chats root', async () => {
    const directory = await createChatDirectory(new Date(2026, 7, 21, 12));
    expect(createdDirectories[0]).toBe(directory);
    expect(directory.startsWith('/Users/tester/.config/openchamber/chats/2026-08-21/session-')).toBe(true);
    expect(createdDirectories).toEqual([directory]);
    expect(createDirectoryOptions).toEqual([undefined]);
  });

  test('recognizes only descendants of the managed chats root', () => {
    expect(isChatDirectoryForHome('/Users/tester/.config/openchamber/chats/2026-08-21/session-a', '/Users/tester')).toBe(true);
    expect(isChatDirectoryForHome('/Users/tester/project', '/Users/tester')).toBe(false);
    expect(isChatDirectoryForHome('/remote/home/.config/openchamber/chats/2026-08-21/session-a', '/Users/tester')).toBe(true);
    expect(isChatDirectoryPath('/remote/home/.config/openchamber/chats/2026-08-21/session-a')).toBe(true);
    expect(getChatsRootFromDirectory('/remote/home/.config/openchamber/chats/2026-08-21/session-a')).toBe('/remote/home/.config/openchamber/chats');
  });

  test('deletes managed chat directories but leaves project directories alone', async () => {
    await deleteChatDirectory('/Users/tester/.config/openchamber/chats/2026-08-21/session-a');
    await deleteChatDirectory('/Users/tester/project');
    expect(deletedDirectories).toEqual(['/Users/tester/.config/openchamber/chats/2026-08-21/session-a']);
  });
});

describe('chat directories with relocated chats root', () => {
  beforeEach(() => {
    createdDirectories.length = 0;
    createDirectoryOptions.length = 0;
    deletedDirectories.length = 0;
    serverChatsRoot = '/srv/openchamber-chats';
    chatsRootOutcomes.length = 0;
    homeRequests.length = 0;
    testRuntimeKey = `runtime-${Math.random().toString(36).slice(2)}`;
  });

  test('creates chat directories beneath the server-provided root', async () => {
    const directory = await createChatDirectory(new Date(2026, 7, 21, 12));
    expect(directory.startsWith('/srv/openchamber-chats/2026-08-21/session-')).toBe(true);
    expect(createdDirectories).toEqual([directory]);
  });

  test('classifies relocated directories synchronously once the root is warm', async () => {
    await warmChatsRootDirectory();
    await new Promise<void>((resolve) => { queueMicrotask(() => resolve()); });

    expect(isChatDirectoryPath('/srv/openchamber-chats/2026-08-21/session-a')).toBe(true);
    expect(isChatDirectoryPath('/srv/openchamber-chats')).toBe(true);
    expect(isChatDirectoryPath('/Users/tester/project')).toBe(false);
    expect(isChatDirectoryForHome('/srv/openchamber-chats/2026-08-21/session-a', '/Users/tester')).toBe(true);
    expect(getChatsRootFromDirectory('/srv/openchamber-chats/2026-08-21/session-a')).toBe('/srv/openchamber-chats');
    expect(getChatsRootForHome('/Users/tester')).toBe('/srv/openchamber-chats');
  });

  test('deletes relocated chat directories', async () => {
    await deleteChatDirectory('/srv/openchamber-chats/2026-08-21/session-a');
    await deleteChatDirectory('/Users/tester/project');
    expect(deletedDirectories).toEqual(['/srv/openchamber-chats/2026-08-21/session-a']);
  });

  test('deletes legacy chat directories under the well-known segment while relocated', async () => {
    await deleteChatDirectory('/Users/tester/.config/openchamber/chats/2026-08-21/session-legacy');
    expect(deletedDirectories).toEqual(['/Users/tester/.config/openchamber/chats/2026-08-21/session-legacy']);
  });

  test('retries the server chats root after a transient root failure', async () => {
    chatsRootOutcomes.push(new Error('transient network failure'), '/srv/openchamber-chats');
    await warmChatsRootDirectory();

    const directory = await createChatDirectory(new Date(2026, 7, 21, 12));

    expect(directory.startsWith('/srv/openchamber-chats/2026-08-21/session-')).toBe(true);
    expect(createdDirectories).toEqual([directory]);
    expect(homeRequests).toEqual([]);
  });

  test('still recognizes the well-known segment when the root is not warm', () => {
    expect(isChatDirectoryPath('/remote/home/.config/openchamber/chats/2026-08-21/session-a')).toBe(true);
    expect(isChatDirectoryPath('/srv/openchamber-chats/2026-08-21/session-a')).toBe(false);
  });
});
