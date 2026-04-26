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
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';

type SaveProjectPlanDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTitle: string;
  sourceText: string;
  saving?: boolean;
  onSave: (title: string) => Promise<void> | void;
};

export function SaveProjectPlanDialog(props: SaveProjectPlanDialogProps) {
  const { t } = useI18n();
  const { open, onOpenChange, initialTitle, sourceText, saving = false, onSave } = props;
  const [title, setTitle] = React.useState(initialTitle);

  React.useEffect(() => {
    if (open) {
      setTitle(initialTitle);
    }
  }, [initialTitle, open]);

  const trimmedTitle = title.trim();

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!saving) onOpenChange(nextOpen); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('saveProjectPlanDialog.title')}</DialogTitle>
          <DialogDescription>{t('saveProjectPlanDialog.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="typography-ui-label font-medium text-foreground">{t('saveProjectPlanDialog.field.title')}</label>
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t('saveProjectPlanDialog.field.titlePlaceholder')}
              autoFocus
              disabled={saving}
            />
          </div>

          <div className="space-y-1.5">
            <label className="typography-ui-label font-medium text-foreground">{t('saveProjectPlanDialog.field.contentPreview')}</label>
            <div className="max-h-40 overflow-auto rounded-lg border border-border/70 bg-[var(--surface-subtle)] px-3 py-2 typography-meta text-foreground">
              {sourceText}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>{t('saveProjectPlanDialog.actions.cancel')}</Button>
          <Button onClick={() => void onSave(trimmedTitle)} disabled={!trimmedTitle || saving}>
            {saving ? t('saveProjectPlanDialog.actions.saving') : t('saveProjectPlanDialog.actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
