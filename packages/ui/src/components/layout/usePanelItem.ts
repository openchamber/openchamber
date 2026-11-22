import React from 'react';
import type { GuestHostSurface, GuestItem } from '@openchamber/sdk';

import { useGuestItemStore } from '@/lib/guests/item-store';

export function usePanelItem({ guestId, surface, headless, itemProp, panelOpen }: {
  guestId: string;
  surface: GuestHostSurface;
  headless: boolean;
  itemProp: GuestItem | null | undefined;
  panelOpen: boolean;
}): GuestItem | null {
  const pendingItem = useGuestItemStore((state) => state.pendingItemByGuest[guestId]);
  const takePendingItem = useGuestItemStore((state) => state.takePendingItem);
  const [railItem, setRailItem] = React.useState<GuestItem | null>(null);
  const [wasPanelOpen, setWasPanelOpen] = React.useState(panelOpen);
  if (wasPanelOpen !== panelOpen) {
    setWasPanelOpen(panelOpen);
    if (!panelOpen) setRailItem(null);
  }

  React.useEffect(() => {
    if (surface !== 'panel' || headless || itemProp !== undefined || !pendingItem) return;
    const taken = takePendingItem(guestId);
    if (taken) setRailItem(taken);
  }, [guestId, headless, itemProp, pendingItem, surface, takePendingItem]);

  return railItem;
}
