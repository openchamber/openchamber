import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2/client';

import { Button } from '@/components/ui/button';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { getWorktreeStatus } from '@/lib/worktrees/worktreeStatus';
import { removeProjectWorktree, type ProjectRef, getWorktreeDisplayName } from '@/lib/worktrees/worktreeManager';
import { removeWorktreeThenArchiveSessions } from '@/lib/worktrees/worktreeRemovalFlow';
import { GitOperationResultError } from '@/lib/boundGitNetworkOperation';
import { PendingGitOperationError } from '@/lib/source-control/git-operation-recovery';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useAllLiveSessions } from '@/sync/sync-context';
import type { WorktreeMetadata } from '@/types/worktree';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';

type MobileDeleteWorktreeDialogProps = {
  open: boolean;
  project: ProjectRef;
  worktree: WorktreeMetadata | null;
  onClose: () => void;
  onDeleted?: () => void;
};

const normalizePath = (value?: string | null): string =>
  (value || '').replace(/\\/g, '/').replace(/\/+$/, '');

const getSessionDirectory = (session: Session): string => {
  const record = session as Session & { directory?: string | null; project?: { worktree?: string | null } | null };
  return normalizePath(record.directory ?? record.project?.worktree ?? null);
};

/**
 * Mobile worktree-deletion confirmation. It mirrors the desktop flow: remove
 * the worktree first, then archive its linked sessions. Branch deletion is
 * optional.
 */
export const MobileDeleteWorktreeDialog: React.FC<MobileDeleteWorktreeDialogProps> = ({
  open,
  project,
  worktree,
  onClose,
  onDeleted,
}) => {
  const { t } = useI18n();
  const liveSessions = useAllLiveSessions();
  const globalActiveSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const archiveSessions = useSessionUIStore((state) => state.archiveSessions);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const { git, sourceControl } = useRuntimeAPIs();

  const [deleteLocalBranch, setDeleteLocalBranch] = React.useState(false);
  const [deleteRemoteBranch, setDeleteRemoteBranch] = React.useState(false);
  const [isDirty, setIsDirty] = React.useState(false);
  const [remoteName, setRemoteName] = React.useState<string | null>(null);
  const [isProcessing, setIsProcessing] = React.useState(false);

  const worktreePath = normalizePath(worktree?.path);
  const hasBranch = typeof worktree?.branch === 'string' && worktree.branch.trim().length > 0;

  // Match the desktop behavior by archiving, rather than deleting, linked sessions.
  const linkedSessions = React.useMemo(() => {
    if (!worktreePath) return [] as Session[];
    const merged = new Map<string, Session>();
    for (const session of [...globalActiveSessions, ...liveSessions]) {
      if (getSessionDirectory(session) === worktreePath) merged.set(session.id, session);
    }
    return Array.from(merged.values());
  }, [globalActiveSessions, liveSessions, worktreePath]);

  React.useEffect(() => {
    if (!open) {
      setDeleteLocalBranch(false);
      setDeleteRemoteBranch(false);
      setIsDirty(false);
      setRemoteName(null);
      setIsProcessing(false);
      return;
    }
    if (!worktree?.path) return;
    let cancelled = false;
    void getWorktreeStatus(worktree.path)
      .then((status) => {
        if (!cancelled) {
          setIsDirty(Boolean(status?.isDirty));
          setRemoteName(status?.upstream?.split('/')[0]?.trim() || null);
        }
      })
      .catch(() => {
        if (!cancelled) setIsDirty(Boolean(worktree.status?.isDirty));
      });
    return () => {
      cancelled = true;
    };
  }, [open, worktree?.path, worktree?.status?.isDirty]);

  const removeWorktree = React.useCallback(async (target: WorktreeMetadata): Promise<boolean> => {
    await removeProjectWorktree(project, target, {
      deleteRemoteBranch: hasBranch && deleteRemoteBranch,
      deleteLocalBranch: hasBranch && deleteLocalBranch,
      remoteName: remoteName ?? undefined,
      network: {
        git,
        sourceControl,
        confirmSystemTransport: () => true,
      },
    });

    if (normalizePath(currentDirectory) === worktreePath && normalizePath(project.path)) {
      useDirectoryStore.getState().setDirectory(normalizePath(project.path), { showOverlay: false });
    }
    return true;
  }, [currentDirectory, deleteLocalBranch, deleteRemoteBranch, git, hasBranch, project, remoteName, sourceControl, worktreePath]);
  // The worktree goes first: archiving sessions ahead of a removal that then
  // fails would leave archived sessions attached to a worktree still on disk.
  const removeWorktreeInBackground = React.useCallback((target: WorktreeMetadata, sessionIds: string[]) => {
    const name = getWorktreeDisplayName(target);
    const toastId = toast.loading(t('sessions.sidebar.sessionDialogs.worktree.removingTitle', { name }));
    void (async () => {
      try {
        const result = await removeWorktreeThenArchiveSessions({
          sessionIds,
          removeWorktree: () => removeWorktree(target),
          archiveSessions,
        });
        if (!result.removed) {
          toast.dismiss(toastId);
          return;
        }
        const { failedIds } = result.archive;
        if (failedIds.length > 0) {
          toast.error(
            failedIds.length === 1
              ? t('sessions.sidebar.bulkActions.failedArchiveSingle', { count: failedIds.length })
              : t('sessions.sidebar.bulkActions.failedArchivePlural', { count: failedIds.length }),
            { id: toastId, description: t('sessions.sidebar.dialogs.deleteResult.tryAgain') },
          );
          return;
        }

        toast.success(t('sessions.sidebar.sessionDialogs.worktree.removedTitle', { name }), {
          id: toastId,
          description:
            hasBranch && deleteRemoteBranch
              ? t('sessions.sidebar.sessionDialogs.worktree.removedWithRemote')
              : t('sessions.sidebar.sessionDialogs.worktree.removed'),
        });
        onDeleted?.();
      } catch (error) {
        if (error instanceof GitOperationResultError || error instanceof PendingGitOperationError) {
          toast.dismiss(toastId);
          return;
        }
        toast.error(t('sessions.sidebar.sessionDialogs.worktree.errorRemoveTitle', { name }), {
          id: toastId,
          description: error instanceof Error ? error.message : t('sessions.sidebar.dialogs.deleteResult.tryAgain'),
        });
      }
    })();
  }, [archiveSessions, deleteRemoteBranch, hasBranch, onDeleted, removeWorktree, t]);

  const handleConfirm = () => {
    if (!worktree || isProcessing) return;
    removeWorktreeInBackground(worktree, linkedSessions.map((session) => session.id));
    onClose();
  };

  if (!worktree) return null;

  const worktreeName = worktree.branch || worktree.label || worktree.path;

  const toggle = (checked: boolean, onChange: (value: boolean) => void, label: string, disabled?: boolean) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'flex w-full items-center justify-between gap-3 rounded-xl border border-border/70 px-3.5 py-3 text-left transition-colors',
        'hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        disabled && 'pointer-events-none opacity-40',
      )}
      style={{ touchAction: 'manipulation' }}
    >
      <span className="typography-ui-label text-foreground">{label}</span>
      <span
        className={cn(
          'relative h-6 w-10 shrink-0 rounded-full transition-colors',
          checked ? 'bg-primary' : 'bg-muted-foreground/30',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 size-5 rounded-full bg-white transition-transform',
            checked ? 'translate-x-[1.125rem]' : 'translate-x-0.5',
          )}
        />
      </span>
    </button>
  );

  return (
    <MobileOverlayPanel
      open={open}
      onClose={onClose}
      title={t('mobile.projectEdit.deleteWorktreeTitle')}
      footer={
        <div className="flex gap-2">
          <Button variant="ghost" className="flex-1" onClick={onClose} disabled={isProcessing}>
            {t('projectEditDialog.actions.cancel')}
          </Button>
          <Button
            variant="destructive"
            className="flex-1"
            onClick={() => void handleConfirm()}
            disabled={isProcessing}
          >
            {t('mobile.projectEdit.deleteWorktreeConfirmButton')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4 px-1 py-1">
        <p className="typography-ui-body text-foreground">
          {t('mobile.projectEdit.deleteWorktreeConfirm', { name: worktreeName })}
        </p>

        {isDirty ? (
          <p className="rounded-xl border border-[var(--warning)]/40 bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] px-3.5 py-3 typography-meta text-foreground">
            {t('mobile.projectEdit.deleteWorktreeDirty')}
          </p>
        ) : null}

        {linkedSessions.length > 0 ? (
          <p className="typography-meta text-muted-foreground">
            {t('mobile.projectEdit.deleteWorktreeArchiveNote', { count: linkedSessions.length })}
          </p>
        ) : null}

        {hasBranch ? (
          <div className="flex flex-col gap-2">
            {toggle(deleteLocalBranch, setDeleteLocalBranch, t('mobile.projectEdit.deleteLocalBranch'), isProcessing)}
            {toggle(deleteRemoteBranch, setDeleteRemoteBranch, t('mobile.projectEdit.deleteRemoteBranch'), isProcessing || !remoteName)}
            {deleteRemoteBranch ? (
              <p className="px-1 typography-micro text-status-warning" role="note">
                {t('gitView.confirm.systemTransport')}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </MobileOverlayPanel>
  );
};
