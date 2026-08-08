import { beforeEach, describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2/client';

import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import {
  type ArchiveSessionsResult,
  archiveMobileSessionSubtree,
  collectMobileArchiveTargetIds,
  excludeArchivedMobileSessions,
  collectMobileDeleteTargetIds,
  deleteMobileSessionSubtree,
} from './mobileSessionArchive';

const session = (id: string, parentID?: string, archivedAt?: number, directory?: string): Session => ({
  id,
  parentID,
  directory,
  time: archivedAt ? { archived: archivedAt } : {},
}) as Session;

const RUNTIME_KEY = getRuntimeKey();

beforeEach(() => {
  switchRuntimeEndpoint({ apiBaseUrl: 'http://mobile-session-helper.test', runtimeKey: RUNTIME_KEY });
});

/** Records every call it receives and archives everything except `failing`. */
const createArchiveSpy = (failing: string[] = []) => {
  const calls: Array<{ ids: string[]; options?: Record<string, unknown> }> = [];
  const archiveSessions = async (
    ids: string[],
    options?: Record<string, unknown>,
  ): Promise<ArchiveSessionsResult> => {
    calls.push({ ids, options });
    return {
      archivedIds: ids.filter((id) => !failing.includes(id)),
      failedIds: ids.filter((id) => failing.includes(id)),
    };
  };
  return { calls, archiveSessions };
};

describe('mobile session archive targets', () => {
  test('archives only the row when it has no subsessions', () => {
    const sessions = [session('ses_root'), session('ses_other')];

    expect(collectMobileArchiveTargetIds(sessions, 'ses_root')).toEqual(['ses_root']);
  });

  test('archives the whole subtree at any depth, root first', () => {
    const sessions = [
      session('ses_root'),
      session('ses_child_a', 'ses_root'),
      session('ses_child_b', 'ses_root'),
      session('ses_grandchild', 'ses_child_a'),
      session('ses_unrelated'),
      session('ses_unrelated_child', 'ses_unrelated'),
    ];

    const targets = collectMobileArchiveTargetIds(sessions, 'ses_root');

    expect(targets[0]).toBe('ses_root');
    expect([...targets].sort()).toEqual([
      'ses_child_a',
      'ses_child_b',
      'ses_grandchild',
      'ses_root',
    ]);
  });

  test('skips descendants that are already archived', () => {
    const sessions = [
      session('ses_root'),
      session('ses_active_child', 'ses_root'),
      session('ses_archived_child', 'ses_root', 1),
    ];

    expect(collectMobileArchiveTargetIds(sessions, 'ses_root')).toEqual([
      'ses_root',
      'ses_active_child',
    ]);
  });

  test('reaches an active session below an archived intermediate', () => {
    const sessions = [
      session('ses_root'),
      session('ses_archived_middle', 'ses_root', 1),
      session('ses_active_leaf', 'ses_archived_middle'),
    ];

    expect(collectMobileArchiveTargetIds(sessions, 'ses_root')).toEqual([
      'ses_root',
      'ses_active_leaf',
    ]);
  });

  test('includes a descendant from another directory', () => {
    const sessions = [
      session('ses_root', undefined, undefined, '/project'),
      session('ses_child', 'ses_root', undefined, '/project/.worktrees/feature'),
    ];

    expect(collectMobileArchiveTargetIds(sessions, 'ses_root')).toEqual(['ses_root', 'ses_child']);
  });

  test('keeps the swiped row even when it is not in the list', () => {
    expect(collectMobileArchiveTargetIds([session('ses_other')], 'ses_root')).toEqual(['ses_root']);
  });

  test('terminates on a corrupted parent cycle without duplicating IDs', () => {
    const sessions = [
      session('ses_root'),
      session('ses_a', 'ses_root'),
      session('ses_b', 'ses_a'),
      session('ses_root', 'ses_b'),
    ];

    const targets = collectMobileArchiveTargetIds(sessions, 'ses_root');

    expect(targets).toEqual(['ses_root', 'ses_a', 'ses_b']);
    expect(new Set(targets).size).toBe(targets.length);
  });
});

describe('mobile active session authority', () => {
  test('does not resurrect an archived session from a stale live copy', () => {
    const staleLive = session('ses_archived');

    expect(excludeArchivedMobileSessions(
      [session('ses_active'), staleLive],
      [session('ses_archived')],
    ).map((candidate) => candidate.id)).toEqual(['ses_active']);
  });
});

describe('mobile session archive subtree', () => {
  test('pins a childless row to the runtime it was swiped on', async () => {
    const spy = createArchiveSpy();

    const result = await archiveMobileSessionSubtree({
      sessions: [session('ses_root')],
      rootId: 'ses_root',
      expectedRuntimeKey: RUNTIME_KEY,
      archiveSessions: spy.archiveSessions,
    });

    expect(spy.calls).toEqual([{
      ids: ['ses_root'],
      options: { expectedRuntimeKey: RUNTIME_KEY, directory: null },
    }]);
    expect(result).toEqual({ archivedIds: ['ses_root'], failedIds: [], targetCount: 1 });
  });

  test('archives descendants before their ancestors, root last', async () => {
    const spy = createArchiveSpy();

    const result = await archiveMobileSessionSubtree({
      sessions: [
        session('ses_root'),
        session('ses_child', 'ses_root'),
        session('ses_grandchild', 'ses_child'),
      ],
      rootId: 'ses_root',
      expectedRuntimeKey: RUNTIME_KEY,
      archiveSessions: spy.archiveSessions,
    });

    expect(spy.calls.map((call) => call.ids)).toEqual([
      ['ses_grandchild'],
      ['ses_child'],
      ['ses_root'],
    ]);
    expect(spy.calls.every((call) => call.options?.expectedRuntimeKey === RUNTIME_KEY)).toBe(true);
    expect(spy.calls.every((call) => call.options?.directory === null)).toBe(true);
    expect(result.archivedIds).toEqual(['ses_grandchild', 'ses_child', 'ses_root']);
    expect(result.failedIds).toEqual([]);
    expect(result.targetCount).toBe(3);
  });

  test('leaves the parent active when a descendant fails', async () => {
    const spy = createArchiveSpy(['ses_child']);

    const result = await archiveMobileSessionSubtree({
      sessions: [session('ses_root'), session('ses_child', 'ses_root')],
      rootId: 'ses_root',
      expectedRuntimeKey: RUNTIME_KEY,
      archiveSessions: spy.archiveSessions,
    });

    expect(spy.calls.map((call) => call.ids)).toEqual([['ses_child']]);
    expect(result.archivedIds).toEqual([]);
    expect(result.failedIds).toEqual(['ses_child', 'ses_root']);
  });

  test('stops at a failed grandchild before sibling and ancestor archive calls', async () => {
    const spy = createArchiveSpy(['ses_grandchild']);

    const result = await archiveMobileSessionSubtree({
      sessions: [
        session('ses_root'),
        session('ses_child_a', 'ses_root'),
        session('ses_child_b', 'ses_root'),
        session('ses_grandchild', 'ses_child_a'),
      ],
      rootId: 'ses_root',
      expectedRuntimeKey: RUNTIME_KEY,
      archiveSessions: spy.archiveSessions,
    });

    expect(spy.calls.map((call) => call.ids)).toEqual([['ses_grandchild']]);
    expect(result.archivedIds).toEqual([]);
    expect(result.failedIds).toEqual([
      'ses_grandchild',
      'ses_child_b',
      'ses_child_a',
      'ses_root',
    ]);
  });

  test('preserves completed descendants before the first failed target', async () => {
    const spy = createArchiveSpy(['ses_child_a']);

    const result = await archiveMobileSessionSubtree({
      sessions: [
        session('ses_root'),
        session('ses_child_a', 'ses_root'),
        session('ses_child_b', 'ses_root'),
      ],
      rootId: 'ses_root',
      expectedRuntimeKey: RUNTIME_KEY,
      archiveSessions: spy.archiveSessions,
    });

    expect(spy.calls.map((call) => call.ids)).toEqual([['ses_child_b'], ['ses_child_a']]);
    expect(result).toEqual({
      archivedIds: ['ses_child_b'],
      failedIds: ['ses_child_a', 'ses_root'],
      targetCount: 3,
    });
  });

  test('collects a descendant through an archived intermediate before the root', async () => {
    const spy = createArchiveSpy();

    await archiveMobileSessionSubtree({
      sessions: [
        session('ses_root'),
        session('ses_archived_middle', 'ses_root', 1),
        session('ses_active_leaf', 'ses_archived_middle'),
      ],
      rootId: 'ses_root',
      expectedRuntimeKey: RUNTIME_KEY,
      archiveSessions: spy.archiveSessions,
    });

    expect(spy.calls.map((call) => call.ids)).toEqual([['ses_active_leaf'], ['ses_root']]);
  });

  test('captures each target directory before executing a cross-directory subtree', async () => {
    const spy = createArchiveSpy();

    await archiveMobileSessionSubtree({
      sessions: [
        session('ses_root', undefined, undefined, '/repo/root'),
        session('ses_child', 'ses_root', undefined, '/repo/child'),
        session('ses_grandchild', 'ses_child', undefined, '/repo/grandchild'),
      ],
      rootId: 'ses_root',
      expectedRuntimeKey: RUNTIME_KEY,
      archiveSessions: spy.archiveSessions,
      captureDirectory: () => '/fallback',
    });

    expect(spy.calls.map((call) => ({ ids: call.ids, directory: call.options?.directory }))).toEqual([
      { ids: ['ses_grandchild'], directory: '/repo/grandchild' },
      { ids: ['ses_child'], directory: '/repo/child' },
      { ids: ['ses_root'], directory: '/repo/root' },
    ]);
  });
});

describe('mobile session delete subtree', () => {
  const createDeleteSpy = (failing: string[] = []) => {
    const calls: Array<{ ids: string[]; options?: Record<string, unknown> }> = [];
    const deleteSessions = async (
      ids: string[],
      options?: Record<string, unknown>,
    ) => {
      calls.push({ ids, options });
      return {
        deletedIds: ids.filter((id) => !failing.includes(id)),
        failedIds: ids.filter((id) => failing.includes(id)),
      };
    };
    return { calls, deleteSessions };
  };

  test('includes archived descendants in delete targets', () => {
    expect(collectMobileDeleteTargetIds([
      session('ses_root'),
      session('ses_archived_child', 'ses_root', 1),
    ], 'ses_root')).toEqual(['ses_root', 'ses_archived_child']);
  });

  test('deletes a deep subtree in post-order, including archived descendants', async () => {
    const spy = createDeleteSpy();

    const result = await deleteMobileSessionSubtree({
      sessions: [
        session('ses_root', undefined, undefined, '/repo/root'),
        session('ses_child', 'ses_root', undefined, '/repo/child'),
        session('ses_archived_middle', 'ses_child', 1, '/repo/middle'),
        session('ses_leaf', 'ses_archived_middle', undefined, '/repo/leaf'),
      ],
      rootId: 'ses_root',
      expectedRuntimeKey: RUNTIME_KEY,
      deleteSessions: spy.deleteSessions,
    });

    expect(spy.calls.map((call) => call.ids)).toEqual([
      ['ses_leaf'],
      ['ses_archived_middle'],
      ['ses_child'],
      ['ses_root'],
    ]);
    expect(spy.calls.map((call) => call.options?.directory)).toEqual([
      '/repo/leaf',
      '/repo/middle',
      '/repo/child',
      '/repo/root',
    ]);
    expect(result).toEqual({
      deletedIds: ['ses_leaf', 'ses_archived_middle', 'ses_child', 'ses_root'],
      failedIds: [],
      targetCount: 4,
    });
  });

  test('stops after the first descendant failure and blocks all remaining targets', async () => {
    const spy = createDeleteSpy(['ses_leaf']);

    const result = await deleteMobileSessionSubtree({
      sessions: [
        session('ses_root'),
        session('ses_child', 'ses_root'),
        session('ses_leaf', 'ses_child'),
      ],
      rootId: 'ses_root',
      expectedRuntimeKey: RUNTIME_KEY,
      deleteSessions: spy.deleteSessions,
    });

    expect(spy.calls.map((call) => call.ids)).toEqual([['ses_leaf']]);
    expect(result).toEqual({
      deletedIds: [],
      failedIds: ['ses_leaf', 'ses_child', 'ses_root'],
      targetCount: 3,
    });
  });

  test('keeps the root as a target when it is absent from the snapshot', async () => {
    const spy = createDeleteSpy();

    const result = await deleteMobileSessionSubtree({
      sessions: [session('ses_other')],
      rootId: 'ses_root',
      expectedRuntimeKey: RUNTIME_KEY,
      deleteSessions: spy.deleteSessions,
      captureDirectory: (id) => id === 'ses_root' ? '/repo/root' : null,
    });

    expect(spy.calls).toEqual([{
      ids: ['ses_root'],
      options: { expectedRuntimeKey: RUNTIME_KEY, directory: '/repo/root' },
    }]);
    expect(result).toEqual({ deletedIds: ['ses_root'], failedIds: [], targetCount: 1 });
  });

  test('does not start a delete batch after the runtime was already replaced', async () => {
    const spy = createDeleteSpy();
    switchRuntimeEndpoint({ apiBaseUrl: 'http://mobile-session-helper-before.test', runtimeKey: 'runtime:before' });

    const result = await deleteMobileSessionSubtree({
      sessions: [session('ses_root'), session('ses_child', 'ses_root')],
      rootId: 'ses_root',
      expectedRuntimeKey: RUNTIME_KEY,
      deleteSessions: spy.deleteSessions,
    });

    expect(spy.calls).toEqual([]);
    expect(result).toEqual({
      deletedIds: [],
      failedIds: ['ses_child', 'ses_root'],
      targetCount: 2,
    });
  });

  test('does not call another target after a runtime switch during a mutation', async () => {
    const calls: string[] = [];
    let first = true;
    const deleteSessions = async (ids: string[]) => {
      calls.push(ids[0]);
      if (first) {
        first = false;
        switchRuntimeEndpoint({ apiBaseUrl: 'http://mobile-session-helper-new.test', runtimeKey: 'runtime:new' });
      }
      return { deletedIds: ids, failedIds: [] };
    };

    const result = await deleteMobileSessionSubtree({
      sessions: [session('ses_root'), session('ses_child', 'ses_root')],
      rootId: 'ses_root',
      expectedRuntimeKey: RUNTIME_KEY,
      deleteSessions,
    });

    expect(calls).toEqual(['ses_child']);
    expect(result).toEqual({
      deletedIds: [],
      failedIds: ['ses_child', 'ses_root'],
      targetCount: 2,
    });
  });
});
