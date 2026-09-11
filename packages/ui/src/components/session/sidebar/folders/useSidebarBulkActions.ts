import React from 'react';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';
import type { SessionFolder } from '@/stores/useSessionFoldersStore';

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
  setBulkDeleteConfirm: React.Dispatch<React.SetStateAction<{
    sessionCount: number;
    archivedBucket: boolean;
  } | null>>;
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
 * deferred behind a `selectedIds.size > 0` check inside the hook
 * itself, so toggling selection mode on/off does not force the
 * downstream useMemo chain to re-evaluate when no rows are selected.
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
    setBulkDeleteConfirm,
  } = args;

  const selectionModeEnabled = useSessionMultiSelectStore((state) => state.enabled);
  const selectedIdsSize = useSessionMultiSelectStore((state) => state.selectedIds.size);
  const hasSelection = selectedIdsSize > 0;
  const selectedIds = useSessionMultiSelectStore((state) => state.selectedIds);
  const selectionScopeKey = useSessionMultiSelectStore((state) => state.scopeKey);

  const handleToggleSelectionMode = React.useCallback(() => {
    useSessionMultiSelectStore.getState().toggleMode();
  }, []);
  const handleExitSelectionMode = React.useCallback(() => {
    useSessionMultiSelectStore.getState().disable();
  }, []);

  // All of the below short-circuit on `hasSelection` so the DOM-scanning
  // and folder-lookup work only runs when there's something to act on.
  const bulkScopeIsArchived = React.useMemo(() => {
    if (!hasSelection) return false;
    if (typeof document === 'undefined') return false;
    let sawActive = false;
    let sawArchived = false;
    for (const id of selectedIds) {
      const rows = document.querySelectorAll<HTMLElement>(`[data-session-row="${CSS.escape(id)}"]`);
      for (const row of rows) {
        if (row.getAttribute('data-session-archived') === '1') sawArchived = true;
        else sawActive = true;
      }
    }
    return sawArchived && !sawActive;
  }, [hasSelection, selectedIds]);

  const derivedSelectionScope = React.useMemo(() => {
    if (selectionScopeKey) return selectionScopeKey;
    if (!hasSelection) return null;
    if (typeof document === 'undefined') return null;
    for (const id of selectedIds) {
      const row = document.querySelector<HTMLElement>(`[data-session-row="${CSS.escape(id)}"]`);
      const scope = row?.getAttribute('data-session-scope');
      if (scope && scope.length > 0) return scope;
    }
    return null;
  }, [hasSelection, selectedIds, selectionScopeKey]);

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

  const executeBulkDelete = React.useCallback(async () => {
    const ids = Array.from(selectedIds);
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
    const isMac = typeof navigator !== 'undefined' && /Macintosh|Mac OS X/.test(navigator.userAgent || '');
    const listener = (event: KeyboardEvent) => {
      if (isInlineEditing) return;
      const target = event.target as HTMLElement | null;
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
        const rows = typeof document !== 'undefined'
          ? Array.from(document.querySelectorAll<HTMLElement>('[data-session-row]'))
          : [];
        if (rows.length === 0) return;
        event.preventDefault();
        const currentScope = useSessionMultiSelectStore.getState().scopeKey;
        const targetScope = currentScope
          ?? rows[0]?.getAttribute('data-session-scope')
          ?? null;
        const scopeFilter = (el: HTMLElement): boolean => {
          if (!targetScope) return true;
          return el.getAttribute('data-session-scope') === targetScope;
        };
        const ids = rows
          .filter(scopeFilter)
          .map((el) => el.getAttribute('data-session-row'))
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
        if (ids.length === 0) return;
        useSessionMultiSelectStore.getState().replaceAll(ids, targetScope || null);
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [handleBulkDelete, isInlineEditing, selectionModeEnabled]);

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
