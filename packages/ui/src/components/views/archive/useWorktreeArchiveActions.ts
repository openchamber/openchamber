import React from 'react';
import { toast } from '@/components/ui';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import type { GitWorktreeArchive } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import type { ProjectRef } from '@/lib/worktrees/worktreeManager';
import { archivedWorktreeLabel, deleteArchivedWorktree, restoreArchivedWorktree } from '@/lib/worktrees/worktreeArchive';

/**
 * Restore and delete for archived worktrees, with their toasts and the
 * confirmation deleting asks for. `busyIds` are the archives being worked on,
 * so their buttons wait.
 */
export function useWorktreeArchiveActions() {
  const { t } = useI18n();
  const { confirm, dialog } = useConfirmDialog();
  const [busyIds, setBusyIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const track = React.useCallback(async (id: string, work: () => Promise<void>) => {
    setBusyIds((current) => new Set(current).add(id));
    try {
      await work();
    } finally {
      setBusyIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const restore = React.useCallback((project: ProjectRef, archive: GitWorktreeArchive) => track(archive.id, async () => {
    const label = archivedWorktreeLabel(archive);
    try {
      const result = await restoreArchivedWorktree({ project, archive });
      if (result.outcome === 'cancelled') return;
      if (result.conflicts) {
        toast.warning(t('sessions.archive.worktree.restoredWithConflicts'), { description: t('sessions.archive.worktree.restoredWithConflictsDescription') });
      } else {
        toast.success(t('sessions.archive.worktree.restored'), { description: label });
      }
      if (result.sessionsFailed > 0) {
        toast.warning(t('sessions.archive.worktree.sessionsNotRestored'), { description: t('sessions.archive.worktree.sessionsNotRestoredDescription') });
      }
    } catch (error) {
      toast.error(t('sessions.archive.worktree.restoreFailed'), { description: error instanceof Error ? error.message : String(error) });
    }
  }), [t, track]);

  const remove = React.useCallback(async (project: ProjectRef, archive: GitWorktreeArchive) => {
    const label = archivedWorktreeLabel(archive);
    const agreed = await confirm({
      title: t('sessions.archive.worktree.deleteTitle', { label }),
      message: t('sessions.archive.worktree.deleteMessage'),
      action: t('sessions.archive.worktree.deleteAction'),
      destructive: true,
    });
    if (!agreed) return;
    await track(archive.id, async () => {
      try {
        await deleteArchivedWorktree({ project, archive });
        toast.success(t('sessions.archive.worktree.deleted'), { description: label });
      } catch (error) {
        toast.error(t('sessions.archive.worktree.deleteFailed'), { description: error instanceof Error ? error.message : String(error) });
      }
    });
  }, [confirm, t, track]);

  return { restore, remove, busyIds, dialog };
}
