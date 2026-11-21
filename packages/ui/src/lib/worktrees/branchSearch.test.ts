import { describe, expect, test } from 'bun:test';

import { rankBranchesForQuery, remoteDefaultBranches, splitBranchList } from './branchSearch';

describe('rankBranchesForQuery', () => {
  test('empty query keeps everything in the other groups', () => {
    const result = rankBranchesForQuery({ localBranches: ['main'], remoteBranches: ['origin/dev'], query: ' ' });
    expect(result.matching).toEqual([]);
    expect(result.otherLocal).toEqual(['main']);
    expect(result.otherRemote).toEqual(['origin/dev']);
  });

  test('orders matches by relevance, not alphabetically', () => {
    const result = rankBranchesForQuery({
      localBranches: ['aaa-fix-scroll', 'fix/scroll', 'main'],
      remoteBranches: ['origin/fix/scroll-old'],
      query: 'fix',
    });
    expect(result.matching[0]).toEqual({ label: 'fix/scroll', value: 'fix/scroll', source: 'local' });
    expect(result.matching.map((entry) => entry.label)).toEqual([
      'fix/scroll',
      'aaa-fix-scroll',
      'origin/fix/scroll-old',
    ]);
    expect(result.otherLocal).toEqual(['main']);
    expect(result.otherRemote).toEqual([]);
  });

  test('remote matches carry the remotes/ checkout value', () => {
    const result = rankBranchesForQuery({ localBranches: [], remoteBranches: ['origin/feat/x'], query: 'feat' });
    expect(result.matching[0].value).toBe('remotes/origin/feat/x');
  });

  test('remote defaults lead an empty query and leave the remote list', () => {
    const result = rankBranchesForQuery({
      localBranches: ['main'],
      remoteBranches: ['origin/aaa', 'origin/main', 'upstream/main', 'upstream/zzz'],
      remoteDefaults: ['upstream/main', 'origin/main'],
      query: '',
    });
    expect(result.remoteDefaults).toEqual(['upstream/main', 'origin/main']);
    expect(result.otherLocal).toEqual(['main']);
    expect(result.otherRemote).toEqual(['origin/aaa', 'upstream/zzz']);
  });

  test('a query ranks remote defaults with every other branch', () => {
    const result = rankBranchesForQuery({
      localBranches: ['fix/main-menu'],
      remoteBranches: ['origin/main', 'upstream/main'],
      remoteDefaults: ['origin/main', 'upstream/main'],
      query: 'fix',
    });
    expect(result.remoteDefaults).toEqual([]);
    expect(result.matching.map((entry) => entry.label)).toEqual(['fix/main-menu']);
  });
});

describe('splitBranchList', () => {
  test('splits local and remote branches, sorted, without the remotes/ prefix', () => {
    expect(splitBranchList(['main', 'remotes/upstream/main', 'feature', 'remotes/origin/main'])).toEqual({
      localBranches: ['feature', 'main'],
      remoteBranches: ['origin/main', 'upstream/main'],
    });
    expect(splitBranchList(undefined)).toEqual({ localBranches: [], remoteBranches: [] });
  });
});

describe('remoteDefaultBranches', () => {
  const remoteBranches = ['origin/feature', 'origin/main', 'upstream/develop', 'upstream/main', 'zfork/trunk'];

  test('lists every remote default, the bound remote first and the rest by remote name', () => {
    expect(remoteDefaultBranches({
      defaultBranches: { zfork: 'trunk', origin: 'main', upstream: 'develop' },
      remoteBranches,
      primaryRemote: 'upstream',
    })).toEqual(['upstream/develop', 'origin/main', 'zfork/trunk']);
  });

  test('skips a default whose branch is not listed', () => {
    expect(remoteDefaultBranches({
      defaultBranches: { origin: 'main', upstream: 'gone' },
      remoteBranches,
      primaryRemote: 'origin',
    })).toEqual(['origin/main']);
  });

  test('lists nothing without detected defaults', () => {
    expect(remoteDefaultBranches({ defaultBranches: undefined, remoteBranches, primaryRemote: 'origin' })).toEqual([]);
    expect(remoteDefaultBranches({ defaultBranches: {}, remoteBranches, primaryRemote: 'origin' })).toEqual([]);
  });

  test('orders by remote name when the bound remote has no default', () => {
    expect(remoteDefaultBranches({
      defaultBranches: { upstream: 'main', origin: 'main' },
      remoteBranches,
      primaryRemote: 'fork',
    })).toEqual(['origin/main', 'upstream/main']);
  });
});
