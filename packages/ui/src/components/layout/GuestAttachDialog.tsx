import React from 'react';
import { isGuestAttachItem, isGuestLinkItem, type AttachIssueRequest, type GuestItem } from '@openchamber/sdk';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { MobileFullscreenSurface } from '@/apps/MobileFullscreenSurface';
import { useTabletLayout } from '@/lib/device';
import { useGuestsStore } from '@/lib/guests/store';
import { useI18n } from '@/lib/i18n';
import { registerBackLayer } from '@/lib/mobileBackLayers';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
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
  const phone = isMobileSurfaceRuntime();
  const tablet = useTabletLayout().enabled;
  const open = Boolean(guestId);
  // The phone's back button closes it before the screen under it.
  const onOpenChangeRef = React.useRef(onOpenChange);
  React.useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  }, [onOpenChange]);
  React.useEffect(() => (phone && open ? registerBackLayer(() => onOpenChangeRef.current(false)) : undefined), [open, phone]);

  const pane = guestId ? (
    <PluginPane
      mode={pluginModeFromId(guestId)}
      surface="dialog"
      item={item}
      onDismiss={() => onOpenChange(false)}
      onAttach={onAttach}
      onSessionStarted={onSessionStarted}
    />
  ) : null;

  // A phone has no room for a dialog over the chat: the frame takes the
  // screen, with the app's back arrow to leave it.
  if (phone) {
    return (
      <MobileFullscreenSurface
        open={open}
        onClose={() => onOpenChange(false)}
        // A tablet packs it into a card, as the shell's own pages.
        variant={tablet ? 'dialog' : 'fullscreen'}
        title={guest?.name ?? guestId}
        ariaLabel={guest?.name ?? guestId ?? undefined}
        disableEscapeDismiss
      >
        <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">{pane}</div>
      </MobileFullscreenSurface>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[70vh] max-h-[70vh] max-w-2xl flex-col overflow-hidden">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle>{guest?.name ?? guestId}</DialogTitle>
          <DialogDescription>
            {item === null || isGuestAttachItem(item)
              ? t('contextPanel.plugin.attachDialog.description')
              : isGuestLinkItem(item)
                ? t('contextPanel.plugin.linkDialog.description')
                : t('contextPanel.plugin.actionDialog.description')}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{pane}</div>
      </DialogContent>
    </Dialog>
  );
};
