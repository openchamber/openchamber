import { describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { toast } from '@/components/ui';
import { I18nProvider } from '@/lib/i18n';
import type { Session } from '@/lib/opencode/model';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';
import { installHookTestDom } from '../test-utils/testDom';
import { SessionRowOrderProvider, type SessionRowOrderWork } from '../sessions/sessionRowOrder';
import { recordSessionActionFailure } from '@/sync/session-action-failures';
import type { SessionGroup } from '../types';
import type { FinishWorktreeWorkOutcome } from '../works/workActions';
import { selectSessionsToMarkDone, useSidebarBulkActions } from './useSidebarBulkActions';

const open = { openchamber: { work: { state: 'open', openedAt: 1, openedBy: 'user' } } };
const done = { openchamber: { work: { state: 'done', doneAt: 2 } } };
// SAFETY: the bulk actions read only the id, parent, archive time and work metadata.
const session = (id: string, overrides: Partial<Session> = {}): Session => ({
  id, directory: '/repo', time: { created: 1, updated: 1 }, metadata: open, ...overrides,
} as Session);

const sessions = new Map([
  ['root', session('root')],
  ['btw', session('btw')],
  ['subagent', session('subagent', { parentID: 'root' })],
  ['finished', session('finished', { metadata: done })],
  ['archived', session('archived', { time: { created: 1, updated: 1, archived: 3 } })],
  ['other', session('other')],
]);

describe('selectSessionsToMarkDone', () => {
  test('takes selected root sessions in work, past subagents, finished, archived and unknown ones', () => {
    expect(selectSessionsToMarkDone(['root', 'btw', 'subagent', 'finished', 'archived', 'gone'], sessions).map((entry) => entry.id))
      .toEqual(['root', 'btw']);
  });
});

describe('bulk Mark done', () => {
  type Bulk = ReturnType<typeof useSidebarBulkActions>;

  type FinishWork = (work: SessionRowOrderWork, doneIds: ReadonlySet<string>) => Promise<FinishWorktreeWorkOutcome> | null;

  const render = async (
    markSessionsDone: (sessions: Session[]) => Promise<{ doneIds: string[]; failedIds: string[] } | null>,
    sessionWorkEnabled = true,
    options: { works?: SessionRowOrderWork[]; finishWork?: FinishWork } = {},
  ) => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    let bulk: Bulk | null = null;
    const Probe = () => {
      bulk = useSidebarBulkActions({
        isInlineEditing: false,
        showDeletionDialog: false,
        foldersMap: {},
        getFolderScopesForProject: () => [],
        folderOwnerKeyBySessionId: new Map(),
        addSessionsToFolder: () => {},
        removeSessionsFromFolders: () => {},
        createFolderAndStartRename: () => null,
        archiveSessions: async () => ({ archivedIds: [], failedIds: [] }),
        unarchiveSessions: async () => ({ restoredIds: [], failedIds: [] }),
        deleteSessions: async () => ({ deletedIds: [], failedIds: [] }),
        markSessionsDone,
        finishWork: options.finishWork ?? (() => null),
        sessionWorkEnabled,
        bulkDeleteConfirm: null,
        setBulkDeleteConfirm: () => {},
      });
      return null;
    };
    const draw = (works: SessionRowOrderWork[] | undefined) => root.render(
      <I18nProvider>
        <SessionRowOrderProvider entries={[]} descendantIds={[]} sessionsById={sessions} works={works}>
          <Probe />
        </SessionRowOrderProvider>
      </I18nProvider>,
    );
    await act(async () => draw(options.works));
    return {
      /** The sidebar rebuilding with other works listed, at once, mid-batch. */
      relist: (works: SessionRowOrderWork[]) => flushSync(() => draw(works)),
      get bulk(): Bulk {
        if (!bulk) throw new Error('the hook did not render');
        return bulk;
      },
      cleanup: async () => {
        await act(async () => root.unmount());
        dom.restore();
      },
    };
  };

  const select = (ids: string[]) => {
    useSessionMultiSelectStore.setState({ enabled: true, selectedIds: new Set(ids), scopeKey: 'activity:work', anchorId: null, anchorRowKey: null });
  };

  test('marks the selected sessions in work done and keeps only the failures selected', async () => {
    const original = useSessionMultiSelectStore.getState();
    const calls: string[][] = [];
    select(['root', 'btw', 'subagent', 'other']);
    const view = await render(async (targets) => {
      calls.push(targets.map((entry) => entry.id));
      return { doneIds: ['root', 'btw'], failedIds: ['other'] };
    });
    try {
      expect(view.bulk).toMatchObject({ bulkShowsMarkDone: true, bulkCanMarkDone: true });
      await act(async () => view.bulk.handleBulkMarkDone());

      expect(calls).toEqual([['root', 'btw', 'other']]);
      expect([...useSessionMultiSelectStore.getState().selectedIds]).toEqual(['other']);
    } finally {
      await view.cleanup();
      useSessionMultiSelectStore.setState(original, true);
    }
  });

  test('a failed write shows its cause, and only the failed session stays selected to retry', async () => {
    const original = useSessionMultiSelectStore.getState();
    const error = spyOn(toast, 'error').mockImplementation(() => 'toast');
    select(['root', 'other']);
    const view = await render(async () => {
      recordSessionActionFailure('other', new Error('folder is gone'));
      return { doneIds: ['root'], failedIds: ['other'] };
    });
    try {
      await act(async () => view.bulk.handleBulkMarkDone());

      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0]?.[1]).toEqual({ description: 'folder is gone' });
      expect([...useSessionMultiSelectStore.getState().selectedIds]).toEqual(['other']);
    } finally {
      error.mockRestore();
      await view.cleanup();
      useSessionMultiSelectStore.setState(original, true);
    }
  });

  const work = (id: string, ids: string[]): SessionRowOrderWork => ({
    projectId: 'project-a',
    // SAFETY: selecting finished works reads the directory, the pin and the sessions.
    group: {
      id, label: id, branch: null, description: null, isMain: false, directory: `/${id}`, folderScopeKey: `/${id}`,
      worktree: { path: `/${id}`, projectDirectory: '/repo', branch: id, label: id },
      sessions: ids.map((sessionId) => ({ session: sessions.get(sessionId) ?? session(sessionId), children: [], worktree: null })),
    } as SessionGroup,
  });

  test('a worktree work finished whole gets its own Done, one marked in part does not', async () => {
    const original = useSessionMultiSelectStore.getState();
    const finished: string[] = [];
    select(['root', 'btw']);
    const view = await render(async () => ({ doneIds: ['root', 'btw'], failedIds: [] }), true, {
      works: [work('whole', ['root', 'btw', 'finished']), work('part', ['btw', 'other'])],
      finishWork: async (entry, doneIds) => {
        finished.push(`${entry.group.id}:${[...doneIds].join(',')}`);
        return { kind: 'done' };
      },
    });
    try {
      await act(async () => view.bulk.handleBulkMarkDone());
      expect(finished).toEqual(['whole:root,btw']);
    } finally {
      await view.cleanup();
      useSessionMultiSelectStore.setState(original, true);
    }
  });

  test('a work finished whole still gets its Done when the sidebar drops it mid-batch', async () => {
    const original = useSessionMultiSelectStore.getState();
    const finished: string[] = [];
    select(['root', 'btw']);
    let relist: (works: SessionRowOrderWork[]) => void = () => {};
    const view = await render(async () => {
      // Its sessions are done now, so In work lists only the other work.
      relist([work('part', ['other'])]);
      return { doneIds: ['root', 'btw'], failedIds: [] };
    }, true, {
      works: [work('whole', ['root', 'btw']), work('part', ['other'])],
      finishWork: async (entry) => {
        finished.push(entry.group.id);
        return { kind: 'done' };
      },
    });
    relist = view.relist;
    try {
      await act(async () => view.bulk.handleBulkMarkDone());
      expect(finished).toEqual(['whole']);
    } finally {
      await view.cleanup();
      useSessionMultiSelectStore.setState(original, true);
    }
  });

  test('a stale batch leaves the selection alone', async () => {
    const original = useSessionMultiSelectStore.getState();
    select(['root', 'other']);
    const view = await render(async () => null);
    try {
      await act(async () => view.bulk.handleBulkMarkDone());
      expect([...useSessionMultiSelectStore.getState().selectedIds]).toEqual(['root', 'other']);
    } finally {
      await view.cleanup();
      useSessionMultiSelectStore.setState(original, true);
    }
  });

  test('is disabled with nothing in work selected, and hidden while work tracking is off', async () => {
    const original = useSessionMultiSelectStore.getState();
    let called = false;
    select(['finished', 'subagent']);
    const view = await render(async () => {
      called = true;
      return { doneIds: [], failedIds: [] };
    });
    const off = await render(async () => null, false);
    try {
      expect(view.bulk).toMatchObject({ bulkShowsMarkDone: true, bulkCanMarkDone: false });
      await act(async () => view.bulk.handleBulkMarkDone());
      expect(called).toBe(false);
      expect(off.bulk).toMatchObject({ bulkShowsMarkDone: false, bulkCanMarkDone: false });
    } finally {
      await off.cleanup();
      await view.cleanup();
      useSessionMultiSelectStore.setState(original, true);
    }
  });
});
