import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { indexSessionsByParent } from './useSessionGrouping';

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

  test('active subagents spawned by an archived parent nest under it instead of becoming roots (#2266 issue 2)', () => {
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

  test('archiving a parent tree and then spawning new subagents keeps everything under the parent (#2266)', () => {
    const result = indexSessionsByParent([
      makeSession('parent', { archived: true }),
      makeSession('orig-child-1', { parentID: 'parent', archived: true }),
      makeSession('orig-child-2', { parentID: 'parent', archived: true }),
      makeSession('new-child', { parentID: 'parent' }),
    ]);

    expect(rootIds(result)).toEqual(['parent']);
    expect(childIds(result, 'parent')).toEqual(['orig-child-1', 'orig-child-2', 'new-child']);
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
