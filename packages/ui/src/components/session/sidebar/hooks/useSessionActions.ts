import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import type { MainTab } from '@/stores/useUIStore';
import { useUIStore } from '@/stores/useUIStore';
import { streamPerfMark } from '@/stores/utils/streamDebug';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { sessionEvents } from '@/lib/sessionEvents';

type DeleteSessionConfirmSetter = React.Dispatch<React.SetStateAction<{
  session: Session;
  descendantCount: number;
  descendantIds: string[];
} | null>>;

type DeleteSessionSource = {
  archivedBucket?: boolean;
  hardDelete?: boolean;
  /** Bypass the confirmation dialog and delete/archive immediately. */
  skipConfirm?: boolean;
};

type Args = {
  mobileVariant: boolean;
  allowReselect: boolean;
  onSessionSelected?: (sessionId: string) => void;
  isSessionSearchOpen: boolean;
  sessionSearchQuery: string;
  setSessionSearchQuery: (value: string) => void;
  setIsSessionSearchOpen: (open: boolean) => void;
  setActiveMainTab: (tab: MainTab) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
  setCurrentSession: (sessionId: string | null, directoryHint?: string | null) => void;
  updateSessionTitle: (id: string, title: string) => Promise<void>;
  shareSession: (id: string) => Promise<Session | null>;
  unshareSession: (id: string) => Promise<Session | null>;
  archiveSession: (id: string) => Promise<boolean>;
  archiveSessions: (ids: string[]) => Promise<{ archivedIds: string[]; failedIds: string[] }>;
  childrenMap: Map<string, Session[]>;
  showDeletionDialog: boolean;
  setDeleteSessionConfirm: DeleteSessionConfirmSetter;
  deleteSessionConfirm: { session: Session; descendantCount: number; descendantIds: string[] } | null;
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
    (sessionId: string, sessionDirectory?: string | null) => {
      streamPerfMark('navigation.session_select');
      // Selecting a session always leaves any full-page surface, even when
      // the session is already the current one (no store transition fires).
      useUIStore.getState().closeMainSurfaces();
      const resetSessionSearch = () => {
        if (!args.isSessionSearchOpen && args.sessionSearchQuery.length === 0) {
          return;
        }
        args.setSessionSearchQuery('');
        args.setIsSessionSearchOpen(false);
      };

      if (args.mobileVariant) {
        args.setActiveMainTab('chat');
        args.setSessionSwitcherOpen(false);
      }

      if (sessionId === useSessionUIStore.getState().currentSessionId) {
        if (args.allowReselect) {
          args.onSessionSelected?.(sessionId);
        }
        resetSessionSearch();
        return;
      }
      streamPerfMark('navigation.session_state_set');
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

  const handleSaveEdit = React.useCallback(async (titleOverride?: string) => {
    if (!args.editingId) return;
    const trimmed = (titleOverride ?? args.editTitle).trim();
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

  const collectDescendantIdsForAction = React.useCallback((session: Session): string[] => (
    collectDescendants(session.id)
      .filter((descendant) => !descendant.time?.archived)
      .map((descendant) => descendant.id)
  ), [collectDescendants]);

  const executeDeleteSession = React.useCallback(
    async (
      session: Session,
      precomputed?: { descendantIds: string[] },
    ) => {
      const descendantIds = precomputed?.descendantIds
        ?? collectDescendantIdsForAction(session);
      if (descendantIds.length === 0) {
        const success = await args.archiveSession(session.id);
        if (success) {
          toast.success(t('sessions.sidebar.session.archive.success'));
        } else {
          toast.error(t('sessions.sidebar.session.archive.error'));
        }
        return;
      }

      const ids = [session.id, ...descendantIds];
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
    [args, collectDescendantIdsForAction, t],
  );

  const handleDeleteSession = React.useCallback(
    (session: Session, source?: DeleteSessionSource) => {
      const shouldHardDelete = source?.archivedBucket === true || source?.hardDelete === true;
      if (shouldHardDelete) {
        sessionEvents.requestDelete({
          sessions: [session],
          mode: 'session',
          requireArchived: source?.archivedBucket === true,
          skipConfirm: source?.skipConfirm,
        });
        return;
      }
      const effectiveDescendantIds = collectDescendantIdsForAction(session);
      if (!args.showDeletionDialog || source?.skipConfirm === true) {
        void executeDeleteSession(session, { descendantIds: effectiveDescendantIds });
        return;
      }
      args.setDeleteSessionConfirm({
        session,
        descendantCount: effectiveDescendantIds.length,
        descendantIds: effectiveDescendantIds,
      });
    },
    [args, collectDescendantIdsForAction, executeDeleteSession],
  );

  const confirmDeleteSession = React.useCallback(async () => {
    if (!args.deleteSessionConfirm) return;
    const { session, descendantIds } = args.deleteSessionConfirm;
    args.setDeleteSessionConfirm(null);
    await executeDeleteSession(session, { descendantIds });
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
