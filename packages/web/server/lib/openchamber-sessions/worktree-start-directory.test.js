import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import { createStartDirectoryResolver } from './worktree-start-directory.js';
import { createSessionDirectoryCanonicalizer } from '../opencode/directory-canonicalization.js';

const inside = async () => ({ valid: true, insideWorktreeRoot: true });

const build = (overrides = {}) => {
  const reads = [];
  const checks = [];
  const resolve = createStartDirectoryResolver({
    resolveWorktreeTopLevel: async (directory) => { reads.push(directory); return { prefix: 'ai' }; },
    validateWorktreeDirectory: async (directory, root) => { checks.push([directory, root]); return inside(); },
    warn: () => {},
    ...overrides,
  });
  return { resolve, reads, checks };
};

describe('start directory resolver', () => {
  it('answers the path OpenCode will store while it shares this filesystem, and the checkout spelling otherwise', async () => {
    const realpath = async (directory) => directory.replace('/link/', '/real/');
    const local = build({ getSessionDirectoryCanonicalizer: createSessionDirectoryCanonicalizer({ sharesFilesystem: () => true, realpath }) });
    expect(await local.resolve({ projectPath: '/repo/ai', worktreeRoot: '/link/feat' })).toEqual({ directory: path.join('/real/feat', 'ai'), fallback: null });
    expect(local.checks).toEqual([[path.join('/link/feat', 'ai'), '/link/feat']]);
    const remote = build({ getSessionDirectoryCanonicalizer: createSessionDirectoryCanonicalizer({ sharesFilesystem: () => false, realpath }) });
    expect(await remote.resolve({ projectPath: '/repo/ai', worktreeRoot: '/link/feat' })).toEqual({ directory: path.join('/link/feat', 'ai'), fallback: null });
  });

  it('starts in the project folder inside the worktree when the project sits on a folder of its repository', async () => {
    const { resolve, reads, checks } = build();
    expect(await resolve({ projectPath: '/repo/ai', worktreeRoot: '/wt/feat' }))
      .toEqual({ directory: path.join('/wt/feat', 'ai'), fallback: null });
    expect(reads).toEqual(['/repo/ai']);
    expect(checks).toEqual([[path.join('/wt/feat', 'ai'), '/wt/feat']]);
  });

  it('starts in the worktree root, without checking the disk, when the project is the repository root', async () => {
    const { resolve, checks } = build({ resolveWorktreeTopLevel: async () => ({ prefix: '' }) });
    expect(await resolve({ projectPath: '/repo', worktreeRoot: '/wt/feat' })).toEqual({ directory: '/wt/feat', fallback: null });
    expect(checks).toEqual([]);
  });

  it('names a folder the checkout lacks or that leaves it through a symlink', async () => {
    const missing = build({ validateWorktreeDirectory: async () => ({ valid: false, insideWorktreeRoot: false }) });
    expect(await missing.resolve({ projectPath: '/repo/ai', worktreeRoot: '/wt/feat' })).toEqual({ directory: '/wt/feat', fallback: 'missing' });
    const escaped = build({ validateWorktreeDirectory: async () => ({ valid: true, insideWorktreeRoot: false }) });
    expect(await escaped.resolve({ projectPath: '/repo/ai', worktreeRoot: '/wt/feat' })).toEqual({ directory: '/wt/feat', fallback: 'missing' });
  });

  it('names an unreadable project folder and a failing check instead of treating them as "at the root"', async () => {
    const unreadable = build({ resolveWorktreeTopLevel: async () => { throw new Error('git'); } });
    expect(await unreadable.resolve({ projectPath: '/repo/ai', worktreeRoot: '/wt/feat' })).toEqual({ directory: '/wt/feat', fallback: 'unknown' });
    const noPrefix = build({ resolveWorktreeTopLevel: async () => ({ root: '/repo/ai' }) });
    expect(await noPrefix.resolve({ projectPath: '/repo/ai', worktreeRoot: '/wt/feat' })).toEqual({ directory: '/wt/feat', fallback: 'unknown' });
    const unchecked = build({ validateWorktreeDirectory: async () => { throw new Error('git'); } });
    expect(await unchecked.resolve({ projectPath: '/repo/ai', worktreeRoot: '/wt/feat' })).toEqual({ directory: '/wt/feat', fallback: 'unverified' });
  });
});
