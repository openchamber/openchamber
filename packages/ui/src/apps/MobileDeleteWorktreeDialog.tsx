import React from 'react';
import type { Session } from '@/lib/opencode/model';

import { Button } from '@/components/ui/button';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { normalizePath as normalizePathImpl } from '@/lib/pathNormalization';
import { canDeleteWorktreeBranch, getWorktreeStatus } from '@/lib/worktrees/worktreeStatus';
import { getWorktreeDisplayName, removeProjectWorktree, type ProjectRef } from '@/lib/worktrees/worktreeManager';
import { archiveSessionsThenRemoveWorktree, deleteWithoutTeardownToast } from '@/lib/worktrees/worktreeRemovalFlow';
import { clearWorktreeRemoval, markWorktreeRemoving } from '@/lib/worktrees/worktreeRemovalState';
import { withSessionsNowInWorktree } from '@/lib/worktrees/worktreeUse';
import { BoundGitNetworkOperationError, GitOperationResultError } from '@/lib/boundGitNetworkOperation';
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

const normalizePath = (value: string | null | undefined): string => normalizePathImpl(value) ?? '';

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
  const unarchiveSessions = useSessionUIStore((state) => state.unarchiveSessions);
  const { git, sourceControl } = useRuntimeAPIs();

  const [deleteLocalBranch, setDeleteLocalBranch] = React.useState(false);
  const [deleteRemoteBranch, setDeleteRemoteBranch] = React.useState(false);
  const [isDirty, setIsDirty] = React.useState(false);
  const [remoteName, setRemoteName] = React.useState<string | null>(null);
  const [isProcessing, setIsProcessing] = React.useState(false);

  const worktreePath = normalizePath(worktree?.path);
  // The branch toggles appear only once the check allows them, so a worktree
  // on the default branch never offers deleting it.
  const [canDeleteBranch, setCanDeleteBranch] = React.useState(false);
  const worktreeBranch = worktree?.branch ?? '';
  React.useEffect(() => {
    setCanDeleteBranch(false);
    if (!open || !worktreePath) return;
    let cancelled = false;
    void canDeleteWorktreeBranch(project.path, { path: worktreePath, branch: worktreeBranch }).then((allowed) => {
      if (!cancelled) setCanDeleteBranch(allowed);
    });
    return () => {
      cancelled = true;
    };
  }, [open, project.path, worktreeBranch, worktreePath]);

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

  const removeWorktree = React.useCallback(async (target: WorktreeMetadata, skipTeardown: boolean): Promise<boolean> => {
    await removeProjectWorktree(project, target, {
      deleteRemoteBranch: canDeleteBranch && deleteRemoteBranch,
      deleteLocalBranch: canDeleteBranch && deleteLocalBranch,
      remoteName: remoteName ?? undefined,
      network: {
        git,
        sourceControl,
      },
      skipTeardown,
    });

    // Read now, not when the delete started: a teardown can run for minutes,
    // and "Delete without teardown" can come much later.
    if (normalizePath(useDirectoryStore.getState().currentDirectory) === worktreePath && normalizePath(project.path)) {
      useDirectoryStore.getState().setDirectory(normalizePath(project.path), { showOverlay: false });
    }
    return true;
  }, [deleteLocalBranch, deleteRemoteBranch, git, canDeleteBranch, project, remoteName, sourceControl, worktreePath]);
  // The sessions are archived while their folder still exists, and come back
  // if the removal fails (`archiveSessionsThenRemoveWorktree`).
  const removeWorktreeInBackground = React.useCallback((target: WorktreeMetadata, sessionIds: string[]) => {
    const name = getWorktreeDisplayName(target);
    // `skipTeardown` only from the failure toast; the same options otherwise.
    const run = async (skipTeardown: boolean, attemptSessionIds: string[]): Promise<void> => {
      const toastId = toast.loading(t('sessions.sidebar.sessionDialogs.worktree.removingTitle', { name }));
      // The row shows it from here, through archiving the sessions too.
      markWorktreeRemoving(target.path);
      try {
        const result = await archiveSessionsThenRemoveWorktree({
          sessionIds: attemptSessionIds,
          removeWorktree: () => removeWorktree(target, skipTeardown),
          archiveSessions,
          restoreSessions: (ids) => unarchiveSessions(ids, { undo: true }),
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

        toast.success(canDeleteBranch && deleteRemoteBranch
          ? t('sessions.sidebar.sessionDialogs.worktree.removedWithRemote')
          : t('sessions.sidebar.sessionDialogs.worktree.removed'), { id: toastId, description: name });
        onDeleted?.();
      } catch (error) {
        // The remote branch could not be deleted, so the worktree was kept: say
        // that, with the reason when there is one, instead of a bare code.
        const description = error instanceof GitOperationResultError
          ? error.message || t('sessions.sidebar.dialogs.deleteResult.tryAgain')
          : error instanceof PendingGitOperationError || (error instanceof BoundGitNetworkOperationError && !error.message.includes(' '))
            ? t('gitView.publish.remoteNotGranted')
            : error instanceof Error ? error.message : t('sessions.sidebar.dialogs.deleteResult.tryAgain');
        toast.error(t('sessions.sidebar.sessionDialogs.worktree.errorRemoveTitle'), {
          id: toastId,
          description,
          ...(error instanceof Error
            ? deleteWithoutTeardownToast(error, t('sessions.sidebar.sessionDialogs.worktree.deleteWithoutTeardown'), () => {
              void run(true, withSessionsNowInWorktree(attemptSessionIds, target.path));
            })
            : undefined),
        });
      } finally {
        clearWorktreeRemoval(target.path);
      }
    };
    void run(false, sessionIds);
  }, [archiveSessions, deleteRemoteBranch, canDeleteBranch, onDeleted, removeWorktree, t, unarchiveSessions]);

  const handleConfirm = () => {
    if (!worktree || isProcessing) return;
    removeWorktreeInBackground(worktree, linkedSessions.map((session) => session.id));
    onClose();
  };

  if (!worktree) return null;

  const worktreeName = worktree.branch || worktree.label || worktree.path;

  const toggle = (checked: boolean, onChange: (value: boolean) => void, label: string, disabled?: boolean) => (
    <label className={cn('oc-tile flex min-h-11 items-center justify-between gap-3 rounded-lg px-3', disabled && 'opacity-50')}>
      <span className="typography-meta font-medium text-foreground">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </label>
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
          <p className="rounded-lg bg-[var(--status-warning-background)] px-3 py-2.5 typography-meta text-foreground">
            {t('mobile.projectEdit.deleteWorktreeDirty')}
          </p>
        ) : null}

        {linkedSessions.length > 0 ? (
          <p className="typography-meta text-muted-foreground">
            {t('mobile.projectEdit.deleteWorktreeArchiveNote', { count: linkedSessions.length })}
          </p>
        ) : null}

        {canDeleteBranch ? (
          <div className="flex flex-col gap-2">
            {toggle(deleteLocalBranch, setDeleteLocalBranch, t('mobile.projectEdit.deleteLocalBranch'), isProcessing)}
            {toggle(deleteRemoteBranch, setDeleteRemoteBranch, t('mobile.projectEdit.deleteRemoteBranch'), isProcessing || !remoteName)}
          </div>
        ) : null}
      </div>
    </MobileOverlayPanel>
  );
};
