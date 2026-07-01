import React, { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import type { QuotaCredentialRecord } from '@/types/quota';

interface DeleteCredentialDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  credential: QuotaCredentialRecord;
}

export const DeleteCredentialDialog: React.FC<DeleteCredentialDialogProps> = ({ open, onOpenChange, onSuccess, credential }) => {
  const { t } = useI18n();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleDelete = async () => {
    try {
      setIsSubmitting(true);
      const res = await runtimeFetch(`/api/quota/credentials/${encodeURIComponent(credential.id)}`, {
        method: 'DELETE'
      });

      if (!res.ok) {
        throw new Error('Failed to delete');
      }

      toast.success(t('settings.credentials.toast.deleteSuccess'));
      onSuccess();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.credentials.toast.deleteFailed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[var(--status-error)] flex items-center gap-2">
            <Icon name="error-warning" className="h-5 w-5" />
            {t('settings.credentials.dialog.delete.title')}
          </DialogTitle>
          <DialogDescription>
            {t('settings.credentials.dialog.delete.description', { label: credential.label })}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('settings.credentials.actions.cancel')}</Button>
          <Button variant="destructive" onClick={handleDelete} disabled={isSubmitting}>
             {isSubmitting && <Icon name="loader-4" className="mr-2 h-4 w-4 animate-spin" />}
             {t('settings.credentials.actions.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
