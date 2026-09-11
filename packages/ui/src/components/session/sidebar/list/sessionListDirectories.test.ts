import { describe, expect, test } from 'bun:test';
import { buildKnownSessionDirectories } from './sessionListDirectories';

describe('buildKnownSessionDirectories', () => {
  test('normalizes project roots and optionally includes worktrees', () => {
    const worktrees = new Map([
      ['/repo', [{ path: '/repo/worktree', projectDirectory: '/repo', branch: 'worktree', label: 'worktree' }]],
    ]);

    expect([...buildKnownSessionDirectories([{ path: '/Repo' }], worktrees)]).toEqual([
      '/repo',
      '/repo/worktree',
    ]);
    expect([...buildKnownSessionDirectories([{ path: '/Repo' }], worktrees, { includeWorktrees: false })]).toEqual([
      '/repo',
    ]);
  });
});
