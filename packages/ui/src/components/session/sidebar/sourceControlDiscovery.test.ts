import { describe, expect, test } from 'bun:test';
import { limitSourceControlDiscoveryCandidates, SOURCE_CONTROL_DISCOVERY_LIMIT } from './sourceControlDiscovery';

describe('source-control sidebar discovery', () => {
  test('keeps at most 50 unique directories in the order they are shown', () => {
    const targets = Array.from({ length: 55 }, (_, index) => ({
      directory: `/repo/worktree-${index}`,
      branch: `branch-${index}`,
    }));
    targets.splice(1, 0, { directory: '/repo/worktree-0', branch: 'duplicate-branch' });

    const candidates = limitSourceControlDiscoveryCandidates(targets);

    expect(candidates).toHaveLength(SOURCE_CONTROL_DISCOVERY_LIMIT);
    expect(new Set(candidates.map((candidate) => candidate.directory)).size).toBe(SOURCE_CONTROL_DISCOVERY_LIMIT);
    expect(candidates[0]).toEqual({ directory: '/repo/worktree-0', branch: 'branch-0' });
    expect(candidates.at(-1)).toEqual({ directory: '/repo/worktree-49', branch: 'branch-49' });
  });

  test('skips targets without a directory or a branch', () => {
    expect(limitSourceControlDiscoveryCandidates([
      { directory: '', branch: 'feature' },
      { directory: '/repo/no-branch', branch: '  ' },
      { directory: '/repo/feature', branch: 'feature' },
    ])).toEqual([{ directory: '/repo/feature', branch: 'feature' }]);
  });
});
