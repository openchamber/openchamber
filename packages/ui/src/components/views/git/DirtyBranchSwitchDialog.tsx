import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';

interface DirtyBranchSwitchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetBranch: string;
  changedFileCount: number;
  /**
   * Commit every uncommitted change with this message — pushing the commit
   * first when the user opted in — then perform the checkout.
   */
  onCommitAndSwitch: (message: string, pushAfter: boolean) => Promise<void>;
  /** Produce an AI commit message for the current changes, same as the commit panel. */
  onGenerateMessage: () => Promise<string>;
  /** Revert every uncommitted change, then perform the checkout. */
  onRevertAndSwitch: () => Promise<void>;
}

/**
 * Switching branches with uncommitted changes is blocked so a checkout can
 * never silently carry, conflict with, or drop the user's work. The user
 * resolves the working tree with one explicit choice: commit and switch
 * (message written, generated on demand, or generated automatically when the
 * field is left empty — same pipeline as the commit panel), or revert and
 * switch. Cancel leaves everything untouched for a fully manual flow.
 */
export const DirtyBranchSwitchDialog: React.FC<DirtyBranchSwitchDialogProps> = ({
  open,
  onOpenChange,
  targetBranch,
  changedFileCount,
  onCommitAndSwitch,
  onGenerateMessage,
  onRevertAndSwitch,
}) => {
  const { t } = useI18n();
  const [commitMessage, setCommitMessage] = React.useState('');
  const [pendingAction, setPendingAction] = React.useState<'generate' | 'commit' | 'revert' | null>(null);
  const [pushAfter, setPushAfter] = React.useState(false);
  const isProcessing = pendingAction !== null;

  React.useEffect(() => {
    if (!open) {
      setCommitMessage('');
      setPushAfter(false);
    }
  }, [open]);

  const handleGenerate = async () => {
    setPendingAction('generate');
    try {
      const generated = await onGenerateMessage();
      if (generated) setCommitMessage(generated);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('gitView.dirtySwitch.actionFailed'));
    } finally {
      setPendingAction(null);
    }
  };

  // An empty field is not an obstacle: the message is generated on the spot,
  // through the same pipeline as the commit panel, and the commit proceeds.
  const handleCommitAndSwitch = async () => {
    setPendingAction('commit');
    try {
      let message = commitMessage.trim();
      if (!message) {
        message = (await onGenerateMessage()).trim();
        if (!message) {
          toast.error(t('gitView.toast.enterCommitMessage'));
          return;
        }
        setCommitMessage(message);
      }
      await onCommitAndSwitch(message, pushAfter);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('gitView.dirtySwitch.actionFailed'));
    } finally {
      setPendingAction(null);
    }
  };

  const handleRevertAndSwitch = async () => {
    setPendingAction('revert');
    try {
      await onRevertAndSwitch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('gitView.dirtySwitch.actionFailed'));
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!isProcessing) onOpenChange(next); }}>
      <DialogContent className="max-w-md w-[calc(100vw-2rem)]">
        <div className="flex flex-col gap-4">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <Icon name="alert" className="size-5 shrink-0 text-[var(--status-warning)]" />
              <DialogTitle>{t('gitView.dirtySwitch.title')}</DialogTitle>
            </div>
            <DialogDescription>
              {changedFileCount === 1
                ? t('gitView.dirtySwitch.descriptionSingle', { branch: targetBranch })
                : t('gitView.dirtySwitch.descriptionPlural', { branch: targetBranch, count: changedFileCount })}
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2 rounded-lg border border-border/60 px-3 py-2 focus-within:border-border">
            <input
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              placeholder={t('gitView.commit.messagePlaceholder')}
              disabled={isProcessing}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !isProcessing) {
                  event.preventDefault();
                  void handleCommitAndSwitch();
                }
              }}
              className="min-w-0 flex-1 bg-transparent typography-meta text-foreground outline-none placeholder:text-muted-foreground"
            />
            <button
              type="button"
              onClick={() => { void handleGenerate(); }}
              disabled={isProcessing}
              aria-label={t('gitView.commit.generate')}
              title={t('gitView.commit.generate')}
              className="shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              {pendingAction === 'generate' ? (
                <Icon name="loader-4" className="size-4 animate-spin" />
              ) : (
                <Icon name="ai-generate-2" className="size-4 text-primary" />
              )}
            </button>
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              checked={pushAfter}
              onChange={setPushAfter}
              disabled={isProcessing}
              ariaLabel={t('gitView.dirtySwitch.pushAfterCommit')}
            />
            <span
              className="typography-ui-label text-foreground cursor-pointer select-none"
              onClick={() => !isProcessing && setPushAfter(!pushAfter)}
            >
              {t('gitView.dirtySwitch.pushAfterCommit')}
            </span>
          </div>

          <div className="flex items-center justify-between gap-2 pt-1">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => { void handleRevertAndSwitch(); }}
              disabled={isProcessing}
              className="gap-2"
            >
              {pendingAction === 'revert' ? (
                <Icon name="loader-4" className="size-4 animate-spin" />
              ) : null}
              {t('gitView.dirtySwitch.revertAndSwitch')}
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => { void handleCommitAndSwitch(); }}
              disabled={isProcessing}
              className="gap-2"
            >
              {pendingAction === 'commit' ? (
                <Icon name="loader-4" className="size-4 animate-spin" />
              ) : null}
              {t('gitView.dirtySwitch.commitAndSwitch')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
