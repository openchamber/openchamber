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
import { m } from '@/lib/i18n/messages';

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
  const [restoreAfter, setRestoreAfter] = React.useState(true);
  const [isProcessing, setIsProcessing] = React.useState(false);

  const handleConfirm = async () => {
    setIsProcessing(true);
    try {
      await onConfirm(restoreAfter);
      onOpenChange(false);
    } catch (err) {
      // Show error to user - parent may also handle it but user should see feedback
      const message = err instanceof Error ? err.message : m.gitStashError();
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
            <DialogTitle>{m.gitUncommittedChanges()}</DialogTitle>
          </div>
          <DialogDescription>
            {m.gitUncommittedChangesDescription(operation)}
          </DialogDescription>
        </DialogHeader>

        <div className="py-2">
          <p className="typography-meta text-muted-foreground mb-3">
            {m.gitStashWill()}
          </p>
          <ol className="list-decimal list-inside space-y-1 typography-meta text-foreground">
            <li>{m.gitStashUncommittedChanges()}</li>
            <li>
              {operation === 'merge' ? m.gitMergeWith() : m.gitRebaseOnto()}{' '}
              <span className="font-mono text-primary">{targetBranch}</span>
            </li>
            {restoreAfter && <li>{m.gitRestoreChangesAfter(operation)}</li>}
          </ol>
        </div>

        <div className="flex items-center gap-2 py-2">
          <Checkbox
            checked={restoreAfter}
            onChange={setRestoreAfter}
            disabled={isProcessing}
            ariaLabel={m.gitRestoreChangesAfterOperation()}
          />
          <span
            className="typography-ui-label text-foreground cursor-pointer select-none"
            onClick={() => !isProcessing && setRestoreAfter(!restoreAfter)}
          >
            {m.gitRestoreChangesAfter(operation)}
          </span>
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCancel}
            disabled={isProcessing}
          >
            {m.gitStashCancel()}
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
                {m.gitProcessing()}
              </>
            ) : (
              m.gitStashAnd(operation)
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
