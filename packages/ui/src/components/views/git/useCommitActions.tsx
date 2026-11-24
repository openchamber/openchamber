import React from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import type { GitLogEntry } from '@/lib/api/types';

export interface CommitConflictResult {
  conflict: boolean;
  conflictFiles?: string[];
  operation: 'cherry-pick' | 'revert' | 'merge' | 'rebase';
}

export function useCommitActions(options: {
  directory: string | undefined;
  onCopyHash: (hash: string) => void;
  onConflict?: (result: CommitConflictResult) => void;
  onActionSuccess?: () => void;
}) {
  const { directory, onCopyHash, onConflict, onActionSuccess } = options;
  const { git } = useRuntimeAPIs();
  const { t } = useI18n();
  const confirmDialog = useConfirmDialog();
  const [branchDialogHash, setBranchDialogHash] = React.useState<string | null>(null);
  const [newBranchName, setNewBranchName] = React.useState('');
  const [busyHash, setBusyHash] = React.useState<string | null>(null);

  const runAction = React.useCallback(async (hash: string, fn: () => Promise<void>) => {
    setBusyHash(hash);
    try {
      await fn();
    } finally {
      setBusyHash(null);
    }
  }, []);

  const handleCheckout = React.useCallback(async (entry: GitLogEntry) => {
    if (!directory || !git.checkoutCommit) return;
    const confirmed = await confirmDialog.confirm({
      title: t('gitView.history.actions.checkout'),
      message: t('gitView.history.actions.checkoutConfirm'),
      action: t('gitView.history.actions.confirmButton'),
      destructive: true,
    });
    if (!confirmed) return;
    await runAction(entry.hash, async () => {
      try {
        await git.checkoutCommit!(directory, entry.hash);
        toast.success(t('gitView.history.actions.detachedHead'));
        onActionSuccess?.();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('gitView.history.actions.checkout'));
      }
    });
  }, [confirmDialog, directory, git, onActionSuccess, runAction, t]);

  const handleCherryPick = React.useCallback(async (entry: GitLogEntry) => {
    if (!directory || !git.cherryPick) return;
    const confirmed = await confirmDialog.confirm({
      title: t('gitView.history.actions.cherryPick'),
      message: t('gitView.history.actions.cherryPickConfirm'),
      action: t('gitView.history.actions.confirmButton'),
    });
    if (!confirmed) return;
    await runAction(entry.hash, async () => {
      try {
        const result = await git.cherryPick!(directory, entry.hash);
        if (result.conflict) {
          onConflict?.({ conflict: true, conflictFiles: result.conflictFiles, operation: 'cherry-pick' });
        } else {
          toast.success(t('gitView.history.actions.cherryPick'));
          onActionSuccess?.();
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('gitView.history.actions.cherryPick'));
      }
    });
  }, [confirmDialog, directory, git, onActionSuccess, onConflict, runAction, t]);

  const handleRevert = React.useCallback(async (entry: GitLogEntry) => {
    if (!directory || !git.revertCommit) return;
    const confirmed = await confirmDialog.confirm({
      title: t('gitView.history.actions.revert'),
      message: t('gitView.history.actions.revertConfirm'),
      action: t('gitView.history.actions.confirmButton'),
    });
    if (!confirmed) return;
    await runAction(entry.hash, async () => {
      try {
        const result = await git.revertCommit!(directory, entry.hash);
        if (result.conflict) {
          onConflict?.({ conflict: true, conflictFiles: result.conflictFiles, operation: 'revert' });
        } else {
          toast.success(t('gitView.history.actions.revert'));
          onActionSuccess?.();
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('gitView.history.actions.revert'));
      }
    });
  }, [confirmDialog, directory, git, onActionSuccess, onConflict, runAction, t]);

  const handleReset = React.useCallback(async (entry: GitLogEntry, mode: 'soft' | 'mixed' | 'hard') => {
    if (!directory || !git.resetToCommit) return;
    const confirmKey = mode === 'soft'
      ? 'gitView.history.actions.resetSoftConfirm'
      : mode === 'mixed'
        ? 'gitView.history.actions.resetMixedConfirm'
        : 'gitView.history.actions.resetHardConfirm';
    const confirmed = await confirmDialog.confirm({
      title: t('gitView.history.actions.reset'),
      message: t(confirmKey),
      action: mode === 'hard'
        ? t('gitView.history.actions.resetHardConfirmButton')
        : t('gitView.history.actions.confirmButton'),
      destructive: mode === 'hard',
    });
    if (!confirmed) return;
    await runAction(entry.hash, async () => {
      try {
        await git.resetToCommit!(directory, entry.hash, mode, mode === 'hard');
        toast.success(t('gitView.history.actions.reset'));
        onActionSuccess?.();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('gitView.history.actions.reset'));
      }
    });
  }, [confirmDialog, directory, git, onActionSuccess, runAction, t]);

  const handleCreateBranchSubmit = React.useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = newBranchName.trim();
    if (!directory || !branchDialogHash || !trimmed || !git.createBranch) return;
    const hash = branchDialogHash;
    await runAction(hash, async () => {
      try {
        await git.createBranch!(directory, trimmed, hash);
        toast.success(t('gitView.history.actions.createBranch'));
        setBranchDialogHash(null);
        setNewBranchName('');
        onActionSuccess?.();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('gitView.history.actions.createBranch'));
      }
    });
  }, [branchDialogHash, directory, git, newBranchName, onActionSuccess, runAction, t]);

  const dialogs = (
    <>
      {confirmDialog.dialog}
      <Dialog
        open={branchDialogHash !== null}
        onOpenChange={(open) => {
          if (!open) {
            setBranchDialogHash(null);
            setNewBranchName('');
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('gitView.history.actions.createBranch')}</DialogTitle>
            <DialogDescription>
              {branchDialogHash ? branchDialogHash.slice(0, 8) : ''}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => void handleCreateBranchSubmit(e)} className="flex flex-col gap-3">
            <Input
              autoFocus
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              placeholder={t('gitView.history.actions.createBranchPlaceholder')}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setBranchDialogHash(null);
                  setNewBranchName('');
                }}
              >
                {t('gitView.history.actions.cancelButton')}
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={!newBranchName.trim() || busyHash !== null}
              >
                {t('gitView.history.actions.createBranchConfirm')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );

  return {
    busyHash,
    canMutate: Boolean(directory),
    copySha: (entry: GitLogEntry) => onCopyHash(entry.hash),
    checkout: (entry: GitLogEntry) => void handleCheckout(entry),
    openCreateBranch: (entry: GitLogEntry) => {
      setNewBranchName('');
      setBranchDialogHash(entry.hash);
    },
    cherryPick: (entry: GitLogEntry) => void handleCherryPick(entry),
    revert: (entry: GitLogEntry) => void handleRevert(entry),
    reset: (entry: GitLogEntry, mode: 'soft' | 'mixed' | 'hard') => void handleReset(entry, mode),
    hasCheckout: Boolean(git.checkoutCommit),
    hasCreateBranch: Boolean(git.createBranch),
    hasCherryPick: Boolean(git.cherryPick),
    hasRevert: Boolean(git.revertCommit),
    hasReset: Boolean(git.resetToCommit),
    dialogs,
  };
}

export type CommitActionsController = ReturnType<typeof useCommitActions>;
