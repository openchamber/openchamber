import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import {
  createArchivedSessionDeleteRequest,
  deleteCascadeChanged,
  executeDeleteCascade,
  expandSessionsWithDescendants,
  getDeleteExecutionOrder,
  requiresDeleteConfirmation,
  resolveAuthoritativeDeleteCascade,
} from './sessionDeleteCascade';

const session = (id: string, parentID?: string, archived?: number, directory = `/repo/${id}`): Session => ({
  id,
  directory,
  ...(parentID === undefined ? {} : { parentID }),
  ...(archived === undefined ? {} : { time: { archived } }),
}) as Session;

const ids = (sessions: Session[]) => sessions.map((entry) => entry.id);

describe('expandSessionsWithDescendants', () => {
  test('returns the requested sessions when none have descendants', () => {
    const known = [session('a'), session('b')];

    expect(ids(expandSessionsWithDescendants([known[0]], known))).toEqual(['a']);
  });

  test('adds a live child of an archived parent, which the server cascade destroys', () => {
    const parent = session('parent', undefined, 10);
    const liveChild = session('child', 'parent');

    expect(ids(expandSessionsWithDescendants([parent], [parent, liveChild]))).toEqual(['parent', 'child']);
  });

  test('adds transitive descendants', () => {
    const known = [session('root'), session('child', 'root'), session('grandchild', 'child')];

    expect(ids(expandSessionsWithDescendants([known[0]], known))).toEqual(['root', 'child', 'grandchild']);
  });

  test('lists every requested session before any added descendant', () => {
    const known = [session('a'), session('b'), session('a-child', 'a')];

    expect(ids(expandSessionsWithDescendants([known[0], known[1]], known))).toEqual(['a', 'b', 'a-child']);
  });

  test('never repeats a session already in the request', () => {
    const known = [session('root'), session('child', 'root')];

    expect(ids(expandSessionsWithDescendants(known, known))).toEqual(['root', 'child']);
  });

  test('ignores sessions outside the requested subtrees', () => {
    const known = [session('a'), session('b'), session('b-child', 'b')];

    expect(ids(expandSessionsWithDescendants([known[0]], known))).toEqual(['a']);
  });

  test('terminates on a parent cycle', () => {
    const known = [session('a', 'b'), session('b', 'a')];

    expect(ids(expandSessionsWithDescendants([known[0]], known))).toEqual(['a', 'b']);
  });
});

describe('requiresDeleteConfirmation', () => {
  test('confirms everything while the dialog is enabled', () => {
    expect(requiresDeleteConfirmation(true, 1)).toBe(true);
    expect(requiresDeleteConfirmation(true, 9)).toBe(true);
  });

  test('lets the opt-out skip a single-session delete', () => {
    expect(requiresDeleteConfirmation(false, 1)).toBe(false);
  });

  test('confirms a multi-session delete even with the opt-out enabled', () => {
    expect(requiresDeleteConfirmation(false, 2)).toBe(true);
    expect(requiresDeleteConfirmation(false, 400)).toBe(true);
  });

  test('skips an empty request rather than confirming nothing', () => {
    expect(requiresDeleteConfirmation(false, 0)).toBe(false);
  });
});

describe('resolveAuthoritativeDeleteCascade', () => {
  test('discovers descendants omitted from the client snapshot', async () => {
    const parent = session('parent', undefined, 10);
    const child = session('child', 'parent');

    const resolved = await resolveAuthoritativeDeleteCascade([parent], async (archived) => (
      archived ? [parent] : [child]
    ));

    expect(ids(resolved)).toEqual(['parent', 'child']);
  });

  test('discovers every active session in a worktree when the client snapshot is empty', async () => {
    const root = session('root', undefined, undefined, '/repo/worktree');
    const child = session('child', 'root', undefined, '/other/directory');
    const archived = session('archived', undefined, 10, '/repo/worktree');
    const activeChild = session('active-child', 'archived', undefined, '/other/directory');

    const resolved = await resolveAuthoritativeDeleteCascade([], async (isArchived) => (
      isArchived ? [archived] : [root, child, activeChild]
    ), { worktreeDirectory: '/repo/worktree/' });

    expect(ids(resolved)).toEqual(['root', 'child', 'active-child']);
  });

  test('rejects an Archive delete when the requested session is now live', async () => {
    const staleArchivedParent = session('parent', undefined, 10);
    const liveParent = session('parent');

    await expect(resolveAuthoritativeDeleteCascade(
      [staleArchivedParent],
      async (archived) => (archived ? [] : [liveParent]),
      { requireArchived: true },
    )).rejects.toThrow('no longer archived');
  });

  test('rejects a request whose target is absent from the authoritative snapshot', async () => {
    await expect(resolveAuthoritativeDeleteCascade(
      [session('missing')],
      async () => [],
    )).rejects.toThrow('no longer exists');
  });

  test('fails closed when either authoritative list cannot be loaded', async () => {
    await expect(resolveAuthoritativeDeleteCascade(
      [session('parent')],
      async (archived) => {
        if (archived) throw new Error('archived list unavailable');
        return [session('parent')];
      },
    )).rejects.toThrow('archived list unavailable');
  });

  test('fails closed when concurrent snapshots disagree about archive state', async () => {
    const parent = session('parent');

    await expect(resolveAuthoritativeDeleteCascade(
      [parent],
      async (archived) => (archived ? [session('parent', undefined, 10)] : [parent]),
    )).rejects.toThrow('archive state changed');
  });
});

describe('delete cascade snapshot validation', () => {
  test('requires reconfirmation when a descendant appears while the dialog is open', () => {
    const confirmed = [session('parent', undefined, 10)];
    const current = [...confirmed, session('child', 'parent')];

    expect(deleteCascadeChanged(confirmed, current)).toBe(true);
  });

  test('ignores unrelated sessions added while the dialog is open', () => {
    const confirmed = [session('parent', undefined, 10), session('child', 'parent')];
    const current = [...confirmed, session('unrelated')];

    expect(deleteCascadeChanged(confirmed, expandSessionsWithDescendants([current[0]], current))).toBe(false);
  });

  test('deletes descendants before parents to avoid an avoidable server cascade', () => {
    const cascade = [session('parent'), session('child', 'parent'), session('grandchild', 'child')];

    expect(ids(getDeleteExecutionOrder(cascade))).toEqual(['grandchild', 'child', 'parent']);
  });

  test('orders descendants before parents even when both were explicitly requested child-first', () => {
    const parent = session('parent');
    const child = session('child', 'parent');

    expect(ids(getDeleteExecutionOrder([child, parent]))).toEqual(['child', 'parent']);
  });

  test('does not delete a parent after a descendant deletion fails', async () => {
    const calls: string[] = [];
    const cascade = [session('parent'), session('child', 'parent'), session('grandchild', 'child')];

    const result = await executeDeleteCascade(cascade, async (entry) => {
      calls.push(entry.id);
      return entry.id !== 'child';
    });

    expect(calls).toEqual(['grandchild', 'child']);
    expect(result).toEqual({
      deletedIds: ['grandchild'],
      failedIds: ['child', 'parent'],
    });
  });

  test('continues deleting unrelated roots after one subtree fails', async () => {
    const calls: string[] = [];
    const cascade = [
      session('failed-root'),
      session('failed-child', 'failed-root'),
      session('other-root'),
      session('other-child', 'other-root'),
    ];

    const result = await executeDeleteCascade(cascade, async (entry) => {
      calls.push(entry.id);
      return entry.id !== 'failed-child';
    });

    expect(calls).toEqual(['failed-child', 'other-child', 'other-root']);
    expect(result).toEqual({
      deletedIds: ['other-child', 'other-root'],
      failedIds: ['failed-child', 'failed-root'],
    });
  });

  test('passes authoritative session metadata to the delete action', async () => {
    const discovered = session('child', 'parent', undefined, '/server/discovered');
    const directories: Array<string | null | undefined> = [];

    await executeDeleteCascade([discovered], async (entry) => {
      directories.push(entry.directory);
      return true;
    });

    expect(directories).toEqual(['/server/discovered']);
  });

  test('fails a cyclic subtree without blocking an unrelated root', async () => {
    const calls: string[] = [];
    const cascade = [session('a', 'b'), session('b', 'a'), session('other')];

    const result = await executeDeleteCascade(cascade, async (entry) => {
      calls.push(entry.id);
      return true;
    });

    expect(calls).toEqual(['other']);
    expect(result).toEqual({ deletedIds: ['other'], failedIds: ['a', 'b'] });
  });
});

describe('desktop Archive delete request', () => {
  test('requires every requested root to remain archived', () => {
    const archived = session('archived', undefined, 10);

    expect(createArchivedSessionDeleteRequest([archived])).toEqual({
      sessions: [archived],
      mode: 'session',
      requireArchived: true,
    });
  });

  test('filters live sessions consistently from archived folder requests', () => {
    const archived = session('archived', undefined, 10);

    expect(createArchivedSessionDeleteRequest([archived, session('live')]).sessions).toEqual([archived]);
  });
});
