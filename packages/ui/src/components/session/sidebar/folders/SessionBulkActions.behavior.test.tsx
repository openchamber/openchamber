import { describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Session } from '@opencode-ai/sdk/v2';
import { I18nProvider } from '@/lib/i18n';
import { useSessionFoldersStore, type SessionFolder } from '@/stores/useSessionFoldersStore';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { installHookTestDom } from '../test-utils/testDom';
import { SessionRowOrderProvider, useRegisterSessionRowOrder } from '../sessions/sessionRowOrder';
import type { SessionRowOrderEntry } from '../sessions/sessionRowOrderUtils';
import { getProjectFolderScopesFromTopology } from '../sessions/sessionFolderIdentity';
import type { SidebarFolderTarget } from './useSidebarBulkActions';

type BulkActionCapture = {
  scopeFolders: readonly { scopeKey: string; folder: SessionFolder }[];
  archivedBucket: boolean;
  onDelete: () => void;
  onMoveToFolder: (target: SidebarFolderTarget) => void;
  onCreateFolderAndMove: () => void;
};

let bulkActionCapture: BulkActionCapture | null = null;

const getBulkActionCapture = (): BulkActionCapture => {
  if (!bulkActionCapture) throw new Error('bulk action bar was not rendered');
  return bulkActionCapture;
};

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

const makeSession = (id: string, archived: boolean): Session => ({
  id,
  slug: id,
  projectID: 'project-a',
  title: id,
  version: '1',
  directory: '/workspace/project-a',
  time: archived
    ? { created: 1, updated: 1, archived: 2 }
    : { created: 1, updated: 1 },
});

const RegisteredRows = ({ entries }: { entries: readonly SessionRowOrderEntry[] }): React.ReactNode => {
  useRegisterSessionRowOrder(0, entries);
  return null;
};

const PROJECT_FOLDER_TOPOLOGY = [{
  project: { id: 'project-a', normalizedPath: '/workspace' },
  groups: [
    { directory: '/workspace', folderScopeKey: '/workspace', isArchivedBucket: false },
    { directory: '/workspace/worktree', folderScopeKey: '/workspace/worktree', isArchivedBucket: false },
    { directory: null, folderScopeKey: '/workspace/.archived', isArchivedBucket: true },
  ],
}];

describe('SessionBulkActions public behavior', () => {
  test('moves the selected sessions into a newly created folder while a row edit is active', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const originalFolders = useSessionFoldersStore.getState();
    const originalSelection = useSessionMultiSelectStore.getState();
    const cssDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'CSS');
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
    Object.defineProperty(globalThis, 'CSS', {
      configurable: true,
      value: { escape: (value: string) => value },
    });

    try {
      await act(async () => root.render(
        <I18nProvider>
          <SessionBulkActions
            getFolderScopesForSelectionScope={(selectionScope) => getProjectFolderScopesFromTopology(PROJECT_FOLDER_TOPOLOGY, selectionScope)}
            selectedSessionsById={new Map()}
            isInlineEditing
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
      if (cssDescriptor) Object.defineProperty(globalThis, 'CSS', cssDescriptor);
      else Reflect.deleteProperty(globalThis, 'CSS');
      bulkActionCapture = null;
      dom.restore();
    }
  });

  test('keeps duplicate folder ids scoped and resolves bulk moves by target scope', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const originalFolders = useSessionFoldersStore.getState();
    const originalSelection = useSessionMultiSelectStore.getState();
    const removals: Array<{ scopeKey: string; ids: string[] }> = [];
    const moved: Array<{ scopeKey: string; folderId: string; ids: string[] }> = [];
    const rootFolder: SessionFolder = { id: 'same-id', name: 'Root folder', parentId: null, sessionIds: ['session-a'], createdAt: 1 };
    const worktreeFolder: SessionFolder = { id: 'same-id', name: 'Worktree folder', parentId: null, sessionIds: [], createdAt: 2 };
    useSessionFoldersStore.setState({
      foldersMap: {
        '/workspace': [rootFolder],
        '/workspace/worktree': [worktreeFolder],
      },
      removeSessionsFromFolders: (scopeKey, ids) => removals.push({ scopeKey, ids }),
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
            getFolderScopesForSelectionScope={() => [
              { scopeKey: '/workspace', directory: '/workspace' },
              { scopeKey: '/workspace/worktree', directory: '/workspace/worktree' },
            ]}
            selectedSessionsById={new Map()}
            isInlineEditing={false}
            startFolderRename={() => undefined}
          />
        </I18nProvider>,
      ));
      expect(bulkActionCapture?.scopeFolders.map(({ scopeKey, folder }) => `${scopeKey}:${folder.id}`)).toEqual([
        '/workspace:same-id',
        '/workspace/worktree:same-id',
      ]);

      await act(async () => bulkActionCapture?.onMoveToFolder({ scopeKey: '/workspace/worktree', folderId: 'same-id' }));
      expect(removals).toEqual([{ scopeKey: '/workspace', ids: ['session-a'] }]);
      expect(moved).toEqual([{ scopeKey: '/workspace/worktree', folderId: 'same-id', ids: ['session-a'] }]);
    } finally {
      await act(async () => root.unmount());
      useSessionFoldersStore.setState(originalFolders, true);
      useSessionMultiSelectStore.setState(originalSelection, true);
      bulkActionCapture = null;
      dom.restore();
    }
  });

  test('uses authoritative metadata for hidden active selections before destructive action', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const originalFolders = useSessionFoldersStore.getState();
    const originalSelection = useSessionMultiSelectStore.getState();
    const originalSessionUI = useSessionUIStore.getState();
    const originalUI = useUIStore.getState();
    const archivedIds: string[][] = [];
    const deletedIds: string[][] = [];
    const entries: SessionRowOrderEntry[] = [
      { id: 'visible-archived', rowKey: 'row:visible-archived', scopeKey: 'project-a', archived: true },
      { id: 'visible-archived', rowKey: 'row:visible-archived:duplicate', scopeKey: 'project-a', archived: true },
    ];
    useSessionMultiSelectStore.setState({
      enabled: true,
      selectedIds: new Set(['visible-archived', 'hidden-active']),
      scopeKey: 'project-a',
      anchorId: 'visible-archived',
      anchorRowKey: 'row:visible-archived',
    });
    useSessionUIStore.setState({
      archiveSessions: async (ids) => {
        archivedIds.push(ids);
        return { archivedIds: ids, failedIds: [] };
      },
      deleteSessions: async (ids) => {
        deletedIds.push(ids);
        return { deletedIds: ids, failedIds: [] };
      },
    });
    useUIStore.setState({ showDeletionDialog: false });

    try {
      await act(async () => root.render(
        <I18nProvider>
          <SessionRowOrderProvider>
            <RegisteredRows entries={entries} />
            <SessionBulkActions
              getFolderScopesForSelectionScope={() => []}
              selectedSessionsById={new Map([
                ['visible-archived', makeSession('visible-archived', true)],
                ['hidden-active', makeSession('hidden-active', false)],
              ])}
              isInlineEditing={false}
              startFolderRename={() => undefined}
            />
          </SessionRowOrderProvider>
        </I18nProvider>,
      ));
      expect(getBulkActionCapture().archivedBucket).toBe(false);

      await act(async () => getBulkActionCapture().onDelete());

      expect(archivedIds).toEqual([['visible-archived', 'hidden-active']]);
      expect(deletedIds).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      useSessionFoldersStore.setState(originalFolders, true);
      useSessionMultiSelectStore.setState(originalSelection, true);
      useSessionUIStore.setState(originalSessionUI, true);
      useUIStore.setState(originalUI, true);
      bulkActionCapture = null;
      dom.restore();
    }
  });

  test('keeps archived-only bulk delete and deduplicates API ids', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const originalFolders = useSessionFoldersStore.getState();
    const originalSelection = useSessionMultiSelectStore.getState();
    const originalSessionUI = useSessionUIStore.getState();
    const originalUI = useUIStore.getState();
    const deletedIds: string[][] = [];
    const archivedIds: string[][] = [];
    useSessionMultiSelectStore.setState({
      enabled: true,
      selectedIds: new Set(['visible-archived', 'hidden-archived']),
      scopeKey: 'project-a',
      anchorId: 'visible-archived',
      anchorRowKey: 'row:visible-archived',
    });
    useSessionUIStore.setState({
      archiveSessions: async (ids) => {
        archivedIds.push(ids);
        return { archivedIds: ids, failedIds: [] };
      },
      deleteSessions: async (ids) => {
        deletedIds.push(ids);
        return { deletedIds: ids, failedIds: [] };
      },
    });
    useUIStore.setState({ showDeletionDialog: false });

    try {
      await act(async () => root.render(
        <I18nProvider>
          <SessionRowOrderProvider>
            <RegisteredRows entries={[
              { id: 'visible-archived', rowKey: 'row:visible-archived', scopeKey: 'project-a', archived: true },
              { id: 'visible-archived', rowKey: 'row:visible-archived:duplicate', scopeKey: 'project-a', archived: true },
            ]} />
            <SessionBulkActions
              getFolderScopesForSelectionScope={() => []}
              selectedSessionsById={new Map([
                ['visible-archived', makeSession('visible-archived', true)],
                ['hidden-archived', makeSession('hidden-archived', true)],
              ])}
              isInlineEditing={false}
              startFolderRename={() => undefined}
            />
          </SessionRowOrderProvider>
        </I18nProvider>,
      ));
      expect(getBulkActionCapture().archivedBucket).toBe(true);

      await act(async () => getBulkActionCapture().onDelete());

      expect(deletedIds).toEqual([['visible-archived', 'hidden-archived']]);
      expect(archivedIds).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      useSessionFoldersStore.setState(originalFolders, true);
      useSessionMultiSelectStore.setState(originalSelection, true);
      useSessionUIStore.setState(originalSessionUI, true);
      useUIStore.setState(originalUI, true);
      bulkActionCapture = null;
      dom.restore();
    }
  });
});
