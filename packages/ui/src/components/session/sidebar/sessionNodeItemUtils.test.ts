import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { computeNodeStructureKey } from './sessionNodeItemUtils';
import type { SessionNode } from './types';

const session = (id: string, title: string): Session => ({
  id,
  title,
  time: { created: 1, updated: 1 },
} as Session);

const rootWithChild = (childSession: Session): SessionNode => ({
  session: session('root', 'Root'),
  children: [{ session: childSession, children: [], worktree: null }],
  worktree: null,
});

describe('computeNodeStructureKey', () => {
  test('stays stable across grouping rebuilds that reuse session objects', () => {
    const child = session('child', 'Child');

    expect(computeNodeStructureKey(rootWithChild(child))).toBe(computeNodeStructureKey(rootWithChild(child)));
  });

  test('changes when a descendant session object changes', () => {
    const previous = session('child', 'Before');
    const next = { ...previous, title: 'After' };

    expect(computeNodeStructureKey(rootWithChild(previous))).not.toBe(computeNodeStructureKey(rootWithChild(next)));
  });
});
