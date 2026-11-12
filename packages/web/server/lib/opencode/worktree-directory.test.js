import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWorktreeDirectory } from './worktree-directory.js';

const primaryWorktree = path.join(path.sep, 'projects', 'my-app');
const homeDirectory = path.join(path.sep, 'home', 'dev');

describe('resolveWorktreeDirectory', () => {
  it('returns null when the setting is absent or not a non-empty string', () => {
    expect(resolveWorktreeDirectory({}, primaryWorktree, homeDirectory)).toBeNull();
    expect(resolveWorktreeDirectory({ worktree: {} }, primaryWorktree, homeDirectory)).toBeNull();
    expect(resolveWorktreeDirectory({ worktree: { directory: null } }, primaryWorktree, homeDirectory)).toBeNull();
    expect(resolveWorktreeDirectory({ worktree: { directory: '   ' } }, primaryWorktree, homeDirectory)).toBeNull();
    expect(resolveWorktreeDirectory({ worktree: { directory: 42 } }, primaryWorktree, homeDirectory)).toBeNull();
    expect(resolveWorktreeDirectory({ worktree: 'nope' }, primaryWorktree, homeDirectory)).toBeNull();
    expect(resolveWorktreeDirectory(null, primaryWorktree, homeDirectory)).toBeNull();
  });

  it('resolves a relative folder against the canonical checkout', () => {
    expect(resolveWorktreeDirectory({ worktree: { directory: '.worktrees' } }, primaryWorktree, homeDirectory))
      .toBe(path.join(primaryWorktree, '.worktrees'));
    expect(resolveWorktreeDirectory({ worktree: { directory: '../trees' } }, primaryWorktree, homeDirectory))
      .toBe(path.join(path.dirname(primaryWorktree), 'trees'));
  });

  it('uses an absolute path as-is', () => {
    const absolute = path.join(path.sep, 'var', 'trees');
    expect(resolveWorktreeDirectory({ worktree: { directory: absolute } }, primaryWorktree, homeDirectory))
      .toBe(absolute);
  });

  it('expands a leading ~ against the home directory', () => {
    expect(resolveWorktreeDirectory({ worktree: { directory: '~' } }, primaryWorktree, homeDirectory))
      .toBe(homeDirectory);
    expect(resolveWorktreeDirectory({ worktree: { directory: '~/trees' } }, primaryWorktree, homeDirectory))
      .toBe(path.join(homeDirectory, 'trees'));
  });
});
