import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { type useFileClosing, type useFileCloseState } from './useFileClosing';
import { type useFileDraft } from './useFileSaving';
import { useI18n } from '@/lib/i18n';

export function renderFileDiscardDialog({ closeState, draft, fileClosing, t }: {
  closeState: Pick<ReturnType<typeof useFileCloseState>, 'confirmDiscardOpen' | 'setConfirmDiscardOpen'>;
  draft: Pick<ReturnType<typeof useFileDraft>, 'isSaving'>;
  fileClosing: Pick<ReturnType<typeof useFileClosing>, 'discardAndContinue' | 'saveAndContinue'>;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const { confirmDiscardOpen, setConfirmDiscardOpen } = closeState;
  const { isSaving } = draft;
  const { discardAndContinue, saveAndContinue } = fileClosing;
  return (
      <Dialog open={confirmDiscardOpen} onOpenChange={(open) => {
        if (!open) {
          setConfirmDiscardOpen(true);
        }
      }}>
        <DialogContent showCloseButton={false} className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('filesView.unsaved.title')}</DialogTitle>
            <DialogDescription>
              {t('filesView.unsaved.description')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => void saveAndContinue()}
              disabled={isSaving}
              className="border-[var(--status-success-border)] bg-[var(--status-success-background)] text-[var(--status-success)] hover:bg-[var(--status-success)]/20"
            >
              {t('filesView.unsaved.saveChanges')}
            </Button>
            <Button variant="destructive" onClick={discardAndContinue}>{t('filesView.unsaved.discard')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

  );
}
