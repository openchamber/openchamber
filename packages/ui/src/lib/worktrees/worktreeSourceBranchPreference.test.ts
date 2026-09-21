import { describe, expect, test } from 'bun:test';

import {
  resolveWorktreeSourceBranchPreference,
  resolveWorktreeSourceBranchToPersist,
} from './worktreeSourceBranchPreference';

describe('resolveWorktreeSourceBranchPreference', () => {
  test('keeps a valid saved source branch', () => {
    expect(resolveWorktreeSourceBranchPreference({
      branches: ['develop', 'main', 'remotes/origin/main'],
      savedSourceBranch: 'develop',
      rootBranch: 'main',
    })).toEqual({
      sourceBranch: 'develop',
      shouldClearSavedSourceBranch: false,
    });
  });

  test('falls back to the root branch and marks a stale saved branch for cleanup', () => {
    expect(resolveWorktreeSourceBranchPreference({
      branches: ['main', 'develop', 'remotes/origin/main'],
      savedSourceBranch: 'feature/stale',
      rootBranch: 'main',
    })).toEqual({
      sourceBranch: 'main',
      shouldClearSavedSourceBranch: true,
    });
  });

  test('uses a deterministic fallback when the root branch is unavailable', () => {
    expect(resolveWorktreeSourceBranchPreference({
      branches: ['feature/new', 'master'],
      savedSourceBranch: 'feature/stale',
      rootBranch: null,
    })).toEqual({
      sourceBranch: 'master',
      shouldClearSavedSourceBranch: true,
    });
  });
});

describe('resolveWorktreeSourceBranchToPersist', () => {
  test('persists the source branch for a new worktree without a linked PR', () => {
    expect(resolveWorktreeSourceBranchToPersist({
      mode: 'new-branch',
      sourceBranch: 'develop',
      linkedPr: false,
      selectedBranch: '',
    })).toBe('develop');
  });

  test('skips persisting a PR-linked source branch', () => {
    expect(resolveWorktreeSourceBranchToPersist({
      mode: 'new-branch',
      sourceBranch: 'feature/pr',
      linkedPr: true,
      selectedBranch: '',
    })).toBeNull();
  });

  test('persists the selected branch for existing-branch mode', () => {
    expect(resolveWorktreeSourceBranchToPersist({
      mode: 'existing-branch',
      sourceBranch: 'feature/unused',
      linkedPr: false,
      selectedBranch: 'hotfix/fix-123',
    })).toBe('hotfix/fix-123');
  });
});
