import { describe, expect, test } from 'bun:test';
import { deriveBaseBranch, hasResolvableBaseBranch, qualifyBaseRef } from './baseBranch';

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

  test('does not guess a conventional base when authoritative selection is required', () => {
    expect(deriveBaseBranch({
      remoteNames: new Set(['upstream']),
      localBranches: ['main', 'next'],
      headBranch: 'next',
      fallbackToConventional: false,
    })).toBe('');
  });

  test('rejects an unbound remote from an authoritative branch hint', () => {
    expect(deriveBaseBranch({
      remoteNames: new Set(['upstream']),
      knownRemoteNames: new Set(['origin', 'upstream']),
      localBranches: ['feature'],
      rootBranchHint: 'origin/main',
      headBranch: 'feature',
      fallbackToConventional: false,
    })).toBe('');
  });

  test('keeps a slash-containing local branch that is not a remote ref', () => {
    expect(deriveBaseBranch({
      remoteNames: new Set(['upstream']),
      knownRemoteNames: new Set(['origin', 'upstream']),
      localBranches: ['feature', 'release/2.0'],
      rootBranchHint: 'release/2.0',
      headBranch: 'feature',
      fallbackToConventional: false,
    })).toBe('release/2.0');
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

describe('qualifyBaseRef', () => {
  const repository = {
    localBranches: ['feature', 'main'],
    remoteBranches: ['origin/main', 'origin/release/2.0', 'upstream/main'],
    remoteNames: new Set(['origin', 'upstream']),
    primaryRemote: 'origin',
  };

  test('names a local branch as a local ref, so no remote is substituted for it', () => {
    expect(qualifyBaseRef('main', repository)).toBe('refs/heads/main');
    expect(qualifyBaseRef('refs/heads/main', repository)).toBe('refs/heads/main');
  });

  test('keeps a remote-tracking base on the remote the repository is bound to', () => {
    const remote = { ...repository, localBranches: ['feature'] };
    expect(qualifyBaseRef('main', remote)).toBe('origin/main');
    expect(qualifyBaseRef('origin/main', remote)).toBe('origin/main');
    expect(qualifyBaseRef('remotes/origin/release/2.0', remote)).toBe('origin/release/2.0');
  });

  test('refuses a base on another remote, however familiar its name', () => {
    // upstream/main is a different project's branch; comparing against it
    // would report changes this repository never made.
    expect(qualifyBaseRef('upstream/main', { ...repository, localBranches: ['feature'] })).toBeNull();
  });

  test('refuses what no ref answers', () => {
    expect(qualifyBaseRef(null, repository)).toBeNull();
    expect(qualifyBaseRef('   ', repository)).toBeNull();
    expect(qualifyBaseRef('never-fetched', { ...repository, localBranches: ['feature'] })).toBeNull();
    // Without a binding there is no remote authorized to supply a base.
    expect(qualifyBaseRef('main', { ...repository, localBranches: ['feature'], primaryRemote: null })).toBeNull();
  });
});
