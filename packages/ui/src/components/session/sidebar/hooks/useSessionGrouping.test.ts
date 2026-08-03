import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionNode } from '../types';
import { shouldHardDeleteSession } from '../sessionNodeItemUtils';
import { indexSessionsByParent, resolveSessionDirectoryFromLineage, subtreeHasLiveSession } from './useSessionGrouping';

const makeSession = (id: string, options: { parentID?: string; archived?: boolean } = {}): Session =>
  ({
    id,
    parentID: options.parentID,
    time: { created: 1, updated: 1, ...(options.archived ? { archived: 2 } : {}) },
  } as unknown as Session);

const rootIds = (result: ReturnType<typeof indexSessionsByParent>): string[] =>
  result.roots.map((session) => session.id);

const childIds = (result: ReturnType<typeof indexSessionsByParent>, parentId: string): string[] =>
  (result.childrenByParent.get(parentId) ?? []).map((session) => session.id);

describe('subtreeHasLiveSession', () => {
  const node = (session: Session, children: SessionNode[] = []): SessionNode => ({ session, children, worktree: null });

  test('a fully archived tree belongs in the archived bucket', () => {
    const tree = node(makeSession('parent', { archived: true }), [
      node(makeSession('child', { parentID: 'parent', archived: true })),
    ]);

    expect(subtreeHasLiveSession(tree)).toBe(false);
  });

  test('an archived parent with a live subagent stays out of the archived bucket', () => {
    const tree = node(makeSession('parent', { archived: true }), [
      node(makeSession('subagent', { parentID: 'parent' })),
    ]);

    expect(subtreeHasLiveSession(tree)).toBe(true);
  });

  test('a live descendant is detected at any depth', () => {
    const tree = node(makeSession('parent', { archived: true }), [
      node(makeSession('child', { parentID: 'parent', archived: true }), [
        node(makeSession('grandchild', { parentID: 'child' })),
      ]),
    ]);

    expect(subtreeHasLiveSession(tree)).toBe(true);
  });
});

describe('indexSessionsByParent', () => {
  test('sessions without a parent are roots', () => {
    const result = indexSessionsByParent([makeSession('a'), makeSession('b', { archived: true })]);

    expect(rootIds(result)).toEqual(['a', 'b']);
    expect(result.childrenByParent.size).toBe(0);
  });

  test('sessions whose parent is missing are roots', () => {
    const result = indexSessionsByParent([makeSession('child', { parentID: 'gone' })]);

    expect(rootIds(result)).toEqual(['child']);
  });

  test('active subagents nest under their active parent', () => {
    const result = indexSessionsByParent([
      makeSession('parent'),
      makeSession('child', { parentID: 'parent' }),
    ]);

    expect(rootIds(result)).toEqual(['parent']);
    expect(childIds(result, 'parent')).toEqual(['child']);
  });

  test('archived subagents nest under their archived parent instead of becoming roots (#2266 issue 1)', () => {
    const result = indexSessionsByParent([
      makeSession('parent', { archived: true }),
      makeSession('child-1', { parentID: 'parent', archived: true }),
      makeSession('child-2', { parentID: 'parent', archived: true }),
    ]);

    expect(rootIds(result)).toEqual(['parent']);
    expect(childIds(result, 'parent')).toEqual(['child-1', 'child-2']);
  });

  test('active subagents spawned by an archived parent remain nested under it (#2266 issue 2)', () => {
    const result = indexSessionsByParent([
      makeSession('parent', { archived: true }),
      makeSession('new-child', { parentID: 'parent' }),
    ]);

    expect(rootIds(result)).toEqual(['parent']);
    expect(childIds(result, 'parent')).toEqual(['new-child']);
  });

  test('a subagent archived independently of its active parent detaches as a root', () => {
    const result = indexSessionsByParent([
      makeSession('parent'),
      makeSession('archived-child', { parentID: 'parent', archived: true }),
    ]);

    expect(rootIds(result)).toEqual(['parent', 'archived-child']);
    expect(childIds(result, 'parent')).toEqual([]);
  });

  test('deep chains stay nested below an archived ancestor', () => {
    const result = indexSessionsByParent([
      makeSession('parent', { archived: true }),
      makeSession('child', { parentID: 'parent' }),
      makeSession('grandchild', { parentID: 'child' }),
    ]);

    expect(rootIds(result)).toEqual(['parent']);
    expect(childIds(result, 'parent')).toEqual(['child']);
    expect(childIds(result, 'child')).toEqual(['grandchild']);
  });

  test('preserves the tree and per-session actions through the reported archive-and-continue lifecycle', () => {
    const active = [
      makeSession('parent'),
      makeSession('orig-child-1', { parentID: 'parent' }),
      makeSession('orig-child-2', { parentID: 'parent' }),
    ];
    expect(rootIds(indexSessionsByParent(active))).toEqual(['parent']);

    const archived = active.map((session) => ({
      ...session,
      time: { ...session.time, archived: 2 },
    }));
    const archivedResult = indexSessionsByParent(archived);
    expect(rootIds(archivedResult)).toEqual(['parent']);
    expect(childIds(archivedResult, 'parent')).toEqual(['orig-child-1', 'orig-child-2']);

    const newChild = makeSession('new-child', { parentID: 'parent' });
    const continuedResult = indexSessionsByParent([...archived, newChild]);
    expect(rootIds(continuedResult)).toEqual(['parent']);
    expect(childIds(continuedResult, 'parent')).toEqual(['orig-child-1', 'orig-child-2', 'new-child']);
    expect(shouldHardDeleteSession(archived[0])).toBe(true);
    expect(shouldHardDeleteSession(newChild)).toBe(false);
  });

  test('preserves input order for roots and children', () => {
    const result = indexSessionsByParent([
      makeSession('root-2'),
      makeSession('child-b', { parentID: 'root-1' }),
      makeSession('root-1'),
      makeSession('child-a', { parentID: 'root-1' }),
    ]);

    expect(rootIds(result)).toEqual(['root-2', 'root-1']);
    expect(childIds(result, 'root-1')).toEqual(['child-b', 'child-a']);
  });
});

describe('resolveSessionDirectoryFromLineage', () => {
  test('inherits the archived parent directory for a newly spawned active child', () => {
    const parent = { ...makeSession('parent', { archived: true }), directory: '/project/worktree' } as Session;
    const child = makeSession('child', { parentID: 'parent' });

    expect(resolveSessionDirectoryFromLineage(
      child,
      new Map([[parent.id, parent], [child.id, child]]),
      new Map(),
    )).toBe('/project/worktree');
  });
});
