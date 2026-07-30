import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getPinnedSessionKey } from '@/stores/useSessionPinnedStore';
import {
  computeNodeStructureKey,
  isSessionTreeRoot,
  nodeHasPinnedMembershipChange,
  selectFolderRootNodes,
  shouldHardDeleteSession,
} from './sessionNodeItemUtils';
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

describe('shouldHardDeleteSession', () => {
  test('preserves explicit hard-delete intent for an active session', () => {
    const active = session('active', 'Active');
    const archived = { ...session('archived', 'Archived'), time: { created: 1, updated: 1, archived: 2 } };

    expect(shouldHardDeleteSession(active)).toBe(false);
    expect(shouldHardDeleteSession(archived)).toBe(true);
    expect(shouldHardDeleteSession(active, true)).toBe(true);
  });
});

describe('isSessionTreeRoot', () => {
  test('keeps new active children under archived parents but detaches independently archived children', () => {
    const activeParent = session('active-parent', 'Active parent');
    const archivedParent = { ...session('archived-parent', 'Archived parent'), time: { created: 1, updated: 1, archived: 2 } };
    const activeChild = { ...session('active-child', 'Active child'), parentID: archivedParent.id };
    const archivedChild = {
      ...session('archived-child', 'Archived child'),
      parentID: activeParent.id,
      time: { created: 1, updated: 1, archived: 2 },
    };
    const sessionsById = new Map([activeParent, archivedParent, activeChild, archivedChild].map((value) => [value.id, value]));

    expect(isSessionTreeRoot(activeChild, sessionsById)).toBe(false);
    expect(isSessionTreeRoot(archivedChild, sessionsById)).toBe(true);
  });
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

describe('nodeHasPinnedMembershipChange', () => {
  test('detects composite pin changes using the group directory fallback', () => {
    const node: SessionNode = {
      session: session('root', 'Root'),
      children: [],
      worktree: null,
    };
    const pinnedKey = getPinnedSessionKey(getRuntimeKey(), '/repo', 'root');

    expect(pinnedKey).not.toBeNull();
    expect(nodeHasPinnedMembershipChange(
      node,
      node,
      new Set(),
      new Set([pinnedKey!]),
      '/repo',
      '/repo',
    )).toBe(true);
  });

  test('ignores pin changes for the same session id in another directory', () => {
    const node: SessionNode = {
      session: session('root', 'Root'),
      children: [],
      worktree: null,
    };
    const pinnedKey = getPinnedSessionKey(getRuntimeKey(), '/other-repo', 'root');

    expect(pinnedKey).not.toBeNull();
    expect(nodeHasPinnedMembershipChange(
      node,
      node,
      new Set(),
      new Set([pinnedKey!]),
      '/repo',
      '/repo',
    )).toBe(false);
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
