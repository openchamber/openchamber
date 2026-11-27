import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createChatsScope } from './chats-scope.js';

const temporaryRoots = [];

// The real spelling of the temporary root: on macOS TMPDIR sits behind /var -> /private/var.
const createTemporaryRoot = async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'chats-scope-')));
  temporaryRoots.push(root);
  return root;
};

const linkDirectory = (target, link) => symlink(target, link, process.platform === 'win32' ? 'junction' : undefined);

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
    await linkDirectory(realChats, aliasChats);

    const scope = createChatsScope(aliasChats);
    await expect(scope.refreshRealRoot()).resolves.toBe(realChats);

    expect(scope.contains(path.join(aliasChats, '2026-11-19', 'session-a'))).toBe(true);
    expect(scope.contains(path.join(realChats, '2026-11-19', 'session-b'))).toBe(true);
  });

  it('knows the resolved root on a fresh install, before the chats directory exists', async () => {
    const root = await createTemporaryRoot();
    const realParent = path.join(root, 'data');
    const aliasParent = path.join(root, 'home');
    await mkdir(realParent, { recursive: true });
    await linkDirectory(realParent, aliasParent);

    const configuredRoot = path.join(aliasParent, 'chats');
    const resolvedRoot = path.join(realParent, 'chats');
    const scope = createChatsScope(configuredRoot);
    await expect(scope.refreshRealRoot()).resolves.toBe(resolvedRoot);

    await mkdir(path.join(configuredRoot, '2026-11-19', 'session-a'), { recursive: true });

    expect(scope.contains(path.join(configuredRoot, '2026-11-19', 'session-a'))).toBe(true);
    expect(scope.contains(path.join(resolvedRoot, '2026-11-19', 'session-a'))).toBe(true);
  });

  it('still rejects a directory outside the chats tree', async () => {
    const root = await createTemporaryRoot();
    const realChats = path.join(root, 'data', 'chats');
    const aliasChats = path.join(root, 'home', 'chats');
    await mkdir(realChats, { recursive: true });
    await mkdir(path.dirname(aliasChats), { recursive: true });
    await linkDirectory(realChats, aliasChats);

    const scope = createChatsScope(aliasChats);
    await scope.refreshRealRoot();

    expect(scope.contains(path.join(root, 'data', 'work'))).toBe(false);
    expect(scope.contains(path.join(root, 'data', 'chats-other', '2026-11-19', 'session-a'))).toBe(false);
    expect(scope.contains('/home/me/chats-other/2026-11-19/session-a')).toBe(false);
  });
});
