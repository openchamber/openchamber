import React from 'react';
import { isGuestAttachItem, type AttachIssueRequest, type GuestItem } from '@openchamber/sdk';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useGuestsStore } from '@/lib/guests/store';
import { useI18n } from '@/lib/i18n';
import { pluginModeFromId } from '@/lib/surfaces/modes';

import { PluginPane } from './PluginPane';

type GuestAttachDialogProps = {
  guestId: string | null;
  /** The chip, message, or session the dialog was opened for; `null` (default) when opened from the + menu. */
  item?: GuestItem | null;
  onOpenChange: (open: boolean) => void;
  onAttach?: (issue: AttachIssueRequest) => void;
  onSessionStarted?: () => void;
};

export const GuestAttachDialog: React.FC<GuestAttachDialogProps> = ({
  guestId,
  item = null,
  onOpenChange,
  onAttach,
  onSessionStarted,
}) => {
  const { t } = useI18n();
  const guest = useGuestsStore((state) => (
    guestId ? state.guests.find((entry) => entry.id === guestId) ?? null : null
  ));

  return (
    <Dialog open={Boolean(guestId)} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[70vh] max-h-[70vh] max-w-2xl flex-col overflow-hidden">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle>{guest?.name ?? guestId}</DialogTitle>
          <DialogDescription>
            {item === null || isGuestAttachItem(item)
              ? t('contextPanel.plugin.attachDialog.description')
              : t('contextPanel.plugin.actionDialog.description')}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {guestId ? (
            <PluginPane
              mode={pluginModeFromId(guestId)}
              surface="dialog"
              item={item}
              onDismiss={() => onOpenChange(false)}
              onAttach={onAttach}
              onSessionStarted={onSessionStarted}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
};
