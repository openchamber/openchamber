import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';
import type { SessionFolder } from '@/stores/useSessionFoldersStore';
import { useSessionRowOrderRegistry } from '../sessions/sessionRowOrder';
import {
  deriveSessionRowBulkSelectAll,
  deriveSessionRowSelectionArchived,
  deriveSessionRowSelectionScope,
} from '../sessions/sessionRowOrderUtils';

type Args = {
  isInlineEditing: boolean;
  showDeletionDialog: boolean;
  foldersMap: Record<string, SessionFolder[]>;
  /** Complete session metadata for selected API ids, independent of row visibility. */
  selectedSessionsById: ReadonlyMap<string, Session>;
  /**
   * Selection scope is a project id or managed-Chats owner; this map resolves
   * it to every folder scope owned by that logical container. When the scope
   * is missing here it is treated as a plain directory scope.
   */
  getFolderScopesForSelectionScope: (selectionScope: string) => readonly { scopeKey: string; directory: string | null }[];
  addSessionsToFolder: (scopeKey: string, folderId: string, sessionIds: string[]) => void;
  removeSessionsFromFolders: (scopeKey: string, sessionIds: string[]) => void;
  createFolderAndStartRename: (scopeKey: string, parentId?: string | null) => { id: string } | null;
  archiveSessions: (ids: string[]) => Promise<{ archivedIds: string[]; failedIds: string[] }>;
  unarchiveSessions: (ids: string[]) => Promise<{ restoredIds: string[]; failedIds: string[] }>;
  deleteSessions: (ids: string[]) => Promise<{ deletedIds: string[]; failedIds: string[] }>;
  setBulkDeleteConfirm: React.Dispatch<React.SetStateAction<{
    sessionCount: number;
    archivedBucket: boolean;
  } | null>>;
};

export type SidebarFolderTarget = {
  scopeKey: string;
  folderId: string;
};

export const resolveSelectionFolderScopes = (
  selectionScope: string | null,
  getFolderScopesForSelectionScope: Args['getFolderScopesForSelectionScope'],
): string[] => {
  if (!selectionScope) return [];
  const projectScopes = getFolderScopesForSelectionScope(selectionScope);
  const scopeKeys = [...new Set(projectScopes.map((scope) => scope.scopeKey).filter(Boolean))];
  return scopeKeys.length > 0
    ? scopeKeys
    : [selectionScope];
};

/**
 * Bulk-action logic for the sidebar. The hot-path concern is that this
 * hook subscribes to `useSessionMultiSelectStore` — which can fire on
 * every selection toggle and on every setRange/toggleSelected call —
 * but the rest of the Sidebar tree only needs the boolean
 * `selectionModeEnabled` flag to decide whether to render the
 * selection chrome.
 *
 * To keep that subscription narrow, the heavy work (folders lookup,
 * registry scans for the active/archived scope, etc.) is deferred behind a
 * `selectedIds.size > 0` check inside the hook itself, so toggling selection
 * mode on/off does not force the downstream useMemo chain to re-evaluate when
 * no rows are selected.
 */
export const useSidebarBulkActions = (args: Args) => {
  const { t } = useI18n();
  const {
    isInlineEditing,
    showDeletionDialog,
    foldersMap,
    selectedSessionsById,
    getFolderScopesForSelectionScope,
    addSessionsToFolder,
    removeSessionsFromFolders,
    createFolderAndStartRename,
    archiveSessions,
    unarchiveSessions,
    deleteSessions,
    setBulkDeleteConfirm,
  } = args;

  const selectionModeEnabled = useSessionMultiSelectStore((state) => state.enabled);
  const selectedIdsSize = useSessionMultiSelectStore((state) => state.selectedIds.size);
  const hasSelection = selectedIdsSize > 0;
  const selectedIds = useSessionMultiSelectStore((state) => state.selectedIds);
  const selectionScopeKey = useSessionMultiSelectStore((state) => state.scopeKey);
  const sessionRowOrderRegistry = useSessionRowOrderRegistry();

  const handleToggleSelectionMode = React.useCallback(() => {
    useSessionMultiSelectStore.getState().toggleMode();
  }, []);
  const handleExitSelectionMode = React.useCallback(() => {
    useSessionMultiSelectStore.getState().disable();
  }, []);

  // All of the below short-circuit on `hasSelection` so the registry scan
  // and folder-lookup work only runs when there's something to act on.
  const bulkScopeIsArchived = React.useMemo(() => {
    if (!hasSelection) return false;
    return deriveSessionRowSelectionArchived(
      sessionRowOrderRegistry?.getOrderedEntries() ?? [],
      selectedIds,
      selectedSessionsById,
    );
  }, [hasSelection, selectedIds, selectedSessionsById, sessionRowOrderRegistry]);

  const derivedSelectionScope = React.useMemo(() => {
    if (selectionScopeKey) return selectionScopeKey;
    if (!hasSelection) return null;
    return deriveSessionRowSelectionScope(
      sessionRowOrderRegistry?.getOrderedEntries() ?? [],
      selectedIds,
    );
  }, [hasSelection, selectedIds, selectionScopeKey, sessionRowOrderRegistry]);

  // The selection scope is a project id; folders live per directory scope
  // (project root + each worktree). Resolve all of them, in project order.
  const selectionFolderScopes = React.useMemo<string[]>(() => {
    return resolveSelectionFolderScopes(derivedSelectionScope, getFolderScopesForSelectionScope);
  }, [derivedSelectionScope, getFolderScopesForSelectionScope]);

  const bulkScopeFolders = React.useMemo(() => {
    const targets = selectionFolderScopes.flatMap((scopeKey) => (foldersMap[scopeKey] ?? []).map((folder) => ({ scopeKey, folder })));
    return targets.filter((target, index) => targets.findIndex((candidate) => (
      candidate.scopeKey === target.scopeKey && candidate.folder.id === target.folder.id
    )) === index);
  }, [foldersMap, selectionFolderScopes]);

  const bulkCanRemoveFromFolder = React.useMemo(() => {
    if (!hasSelection) return false;
    for (const scope of selectionFolderScopes) {
      for (const folder of foldersMap[scope] ?? []) {
        for (const id of folder.sessionIds) {
          if (selectedIds.has(id)) return true;
        }
      }
    }
    return false;
  }, [foldersMap, selectionFolderScopes, hasSelection, selectedIds]);

  const moveSelectionToFolder = React.useCallback((targetScope: string, folderId: string) => {
    const ids = [...new Set(selectedIds)];
    // Clear memberships in every other scope first — the store only dedupes
    // within one scope, and a session must live in a single folder.
    for (const scope of selectionFolderScopes) {
      if (scope === targetScope) continue;
      removeSessionsFromFolders(scope, ids);
    }
    addSessionsToFolder(targetScope, folderId, ids);
  }, [addSessionsToFolder, removeSessionsFromFolders, selectedIds, selectionFolderScopes]);

  const handleBulkMoveToFolder = React.useCallback(({ scopeKey, folderId }: SidebarFolderTarget) => {
    if (!hasSelection) return;
    if (!selectionFolderScopes.includes(scopeKey)) return;
    const targetFolders = foldersMap[scopeKey] ?? [];
    if (targetFolders.filter((folder) => folder.id === folderId).length !== 1) return;
    moveSelectionToFolder(scopeKey, folderId);
  }, [foldersMap, hasSelection, moveSelectionToFolder, selectionFolderScopes]);

  const handleBulkCreateFolderAndMove = React.useCallback(() => {
    const targetScope = selectionFolderScopes[0];
    if (!targetScope || !hasSelection) return;
    const newFolder = createFolderAndStartRename(targetScope);
    if (!newFolder) return;
    moveSelectionToFolder(targetScope, newFolder.id);
  }, [createFolderAndStartRename, hasSelection, moveSelectionToFolder, selectionFolderScopes]);

  const handleBulkRemoveFromFolder = React.useCallback(() => {
    if (!hasSelection) return;
    const ids = [...new Set(selectedIds)];
    for (const scope of selectionFolderScopes) {
      removeSessionsFromFolders(scope, ids);
    }
  }, [removeSessionsFromFolders, selectedIds, selectionFolderScopes, hasSelection]);

  const executeBulkDelete = React.useCallback(async () => {
    const ids = [...new Set(selectedIds)];
    if (ids.length === 0) return;
    if (bulkScopeIsArchived) {
      const { deletedIds, failedIds } = await deleteSessions(ids);
      if (deletedIds.length > 0) {
        toast.success(deletedIds.length === 1
          ? t('sessions.sidebar.bulkActions.deletedSingle', { count: deletedIds.length })
          : t('sessions.sidebar.bulkActions.deletedPlural', { count: deletedIds.length }));
      }
      if (failedIds.length > 0) {
        toast.error(failedIds.length === 1
          ? t('sessions.sidebar.bulkActions.failedDeleteSingle', { count: failedIds.length })
          : t('sessions.sidebar.bulkActions.failedDeletePlural', { count: failedIds.length }));
      }
    } else {
      const { archivedIds, failedIds } = await archiveSessions(ids);
      if (archivedIds.length > 0) {
        toast.success(archivedIds.length === 1
          ? t('sessions.sidebar.bulkActions.archivedSingle', { count: archivedIds.length })
          : t('sessions.sidebar.bulkActions.archivedPlural', { count: archivedIds.length }));
      }
      if (failedIds.length > 0) {
        toast.error(failedIds.length === 1
          ? t('sessions.sidebar.bulkActions.failedArchiveSingle', { count: failedIds.length })
          : t('sessions.sidebar.bulkActions.failedArchivePlural', { count: failedIds.length }));
      }
    }
    useSessionMultiSelectStore.getState().clear();
  }, [archiveSessions, bulkScopeIsArchived, deleteSessions, selectedIds, t]);

  const handleBulkDelete = React.useCallback(() => {
    if (!hasSelection) return;
    const count = selectedIds.size;
    if (!showDeletionDialog) {
      void executeBulkDelete();
      return;
    }
    setBulkDeleteConfirm({ sessionCount: count, archivedBucket: bulkScopeIsArchived });
  }, [bulkScopeIsArchived, executeBulkDelete, selectedIds, showDeletionDialog, setBulkDeleteConfirm, hasSelection]);

  const handleBulkRestore = React.useCallback(async () => {
    if (!hasSelection || !bulkScopeIsArchived) return;
    const ids = [...new Set(selectedIds)];
    const { restoredIds, failedIds } = await unarchiveSessions(ids);
    if (restoredIds.length > 0) {
      toast.success(restoredIds.length === 1
        ? t('sessions.sidebar.bulkActions.restoredSingle', { count: restoredIds.length })
        : t('sessions.sidebar.bulkActions.restoredPlural', { count: restoredIds.length }));
    }
    if (failedIds.length > 0) {
      toast.error(failedIds.length === 1
        ? t('sessions.sidebar.bulkActions.failedRestoreSingle', { count: failedIds.length })
        : t('sessions.sidebar.bulkActions.failedRestorePlural', { count: failedIds.length }));
    }
    useSessionMultiSelectStore.getState().clear();
  }, [bulkScopeIsArchived, hasSelection, selectedIds, t, unarchiveSessions]);

  const confirmBulkDelete = React.useCallback(async () => {
    setBulkDeleteConfirm(null);
    await executeBulkDelete();
    // setBulkDeleteConfirm is a stable React state setter; intentionally
    // omitted from deps to avoid forcing the keyboard-listener effect
    // below to re-subscribe on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [executeBulkDelete]);

  React.useEffect(() => {
    if (!selectionModeEnabled) return;
    const isMac = /Macintosh|Mac OS X/.test(globalThis.navigator?.userAgent ?? '');
    const listener = (event: KeyboardEvent) => {
      if (isInlineEditing) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      const modifier = isMac ? event.metaKey : event.ctrlKey;
      if (event.key === 'Escape') {
        event.preventDefault();
        useSessionMultiSelectStore.getState().disable();
        return;
      }
      if (modifier && event.key === 'Backspace') {
        event.preventDefault();
        handleBulkDelete();
        return;
      }
      if (modifier && (event.key === 'a' || event.key === 'A')) {
        const selection = deriveSessionRowBulkSelectAll(
          sessionRowOrderRegistry?.getOrderedEntries() ?? [],
          useSessionMultiSelectStore.getState().scopeKey,
        );
        if (!selection) return;
        event.preventDefault();
        useSessionMultiSelectStore.getState().replaceAll(selection.ids, selection.scopeKey);
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [handleBulkDelete, isInlineEditing, selectionModeEnabled, sessionRowOrderRegistry]);

  return {
    selectionModeEnabled,
    hasSelection,
    selectedIdsSize,
    bulkScopeIsArchived,
    derivedSelectionScope,
    bulkScopeFolders,
    bulkCanRemoveFromFolder,
    handleToggleSelectionMode,
    handleExitSelectionMode,
    handleBulkMoveToFolder,
    handleBulkCreateFolderAndMove,
    handleBulkRemoveFromFolder,
    handleBulkDelete,
    handleBulkRestore,
    confirmBulkDelete,
  };
};
