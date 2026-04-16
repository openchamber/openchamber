import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/lib/i18n/toast';
import { useUIStore } from '@/stores/useUIStore';
import { copyTextToClipboard } from '@/lib/clipboard';
import {
  commonCopied,
  ocStatusCopied,
  toastCopyFailed,
  ocStatusTitle,
  ocStatusDesc,
  commonCopy,
  ocNoData,
} from '@/lib/i18n/messages';

export const OpenCodeStatusDialog: React.FC = () => {
  const isOpenCodeStatusDialogOpen = useUIStore((state) => state.isOpenCodeStatusDialogOpen);
  const setOpenCodeStatusDialogOpen = useUIStore((state) => state.setOpenCodeStatusDialogOpen);
  const openCodeStatusText = useUIStore((state) => state.openCodeStatusText);

  const handleCopy = React.useCallback(async () => {
    if (!openCodeStatusText) {
      return;
    }

    const result = await copyTextToClipboard(openCodeStatusText);
    if (result.ok) {
      toast.success(commonCopied(), { description: ocStatusCopied() });
      return;
    }
    toast.error(toastCopyFailed());
  }, [openCodeStatusText]);

  return (
    <Dialog open={isOpenCodeStatusDialogOpen} onOpenChange={setOpenCodeStatusDialogOpen}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{ocStatusTitle()}</DialogTitle>
          <DialogDescription>
            {ocStatusDesc()}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={handleCopy}
            className="app-region-no-drag inline-flex h-9 items-center justify-center rounded-md px-3 typography-ui-label font-medium text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {commonCopy()}
          </button>
        </div>

        <pre className="max-h-[60vh] overflow-auto rounded-lg bg-surface-muted p-4 typography-code text-foreground whitespace-pre-wrap">
          {openCodeStatusText || ocNoData()}
        </pre>
      </DialogContent>
    </Dialog>
  );
};
