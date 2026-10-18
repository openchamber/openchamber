import { describe, expect, test } from 'bun:test';
import type { WorktreeMetadata } from '@/types/worktree';
import { findWorktreeHoldingDirectory, projectPathForCheckoutFolder } from './worktreePaths';

describe('findWorktreeHoldingDirectory', () => {
  const worktree = (path: string): WorktreeMetadata => ({ path, projectDirectory: '/repo', branch: 'b', label: 'b' });

  test('finds the worktree for its root and for a sub-folder inside it', () => {
    const alpha = worktree('/worktrees/alpha');
    expect(findWorktreeHoldingDirectory([alpha], '/worktrees/alpha')).toBe(alpha);
    expect(findWorktreeHoldingDirectory([alpha], '/worktrees/alpha/ai')).toBe(alpha);
    expect(findWorktreeHoldingDirectory([alpha], '/worktrees/alpha/')).toBe(alpha);
  });

  test('does not match a sibling that shares a name prefix', () => {
    expect(findWorktreeHoldingDirectory([worktree('/worktrees/alpha')], '/worktrees/alpha-two/ai')).toBeUndefined();
  });

  test('prefers the longest checkout when worktrees nest', () => {
    const outer = worktree('/worktrees/outer');
    const inner = worktree('/worktrees/outer/inner');
    expect(findWorktreeHoldingDirectory([outer, inner], '/worktrees/outer/inner/ai')).toBe(inner);
    expect(findWorktreeHoldingDirectory([inner, outer], '/worktrees/outer/ai')).toBe(outer);
  });

  test('returns undefined for an empty directory', () => {
    expect(findWorktreeHoldingDirectory([worktree('/worktrees/alpha')], '')).toBeUndefined();
  });
});

describe('projectPathForCheckoutFolder', () => {
  const projectPaths = ['/repo', '/repo/ai'];

  test('a session in a worktree folder follows the project of that folder, not the repository root', () => {
    expect(projectPathForCheckoutFolder({ directory: '/worktrees/wt-a/ai/src', folder: 'ai/src', primaryRoot: '/repo', projectPaths }))
      .toBe('/repo/ai');
  });

  test('a session at the worktree root follows the repository root project', () => {
    expect(projectPathForCheckoutFolder({ directory: '/worktrees/wt-a', folder: '', primaryRoot: '/repo', projectPaths }))
      .toBe('/repo');
  });

  test('a worktree inside the repository folder does not belong to the project around it', () => {
    expect(projectPathForCheckoutFolder({ directory: '/repo/.worktrees/a/ai', folder: 'ai', primaryRoot: '/repo', projectPaths }))
      .toBe('/repo/ai');
  });

  test('in the primary checkout the longest containing project wins', () => {
    expect(projectPathForCheckoutFolder({ directory: '/repo/ai/src', folder: 'ai/src', primaryRoot: '/repo', projectPaths }))
      .toBe('/repo/ai');
  });

  test('does not match a project folder that only shares a name prefix', () => {
    expect(projectPathForCheckoutFolder({ directory: '/worktrees/wt-a/ai-tools', folder: 'ai-tools', primaryRoot: '/repo', projectPaths: ['/repo/ai'] }))
      .toBeNull();
  });
});
