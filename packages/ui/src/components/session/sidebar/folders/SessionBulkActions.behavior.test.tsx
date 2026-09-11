import { describe, expect, mock, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';
import { useUIStore } from '@/stores/useUIStore';
import { installHookTestDom } from '../test-utils/testDom';

type BulkActionCapture = {
  archivedBucket: boolean;
  onCreateFolderAndMove: () => void;
  onDelete: () => void;
};

let bulkActionCapture: BulkActionCapture | null = null;

mock.module('./BulkActionBar', () => ({
  BulkActionBar: (props: BulkActionCapture) => {
    bulkActionCapture = props;
    return null;
  },
}));

mock.module('./ConfirmDialogs', () => ({
  BulkSessionDeleteConfirmDialog: () => null,
}));

const { SessionBulkActions } = await import('./SessionBulkActions');
const session = (id: string): Session => ({
  id,
  slug: id,
  projectID: 'project',
  title: id,
  version: '1',
  directory: '/workspace',
  time: { created: 1, updated: 1 },
});

describe('SessionBulkActions public behavior', () => {
  test('moves the selected sessions into a newly created folder while a row edit is active', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const originalFolders = useSessionFoldersStore.getState();
    const originalSelection = useSessionMultiSelectStore.getState();
    const renameRequests: Array<{ scopeKey: string; folder: { id: string; name: string } }> = [];
    const moved: Array<{ scopeKey: string; folderId: string; ids: string[] }> = [];
    useSessionFoldersStore.setState({
      foldersMap: {},
      addSessionsToFolder: (scopeKey, folderId, ids) => moved.push({ scopeKey, folderId, ids }),
    });
    useSessionMultiSelectStore.setState({
      enabled: true,
      selectedIds: new Set(['session-a']),
      scopeKey: 'project-a',
      anchorId: 'session-a',
    });
    try {
      await act(async () => root.render(
        <I18nProvider>
          <SessionBulkActions
            getFolderScopesForProject={() => [{ scopeKey: '/workspace', directory: '/workspace' }]}
            isSessionArchived={() => false}
            isInlineEditing
            sessionTreeRoots={[]}
            startFolderRename={(scopeKey, folder) => renameRequests.push({ scopeKey, folder })}
          />
        </I18nProvider>,
      ));
      expect(bulkActionCapture).not.toBeNull();

      await act(async () => bulkActionCapture?.onCreateFolderAndMove());
      const createdFolder = useSessionFoldersStore.getState().foldersMap['/workspace']?.[0];
      expect(createdFolder?.name).toBe('New folder');
      expect(renameRequests).toEqual([{ scopeKey: '/workspace', folder: createdFolder }]);
      expect(moved).toEqual([{ scopeKey: '/workspace', folderId: createdFolder?.id ?? '', ids: ['session-a'] }]);
    } finally {
      await act(async () => root.unmount());
      useSessionFoldersStore.setState(originalFolders, true);
      useSessionMultiSelectStore.setState(originalSelection, true);
      bulkActionCapture = null;
      dom.restore();
    }
  });

  test('uses the grouped tree for off-screen destructive scope and archive state', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const originalSelection = useSessionMultiSelectStore.getState();
    const originalArchiveSessions = useSessionUIStore.getState().archiveSessions;
    const originalDeleteSessions = useSessionUIStore.getState().deleteSessions;
    const originalShowDeletionDialog = useUIStore.getState().showDeletionDialog;
    const archiveCalls: string[][] = [];
    const deleteCalls: string[][] = [];
    useSessionMultiSelectStore.setState({
      enabled: true,
      selectedIds: new Set(['archived-parent', 'live-child']),
      scopeKey: 'project-a',
      anchorId: 'archived-parent',
    });
    useUIStore.setState({ showDeletionDialog: false });
    useSessionUIStore.setState({
      archiveSessions: async (ids) => {
        archiveCalls.push(ids);
        return { archivedIds: ids, failedIds: [] };
      },
      deleteSessions: async (ids) => {
        deleteCalls.push(ids);
        return { deletedIds: ids, failedIds: [] };
      },
    });

    try {
      await act(async () => root.render(
        <I18nProvider>
          <SessionBulkActions
            getFolderScopesForProject={() => [{ scopeKey: '/workspace', directory: '/workspace' }]}
            isSessionArchived={(sessionId) => sessionId !== 'live-child'}
            isInlineEditing={false}
            sessionTreeRoots={[{
              session: session('archived-parent'),
              children: [
                { session: session('live-child'), children: [], worktree: null },
                { session: session('archived-child'), children: [], worktree: null },
              ],
              worktree: null,
            }]}
            startFolderRename={() => undefined}
          />
        </I18nProvider>,
      ));
      expect(bulkActionCapture?.archivedBucket).toBe(false);

      await act(async () => {
        bulkActionCapture?.onDelete();
        await Promise.resolve();
      });
      expect(archiveCalls).toEqual([['archived-parent', 'live-child', 'archived-child']]);
      expect(deleteCalls).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      useSessionUIStore.setState({
        archiveSessions: originalArchiveSessions,
        deleteSessions: originalDeleteSessions,
      });
      useSessionMultiSelectStore.setState(originalSelection, true);
      useUIStore.setState({ showDeletionDialog: originalShowDeletionDialog });
      bulkActionCapture = null;
      dom.restore();
    }
  });
});
