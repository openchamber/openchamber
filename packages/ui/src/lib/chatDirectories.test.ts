import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { opencodeClient } from '@/lib/opencode/client';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { createChatDirectory, deleteChatDirectory, ensureChatsRootDirectory, getChatsRootFromDirectory, isChatDirectoryForHome, isChatDirectoryPath, warmChatsRootDirectory } from './chatDirectories';

let runtime = 0;
const nextRuntime = () => switchRuntimeEndpoint({ apiBaseUrl: 'https://chats.test', runtimeKey: `chats-${++runtime}` });
let home = spyOn(opencodeClient, 'getFilesystemHomeInfo');
let mkdir = spyOn(opencodeClient, 'createDirectory');
let request = spyOn(globalThis, 'fetch');
const deleteRequests = () => request.mock.calls.filter(([input]) => String(input).includes('/fs/delete'));

beforeEach(() => {
  nextRuntime();
  home = spyOn(opencodeClient, 'getFilesystemHomeInfo').mockResolvedValue({ home: '/home/user', chatsRoot: '/srv/chats' });
  mkdir = spyOn(opencodeClient, 'createDirectory').mockResolvedValue({ success: true, path: '/unused' });
  request = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
});
afterEach(() => { home.mockRestore(); mkdir.mockRestore(); request.mockRestore(); });

describe('server-owned chat directories', () => {
  test('creates beneath the relocated root and uses the legacy root only for an older response', async () => {
    expect((await createChatDirectory(new Date(2026, 8, 5))).startsWith('/srv/chats/2026-09-05/session-')).toBe(true);
    nextRuntime();
    home.mockResolvedValue({ home: '/home/user' });
    expect((await createChatDirectory(new Date(2026, 8, 5))).startsWith('/home/user/.config/openchamber/chats/2026-09-05/session-')).toBe(true);
  });

  test('classifies only exact configured and actual legacy roots after warming', async () => {
    expect(isChatDirectoryPath('/work/backup/.config/openchamber/chats/project')).toBe(false);
    await ensureChatsRootDirectory();
    expect(isChatDirectoryPath('/srv/chats/day/session-a')).toBe(true);
    expect(isChatDirectoryPath('/home/user/.config/openchamber/chats/day/session-a')).toBe(true);
    expect(isChatDirectoryPath('/work/backup/.config/openchamber/chats/project')).toBe(false);
    expect(isChatDirectoryPath('/srv/chats-other/session-a')).toBe(false);
    expect(getChatsRootFromDirectory('/srv/chats/day/session-a')).toBe('/srv/chats');
    expect(isChatDirectoryForHome('/other/.config/openchamber/chats/session-a', '/home/user')).toBe(false);
  });

  test('deletes real descendants but never shared roots, lookalikes, or traversal paths', async () => {
    for (const path of ['/srv/chats', '/home/user/.config/openchamber/chats', '/work/backup/.config/openchamber/chats/project', '/srv/chats/../project']) {
      await deleteChatDirectory(path);
    }
    expect(deleteRequests()).toHaveLength(0);
    await deleteChatDirectory('/srv/chats/day/session-a');
    await deleteChatDirectory('/home/user/.config/openchamber/chats/day/session-b');
    expect(deleteRequests()).toHaveLength(2);
  });

  test('does not adopt or delete a distinct case-variant project beside a server-owned root', async () => {
    await ensureChatsRootDirectory();
    expect(isChatDirectoryPath('/srv/Chats/project')).toBe(false);
    expect(getChatsRootFromDirectory('/srv/Chats/project')).toBeNull();
    await deleteChatDirectory('/srv/Chats/project');
    expect(deleteRequests()).toHaveLength(0);
  });

  test('recognizes server-confirmed aliases without changing folder scope identities', async () => {
    home.mockResolvedValue({
      home: '/Users/wayne', chatsRoot: '/srv/chat-alias',
      canonicalChatsRoot: '/storage/Chats',
      canonicalLegacyChatsRoot: '/Users/Wayne/.config/openchamber/chats',
    });
    await ensureChatsRootDirectory();
    expect(getChatsRootFromDirectory('/storage/Chats/day/session-a')).toBe('/srv/chat-alias');
    expect(getChatsRootFromDirectory('/Users/Wayne/.config/openchamber/chats/day/session-a')).toBe('/Users/wayne/.config/openchamber/chats');
    expect(isChatDirectoryPath('/storage/chats/project')).toBe(false);
    expect(isChatDirectoryPath('/storage/Chats-other/project')).toBe(false);
    for (const root of ['/srv/chat-alias', '/storage/Chats', '/Users/wayne/.config/openchamber/chats', '/Users/Wayne/.config/openchamber/chats']) {
      await deleteChatDirectory(root);
    }
    expect(deleteRequests()).toHaveLength(0);
    await deleteChatDirectory('/storage/Chats/day/session-a');
    expect(deleteRequests()).toHaveLength(1);
  });

  test('parses filesystem aliases from the home API and rejects relative aliases', async () => {
    home.mockRestore();
    request.mockResolvedValue(new Response(JSON.stringify({
      home: '/Users/wayne', chatsRoot: '/Users/wayne/.config/openchamber/chats',
      canonicalChatsRoot: '/Users/Wayne/.config/openchamber/chats',
    })));
    await ensureChatsRootDirectory();
    expect(isChatDirectoryPath('/Users/Wayne/.config/openchamber/chats/session-a')).toBe(true);
    nextRuntime();
    request.mockResolvedValue(new Response(JSON.stringify({ home: '/home/user', canonicalChatsRoot: '../project' })));
    await expect(deleteChatDirectory('/home/user/.config/openchamber/chats/session-a')).rejects.toThrow();
    expect(deleteRequests()).toHaveLength(0);
  });

  test('failed root lookup never creates or deletes, and the next attempt retries', async () => {
    home.mockRejectedValueOnce(new Error('offline'));
    await expect(deleteChatDirectory('/srv/chats/day/session-a')).rejects.toThrow('offline');
    expect(deleteRequests()).toHaveLength(0);
    home.mockRejectedValueOnce(new Error('offline'));
    await warmChatsRootDirectory();
    await createChatDirectory();
    expect(mkdir.mock.calls).toHaveLength(1);
    expect(home.mock.calls).toHaveLength(3);
  });

  test('runtime switch during root lookup cannot delete on the destination runtime', async () => {
    let resolve!: (value: { home: string; chatsRoot: string }) => void;
    home.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const deletion = deleteChatDirectory('/srv/chats/day/session-a');
    nextRuntime();
    resolve({ home: '/home/user', chatsRoot: '/srv/chats' });
    await expect(deletion).rejects.toThrow('Runtime changed');
    expect(deleteRequests()).toHaveLength(0);
  });
});
