import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';

type TerminalTabRenameDialogProps = {
  /** The label being edited; null keeps the dialog closed. */
  currentLabel: string | null;
  onRename: (label: string) => void;
  onClose: () => void;
};

export const TerminalTabRenameDialog: React.FC<TerminalTabRenameDialogProps> = ({ currentLabel, onRename, onClose }) => {
  const { t } = useI18n();
  const [value, setValue] = React.useState('');

  React.useEffect(() => {
    if (currentLabel !== null) setValue(currentLabel);
  }, [currentLabel]);

  const submit = () => {
    const label = value.trim();
    if (label) onRename(label);
    onClose();
  };

  return (
    <Dialog open={currentLabel !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('terminalView.tabs.renameDialog.title')}</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          placeholder={t('terminalView.tabs.renameDialog.placeholder')}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !isIMECompositionEvent(event)) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('terminalView.tabs.renameDialog.cancel')}
          </Button>
          <Button size="sm" onClick={submit} disabled={!value.trim()}>
            {t('terminalView.tabs.renameDialog.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
