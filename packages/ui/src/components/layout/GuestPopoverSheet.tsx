import React from 'react';

import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { guestPopoverOwnerBlocked, watchGuestPopoverOwner } from '@/lib/guests/popovers';

type GuestPopoverSheetProps = {
  /** The height the guest asked for; the sheet's own limit caps it. */
  height: number;
  label: string;
  ownerFrame: HTMLIFrameElement | null;
  onClose: () => void;
  children: React.ReactNode;
};

/**
 * The phone's place for an extension popover: the app's bottom sheet, as
 * wide as the sheet and as tall as the guest asked. A sheet is modal and
 * closes when the user closes it (the close button, the scrim, back), so the
 * anchor's hover and focus, which a phone does not have, never close it. A
 * host dialog that opens over the owner closes it too, as on the desktop.
 */
export const GuestPopoverSheet: React.FC<GuestPopoverSheetProps> = ({ height, label, ownerFrame, onClose, children }) => {
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;
  React.useEffect(() => {
    const close = () => onCloseRef.current();
    if (!ownerFrame || guestPopoverOwnerBlocked(ownerFrame)) { close(); return; }
    return watchGuestPopoverOwner(ownerFrame, close);
  }, [ownerFrame]);
  return (
    <MobileOverlayPanel open title={label} onClose={onClose} scrollContent={false}>
      <div data-guest-popover-overlay className="min-h-0 w-full max-h-full overflow-hidden" style={{ height }}>
        {children}
      </div>
    </MobileOverlayPanel>
  );
};
