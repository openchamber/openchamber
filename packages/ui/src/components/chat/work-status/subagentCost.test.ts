import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { computeSubtreeCost, formatCost, type SessionTree } from './subagentCost';

const NO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

function makeSession(id: string, cost: number, parentID?: string): Session {
  return {
    id,
    projectID: 'project',
    directory: '/project',
    title: id,
    time: { created: 0, updated: 0 },
    cost,
    tokens: NO_TOKENS,
    parentID,
  };
}

function treeOf(sessions: Session[]): SessionTree {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const childIds = new Map<string, string[]>();
  for (const session of sessions) {
    if (session.parentID) childIds.set(session.parentID, [...(childIds.get(session.parentID) ?? []), session.id]);
  }
  return { readSession: (id) => byId.get(id), childIdsOf: (id) => childIds.get(id) };
}

describe('formatCost', () => {
  test('prefixes with $ and trims trailing zeros', () => {
    expect(formatCost(1.5)).toBe('$1.5');
    expect(formatCost(0.0001)).toBe('$0.0001');
    expect(formatCost(2)).toBe('$2');
  });
});

describe('computeSubtreeCost', () => {
  test('sums a flat root with two direct children', () => {
    const root = makeSession('root', 1);
    const childA = makeSession('a', 2, 'root');
    const childB = makeSession('b', 3, 'root');
    const sessions = [root, childA, childB];
    const tree = treeOf(sessions);
    expect(computeSubtreeCost('root', tree)).toBe(6);
  });

  test('rolls up cost through nested descendants', () => {
    const root = makeSession('root', 1);
    const child = makeSession('child', 2, 'root');
    const grandchild = makeSession('grandchild', 4, 'child');
    const sessions = [root, child, grandchild];
    const tree = treeOf(sessions);
    expect(computeSubtreeCost('root', tree)).toBe(7);
    expect(computeSubtreeCost('child', tree)).toBe(6);
  });

  test('does not double-count or infinite-loop on a cycle', () => {
    const a = makeSession('a', 1, 'b');
    const b = makeSession('b', 2, 'a');
    const sessions = [a, b];
    const tree = treeOf(sessions);
    expect(computeSubtreeCost('a', tree)).toBe(3);
  });

  test('treats zero cost as zero, not a break', () => {
    const root = makeSession('root', 0);
    const child = makeSession('child', 0, 'root');
    const sessions = [root, child];
    const tree = treeOf(sessions);
    expect(computeSubtreeCost('root', tree)).toBe(0);
  });

  test('returns 0 for an unknown id', () => {
    expect(computeSubtreeCost('missing', treeOf([]))).toBe(0);
  });
});
