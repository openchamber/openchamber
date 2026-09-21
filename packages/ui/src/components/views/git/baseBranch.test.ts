import { describe, expect, test } from 'bun:test';
import { deriveBaseBranch, hasResolvableBaseBranch } from './baseBranch';

describe('deriveBaseBranch', () => {
  test('prefers the repository default branch over conventional fallbacks', () => {
    expect(deriveBaseBranch({
      remoteNames: new Set(['origin']),
      localBranches: ['next'],
      defaultBranch: 'react',
    })).toBe('react');
  });

  test('accepts a remote-qualified default branch', () => {
    expect(deriveBaseBranch({
      remoteNames: new Set(['origin']),
      localBranches: ['next'],
      defaultBranch: 'origin/react',
    })).toBe('react');
  });

  test('keeps the more specific worktree origin ahead of the default branch', () => {
    expect(deriveBaseBranch({
      remoteNames: new Set(['origin']),
      localBranches: ['next', 'react', 'feature'],
      worktreeCreatedFromBranch: 'feature',
      defaultBranch: 'react',
    })).toBe('feature');
  });

  test('skips a hint that is the branch being compared', () => {
    // In a plain checkout the project root is the current worktree, so the root
    // branch hint is the current branch — a branch is never its own base.
    expect(deriveBaseBranch({
      remoteNames: new Set(['origin']),
      localBranches: ['next', 'react'],
      rootBranchHint: 'next',
      defaultBranch: 'react',
      headBranch: 'next',
    })).toBe('react');
  });

  test('falls back to conventional names when nothing is known', () => {
    expect(deriveBaseBranch({
      remoteNames: new Set(['origin']),
      localBranches: ['master', 'next'],
    })).toBe('master');
  });
});

describe('hasResolvableBaseBranch', () => {
  test('rejects the main fallback when it does not exist', () => {
    expect(hasResolvableBaseBranch({
      baseBranch: 'main',
      localBranches: ['next', 'react'],
      remoteBranches: ['origin/next', 'origin/react'],
    })).toBe(false);
  });

  test('accepts a base branch available through a remote-tracking ref', () => {
    // Safe because getRangeDiff resolves a base that exists only on a remote
    // through that remote rather than passing the bare name to git.
    expect(hasResolvableBaseBranch({
      baseBranch: 'main',
      localBranches: ['next'],
      remoteBranches: ['origin/main', 'origin/next'],
    })).toBe(true);
  });

  test('does not accept a differently-scoped branch that merely ends the same way', () => {
    expect(hasResolvableBaseBranch({
      baseBranch: 'main',
      localBranches: ['next'],
      remoteBranches: ['origin/feature/main'],
    })).toBe(false);
  });

  test('matches a base branch whose own name contains a slash', () => {
    expect(hasResolvableBaseBranch({
      baseBranch: 'release/2.0',
      localBranches: ['next'],
      remoteBranches: ['origin/release/2.0'],
    })).toBe(true);
  });
});
