import React from 'react';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';
import type { SessionFolder } from '@/stores/useSessionFoldersStore';
import { deriveSessionRowBulkSelectAll, deriveSessionRowSelectionArchived, useSessionRowOrderRegistry } from '../sessions/sessionRowOrder';
import type { BulkDeleteSessionsConfirmState } from '../shell/ConfirmDialogs';

const EMPTY_SESSIONS_BY_ID = new Map<string, { time?: { archived?: number | null } }>();

type Args = {
  isInlineEditing: boolean;
  showDeletionDialog: boolean;
  foldersMap: Record<string, SessionFolder[]>;
  /**
   * Selection scope is the project id (flat per-project session list); this
   * map resolves it to the project's folder scopes (root + worktrees). When
   * the scope is missing here it is treated as a plain directory scope.
   */
  getFolderScopesForProject: (projectId: string) => readonly { scopeKey: string; directory: string | null }[];
  addSessionsToFolder: (scopeKey: string, folderId: string, sessionIds: string[]) => void;
  removeSessionsFromFolders: (scopeKey: string, sessionIds: string[]) => void;
  createFolderAndStartRename: (scopeKey: string, parentId?: string | null) => { id: string } | null;
  archiveSessions: (ids: string[]) => Promise<{ archivedIds: string[]; failedIds: string[] }>;
  unarchiveSessions: (ids: string[]) => Promise<{ restoredIds: string[]; failedIds: string[] }>;
  deleteSessions: (ids: string[]) => Promise<{ deletedIds: string[]; failedIds: string[] }>;
  bulkDeleteConfirm: BulkDeleteSessionsConfirmState;
  setBulkDeleteConfirm: React.Dispatch<React.SetStateAction<BulkDeleteSessionsConfirmState>>;
};

export const resolveSelectionFolderScopes = (
  selectionScope: string | null,
  getFolderScopesForProject: Args['getFolderScopesForProject'],
): string[] => {
  if (!selectionScope) return [];
  const projectScopes = getFolderScopesForProject(selectionScope);
  return projectScopes.length > 0
    ? projectScopes.map((scope) => scope.scopeKey)
    : [selectionScope];
};

export const resolveBulkDeleteConfirmation = (
  value: NonNullable<BulkDeleteSessionsConfirmState>,
  sessionsById: ReadonlyMap<string, { time?: { archived?: number | null } }>,
): { ready: true; value: NonNullable<BulkDeleteSessionsConfirmState> }
  | { ready: false; value: NonNullable<BulkDeleteSessionsConfirmState> | null } => {
  const sessionIds = value.sessionIds.filter((id) => sessionsById.has(id));
  if (sessionIds.length === 0) return { ready: false, value: null };
  const archivedBucket = deriveSessionRowSelectionArchived(new Set(sessionIds), sessionsById);
  const next = { sessionIds, sessionCount: sessionIds.length, archivedBucket };
  return {
    ready: sessionIds.length === value.sessionIds.length && archivedBucket === value.archivedBucket,
    value: next,
  };
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
 * DOM-attribute scanning for the active/archived scope, etc.) is
 * deferred behind a `selectedIds.size > 0` check inside the hook itself.
 * Scope and archive state come from the selection store rather than mounted
 * row DOM, so virtual eviction cannot change the available actions.
 */
export const useSidebarBulkActions = (args: Args) => {
  const { t } = useI18n();
  const {
    isInlineEditing,
    showDeletionDialog,
    foldersMap,
    getFolderScopesForProject,
    addSessionsToFolder,
    removeSessionsFromFolders,
    createFolderAndStartRename,
    archiveSessions,
    unarchiveSessions,
    deleteSessions,
    bulkDeleteConfirm,
    setBulkDeleteConfirm,
  } = args;

  const selectionModeEnabled = useSessionMultiSelectStore((state) => state.enabled);
  const selectedIdsSize = useSessionMultiSelectStore((state) => state.selectedIds.size);
  const hasSelection = selectedIdsSize > 0;
  const selectedIds = useSessionMultiSelectStore((state) => state.selectedIds);
  const selectionScopeKey = useSessionMultiSelectStore((state) => state.scopeKey);
  const rowOrderRegistry = useSessionRowOrderRegistry();

  const handleToggleSelectionMode = React.useCallback(() => {
    useSessionMultiSelectStore.getState().toggleMode();
  }, []);
  const handleExitSelectionMode = React.useCallback(() => {
    useSessionMultiSelectStore.getState().disable();
  }, []);

  const bulkScopeIsArchived = hasSelection && deriveSessionRowSelectionArchived(
    selectedIds,
    rowOrderRegistry?.getSessionsById() ?? EMPTY_SESSIONS_BY_ID,
  );

  const derivedSelectionScope = React.useMemo(() => {
    if (selectionScopeKey) return selectionScopeKey;
    return null;
  }, [selectionScopeKey]);

  // The selection scope is a project id; folders live per directory scope
  // (project root + each worktree). Resolve all of them, in project order.
  const selectionFolderScopes = React.useMemo<string[]>(() => {
    return resolveSelectionFolderScopes(derivedSelectionScope, getFolderScopesForProject);
  }, [derivedSelectionScope, getFolderScopesForProject]);

  const bulkScopeFolders = React.useMemo(() => {
    return selectionFolderScopes.flatMap((scope) => foldersMap[scope] ?? []);
  }, [foldersMap, selectionFolderScopes]);

  const resolveFolderScope = React.useCallback((folderId: string): string | null => {
    for (const scope of selectionFolderScopes) {
      if ((foldersMap[scope] ?? []).some((folder) => folder.id === folderId)) return scope;
    }
    return null;
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
    const ids = Array.from(selectedIds);
    // Clear memberships in every other scope first — the store only dedupes
    // within one scope, and a session must live in a single folder.
    for (const scope of selectionFolderScopes) {
      if (scope === targetScope) continue;
      removeSessionsFromFolders(scope, ids);
    }
    addSessionsToFolder(targetScope, folderId, ids);
  }, [addSessionsToFolder, removeSessionsFromFolders, selectedIds, selectionFolderScopes]);

  const handleBulkMoveToFolder = React.useCallback((folderId: string) => {
    if (!hasSelection) return;
    const targetScope = resolveFolderScope(folderId);
    if (!targetScope) return;
    moveSelectionToFolder(targetScope, folderId);
  }, [hasSelection, moveSelectionToFolder, resolveFolderScope]);

  const handleBulkCreateFolderAndMove = React.useCallback(() => {
    const targetScope = selectionFolderScopes[0];
    if (!targetScope || !hasSelection) return;
    const newFolder = createFolderAndStartRename(targetScope);
    if (!newFolder) return;
    moveSelectionToFolder(targetScope, newFolder.id);
  }, [createFolderAndStartRename, hasSelection, moveSelectionToFolder, selectionFolderScopes]);

  const handleBulkRemoveFromFolder = React.useCallback(() => {
    if (!hasSelection) return;
    const ids = Array.from(selectedIds);
    for (const scope of selectionFolderScopes) {
      removeSessionsFromFolders(scope, ids);
    }
  }, [removeSessionsFromFolders, selectedIds, selectionFolderScopes, hasSelection]);

  const executeBulkDelete = React.useCallback(async (ids: string[], archivedBucket: boolean) => {
    if (ids.length === 0) return;
    if (archivedBucket) {
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
      useSessionMultiSelectStore.getState().removeMany(deletedIds);
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
      useSessionMultiSelectStore.getState().removeMany(archivedIds);
    }
  }, [archiveSessions, deleteSessions, t]);

  const handleBulkDelete = React.useCallback(() => {
    if (!hasSelection) return;
    const sessionIds = Array.from(selectedIds);
    if (!showDeletionDialog) {
      void executeBulkDelete(sessionIds, bulkScopeIsArchived);
      return;
    }
    setBulkDeleteConfirm({ sessionIds, sessionCount: sessionIds.length, archivedBucket: bulkScopeIsArchived });
  }, [bulkScopeIsArchived, executeBulkDelete, selectedIds, showDeletionDialog, setBulkDeleteConfirm, hasSelection]);

  const handleBulkRestore = React.useCallback(async () => {
    if (!hasSelection || !bulkScopeIsArchived) return;
    const ids = Array.from(selectedIds);
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
    useSessionMultiSelectStore.getState().removeMany(restoredIds);
  }, [bulkScopeIsArchived, hasSelection, selectedIds, t, unarchiveSessions]);

  const confirmBulkDelete = React.useCallback(async () => {
    if (!bulkDeleteConfirm) return;
    const sessionsById = rowOrderRegistry?.getSessionsById() ?? EMPTY_SESSIONS_BY_ID;
    const resolution = resolveBulkDeleteConfirmation(bulkDeleteConfirm, sessionsById);
    if (!resolution.ready) {
      setBulkDeleteConfirm(resolution.value);
      return;
    }
    setBulkDeleteConfirm(null);
    await executeBulkDelete(resolution.value.sessionIds, resolution.value.archivedBucket);
  }, [bulkDeleteConfirm, executeBulkDelete, rowOrderRegistry, setBulkDeleteConfirm]);

  React.useEffect(() => {
    if (!selectionModeEnabled) return;
    const isMac = /Macintosh|Mac OS X/.test(navigator.userAgent || '');
    const listener = (event: KeyboardEvent) => {
      if (bulkDeleteConfirm) return;
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
          rowOrderRegistry?.getEntries() ?? [],
          rowOrderRegistry?.getDescendantIds() ?? [],
          useSessionMultiSelectStore.getState().scopeKey,
        );
        if (!selection) return;
        event.preventDefault();
        useSessionMultiSelectStore.getState().replaceAll(selection.ids, selection.scopeKey);
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [bulkDeleteConfirm, handleBulkDelete, isInlineEditing, rowOrderRegistry, selectionModeEnabled]);

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
