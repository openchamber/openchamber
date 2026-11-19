import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createChatsScope } from './chats-scope.js';

const temporaryRoots = [];

const createTemporaryRoot = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chats-scope-'));
  temporaryRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('createChatsScope.contains', () => {
  it('keeps a session created at the configured spelling', async () => {
    const scope = createChatsScope('/home/me/chats');
    expect(scope.contains('/home/me/chats/2026-11-19/session-a')).toBe(true);
  });

  it('keeps a session whose directory was resolved past a symlinked home', async () => {
    const root = await createTemporaryRoot();
    const realChats = path.join(root, 'data', 'chats');
    const aliasChats = path.join(root, 'home', 'chats');
    await mkdir(realChats, { recursive: true });
    await mkdir(path.dirname(aliasChats), { recursive: true });
    await symlink(realChats, aliasChats);

    const scope = createChatsScope(aliasChats);

    expect(scope.contains(path.join(aliasChats, '2026-11-19', 'session-a'))).toBe(true);
    expect(scope.contains(path.join(realChats, '2026-11-19', 'session-b'))).toBe(true);
  });

  it('still rejects a directory outside the chats tree', async () => {
    const scope = createChatsScope('/home/me/chats');
    expect(scope.contains('/home/me/work')).toBe(false);
    expect(scope.contains('/home/me/chats-other/2026-11-19/session-a')).toBe(false);
  });
});
