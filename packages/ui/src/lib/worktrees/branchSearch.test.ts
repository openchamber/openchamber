import { describe, expect, test } from 'bun:test';

import { rankBranchesForQuery } from './branchSearch';

describe('rankBranchesForQuery', () => {
  test('empty query keeps the local branches in the other group', () => {
    const result = rankBranchesForQuery({ localBranches: ['main'], remoteBranches: ['origin/dev'], query: ' ' });
    expect(result.matching).toEqual([]);
    expect(result.otherLocal).toEqual(['main']);
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
  });

  test('remote matches carry the remotes/ checkout value', () => {
    const result = rankBranchesForQuery({ localBranches: [], remoteBranches: ['origin/feat/x'], query: 'feat' });
    expect(result.matching[0].value).toBe('remotes/origin/feat/x');
  });
});
