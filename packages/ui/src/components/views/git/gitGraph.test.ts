import { describe, expect, test } from 'bun:test';
import { assignLanes } from './gitGraph';
import type { GitLogEntry } from '@/lib/api/types';

function makeCommit(hash: string, parents: string[], refs = ''): GitLogEntry {
  return {
    hash,
    parents,
    date: '2024-01-01T00:00:00Z',
    message: `commit ${hash}`,
    refs,
    body: '',
    author_name: 'Test',
    author_email: 'test@test.com',
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
  };
}

describe('assignLanes', () => {
  test('returns empty array for empty input', () => {
    expect(assignLanes([])).toEqual([]);
  });

  test('assigns lane 0 to all commits in a linear history', () => {
    const commits = [
      makeCommit('c', ['b']),
      makeCommit('b', ['a']),
      makeCommit('a', []),
    ];
    const result = assignLanes(commits);
    expect(result.every((r) => r.lane === 0)).toBe(true);
    expect(result).toHaveLength(3);
  });

  test('assigns a color to every commit', () => {
    const commits = [makeCommit('a', [])];
    const result = assignLanes(commits);
    expect(result[0].color).toBeTruthy();
    expect(result[0].color).toContain('var(--');
  });

  test('assigns separate lanes to two diverging branches', () => {
    // main: c -> a; feat: b -> a; order newest first: c, b, a
    const commits = [
      makeCommit('c', ['a']),
      makeCommit('b', ['a']),
      makeCommit('a', []),
    ];
    const result = assignLanes(commits);
    const cLane = result.find((r) => r.commit.hash === 'c')!.lane;
    const bLane = result.find((r) => r.commit.hash === 'b')!.lane;
    expect(cLane).not.toEqual(bLane);
    // convergence commit 'a' should be on the lower lane
    const aLane = result.find((r) => r.commit.hash === 'a')!.lane;
    expect(aLane <= Math.min(cLane, bLane)).toBe(true);
  });

  test('handles a merge commit (2 parents)', () => {
    const commits = [
      makeCommit('m', ['b', 'a']),
      makeCommit('b', ['base']),
      makeCommit('a', ['base']),
      makeCommit('base', []),
    ];
    const result = assignLanes(commits);
    expect(result).toHaveLength(4);
    result.forEach((r) => expect(r.lane >= 0).toBe(true));
    const baseResult = result.find((r) => r.commit.hash === 'base')!;
    expect(baseResult.lane).toBe(0);
  });

  test('handles an octopus merge (3 parents)', () => {
    const commits = [
      makeCommit('oct', ['p1', 'p2', 'p3']),
      makeCommit('p1', ['base']),
      makeCommit('p2', ['base']),
      makeCommit('p3', ['base']),
      makeCommit('base', []),
    ];
    const result = assignLanes(commits);
    expect(result).toHaveLength(5);
    result.forEach((r) => expect(r.lane >= 0).toBe(true));
  });

  test('root commit gets a top-stub connector', () => {
    const commits = [
      makeCommit('b', ['a']),
      makeCommit('a', []),
    ];
    const result = assignLanes(commits);
    const aResult = result.find((r) => r.commit.hash === 'a')!;
    const topStub = aResult.connectors.find((c) => c.type === 'top-stub');
    expect(topStub).not.toBeNull();
  });

  test('commit with both parent and child gets a commit-lane connector', () => {
    const commits = [
      makeCommit('c', ['b']),
      makeCommit('b', ['a']),
      makeCommit('a', []),
    ];
    const result = assignLanes(commits);
    const bResult = result.find((r) => r.commit.hash === 'b')!;
    const commitLane = bResult.connectors.find((c) => c.type === 'commit-lane');
    expect(commitLane).not.toBeNull();
  });

  test('merge commit produces branch-out connectors for extra parents', () => {
    const commits = [
      makeCommit('m', ['main', 'feat']),
      makeCommit('main', ['base']),
      makeCommit('feat', ['base']),
      makeCommit('base', []),
    ];
    const result = assignLanes(commits);
    const mResult = result.find((r) => r.commit.hash === 'm')!;
    const branchOut = mResult.connectors.filter((c) => c.type === 'branch-out');
    expect(branchOut.length).toBeGreaterThan(0);
  });

  test('converges two branches cleanly with merge-in connectors', () => {
    const commits = [
      makeCommit('c', ['a']),
      makeCommit('b', ['a']),
      makeCommit('a', ['base']),
      makeCommit('base', []),
    ];
    const result = assignLanes(commits);

    // 'a' should be where the two lanes converge
    const aResult = result.find((r) => r.commit.hash === 'a')!;
    const mergeIns = aResult.connectors.filter((c) => c.type === 'merge-in');
    expect(mergeIns.length).toBeGreaterThan(0);

    // 'base' should only have one lane (the merged one)
    const baseResult = result.find((r) => r.commit.hash === 'base')!;
    const passingThroughBase = baseResult.connectors.filter((c) => c.type === 'passing');
    expect(passingThroughBase.length).toBe(0);
  });

  test('produces passing connectors for unrelated active lanes', () => {
    const commits = [
      makeCommit('c', ['a']),
      makeCommit('b', ['a']),
      makeCommit('a', []),
    ];
    const result = assignLanes(commits);
    // While processing 'b', lane 0 (from c) is still active — should be 'passing'
    const bResult = result.find((r) => r.commit.hash === 'b')!;
    const passing = bResult.connectors.filter((c) => c.type === 'passing');
    expect(passing.length).toBeGreaterThan(0);
  });

  test('produces a bottom-stub connector when a new branch starts', () => {
    const commits = [
      makeCommit('c', ['a']),
      makeCommit('b', ['a']),
      makeCommit('a', []),
    ];
    const result = assignLanes(commits);
    // 'c' is the first commit processed — no child above claims it.
    // Its lane has a parent ('a') but no incoming.
    const cResult = result.find((r) => r.commit.hash === 'c')!;
    const bottomStub = cResult.connectors.find((c) => c.type === 'bottom-stub');
    expect(bottomStub).toBeTruthy();
  });

  test('handles double merge of same branch with single commit between merges (screenshot case)', () => {
    // Repro for screenshot: admin branch forked from base, 3 commits (48f6,c55f,2949),
    // merged into main at 594c, then one more admin commit 3257 whose parent is
    // the same 2949 as the merge's second parent (criss-cross), then merged again at a37.
    // Order is topo-order as returned by `git log --all --topo-order` for that DAG.
    const commits = [
      makeCommit('a37', ['594c', '3257']),
      makeCommit('3257', ['2949']),
      makeCommit('594c', ['base', '2949']),
      makeCommit('2949', ['c55f']),
      makeCommit('c55f', ['48f6']),
      makeCommit('48f6', ['base']),
      makeCommit('base', []),
    ];
    const result = assignLanes(commits);

    // Should use only 2 lanes (main=0, admin=1) throughout – no lane jump to 2
    const maxLane = Math.max(...result.map((r) => r.lane));
    expect(maxLane).toBe(1);

    // The intermediate admin commit 3257 should be on admin lane
    const c3257 = result.find((r) => r.commit.hash === '3257')!;
    expect(c3257.lane).toBe(1);

    // Second merge (594c) must reuse admin lane rather than opening a new one,
    // so its extra parent lane is 1 (reused) not a fresh lane.
    const m1 = result.find((r) => r.commit.hash === '594c')!;
    const m1BranchOut = m1.connectors.find((c) => c.type === 'branch-out')!;
    expect(m1BranchOut.toLane).toBe(1);

    // Crucial: at the merge row, the reused admin lane must keep its vertical
    // passing segment for continuity between 3257 above and 2949 below.
    // Without this, a gap appears between those rows (the screenshot bug).
    const m1Passing = m1.connectors.filter((c) => c.type === 'passing');
    expect(m1Passing.some((c) => c.fromLane === 1)).toBe(true);

    // Top merge also branch-out to admin lane
    const m2 = result.find((r) => r.commit.hash === 'a37')!;
    const m2BranchOut = m2.connectors.find((c) => c.type === 'branch-out')!;
    expect(m2BranchOut.toLane).toBe(1);
    // Top merge's admin lane is new, so no passing at that row (branch starts there)
    expect(m2.connectors.some((c) => c.type === 'passing' && c.fromLane === 1)).toBe(false);

    // Base should merge both lanes cleanly
    const base = result.find((r) => r.commit.hash === 'base')!;
    const mergeIns = base.connectors.filter((c) => c.type === 'merge-in');
    expect(mergeIns.length).toBe(1);
  });

  test('reuses lane when merge second parent already active (no extra lane)', () => {
    const commits = [
      makeCommit('m2', ['m1', 'a3']),
      makeCommit('a3', ['common']),
      makeCommit('m1', ['base', 'common']),
      makeCommit('common', ['base']),
      makeCommit('base', []),
    ];
    const result = assignLanes(commits);
    // m1 should reuse lane 1 (where a3 lives) rather than opening lane 2
    const m1 = result.find((r) => r.commit.hash === 'm1')!;
    expect(m1.connectors.find((c) => c.type === 'branch-out')!.toLane).toBe(1);
    expect(Math.max(...result.map((r) => r.lane))).toBe(1);
  });
});
