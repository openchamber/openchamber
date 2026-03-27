import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';

type DeleteSessionConfirmSetter = React.Dispatch<React.SetStateAction<{
  session: Session;
  descendantCount: number;
  archivedBucket: boolean;
} | null>>;

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
  setActiveMainTab: (tab: 'chat' | 'plan' | 'git' | 'diff' | 'terminal' | 'files') => void;
  setSessionSwitcherOpen: (open: boolean) => void;
  setCurrentSession: (sessionId: string | null) => void;
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
  deleteSessionConfirm: { session: Session; descendantCount: number; archivedBucket: boolean } | null;
  setEditingId: (id: string | null) => void;
  setEditTitle: (value: string) => void;
  editingId: string | null;
  editTitle: string;
};

export const useSessionActions = (args: Args) => {
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
    (sessionId: string, sessionDirectory?: string | null, disabled?: boolean, projectId?: string | null) => {
      if (disabled) {
        return;
      }

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
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent<string>('openchamber:session-reselected', {
              detail: sessionId,
            }));
          }
          args.onSessionSelected?.(sessionId);
        }
        resetSessionSearch();
        return;
      }
      args.setCurrentSession(sessionId);
      args.onSessionSelected?.(sessionId);
      resetSessionSearch();
    },
    [args],
  );

  const handleSessionDoubleClick = React.useCallback(() => {
    args.setActiveMainTab('chat');
  }, [args]);

  const handleSaveEdit = React.useCallback(async () => {
    if (args.editingId && args.editTitle.trim()) {
      await args.updateSessionTitle(args.editingId, args.editTitle.trim());
      args.setEditingId(null);
      args.setEditTitle('');
    }
  }, [args]);

  const handleCancelEdit = React.useCallback(() => {
    args.setEditingId(null);
    args.setEditTitle('');
  }, [args]);

  const handleShareSession = React.useCallback(async (session: Session) => {
    const result = await args.shareSession(session.id);
    if (result && result.share?.url) {
      toast.success('Session shared', {
        description: 'You can copy the link from the menu.',
      });
    } else {
      toast.error('Unable to share session');
    }
  }, [args]);

  const handleCopyShareUrl = React.useCallback((url: string, sessionId: string) => {
    void copyTextToClipboard(url)
      .then((result) => {
        if (!result.ok) {
          toast.error('Failed to copy URL');
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
        toast.error('Failed to copy URL');
      });
  }, []);

  const handleUnshareSession = React.useCallback(async (sessionId: string) => {
    const result = await args.unshareSession(sessionId);
    if (result) {
      toast.success('Session unshared');
    } else {
      toast.error('Unable to unshare session');
    }
  }, [args]);

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

  const executeDeleteSession = React.useCallback(
    async (session: Session, source?: { archivedBucket?: boolean }) => {
      const descendants = collectDescendants(session.id);
      const shouldHardDelete = source?.archivedBucket === true;
      if (descendants.length === 0) {
        const success = shouldHardDelete
          ? await args.deleteSession(session.id)
          : await args.archiveSession(session.id);
        if (success) {
          toast.success(shouldHardDelete ? 'Session deleted' : 'Session archived');
        } else {
          toast.error(shouldHardDelete ? 'Failed to delete session' : 'Failed to archive session');
        }
        return;
      }

      const ids = [session.id, ...descendants.map((s) => s.id)];
      if (shouldHardDelete) {
        const { deletedIds, failedIds } = await args.deleteSessions(ids);
        if (deletedIds.length > 0) {
          toast.success(`Deleted ${deletedIds.length} session${deletedIds.length === 1 ? '' : 's'}`);
        }
        if (failedIds.length > 0) {
          toast.error(`Failed to delete ${failedIds.length} session${failedIds.length === 1 ? '' : 's'}`);
        }
        return;
      }

      const { archivedIds, failedIds } = await args.archiveSessions(ids);
      if (archivedIds.length > 0) {
        toast.success(`Archived ${archivedIds.length} session${archivedIds.length === 1 ? '' : 's'}`);
      }
      if (failedIds.length > 0) {
        toast.error(`Failed to archive ${failedIds.length} session${failedIds.length === 1 ? '' : 's'}`);
      }
    },
    [args, collectDescendants],
  );

  const handleDeleteSession = React.useCallback(
    (session: Session, source?: { archivedBucket?: boolean }) => {
      const descendants = collectDescendants(session.id);
      if (!args.showDeletionDialog) {
        void executeDeleteSession(session, source);
        return;
      }
      args.setDeleteSessionConfirm({ session, descendantCount: descendants.length, archivedBucket: source?.archivedBucket === true });
    },
    [args, collectDescendants, executeDeleteSession],
  );

  const confirmDeleteSession = React.useCallback(async () => {
    if (!args.deleteSessionConfirm) return;
    const { session, archivedBucket } = args.deleteSessionConfirm;
    args.setDeleteSessionConfirm(null);
    await executeDeleteSession(session, { archivedBucket });
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
