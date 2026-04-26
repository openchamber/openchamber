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
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from '@/components/ui';
import { RiAlertLine, RiLoader4Line } from '@remixicon/react';
import { useI18n } from '@/lib/i18n';

interface StashDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  operation: 'merge' | 'rebase';
  targetBranch: string;
  onConfirm: (restoreAfter: boolean) => Promise<void>;
}

export const StashDialog: React.FC<StashDialogProps> = ({
  open,
  onOpenChange,
  operation,
  targetBranch,
  onConfirm,
}) => {
  const { t } = useI18n();
  const [restoreAfter, setRestoreAfter] = React.useState(true);
  const [isProcessing, setIsProcessing] = React.useState(false);

  const operationLabel = operation === 'merge' ? t('gitView.operation.merge') : t('gitView.operation.rebase');

  const handleConfirm = async () => {
    setIsProcessing(true);
    try {
      await onConfirm(restoreAfter);
      onOpenChange(false);
    } catch (err) {
      // Show error to user - parent may also handle it but user should see feedback
      const message = err instanceof Error ? err.message : `Failed to ${operation}`;
      toast.error(message);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCancel = () => {
    if (!isProcessing) {
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={isProcessing ? undefined : onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <RiAlertLine className="size-5 text-[var(--status-warning)]" />
            <DialogTitle>{t('gitView.stash.title')}</DialogTitle>
          </div>
          <DialogDescription>
            {t('gitView.stash.description', { operation })}
          </DialogDescription>
        </DialogHeader>

        <div className="py-2">
          <p className="typography-meta text-muted-foreground mb-3">
            {t('gitView.stash.thisWill')}
          </p>
          <ol className="list-decimal list-inside space-y-1 typography-meta text-foreground">
            <li>{t('gitView.stash.stepStash')}</li>
            <li>
              {operation === 'merge' ? t('gitView.operation.merge') : t('gitView.operation.rebase')}{' '}
              {operation === 'merge' ? t('gitView.stash.mergeWith') : t('gitView.stash.rebaseOnto')}{' '}
              <span className="font-mono text-primary">{targetBranch}</span>
            </li>
            {restoreAfter && <li>{t('gitView.stash.stepRestore')}</li>}
          </ol>
        </div>

        <div className="flex items-center gap-2 py-2">
          <Checkbox
            checked={restoreAfter}
            onChange={setRestoreAfter}
            disabled={isProcessing}
            ariaLabel={t('gitView.stash.restoreAria')}
          />
          <span
            className="typography-ui-label text-foreground cursor-pointer select-none"
            onClick={() => !isProcessing && setRestoreAfter(!restoreAfter)}
          >
            {t('gitView.stash.restoreAfterOperation', { operation })}
          </span>
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCancel}
            disabled={isProcessing}
          >
            {t('gitView.common.cancel')}
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={handleConfirm}
            disabled={isProcessing}
            className="gap-1.5"
          >
            {isProcessing ? (
              <>
                <RiLoader4Line className="size-4 animate-spin" />
                {t('gitView.common.processing')}
              </>
            ) : (
              t('gitView.stash.confirmButton', { operation: operationLabel })
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
