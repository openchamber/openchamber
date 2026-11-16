import React from 'react';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { useKeybinds } from '@/hooks/useKeybind';
import type { Session } from '@/lib/opencode/model';
import { isSessionInWork } from '@/lib/sessionWorkMetadata';
import { takeSessionActionFailure } from '@/sync/session-action-failures';
import { describeSessionActionError } from '../sessions/sessionActionError';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';
import type { SessionFolder } from '@/stores/useSessionFoldersStore';
import { deriveSessionRowBulkSelectAll, deriveSessionRowSelectionArchived, useSessionRowOrderRegistry, type SessionRowLifecycle, type SessionRowOrderWork } from '../sessions/sessionRowOrder';
import { bulkDoneWorkLabel, selectFinishedWorks, type FinishWorktreeWorkOutcome } from '../works/workActions';
import { toastFinishWorkOutcome } from '../works/useWorktreeWork';
import type { BulkDeleteSessionsConfirmState } from '../shell/ConfirmDialogs';

const EMPTY_SESSIONS_BY_ID: ReadonlyMap<string, Session> = new Map();
const EMPTY_LIFECYCLE_BY_ID: ReadonlyMap<string, SessionRowLifecycle> = new Map();

type Args = {
  isInlineEditing: boolean;
  showDeletionDialog: boolean;
  foldersMap: Record<string, SessionFolder[]>;
  getFolderScopesForProject: (projectId: string) => readonly { scopeKey: string; directory: string | null }[];
  folderOwnerKeyBySessionId: ReadonlyMap<string, string>;
  addSessionsToFolder: (scopeKey: string, folderId: string, sessionIds: string[]) => void;
  removeSessionsFromFolders: (scopeKey: string, sessionIds: string[]) => void;
  createFolderAndStartRename: (scopeKey: string, parentId?: string | null) => { id: string } | null;
  archiveSessions: (ids: string[]) => Promise<{ archivedIds: string[]; failedIds: string[] }>;
  unarchiveSessions: (ids: string[]) => Promise<{ restoredIds: string[]; failedIds: string[] }>;
  deleteSessions: (ids: string[]) => Promise<{ deletedIds: string[]; failedIds: string[] }>;
  markSessionsDone: (sessions: Session[]) => Promise<{ doneIds: string[]; failedIds: string[] } | null>;
  finishWork: (work: SessionRowOrderWork, doneIds: ReadonlySet<string>) => Promise<FinishWorktreeWorkOutcome> | null;
  sessionWorkEnabled: boolean;
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

export const resolveSelectionFolderIds = (
  sessionIds: readonly string[],
  ownerKey: string | null,
  folderOwnerKeyBySessionId: ReadonlyMap<string, string>,
): string[] => {
  if (!ownerKey) return [];
  const ids: string[] = [];
  for (const sessionId of sessionIds) {
    const owner = folderOwnerKeyBySessionId.get(sessionId);
    if (!owner) return [];
    if (owner === ownerKey) ids.push(sessionId);
  }
  return ids;
};

export const selectSessionsToMarkDone = (
  selectedIds: Iterable<string>,
  sessionsById: ReadonlyMap<string, Session>,
): Session[] => {
  const sessions: Session[] = [];
  for (const id of selectedIds) {
    const session = sessionsById.get(id);
    if (session && !session.parentID && !session.time?.archived && isSessionInWork(session)) sessions.push(session);
  }
  return sessions;
};

export const resolveBulkDeleteConfirmation = (
  value: NonNullable<BulkDeleteSessionsConfirmState>,
  sessionsById: ReadonlyMap<string, SessionRowLifecycle>,
): { ready: true; value: NonNullable<BulkDeleteSessionsConfirmState> }
  | { ready: false; value: NonNullable<BulkDeleteSessionsConfirmState> | null } => {
  const sessionIds = value.sessionIds.filter((id) => sessionsById.has(id));
  if (sessionIds.length === 0) return { ready: false, value: null };
  const archivedBucket = value.archivedBucket
    || deriveSessionRowSelectionArchived(new Set(sessionIds), sessionsById);
  const next = { sessionIds, sessionCount: sessionIds.length, archivedBucket };
  return {
    ready: sessionIds.length === value.sessionIds.length && archivedBucket === value.archivedBucket,
    value: next,
  };
};

export const useSidebarBulkActions = (args: Args) => {
  const { t } = useI18n();
  const failureDescription = React.useCallback((ids: readonly string[]): { description: string } | undefined => {
    const error = takeSessionActionFailure(ids);
    return error ? { description: describeSessionActionError(error, t) } : undefined;
  }, [t]);
  const {
    isInlineEditing,
    showDeletionDialog,
    foldersMap,
    getFolderScopesForProject,
    folderOwnerKeyBySessionId,
    addSessionsToFolder,
    removeSessionsFromFolders,
    createFolderAndStartRename,
    archiveSessions,
    unarchiveSessions,
    deleteSessions,
    markSessionsDone,
    finishWork,
    sessionWorkEnabled,
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
    rowOrderRegistry?.getLifecycleById() ?? EMPTY_LIFECYCLE_BY_ID,
  );

  const bulkShowsMarkDone = sessionWorkEnabled && !bulkScopeIsArchived;
  const bulkCanMarkDone = bulkShowsMarkDone && hasSelection
    && selectSessionsToMarkDone(selectedIds, rowOrderRegistry?.getSessionsById() ?? EMPTY_SESSIONS_BY_ID).length > 0;

  const derivedSelectionScope = React.useMemo(() => {
    if (selectionScopeKey) return selectionScopeKey;
    return null;
  }, [selectionScopeKey]);

  const folderSelectionIds = React.useMemo(() => resolveSelectionFolderIds(
    Array.from(selectedIds), derivedSelectionScope, folderOwnerKeyBySessionId,
  ), [selectedIds, derivedSelectionScope, folderOwnerKeyBySessionId]);

  const selectionFolderScopes = React.useMemo<string[]>(() => {
    return resolveSelectionFolderScopes(derivedSelectionScope, getFolderScopesForProject);
  }, [derivedSelectionScope, getFolderScopesForProject]);

  const bulkScopeFolders = React.useMemo(() => {
    const rootScope = selectionFolderScopes[0];
    return rootScope ? foldersMap[rootScope] ?? [] : [];
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
    const ids = folderSelectionIds;
    if (ids.length === 0) return;
    for (const scope of selectionFolderScopes) {
      if (scope === targetScope) continue;
      removeSessionsFromFolders(scope, ids);
    }
    addSessionsToFolder(targetScope, folderId, ids);
  }, [addSessionsToFolder, folderSelectionIds, removeSessionsFromFolders, selectionFolderScopes]);

  const handleBulkMoveToFolder = React.useCallback((folderId: string) => {
    if (!hasSelection) return;
    const targetScope = resolveFolderScope(folderId);
    if (!targetScope) return;
    moveSelectionToFolder(targetScope, folderId);
  }, [hasSelection, moveSelectionToFolder, resolveFolderScope]);

  const handleBulkCreateFolderAndMove = React.useCallback(() => {
    const targetScope = selectionFolderScopes[0];
    if (!targetScope || !hasSelection) return;
    if (folderSelectionIds.length === 0) return;
    const newFolder = createFolderAndStartRename(targetScope);
    if (!newFolder) return;
    moveSelectionToFolder(targetScope, newFolder.id);
  }, [createFolderAndStartRename, folderSelectionIds, hasSelection, moveSelectionToFolder, selectionFolderScopes]);

  const handleBulkRemoveFromFolder = React.useCallback(() => {
    if (!hasSelection) return;
    const ids = folderSelectionIds;
    if (ids.length === 0) return;
    for (const scope of selectionFolderScopes) {
      removeSessionsFromFolders(scope, ids);
    }
  }, [folderSelectionIds, removeSessionsFromFolders, selectionFolderScopes, hasSelection]);

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
          : t('sessions.sidebar.bulkActions.failedDeletePlural', { count: failedIds.length }), failureDescription(failedIds));
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
          : t('sessions.sidebar.bulkActions.failedArchivePlural', { count: failedIds.length }), failureDescription(failedIds));
      }
      useSessionMultiSelectStore.getState().removeMany(archivedIds);
    }
  }, [archiveSessions, deleteSessions, failureDescription, t]);

  const requestBulkDestructive = React.useCallback((hardDelete: boolean) => {
    if (!hasSelection) return;
    const sessionIds = Array.from(selectedIds);
    if (!showDeletionDialog) {
      void executeBulkDelete(sessionIds, hardDelete);
      return;
    }
    setBulkDeleteConfirm({ sessionIds, sessionCount: sessionIds.length, archivedBucket: hardDelete });
  }, [executeBulkDelete, selectedIds, showDeletionDialog, setBulkDeleteConfirm, hasSelection]);
  const handleBulkDelete = React.useCallback(() => requestBulkDestructive(bulkScopeIsArchived), [bulkScopeIsArchived, requestBulkDestructive]);
  const handleBulkArchive = React.useCallback(() => requestBulkDestructive(false), [requestBulkDestructive]);
  const handleBulkHardDelete = React.useCallback(() => requestBulkDestructive(true), [requestBulkDestructive]);

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
        : t('sessions.sidebar.bulkActions.failedRestorePlural', { count: failedIds.length }), failureDescription(failedIds));
    }
    useSessionMultiSelectStore.getState().removeMany(restoredIds);
  }, [bulkScopeIsArchived, failureDescription, hasSelection, selectedIds, t, unarchiveSessions]);

  const markDoneRunningRef = React.useRef(false);
  const handleBulkMarkDone = React.useCallback(async () => {
    if (markDoneRunningRef.current) return;
    const batchIds = Array.from(selectedIds);
    const sessions = selectSessionsToMarkDone(batchIds, rowOrderRegistry?.getSessionsById() ?? EMPTY_SESSIONS_BY_ID);
    if (sessions.length === 0) return;
    const works = rowOrderRegistry?.getWorks() ?? [];
    markDoneRunningRef.current = true;
    try {
      const result = await markSessionsDone(sessions);
      if (!result) return;
      const { doneIds, failedIds } = result;
      if (doneIds.length > 0) {
        toast.success(doneIds.length === 1
          ? t('sessions.sidebar.bulkActions.markedDoneSingle', { count: doneIds.length })
          : t('sessions.sidebar.bulkActions.markedDonePlural', { count: doneIds.length }));
      }
      if (failedIds.length > 0) {
        toast.error(failedIds.length === 1
          ? t('sessions.sidebar.bulkActions.failedMarkDoneSingle', { count: failedIds.length })
          : t('sessions.sidebar.bulkActions.failedMarkDonePlural', { count: failedIds.length }), failureDescription(failedIds));
      }
      const failed = new Set(failedIds);
      useSessionMultiSelectStore.getState().removeMany(batchIds.filter((id) => !failed.has(id)));
      const done = new Set(doneIds);
      await Promise.all(selectFinishedWorks(works, done).map(async (work) => {
        const pending = finishWork(work, done);
        if (pending) toastFinishWorkOutcome(await pending, bulkDoneWorkLabel(work.group), t);
      }));
    } finally {
      markDoneRunningRef.current = false;
    }
  }, [failureDescription, finishWork, markSessionsDone, rowOrderRegistry, selectedIds, t]);

  const confirmBulkDelete = React.useCallback(async () => {
    if (!bulkDeleteConfirm) return;
    const sessionsById = rowOrderRegistry?.getLifecycleById() ?? EMPTY_LIFECYCLE_BY_ID;
    const resolution = resolveBulkDeleteConfirmation(bulkDeleteConfirm, sessionsById);
    if (!resolution.ready) {
      setBulkDeleteConfirm(resolution.value);
      return;
    }
    setBulkDeleteConfirm(null);
    await executeBulkDelete(resolution.value.sessionIds, resolution.value.archivedBucket);
  }, [bulkDeleteConfirm, executeBulkDelete, rowOrderRegistry, setBulkDeleteConfirm]);

  const selectionKeysApply = React.useCallback((event: KeyboardEvent): boolean => {
    if (bulkDeleteConfirm || isInlineEditing) return false;
    const target = event.target instanceof HTMLElement ? event.target : null;
    return !(target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable));
  }, [bulkDeleteConfirm, isInlineEditing]);

  React.useEffect(() => {
    if (!selectionModeEnabled) return;
    const listener = (event: KeyboardEvent) => {
      if (!selectionKeysApply(event) || event.key !== 'Escape') return;
      event.preventDefault();
      useSessionMultiSelectStore.getState().disable();
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [selectionKeysApply, selectionModeEnabled]);

  useKeybinds(selectionModeEnabled ? {
    sessions_bulk_delete: (event) => {
      if (!selectionKeysApply(event)) return false;
      handleBulkDelete();
    },
    sessions_select_all: (event) => {
      if (!selectionKeysApply(event)) return false;
      const selection = deriveSessionRowBulkSelectAll(
        rowOrderRegistry?.getEntries() ?? [],
        rowOrderRegistry?.getDescendantIds() ?? [],
        useSessionMultiSelectStore.getState().scopeKey,
      );
      if (!selection) return false;
      useSessionMultiSelectStore.getState().replaceAll(selection.ids, selection.scopeKey);
    },
  } : {});

  return {
    selectionModeEnabled,
    hasSelection,
    selectedIdsSize,
    bulkScopeIsArchived,
    derivedSelectionScope,
    bulkScopeFolders,
    bulkCanMoveToFolder: folderSelectionIds.length > 0,
    bulkCanRemoveFromFolder,
    bulkShowsMarkDone,
    bulkCanMarkDone,
    handleToggleSelectionMode,
    handleExitSelectionMode,
    handleBulkMoveToFolder,
    handleBulkCreateFolderAndMove,
    handleBulkRemoveFromFolder,
    handleBulkDelete,
    handleBulkArchive,
    handleBulkHardDelete,
    handleBulkRestore,
    handleBulkMarkDone,
    confirmBulkDelete,
  };
};
