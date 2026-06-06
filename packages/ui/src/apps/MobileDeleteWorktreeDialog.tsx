import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2/client';

import { Button } from '@/components/ui/button';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { getWorktreeStatus } from '@/lib/worktrees/worktreeStatus';
import { removeProjectWorktree, type ProjectRef } from '@/lib/worktrees/worktreeManager';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useAllLiveSessions } from '@/sync/sync-context';
import type { WorktreeMetadata } from '@/types/worktree';

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
 * Mobile worktree-deletion confirmation. Built directly on the shared
 * primitives (getWorktreeStatus / removeProjectWorktree / archiveSessions) so
 * it mirrors the desktop SessionDialogs worktree flow without mounting it:
 * linked sessions are archived, the worktree is removed, and remote/local
 * branch deletion are optional.
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

  const [deleteLocalBranch, setDeleteLocalBranch] = React.useState(false);
  const [deleteRemoteBranch, setDeleteRemoteBranch] = React.useState(false);
  const [isDirty, setIsDirty] = React.useState(false);
  const [isProcessing, setIsProcessing] = React.useState(false);

  const worktreePath = normalizePath(worktree?.path);
  const hasBranch = typeof worktree?.branch === 'string' && worktree.branch.trim().length > 0;

  // Sessions attached to this worktree — archived (not deleted) on removal,
  // matching the desktop behavior.
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
      setIsProcessing(false);
      return;
    }
    if (!worktree?.path) return;
    let cancelled = false;
    void getWorktreeStatus(worktree.path)
      .then((status) => {
        if (!cancelled) setIsDirty(Boolean(status?.isDirty));
      })
      .catch(() => {
        if (!cancelled) setIsDirty(Boolean(worktree.status?.isDirty));
      });
    return () => {
      cancelled = true;
    };
  }, [open, worktree?.path, worktree?.status?.isDirty]);

  const handleConfirm = async () => {
    if (!worktree || isProcessing) return;
    setIsProcessing(true);
    try {
      if (linkedSessions.length > 0) {
        await archiveSessions(linkedSessions.map((session) => session.id));
      }
      await removeProjectWorktree(project, worktree, {
        deleteRemoteBranch: hasBranch && deleteRemoteBranch,
        deleteLocalBranch: hasBranch && deleteLocalBranch,
      });

      // If the removed worktree was the active directory, fall back to the project root.
      if (normalizePath(currentDirectory) === worktreePath && normalizePath(project.path)) {
        useDirectoryStore.getState().setDirectory(normalizePath(project.path), { showOverlay: false });
      }

      toast.success(t('sessions.sidebar.sessionDialogs.worktree.removedTitle'), {
        description:
          hasBranch && deleteRemoteBranch
            ? t('sessions.sidebar.sessionDialogs.worktree.removedWithRemote')
            : t('sessions.sidebar.sessionDialogs.worktree.removed'),
      });
      onDeleted?.();
      onClose();
    } catch (error) {
      toast.error(t('sessions.sidebar.sessionDialogs.worktree.errorRemoveTitle'), {
        description: error instanceof Error ? error.message : t('sessions.sidebar.dialogs.deleteResult.tryAgain'),
      });
    } finally {
      setIsProcessing(false);
    }
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
        'flex w-full items-center justify-between gap-3 rounded-xl border border-border/50 px-3.5 py-3 text-left transition-colors',
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
            {toggle(deleteRemoteBranch, setDeleteRemoteBranch, t('mobile.projectEdit.deleteRemoteBranch'), isProcessing)}
          </div>
        ) : null}
      </div>
    </MobileOverlayPanel>
  );
};
