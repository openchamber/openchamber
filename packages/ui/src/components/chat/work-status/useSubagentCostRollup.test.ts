import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { computeRollup } from './useSubagentCostRollup';

function makeSession(id: string, cost: number, parentID?: string): Session {
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

const sessions: Session[] = [
  makeSession('root', 1),
  makeSession('a', 2, 'root'),
  makeSession('b', 3, 'root'),
  makeSession('a1', 5, 'a'),
];

describe('computeRollup', () => {
  test('sums own cost plus every descendant', () => {
    const result = computeRollup(sessions, 'root');
    expect(result.totalCost).toBe(11);
    expect(result.subagentCount).toBe(3);
  });

  test('splits the total into the session own cost and the subagent share', () => {
    const result = computeRollup(sessions, 'root');
    expect(result.ownCost).toBe(1);
    expect(result.subagentCost).toBe(10);
    expect(result.ownCost + result.subagentCost).toBe(result.totalCost);
  });

  test('reports a zero subagent share for a session with no children', () => {
    const result = computeRollup(sessions, 'a1');
    expect(result.ownCost).toBe(5);
    expect(result.subagentCost).toBe(0);
    expect(result.totalCost).toBe(5);
  });

  test('maps each direct child to its own subtree cost', () => {
    const result = computeRollup(sessions, 'root');
    expect(result.perChildCost.get('a')).toBe(7);
    expect(result.perChildCost.get('b')).toBe(3);
  });

  test('returns null total for a null sessionId', () => {
    const result = computeRollup(sessions, null);
    expect(result.totalCost).toBeNull();
    expect(result.subagentCount).toBe(0);
  });

  test('returns null total for an unknown sessionId', () => {
    const result = computeRollup(sessions, 'missing');
    expect(result.totalCost).toBeNull();
  });

  test('sum of perChildCost plus root cost equals totalCost', () => {
    const result = computeRollup(sessions, 'root');
    const childSum = Array.from(result.perChildCost.values()).reduce((sum, v) => sum + v, 0);
    const rootOwnCost = 1;
    expect(childSum + rootOwnCost).toBe(result.totalCost);
  });
});
