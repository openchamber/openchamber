import React from 'react';

import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { guestPopoverOwnerBlocked, watchGuestPopoverOwner } from '@/lib/guests/popovers';

type GuestPopoverSheetProps = {
  height: number;
  label: string;
  ownerFrame: HTMLIFrameElement | null;
  onClose: () => void;
  children: React.ReactNode;
};

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
