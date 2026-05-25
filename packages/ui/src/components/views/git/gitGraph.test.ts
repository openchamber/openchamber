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
    expect(bottomStub).toBeDefined();
  });
});
