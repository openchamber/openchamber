import { describe, expect, it } from 'vitest';
import { isLinkedWorktreeAnswer } from './worktree-type.js';

describe('isLinkedWorktreeAnswer', () => {
  it('reads the answer of a Git older than 2.31, which prints the flag back and relative paths', () => {
    // What git 2.26.2 prints for WORKTREE_TYPE_ARGS.
    expect(isLinkedWorktreeAnswer('/repo', '--path-format=absolute\n.git\n.git\n')).toBe(false);
    expect(isLinkedWorktreeAnswer('/repo/apps/web', '--path-format=absolute\n/repo/.git\n../../.git\n')).toBe(false);
    expect(isLinkedWorktreeAnswer('/wt/apps/web', '--path-format=absolute\n/repo/.git/worktrees/wt\n/repo/.git\n')).toBe(true);
    expect(isLinkedWorktreeAnswer('/bare.git', '--path-format=absolute\n.\n.\n')).toBe(false);
  });
});
