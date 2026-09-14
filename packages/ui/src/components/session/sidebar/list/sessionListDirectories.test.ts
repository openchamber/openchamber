import { describe, expect, test } from 'bun:test';
import { buildKnownSessionDirectories } from './sessionListDirectories';

describe('buildKnownSessionDirectories', () => {
  test('normalizes project roots and optionally includes worktrees', () => {
    const worktrees = new Map([
      ['/repo', [{ path: '/repo/worktree', projectDirectory: '/repo', branch: 'worktree', label: 'worktree' }]],
    ]);

    expect([...buildKnownSessionDirectories([{ path: '/Repo' }], worktrees)]).toEqual([
      '/Repo',
      '/repo/worktree',
    ]);
    expect([...buildKnownSessionDirectories([{ path: '/Repo' }], worktrees, { includeWorktrees: false })]).toEqual([
      '/Repo',
    ]);
  });

  test('preserves POSIX path case while normalizing separators and trailing syntax', () => {
    expect([...buildKnownSessionDirectories([
      { path: '/Repo/Worktree///' },
      { path: 'C:\\Repo\\Worktree\\' },
    ], new Map())]).toEqual([
      '/Repo/Worktree',
      'c:/repo/worktree',
    ]);
  });

  test('builds one identity set for Windows aliases while keeping POSIX case distinct', () => {
    expect([...buildKnownSessionDirectories([
      { path: 'C:/Repo' },
      { path: 'c:\\repo\\' },
      { path: '/Repo' },
      { path: '/repo' },
    ], new Map())]).toEqual([
      'c:/repo',
      '/Repo',
      '/repo',
    ]);
  });
});
