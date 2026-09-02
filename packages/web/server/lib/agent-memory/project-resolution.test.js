import { describe, expect, test } from 'bun:test';

import { createMemoryProjectResolver } from './project-resolution.js';
import { createProjectIdFromPath } from '../projects/project-id.js';

const PROJECT = '/Users/x/projects/openchamber';
const WORKTREE = '/Users/x/.local/share/opencode/worktree/abc/jammy-koala';

const createResolver = (overrides = {}) => createMemoryProjectResolver({
  listProjectPaths: async () => [PROJECT],
  resolvePrimaryWorktreeRoot: async (directory) => (
    directory === WORKTREE ? { root: PROJECT } : { root: directory }
  ),
  ...overrides,
});

describe('resolving a session directory to its project', () => {
  test('a worktree resolves to the project it belongs to', async () => {
    const resolve = createResolver();

    // The bug this exists for: keyed by its own path, a worktree wrote memory
    // into a project the panel never reads.
    expect(await resolve(WORKTREE)).toBe(createProjectIdFromPath(PROJECT));
  });

  test('the project directory resolves to itself', async () => {
    const resolve = createResolver();

    expect(await resolve(PROJECT)).toBe(createProjectIdFromPath(PROJECT));
  });

  test('every worktree of one repository shares a store', async () => {
    const second = '/Users/x/.local/share/opencode/worktree/abc/other';
    const resolve = createResolver({
      resolvePrimaryWorktreeRoot: async () => ({ root: PROJECT }),
    });

    expect(await resolve(WORKTREE)).toBe(await resolve(second));
  });

  test('a worktree registered as a project in its own right keeps its own store', async () => {
    // The user's explicit choice wins over the git topology.
    const resolve = createResolver({ listProjectPaths: async () => [PROJECT, WORKTREE] });

    expect(await resolve(WORKTREE)).toBe(createProjectIdFromPath(WORKTREE));
  });

  test('a directory outside any repository keys by itself', async () => {
    const resolve = createResolver();

    expect(await resolve('/tmp/loose')).toBe(createProjectIdFromPath('/tmp/loose'));
  });

  test('managed chat session directories share the Chats root store', async () => {
    const chatsRoot = '/Users/x/.config/openchamber/chats';
    const resolve = createResolver({ managedProjectRoots: [chatsRoot] });

    expect(await resolve(`${chatsRoot}/2026-08-21/session-a`)).toBe(createProjectIdFromPath(chatsRoot));
    expect(await resolve(`${chatsRoot}/2026-08-21/session-b`)).toBe(createProjectIdFromPath(chatsRoot));
    expect(await resolve('/Users/x/.config/openchamber/chats-other/session-a')).not.toBe(createProjectIdFromPath(chatsRoot));
  });

  test('no directory resolves to nothing rather than to some default project', async () => {
    const resolve = createResolver();

    expect(await resolve('')).toBe('');
    expect(await resolve(null)).toBe('');
  });

  test('trailing slashes and relative segments do not fork the store', async () => {
    const resolve = createResolver();

    expect(await resolve(`${PROJECT}/`)).toBe(createProjectIdFromPath(PROJECT));
    expect(await resolve(`${PROJECT}/packages/..`)).toBe(createProjectIdFromPath(PROJECT));
  });
});

describe('when something is unavailable', () => {
  test('an unreadable project list still converges worktrees on the repository', async () => {
    const resolve = createResolver({
      listProjectPaths: async () => { throw new Error('settings unreadable'); },
    });

    expect(await resolve(WORKTREE)).toBe(createProjectIdFromPath(PROJECT));
  });

  test('git being unavailable falls back to the directory instead of failing', async () => {
    const resolve = createResolver({
      resolvePrimaryWorktreeRoot: async () => { throw new Error('git missing'); },
    });

    expect(await resolve(WORKTREE)).toBe(createProjectIdFromPath(WORKTREE));
  });
});
