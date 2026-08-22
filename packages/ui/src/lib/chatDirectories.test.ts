import { beforeEach, describe, expect, mock, test } from 'bun:test';

const createdDirectories: string[] = [];
const createDirectoryOptions: Array<{ allowOutsideWorkspace?: boolean } | undefined> = [];
const deletedDirectories: string[] = [];

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getFilesystemHome: mock(async () => '/Users/tester'),
    createDirectory: mock(async (path: string, options?: { allowOutsideWorkspace?: boolean }) => {
      createdDirectories.push(path);
      createDirectoryOptions.push(options);
      return { success: true, path };
    }),
  },
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async (_path: string, init?: RequestInit) => {
    deletedDirectories.push(JSON.parse(String(init?.body)).path);
    return new Response(null, { status: 200 });
  }),
}));

const { createChatDirectory, deleteChatDirectory, getChatsRootFromDirectory, isChatDirectoryForHome, isChatDirectoryPath } = await import('./chatDirectories');

describe('chat directories', () => {
  beforeEach(() => {
    createdDirectories.length = 0;
    createDirectoryOptions.length = 0;
    deletedDirectories.length = 0;
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
