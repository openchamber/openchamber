import { describe, expect, it } from 'vitest';

import {
  hasPullRequestIdentity,
  resolvePullRequestSourceInput,
} from '../src/resolvePullRequestSourceInput.js';

describe('resolvePullRequestSourceInput', () => {
  it('returns null when no PR number is attached', () => {
    expect(resolvePullRequestSourceInput({})).toBeNull();
    expect(resolvePullRequestSourceInput({ prNumber: '' })).toBeNull();
    expect(resolvePullRequestSourceInput(null)).toBeNull();
    expect(resolvePullRequestSourceInput(undefined)).toBeNull();
  });

  it('builds a minimal source when only the PR number is provided', () => {
    const result = resolvePullRequestSourceInput({ prNumber: 42 });
    expect(result).toEqual({
      pullRequest: { number: 42, sourceRef: 'refs/pull/42/head' },
      headBranch: '',
      baseRemote: '',
      fork: null,
    });
  });

  it('prefers upstreamBranch for head branch', () => {
    const result = resolvePullRequestSourceInput({
      prNumber: 5,
      upstreamBranch: 'feature/cool',
      existingBranch: 'origin/feature/cool',
    });
    expect(result?.headBranch).toBe('feature/cool');
  });

  it('falls back to bare <remote>/<branch> existingBranch', () => {
    const result = resolvePullRequestSourceInput({
      prNumber: 5,
      existingBranch: 'origin/feature/cool',
    });
    expect(result?.headBranch).toBe('feature/cool');
  });

  it('falls back to remotes/<remote>/<branch> existingBranch', () => {
    const result = resolvePullRequestSourceInput({
      prNumber: 5,
      existingBranch: 'remotes/origin/feature/cool',
    });
    expect(result?.headBranch).toBe('feature/cool');
  });

  it('falls back to refs/remotes/<remote>/<branch> existingBranch', () => {
    const result = resolvePullRequestSourceInput({
      prNumber: 5,
      existingBranch: 'refs/remotes/origin/feature/cool',
    });
    expect(result?.headBranch).toBe('feature/cool');
  });

  it('strips refs/heads/ from head branch', () => {
    const result = resolvePullRequestSourceInput({
      prNumber: 5,
      upstreamBranch: 'refs/heads/feature/cool',
    });
    expect(result?.headBranch).toBe('feature/cool');
  });

  it('omits fork when ensureRemoteName or ensureRemoteUrl is missing', () => {
    const result = resolvePullRequestSourceInput({
      prNumber: 5,
      upstreamBranch: 'feature',
      ensureRemoteName: 'fork',
      // ensureRemoteUrl intentionally missing
      baseRemote: 'origin',
    });
    expect(result?.fork).toBeNull();
  });

  it('omits fork when head branch is empty', () => {
    const result = resolvePullRequestSourceInput({
      prNumber: 5,
      ensureRemoteName: 'fork',
      ensureRemoteUrl: 'git@github.com:fork/repo.git',
      baseRemote: 'origin',
    });
    expect(result?.fork).toBeNull();
  });

  it('builds fork when all fork fields are present', () => {
    const result = resolvePullRequestSourceInput({
      prNumber: 5,
      upstreamBranch: 'feature/cool',
      ensureRemoteName: 'fork',
      ensureRemoteUrl: 'git@github.com:fork/repo.git',
      baseRemote: 'origin',
    });
    expect(result?.fork).toEqual({
      remote: 'fork',
      url: 'git@github.com:fork/repo.git',
      branch: 'feature/cool',
    });
    expect(result?.baseRemote).toBe('origin');
  });

  it('captures baseRemote even when fork is omitted', () => {
    const result = resolvePullRequestSourceInput({
      prNumber: 5,
      baseRemote: 'origin',
    });
    expect(result?.baseRemote).toBe('origin');
    expect(result?.fork).toBeNull();
  });
});

describe('hasPullRequestIdentity', () => {
  it('is true for any non-blank PR value', () => {
    expect(hasPullRequestIdentity({ prNumber: 1 })).toBe(true);
    expect(hasPullRequestIdentity({ prNumber: '2' })).toBe(true);
    expect(hasPullRequestIdentity({ prNumber: '  3  ' })).toBe(true);
  });

  it('is false for missing or blank values', () => {
    expect(hasPullRequestIdentity({})).toBe(false);
    expect(hasPullRequestIdentity({ prNumber: '' })).toBe(false);
    expect(hasPullRequestIdentity({ prNumber: '   ' })).toBe(false);
    expect(hasPullRequestIdentity({ prNumber: null })).toBe(false);
    expect(hasPullRequestIdentity({ prNumber: undefined })).toBe(false);
  });
});
