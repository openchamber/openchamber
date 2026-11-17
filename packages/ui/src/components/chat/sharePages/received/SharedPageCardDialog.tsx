import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';

import type { ComposerReference } from '../../composer/composerReferences';

import { SharedPageChip } from './SharedPageChip';

type SharedPageReference = Extract<ComposerReference, { kind: 'shared-page' }>;

export function SharedPageCardDialog({ reference, onChange, onClose }: {
  reference: SharedPageReference | null;
  onChange: (next: SharedPageReference) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={reference !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md gap-0 p-3">
        <DialogTitle className="sr-only">
          {reference ? reference.title ?? t('chat.sharedPage.chip.label', { host: reference.host }) : ''}
        </DialogTitle>
        {reference ? <SharedPageChip reference={reference} onChange={onChange} /> : null}
      </DialogContent>
    </Dialog>
  );
}
