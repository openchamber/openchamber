import React from 'react';
import type { GuestHostSurface, GuestItem, HostMessage } from '@openchamber/sdk';

import { buildItemMessage } from '@/lib/guests/host-bridge';
import { guestPanelItemOwner, useGuestItemStore } from '@/lib/guests/item-store';
import type { InstalledGuest } from '@/lib/guests/types';

export function usePanelItem({ guestId, guest, directory, surface, headless, itemProp, panelOpen }: {
  guestId: string;
  guest: InstalledGuest | null;
  directory: string | undefined;
  surface: GuestHostSurface;
  headless: boolean;
  itemProp: GuestItem | null | undefined;
  panelOpen: boolean;
}) {
  const pendingItem = useGuestItemStore((state) => state.pendingItemByGuest[guestId]);
  const takePendingItem = useGuestItemStore((state) => state.takePendingItem);
  const [railItem, setRailItem] = React.useState<ReturnType<typeof takePendingItem>>(null);
  const owner = guest && (pendingItem?.owner || railItem?.owner) ? guestPanelItemOwner(guest, directory) : undefined;
  const readsItems = surface === 'panel' && !headless && itemProp === undefined;
  const delivery = readsItems && panelOpen && pendingItem?.finish && pendingItem.owner === owner ? pendingItem : null;
  const [wasPanelOpen, setWasPanelOpen] = React.useState(panelOpen);
  if (wasPanelOpen !== panelOpen) {
    setWasPanelOpen(panelOpen);
  }
  if ((wasPanelOpen && !panelOpen) || (railItem?.owner !== undefined && railItem.owner !== owner)) setRailItem(null);

  React.useEffect(() => {
    if (!readsItems || !pendingItem || pendingItem.finish) return;
    const taken = takePendingItem(guestId, owner);
    if (taken) setRailItem(taken);
  }, [guestId, owner, pendingItem, readsItems, takePendingItem]);

  const postItem = (item: GuestItem | null, document: symbol, post: (message: HostMessage, transfer?: Transferable[]) => void) => {
    const message = buildItemMessage(item);
    if (!delivery || delivery.item !== item || useGuestItemStore.getState().pendingItemByGuest[guestId] !== delivery) {
      post(message);
      return;
    }
    const receipt = delivery.makeReceipt?.(document, () => {
      if (useGuestItemStore.getState().pendingItemByGuest[guestId] !== delivery) return;
      setRailItem({ item: delivery.item, owner: delivery.owner });
      delivery.finish?.(true);
    });
    post(message, receipt ? [receipt] : undefined);
  };
  return { item: delivery?.item ?? railItem?.item ?? null, postItem };
}
