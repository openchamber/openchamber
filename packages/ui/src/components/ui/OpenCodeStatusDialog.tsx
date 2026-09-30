import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui';
import { useUIStore } from '@/stores/useUIStore';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';

export const OpenCodeStatusDialog: React.FC = () => {
  const { t } = useI18n();
  const isOpenCodeStatusDialogOpen = useUIStore((state) => state.isOpenCodeStatusDialogOpen);
  const setOpenCodeStatusDialogOpen = useUIStore((state) => state.setOpenCodeStatusDialogOpen);
  const openCodeStatusText = useUIStore((state) => state.openCodeStatusText);

  const handleCopy = React.useCallback(async () => {
    if (!openCodeStatusText) {
      return;
    }

    const result = await copyTextToClipboard(openCodeStatusText);
    if (result.ok) {
      toast.success(t('openCodeStatusDialog.toast.copiedTitle'), { description: t('openCodeStatusDialog.toast.copiedDescription') });
      return;
    }
    toast.error(t('openCodeStatusDialog.toast.copyFailed'));
  }, [openCodeStatusText, t]);

  const handleDownload = React.useCallback(() => {
    if (!openCodeStatusText) return;
    const url = URL.createObjectURL(new Blob([openCodeStatusText], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `openchamber-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }, [openCodeStatusText]);

  return (
    <Dialog open={isOpenCodeStatusDialogOpen} onOpenChange={setOpenCodeStatusDialogOpen}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('openCodeStatusDialog.title')}</DialogTitle>
          <DialogDescription>
            {t('openCodeStatusDialog.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={handleCopy} disabled={!openCodeStatusText}>
            {t('openCodeStatusDialog.actions.copy')}
          </Button>
          <Button type="button" onClick={handleDownload} disabled={!openCodeStatusText}>
            {t('openCodeStatusDialog.actions.download')}
          </Button>
        </div>

        <pre className="max-h-[60vh] overflow-auto rounded-lg bg-surface-muted p-4 typography-code text-foreground whitespace-pre-wrap">
          {openCodeStatusText || t('openCodeStatusDialog.empty.noData')}
        </pre>
      </DialogContent>
    </Dialog>
  );
};
