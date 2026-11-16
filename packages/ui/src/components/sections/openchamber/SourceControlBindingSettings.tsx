import React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { AdditionalRemoteGrants, AuxiliaryBindingSettings } from './RepositoryBindingEditors';

type RepositoryConfigurationDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  directory: string;
};

const DIALOG_DIVIDER_CLASS = 'border-t border-edge pt-4';

export const RepositoryConfigurationDialog: React.FC<RepositoryConfigurationDialogProps> = ({ open, onOpenChange, directory }) => {
  const { t } = useI18n();
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);

  return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        {open ? <DialogContent className="@container min-w-0 max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('gitView.context.configure')}</DialogTitle>
            <DialogDescription>{t('gitView.context.description')}</DialogDescription>
          </DialogHeader>
          <AdditionalRemoteGrants directory={directory} className={DIALOG_DIVIDER_CLASS} />
          <AuxiliaryBindingSettings directory={directory} className={DIALOG_DIVIDER_CLASS} />
          <DialogFooter className={DIALOG_DIVIDER_CLASS}>
            <Button size="sm" variant="ghost" onClick={() => {
              onOpenChange(false);
              setSettingsPage('git');
              setSettingsDialogOpen(true);
            }}>{t('gitView.context.settings')}</Button>
            <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>{t('dialog.common.actions.close')}</Button>
          </DialogFooter>
        </DialogContent> : null}
      </Dialog>
  );
};
