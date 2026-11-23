import { describe, expect, test } from 'bun:test';
import {
  limitSourceControlDiscoveryCandidates,
  readWithConcurrency,
  SOURCE_CONTROL_DISCOVERY_LIMIT,
  sourceControlDiscoverySignature,
} from './sourceControlDiscovery';

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

  test('ignores the order the sidebar shows the candidates in', () => {
    const candidates = limitSourceControlDiscoveryCandidates([
      { directory: '/repo/b', branch: 'feature/b' },
      { directory: '/repo/a', branch: 'feature/a' },
    ]);
    const signature = sourceControlDiscoverySignature(candidates);

    expect(sourceControlDiscoverySignature([...candidates].reverse())).toBe(signature);
    expect(sourceControlDiscoverySignature([candidates[0]])).not.toBe(signature);
    expect(sourceControlDiscoverySignature([candidates[0], { ...candidates[1], branch: 'feature/other' }])).not.toBe(signature);
  });
});

describe('readWithConcurrency', () => {
  test('reads every item, never more than the limit at once', async () => {
    let active = 0;
    let peak = 0;
    const read: number[] = [];
    await readWithConcurrency(Array.from({ length: 20 }, (_, index) => index), 8, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      read.push(item);
      active -= 1;
    });
    expect(peak).toBe(8);
    expect(read.sort((left, right) => left - right)).toEqual(Array.from({ length: 20 }, (_, index) => index));
    await readWithConcurrency([], 8, async () => { throw new Error('nothing to read'); });
  });
});
