import React from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import type { SessionTreeMoveConfirmation } from '@/lib/worktrees/sessionWorktreeMove';

export type SessionWorktreeMoveConfirmDialogProps = {
  value: SessionTreeMoveConfirmation | null;
  onMoveSessionOnly: () => void;
  onMoveAllChanges: () => void;
  onCancel: () => void;
};

export function SessionWorktreeMoveConfirmDialog(props: SessionWorktreeMoveConfirmDialogProps): React.ReactNode {
  const { t } = useI18n();
  const { value, onMoveSessionOnly, onMoveAllChanges, onCancel } = props;

  return (
    <Dialog open={Boolean(value)} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent
        id="session-worktree-move-confirm-dialog"
        showCloseButton={false}
        className="max-w-md gap-5"
      >
        <DialogHeader>
          <DialogTitle>{t('sessions.sidebar.session.moveToWorktree.confirm.title')}</DialogTitle>
          <DialogDescription>
            {t('sessions.sidebar.session.moveToWorktree.confirm.changedFiles', {
              count: value?.dirtyFileCount ?? 0,
            })}{' '}
            {t('sessions.sidebar.session.moveToWorktree.confirm.ownership')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 typography-ui-label text-muted-foreground">
          <p>{t('sessions.sidebar.session.moveToWorktree.confirm.sessionOnlyHelp')}</p>
          <p>{t('sessions.sidebar.session.moveToWorktree.confirm.allChangesHelp')}</p>
          {value && value.stagedFileCount > 0 ? (
            <p data-session-worktree-move-staged-warning="true">
              {t('sessions.sidebar.session.moveToWorktree.confirm.stagedWarning')}
            </p>
          ) : null}
          <p>{t('sessions.sidebar.session.moveToWorktree.confirm.baseWarning')}</p>
        </div>
        <DialogFooter className="gap-2 sm:justify-end">
          <Button
            type="button"
            variant="neutral"
            data-session-worktree-move-action="cancel"
            onClick={onCancel}
          >
            {t('sessions.sidebar.session.moveToWorktree.confirm.cancel')}
          </Button>
          <Button
            type="button"
            variant="outline"
            data-session-worktree-move-action="all-changes"
            onClick={onMoveAllChanges}
          >
            {t('sessions.sidebar.session.moveToWorktree.confirm.allChanges')}
          </Button>
          <Button
            type="button"
            autoFocus
            data-session-worktree-move-action="session-only"
            onClick={onMoveSessionOnly}
          >
            {t('sessions.sidebar.session.moveToWorktree.confirm.sessionOnly')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
