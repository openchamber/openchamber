import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { computeNodeStructureKey, selectFolderRootNodes } from './sessionNodeItemUtils';
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

describe('selectFolderRootNodes', () => {
  test('does not render assigned descendants again beside their assigned parent tree', () => {
    const grandchild: SessionNode = {
      session: { ...session('grandchild', 'Grandchild'), parentID: 'child' } as Session,
      children: [],
      worktree: null,
    };
    const child: SessionNode = {
      session: { ...session('child', 'Child'), parentID: 'root' } as Session,
      children: [grandchild],
      worktree: null,
    };
    const root: SessionNode = {
      session: session('root', 'Root'),
      children: [child],
      worktree: null,
    };
    const nodes = new Map([
      ['root', root],
      ['child', child],
      ['grandchild', grandchild],
    ]);

    expect(selectFolderRootNodes(['root', 'child', 'grandchild'], nodes)).toEqual([root]);
  });

  test('keeps a child as a folder root when none of its ancestors are assigned', () => {
    const child: SessionNode = {
      session: { ...session('child', 'Child'), parentID: 'root' } as Session,
      children: [],
      worktree: null,
    };
    const root: SessionNode = {
      session: session('root', 'Root'),
      children: [child],
      worktree: null,
    };

    expect(selectFolderRootNodes(['child'], new Map([['root', root], ['child', child]]))).toEqual([child]);
  });

  test('keeps a child when an assigned ancestor is not available in the group', () => {
    const child: SessionNode = {
      session: { ...session('child', 'Child'), parentID: 'missing-root' } as Session,
      children: [],
      worktree: null,
    };

    expect(selectFolderRootNodes(['missing-root', 'child'], new Map([['child', child]]))).toEqual([child]);
  });
});
