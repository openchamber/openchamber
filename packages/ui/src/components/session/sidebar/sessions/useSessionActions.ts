import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { streamPerfMark } from '@/stores/utils/streamDebug';
import { useSessionUIStore } from '@/sync/session-ui-store';

export type DeleteSessionSource = {
  archivedBucket?: boolean;
  hardDelete?: boolean;
  /** Bypass the confirmation dialog and delete/archive immediately. */
  skipConfirm?: boolean;
};

export type DeleteSessionConfirmState = {
  session: Session;
  descendantCount: number;
  descendantIds: string[];
  archivedBucket: boolean;
} | null;

type Args = {
  mobileVariant: boolean;
  allowReselect: boolean;
  onSessionSelected?: (sessionId: string) => void;
  isSessionSearchOpen: boolean;
  sessionSearchQuery: string;
  setSessionSearchQuery: (value: string) => void;
  setIsSessionSearchOpen: (open: boolean) => void;
  descendantIds: readonly string[];
  showDeletionDialog: boolean;
  setDeleteSessionConfirm: (value: DeleteSessionConfirmState) => void;
  deleteSessionConfirm: DeleteSessionConfirmState;
  setEditingId: (id: string | null) => void;
  setEditTitle: (value: string) => void;
  editingId: string | null;
  editTitle: string;
  copiedSessionId: string | null;
  setCopiedSessionId: (sessionId: string | null) => void;
};

export const useSessionActions = (args: Args) => {
  const { t } = useI18n();
  const copyTimeout = React.useRef<number | null>(null);
  const editingIdRef = React.useRef(args.editingId);
  const editTitleRef = React.useRef(args.editTitle);
  const deleteSessionConfirmRef = React.useRef(args.deleteSessionConfirm);
  editingIdRef.current = args.editingId;
  editTitleRef.current = args.editTitle;
  deleteSessionConfirmRef.current = args.deleteSessionConfirm;

  const setSessionSwitcherOpen = useUIStore((state) => state.setSessionSwitcherOpen);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const updateSessionTitle = useSessionUIStore((state) => state.updateSessionTitle);
  const shareSession = useSessionUIStore((state) => state.shareSession);
  const unshareSession = useSessionUIStore((state) => state.unshareSession);
  const deleteSession = useSessionUIStore((state) => state.deleteSession);
  const deleteSessions = useSessionUIStore((state) => state.deleteSessions);
  const archiveSession = useSessionUIStore((state) => state.archiveSession);
  const archiveSessions = useSessionUIStore((state) => state.archiveSessions);
  const unarchiveSession = useSessionUIStore((state) => state.unarchiveSession);

  const {
    mobileVariant,
    allowReselect,
    onSessionSelected,
    isSessionSearchOpen,
    sessionSearchQuery,
    setSessionSearchQuery,
    setIsSessionSearchOpen,
    descendantIds,
    showDeletionDialog,
    setDeleteSessionConfirm,
    setEditingId,
    setEditTitle,
    setCopiedSessionId,
  } = args;

  React.useEffect(() => {
    return () => {
      if (copyTimeout.current) {
        clearTimeout(copyTimeout.current);
      }
    };
  }, []);

  const handleSessionSelect = React.useCallback(
    (sessionId: string, sessionDirectory?: string | null) => {
      streamPerfMark('navigation.session_select');
      // Selecting a session always leaves any full-page surface, even when
      // the session is already the current one (no store transition fires).
      useUIStore.getState().closeMainSurfaces();
      const resetSessionSearch = () => {
        if (!isSessionSearchOpen && sessionSearchQuery.length === 0) {
          return;
        }
        setSessionSearchQuery('');
        setIsSessionSearchOpen(false);
      };

      if (mobileVariant) {
        setSessionSwitcherOpen(false);
      }

      if (sessionId === useSessionUIStore.getState().currentSessionId) {
        if (allowReselect) {
          onSessionSelected?.(sessionId);
        }
        resetSessionSearch();
        return;
      }
      streamPerfMark('navigation.session_state_set');
      setCurrentSession(sessionId, sessionDirectory ?? null);
      onSessionSelected?.(sessionId);
      resetSessionSearch();
    },
    [allowReselect, isSessionSearchOpen, mobileVariant, onSessionSelected, sessionSearchQuery, setCurrentSession, setIsSessionSearchOpen, setSessionSearchQuery, setSessionSwitcherOpen],
  );

  const handleSessionDoubleClick = React.useCallback((sessionId: string, sessionTitle: string) => {
    setEditingId(sessionId);
    setEditTitle(sessionTitle);
  }, [setEditTitle, setEditingId]);

  const handleSaveEdit = React.useCallback(async (titleOverride?: string) => {
    const editingId = editingIdRef.current;
    if (!editingId) return;
    const trimmed = (titleOverride ?? editTitleRef.current).trim();
    if (trimmed) {
      await updateSessionTitle(editingId, trimmed);
    }
    setEditingId(null);
    setEditTitle('');
  }, [setEditTitle, setEditingId, updateSessionTitle]);

  const handleCancelEdit = React.useCallback(() => {
    setEditingId(null);
    setEditTitle('');
  }, [setEditTitle, setEditingId]);

  const copyShareUrl = React.useCallback(async (url: string, sessionId: string): Promise<boolean> => {
    try {
      const result = await copyTextToClipboard(url);
      if (!result.ok) return false;
      setCopiedSessionId(sessionId);
      if (copyTimeout.current) clearTimeout(copyTimeout.current);
      copyTimeout.current = window.setTimeout(() => {
        setCopiedSessionId(null);
        copyTimeout.current = null;
      }, 2000);
      return true;
    } catch {
      return false;
    }
  }, [setCopiedSessionId]);

  const handleShareSession = React.useCallback(async (session: Session) => {
    const result = await shareSession(session.id);
    if (!result?.share?.url) {
      toast.error(t('sessions.sidebar.session.share.error'));
      return;
    }
    const copied = await copyShareUrl(result.share.url, session.id);
    toast[copied ? 'success' : 'warning'](t('sessions.sidebar.session.share.successTitle'), {
      description: t(copied
        ? 'sessions.sidebar.session.share.successDescription'
        : 'sessions.sidebar.session.share.copyUrlError'),
    });
  }, [copyShareUrl, shareSession, t]);

  const handleCopyShareUrl = React.useCallback((url: string, sessionId: string) => {
    void copyShareUrl(url, sessionId).then((copied) => {
      if (!copied) toast.error(t('sessions.sidebar.session.share.copyUrlError'));
    });
  }, [copyShareUrl, t]);

  const handleCopySessionId = React.useCallback((sessionId: string) => {
    void copyTextToClipboard(sessionId)
      .then((result) => {
        if (result.ok) {
          toast.success(t('sessions.sidebar.session.copyId.success'));
          return;
        }
        toast.error(t('sessions.sidebar.session.copyId.error'));
      })
      .catch(() => toast.error(t('sessions.sidebar.session.copyId.error')));
  }, [t]);

  const handleUnshareSession = React.useCallback(async (sessionId: string) => {
    const result = await unshareSession(sessionId);
    if (result) {
      toast.success(t('sessions.sidebar.session.unshare.success'));
    } else {
      toast.error(t('sessions.sidebar.session.unshare.error'));
    }
  }, [t, unshareSession]);

  const executeDeleteSession = React.useCallback(
    async (
      session: Session,
      source?: DeleteSessionSource,
      precomputed?: { descendantIds: string[] },
    ) => {
      const shouldHardDelete = source?.archivedBucket === true || source?.hardDelete === true;
      // Use the snapshot taken when the dialog opened (if any) so the
      // executed list matches what the user was told. Fall back to a fresh
      // collection for direct-execute (no-dialog) callers.
      const effectiveDescendantIds = precomputed?.descendantIds
        ?? descendantIds;
      if (effectiveDescendantIds.length === 0) {
        const success = shouldHardDelete
          ? await deleteSession(session.id)
          : await archiveSession(session.id);
        if (success) {
          toast.success(shouldHardDelete
            ? t('sessions.sidebar.session.delete.success')
            : t('sessions.sidebar.session.archive.success'));
        } else {
          toast.error(shouldHardDelete
            ? t('sessions.sidebar.session.delete.error')
            : t('sessions.sidebar.session.archive.error'));
        }
        return;
      }

      const ids = [session.id, ...effectiveDescendantIds];
      if (shouldHardDelete) {
        // Delete root + all descendants individually. If the server
        // cascade-deletes some children before we get to them, 404 is
        // treated as success by deleteSession and no rollback occurs.
        const { deletedIds, failedIds } = await deleteSessions(ids);
        if (failedIds.length === 0) {
          const totalDeleted = deletedIds.length;
          toast.success(totalDeleted === 1
            ? t('sessions.sidebar.bulkActions.deletedSingle', { count: totalDeleted })
            : t('sessions.sidebar.bulkActions.deletedPlural', { count: totalDeleted }));
        } else {
          toast.error(t('sessions.sidebar.session.delete.error'));
        }
        return;
      }

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
    },
    [archiveSession, archiveSessions, deleteSession, deleteSessions, descendantIds, t],
  );

  const handleDeleteSession = React.useCallback(
    (session: Session, source?: DeleteSessionSource) => {
      const shouldHardDelete = source?.archivedBucket === true || source?.hardDelete === true;
      const effectiveDescendantIds = [...descendantIds];
      if (!showDeletionDialog || source?.skipConfirm === true) {
        void executeDeleteSession(session, source, { descendantIds: effectiveDescendantIds });
        return;
      }
      setDeleteSessionConfirm({
        session,
        descendantCount: effectiveDescendantIds.length,
        descendantIds: effectiveDescendantIds,
        archivedBucket: shouldHardDelete,
      });
    },
    [descendantIds, executeDeleteSession, setDeleteSessionConfirm, showDeletionDialog],
  );

  const confirmDeleteSession = React.useCallback(async () => {
    const deleteSessionConfirm = deleteSessionConfirmRef.current;
    if (!deleteSessionConfirm) return;
    const { session, archivedBucket, descendantIds } = deleteSessionConfirm;
    setDeleteSessionConfirm(null);
    await executeDeleteSession(session, { archivedBucket }, { descendantIds });
  }, [executeDeleteSession, setDeleteSessionConfirm]);

  const handleRestoreSession = React.useCallback(
    async (session: Session) => {
      const success = await unarchiveSession(session.id);
      if (success) {
        toast.success(t('sessions.sidebar.session.restore.success'));
      } else {
        toast.error(t('sessions.sidebar.session.restore.error'));
      }
    },
    [t, unarchiveSession],
  );

  return React.useMemo(() => ({
    handleSessionSelect,
    handleSessionDoubleClick,
    handleSaveEdit,
    handleCancelEdit,
    handleShareSession,
    handleCopyShareUrl,
    handleCopySessionId,
    handleUnshareSession,
    handleDeleteSession,
    handleRestoreSession,
    confirmDeleteSession,
  }), [handleCancelEdit, handleCopySessionId, handleCopyShareUrl, handleDeleteSession,
    handleRestoreSession, handleSaveEdit, handleSessionDoubleClick, handleSessionSelect, handleShareSession,
    handleUnshareSession, confirmDeleteSession]);
};
