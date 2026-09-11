import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { buildChildrenIndex, computeSubtreeCost, formatCost } from './subagentCost';

function makeSession(id: string, cost: number | undefined, parentID?: string): Session {
  return {
    id,
    slug: id,
    projectID: 'project',
    directory: '/project',
    title: id,
    version: '1',
    time: { created: 0, updated: 0 },
    cost,
    parentID,
  };
}

describe('buildChildrenIndex', () => {
  test('groups sessions by parentID', () => {
    const root = makeSession('root', 1);
    const childA = makeSession('a', 2, 'root');
    const childB = makeSession('b', 3, 'root');
    const index = buildChildrenIndex([root, childA, childB]);
    expect(index.get('root')).toEqual([childA, childB]);
  });
});

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
    const sessionsById = new Map(sessions.map((s) => [s.id, s]));
    const childrenByParent = buildChildrenIndex(sessions);
    expect(computeSubtreeCost('root', sessionsById, childrenByParent)).toBe(6);
  });

  test('rolls up cost through nested descendants', () => {
    const root = makeSession('root', 1);
    const child = makeSession('child', 2, 'root');
    const grandchild = makeSession('grandchild', 4, 'child');
    const sessions = [root, child, grandchild];
    const sessionsById = new Map(sessions.map((s) => [s.id, s]));
    const childrenByParent = buildChildrenIndex(sessions);
    expect(computeSubtreeCost('root', sessionsById, childrenByParent)).toBe(7);
    expect(computeSubtreeCost('child', sessionsById, childrenByParent)).toBe(6);
  });

  test('does not double-count or infinite-loop on a cycle', () => {
    const a = makeSession('a', 1, 'b');
    const b = makeSession('b', 2, 'a');
    const sessions = [a, b];
    const sessionsById = new Map(sessions.map((s) => [s.id, s]));
    const childrenByParent = buildChildrenIndex(sessions);
    expect(computeSubtreeCost('a', sessionsById, childrenByParent)).toBe(3);
  });

  test('treats zero and undefined cost as zero, not a break', () => {
    const root = makeSession('root', 0);
    const child = makeSession('child', undefined, 'root');
    const sessions = [root, child];
    const sessionsById = new Map(sessions.map((s) => [s.id, s]));
    const childrenByParent = buildChildrenIndex(sessions);
    expect(computeSubtreeCost('root', sessionsById, childrenByParent)).toBe(0);
  });

  test('returns 0 for an unknown id', () => {
    const sessionsById = new Map<string, Session>();
    const childrenByParent = new Map<string, Session[]>();
    expect(computeSubtreeCost('missing', sessionsById, childrenByParent)).toBe(0);
  });
});
