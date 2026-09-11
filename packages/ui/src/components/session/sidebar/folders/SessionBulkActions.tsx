import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { BulkActionBar } from './BulkActionBar';
import { BulkSessionDeleteConfirmDialog, type BulkDeleteSessionsConfirmState } from '../shell/ConfirmDialogs';
import { useSidebarBulkActions } from './useSidebarBulkActions';

type Props = {
  getFolderScopesForProject: (projectId: string) => readonly { scopeKey: string; directory: string | null }[];
  isInlineEditing: boolean;
  startFolderRename: (scopeKey: string, folder: { id: string; name: string }) => void;
};

/** Owns the sidebar selection projection and its destructive confirmation. */
export function SessionBulkActions({ getFolderScopesForProject, isInlineEditing, startFolderRename }: Props): React.ReactNode {
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
  const bulk = useSidebarBulkActions({
    isInlineEditing,
    showDeletionDialog,
    foldersMap,
    getFolderScopesForProject,
    addSessionsToFolder,
    removeSessionsFromFolders,
    createFolderAndStartRename: (scopeKey) => {
      const folder = createFolder(scopeKey, 'New folder');
      startFolderRename(scopeKey, folder);
      return folder;
    },
    archiveSessions,
    unarchiveSessions,
    deleteSessions,
    setBulkDeleteConfirm,
  });

  return <>
    {bulk.selectionModeEnabled && bulk.hasSelection ? <BulkActionBar
      selectedCount={bulk.selectedIdsSize}
      scopeKey={bulk.derivedSelectionScope}
      scopeFolders={bulk.bulkScopeFolders}
      archivedBucket={bulk.bulkScopeIsArchived}
      onMoveToFolder={bulk.handleBulkMoveToFolder}
      onCreateFolderAndMove={bulk.handleBulkCreateFolderAndMove}
      onRemoveFromFolder={bulk.handleBulkRemoveFromFolder}
      canRemoveFromFolder={bulk.bulkCanRemoveFromFolder}
      onRestore={bulk.handleBulkRestore}
      onDelete={bulk.handleBulkDelete}
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
