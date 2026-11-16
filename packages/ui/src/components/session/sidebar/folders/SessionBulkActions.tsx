import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { BulkActionBar } from './BulkActionBar';
import { BulkSessionDeleteConfirmDialog, type BulkDeleteSessionsConfirmState } from '../shell/ConfirmDialogs';
import { useSidebarBulkActions } from './useSidebarBulkActions';
import { finishBulkDoneWork, markSessionsDone } from '../works/workActions';
import type { SessionRowOrderWork } from '../sessions/sessionRowOrder';

// Archive on Done is read when the batch ends, as the row's Done reads it on click.
const finishWorkOnBulkDone = (work: SessionRowOrderWork, doneIds: ReadonlySet<string>) => (
  finishBulkDoneWork(work, doneIds, useUIStore.getState().worktreeArchiveOnDoneEnabled)
);

type Props = {
  getFolderScopesForProject: (projectId: string) => readonly { scopeKey: string; directory: string | null }[];
  isInlineEditing: boolean;
  startFolderRename: (scopeKey: string, folder: { id: string; name: string }) => void;
  folderOwnerKeyBySessionId: ReadonlyMap<string, string>;
};

/** Owns the sidebar selection projection and its destructive confirmation. */
export function SessionBulkActions({ getFolderScopesForProject, isInlineEditing, startFolderRename, folderOwnerKeyBySessionId }: Props): React.ReactNode {
  const { t } = useI18n();
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = React.useState<BulkDeleteSessionsConfirmState>(null);
  const showDeletionDialog = useUIStore((state) => state.showDeletionDialog);
  const setShowDeletionDialog = useUIStore((state) => state.setShowDeletionDialog);
  const foldersMap = useSessionFoldersStore((state) => state.foldersMap);
  const createFolder = useSessionFoldersStore((state) => state.createFolder);
  const addSessionsToFolder = useSessionFoldersStore((state) => state.addSessionsToFolder);
  const removeSessionsFromFolders = useSessionFoldersStore((state) => state.removeSessionsFromFolders);
  const archiveSessions = useSessionUIStore((state) => state.archiveSessions);
  const unarchiveSessions = useSessionUIStore((state) => state.unarchiveSessions);
  const deleteSessions = useSessionUIStore((state) => state.deleteSessions);
  const sessionWorkEnabled = useUIStore((state) => state.sessionWorkEnabled);
  const bulk = useSidebarBulkActions({
    isInlineEditing,
    showDeletionDialog,
    foldersMap,
    getFolderScopesForProject,
    folderOwnerKeyBySessionId,
    addSessionsToFolder,
    removeSessionsFromFolders,
    createFolderAndStartRename: (scopeKey) => {
      const folder = createFolder(scopeKey, t('sessions.sidebar.folders.newFolderTitle'));
      startFolderRename(scopeKey, folder);
      return folder;
    },
    archiveSessions,
    unarchiveSessions,
    deleteSessions,
    markSessionsDone,
    finishWork: finishWorkOnBulkDone,
    sessionWorkEnabled,
    bulkDeleteConfirm,
    setBulkDeleteConfirm,
  });

  return <>
    {bulk.selectionModeEnabled ? <BulkActionBar
      selectedCount={bulk.selectedIdsSize}
      scopeKey={bulk.derivedSelectionScope}
      scopeFolders={bulk.bulkScopeFolders}
      archivedBucket={bulk.bulkScopeIsArchived}
      onMoveToFolder={bulk.handleBulkMoveToFolder}
      onCreateFolderAndMove={bulk.handleBulkCreateFolderAndMove}
      onRemoveFromFolder={bulk.handleBulkRemoveFromFolder}
      canFileSelection={bulk.bulkCanMoveToFolder}
      canRemoveFromFolder={bulk.bulkCanRemoveFromFolder}
      onRestore={bulk.handleBulkRestore}
      showMarkDone={bulk.bulkShowsMarkDone}
      canMarkDone={bulk.bulkCanMarkDone}
      onMarkDone={bulk.handleBulkMarkDone}
      onArchive={bulk.handleBulkArchive}
      onDelete={bulk.handleBulkHardDelete}
      onDone={bulk.handleExitSelectionMode}
    /> : null}
    <BulkSessionDeleteConfirmDialog
      value={bulkDeleteConfirm}
      setValue={setBulkDeleteConfirm}
      showDeletionDialog={showDeletionDialog}
      setShowDeletionDialog={setShowDeletionDialog}
      onConfirm={bulk.confirmBulkDelete}
    />
  </>;
}
