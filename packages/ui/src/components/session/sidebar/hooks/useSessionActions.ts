import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import type { MainTab } from '@/stores/useUIStore';

type DeleteSessionConfirmSetter = React.Dispatch<React.SetStateAction<{
  session: Session;
  descendantCount: number;
  descendantIds: string[];
  archivedBucket: boolean;
} | null>>;

type DeleteSessionSource = {
  archivedBucket?: boolean;
  hardDelete?: boolean;
};

type Args = {
  activeProjectId: string | null;
  currentDirectory: string | null;
  currentSessionId: string | null;
  mobileVariant: boolean;
  allowReselect: boolean;
  onSessionSelected?: (sessionId: string) => void;
  isSessionSearchOpen: boolean;
  sessionSearchQuery: string;
  setSessionSearchQuery: (value: string) => void;
  setIsSessionSearchOpen: (open: boolean) => void;
  setActiveProjectIdOnly: (id: string) => void;
  setDirectory: (directory: string, options?: { showOverlay?: boolean }) => void;
  setActiveMainTab: (tab: MainTab) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
  setCurrentSession: (sessionId: string | null, directoryHint?: string | null) => void;
  updateSessionTitle: (id: string, title: string) => Promise<void>;
  shareSession: (id: string) => Promise<Session | null>;
  unshareSession: (id: string) => Promise<Session | null>;
  deleteSession: (id: string) => Promise<boolean>;
  deleteSessions: (ids: string[]) => Promise<{ deletedIds: string[]; failedIds: string[] }>;
  archiveSession: (id: string) => Promise<boolean>;
  archiveSessions: (ids: string[]) => Promise<{ archivedIds: string[]; failedIds: string[] }>;
  childrenMap: Map<string, Session[]>;
  showDeletionDialog: boolean;
  setDeleteSessionConfirm: DeleteSessionConfirmSetter;
  deleteSessionConfirm: { session: Session; descendantCount: number; descendantIds: string[]; archivedBucket: boolean } | null;
  setEditingId: (id: string | null) => void;
  setEditTitle: (value: string) => void;
  editingId: string | null;
  editTitle: string;
};

export const useSessionActions = (args: Args) => {
  const { t } = useI18n();
  const [copiedSessionId, setCopiedSessionId] = React.useState<string | null>(null);
  const copyTimeout = React.useRef<number | null>(null);

  React.useEffect(() => {
    return () => {
      if (copyTimeout.current) {
        clearTimeout(copyTimeout.current);
      }
    };
  }, []);

  const handleSessionSelect = React.useCallback(
    (sessionId: string, sessionDirectory?: string | null, projectId?: string | null) => {
      const resetSessionSearch = () => {
        if (!args.isSessionSearchOpen && args.sessionSearchQuery.length === 0) {
          return;
        }
        args.setSessionSearchQuery('');
        args.setIsSessionSearchOpen(false);
      };

      if (projectId && projectId !== args.activeProjectId) {
        args.setActiveProjectIdOnly(projectId);
      }

      if (sessionDirectory && sessionDirectory !== args.currentDirectory) {
        args.setDirectory(sessionDirectory, { showOverlay: false });
      }

      if (args.mobileVariant) {
        args.setActiveMainTab('chat');
        args.setSessionSwitcherOpen(false);
      }

      if (sessionId === args.currentSessionId) {
        if (args.allowReselect) {
          args.onSessionSelected?.(sessionId);
        }
        resetSessionSearch();
        return;
      }
      args.setCurrentSession(sessionId, sessionDirectory ?? null);
      args.onSessionSelected?.(sessionId);
      resetSessionSearch();
    },
    [args],
  );

  const handleSessionDoubleClick = React.useCallback((sessionId: string, sessionTitle: string) => {
    args.setEditingId(sessionId);
    args.setEditTitle(sessionTitle);
  }, [args]);

  const handleSaveEdit = React.useCallback(async () => {
    if (!args.editingId) return;
    const trimmed = args.editTitle.trim();
    if (trimmed) {
      await args.updateSessionTitle(args.editingId, trimmed);
    }
    args.setEditingId(null);
    args.setEditTitle('');
  }, [args]);

  const handleCancelEdit = React.useCallback(() => {
    args.setEditingId(null);
    args.setEditTitle('');
  }, [args]);

  const handleShareSession = React.useCallback(async (session: Session) => {
    const result = await args.shareSession(session.id);
    if (result && result.share?.url) {
      toast.success(t('sessions.sidebar.session.share.successTitle'), {
        description: t('sessions.sidebar.session.share.successDescription'),
      });
    } else {
      toast.error(t('sessions.sidebar.session.share.error'));
    }
  }, [args, t]);

  const handleCopyShareUrl = React.useCallback((url: string, sessionId: string) => {
    void copyTextToClipboard(url)
      .then((result) => {
        if (!result.ok) {
          toast.error(t('sessions.sidebar.session.share.copyUrlError'));
          return;
        }
        setCopiedSessionId(sessionId);
        if (copyTimeout.current) {
          clearTimeout(copyTimeout.current);
        }
        copyTimeout.current = window.setTimeout(() => {
          setCopiedSessionId(null);
          copyTimeout.current = null;
        }, 2000);
      })
      .catch(() => {
        toast.error(t('sessions.sidebar.session.share.copyUrlError'));
      });
  }, [t]);

  const handleUnshareSession = React.useCallback(async (sessionId: string) => {
    const result = await args.unshareSession(sessionId);
    if (result) {
      toast.success(t('sessions.sidebar.session.unshare.success'));
    } else {
      toast.error(t('sessions.sidebar.session.unshare.error'));
    }
  }, [args, t]);

  const collectDescendants = React.useCallback((sessionId: string): Session[] => {
    const collected: Session[] = [];
    const visit = (id: string) => {
      const children = args.childrenMap.get(id) ?? [];
      children.forEach((child) => {
        collected.push(child);
        visit(child.id);
      });
    };
    visit(sessionId);
    return collected;
  }, [args.childrenMap]);

  // Archive cascades to subagents that aren't already archived; hard-delete
  // cascades to every descendant unconditionally. We collect once and filter
  // per-action so the dialog count and the executed ID list always agree.
  const filterDescendantsForAction = React.useCallback(
    (descendants: Session[], shouldHardDelete: boolean): Session[] => {
      if (shouldHardDelete) return descendants;
      return descendants.filter((s) => !s.time?.archived);
    },
    [],
  );

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
      const descendantIds = precomputed?.descendantIds
        ?? filterDescendantsForAction(collectDescendants(session.id), shouldHardDelete).map((s) => s.id);
      if (descendantIds.length === 0) {
        const success = shouldHardDelete
          ? await args.deleteSession(session.id)
          : await args.archiveSession(session.id);
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

      const ids = [session.id, ...descendantIds];
      if (shouldHardDelete) {
        // The server cascade-deletes all descendant sessions when the parent
        // is removed. Only send the root session delete request; sending
        // individual requests for each descendant would hit 404 (already
        // deleted by cascade) and trigger rollback that restores them.
        const success = await args.deleteSession(session.id);
        if (success) {
          const totalDeleted = descendantIds.length + 1;
          toast.success(totalDeleted === 1
            ? t('sessions.sidebar.bulkActions.deletedSingle', { count: totalDeleted })
            : t('sessions.sidebar.bulkActions.deletedPlural', { count: totalDeleted }));
        } else {
          toast.error(t('sessions.sidebar.session.delete.error'));
        }
        return;
      }

      const { archivedIds, failedIds } = await args.archiveSessions(ids);
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
    [args, collectDescendants, filterDescendantsForAction, t],
  );

  const handleDeleteSession = React.useCallback(
    (session: Session, source?: DeleteSessionSource) => {
      const shouldHardDelete = source?.archivedBucket === true || source?.hardDelete === true;
      const effectiveDescendantIds = filterDescendantsForAction(
        collectDescendants(session.id),
        shouldHardDelete,
      ).map((s) => s.id);
      if (!args.showDeletionDialog) {
        void executeDeleteSession(session, source, { descendantIds: effectiveDescendantIds });
        return;
      }
      args.setDeleteSessionConfirm({
        session,
        descendantCount: effectiveDescendantIds.length,
        descendantIds: effectiveDescendantIds,
        archivedBucket: shouldHardDelete,
      });
    },
    [args, collectDescendants, executeDeleteSession, filterDescendantsForAction],
  );

  const confirmDeleteSession = React.useCallback(async () => {
    if (!args.deleteSessionConfirm) return;
    const { session, archivedBucket, descendantIds } = args.deleteSessionConfirm;
    args.setDeleteSessionConfirm(null);
    await executeDeleteSession(session, { archivedBucket }, { descendantIds });
  }, [args, executeDeleteSession]);

  return {
    copiedSessionId,
    handleSessionSelect,
    handleSessionDoubleClick,
    handleSaveEdit,
    handleCancelEdit,
    handleShareSession,
    handleCopyShareUrl,
    handleUnshareSession,
    handleDeleteSession,
    confirmDeleteSession,
  };
};
