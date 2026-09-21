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
import { useI18n } from '@/lib/i18n';

type SystemIdentityConfirmDialogProps = {
  /** Whether a System identity is waiting to be applied. */
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * The one thing choosing an identity cannot decide on its own.
 *
 * A System Git identity says "use whatever this machine holds", and
 * OpenChamber cannot tell whose credentials those are. That is an authority
 * decision, so it is asked before anything is written rather than reported
 * afterwards — picking a name from a menu is not the same as saying it.
 */
export const SystemIdentityConfirmDialog: React.FC<SystemIdentityConfirmDialogProps> = ({
  open,
  onConfirm,
  onCancel,
}) => {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      {open ? (
        <DialogContent className="min-w-0">
          <DialogHeader>
            <DialogTitle>{t('gitView.identity.systemConfirmTitle')}</DialogTitle>
            <DialogDescription>{t('settings.sourceControl.transport.unverifiedConfirmation')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={onCancel}>{t('gitView.common.cancel')}</Button>
            <Button size="sm" onClick={onConfirm}>{t('gitView.identity.systemConfirmAction')}</Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
};
