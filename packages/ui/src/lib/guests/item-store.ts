import { GUEST_REQUEST_TIMEOUT_MS, type GuestItem } from '@openchamber/sdk';
import { create } from 'zustand';

import { getRuntimeKey } from '@/lib/runtime-switch';
import { afterDelay } from '@/lib/timing/afterDelay';
import { normalizeContextPanelDirectoryKey } from '@/stores/ui/contextTabs';

import type { InstalledGuest } from './types.ts';

type PendingItem = {
  item: GuestItem;
  owner?: string;
  finish?: (delivered: boolean) => void;
  makeReceipt?: (document: symbol, onReceived: () => void) => MessagePort | null;
};

type GuestPanelInstallation = Pick<InstalledGuest, 'storageId' | 'version' | 'revision'>;

export const guestPanelInstallationKey = (guest: GuestPanelInstallation): string => (
  JSON.stringify([guest.storageId, guest.version, guest.revision])
);

export const guestPanelItemOwner = (
  guest: GuestPanelInstallation,
  directory: string | null | undefined,
): string => JSON.stringify([getRuntimeKey(), normalizeContextPanelDirectoryKey(directory ?? ''), guestPanelInstallationKey(guest)]);

type GuestItemState = {
  pendingItemByGuest: Record<string, PendingItem>;
  setPendingItem: (guestId: string, item: GuestItem, owner?: string) => void;
  takePendingItem: (guestId: string, owner?: string) => PendingItem | null;
};

export const useGuestItemStore = create<GuestItemState>((set, get) => ({
  pendingItemByGuest: {},
  setPendingItem: (guestId, item, owner) => {
    get().pendingItemByGuest[guestId]?.finish?.(false);
    set((state) => ({ pendingItemByGuest: { ...state.pendingItemByGuest, [guestId]: { item, owner } } }));
  },
  takePendingItem: (guestId, owner) => {
    const pending = get().pendingItemByGuest[guestId];
    if (!pending || pending.finish || (pending.owner !== undefined && pending.owner !== owner)) return null;
    set((state) => {
      const { [guestId]: _taken, ...rest } = state.pendingItemByGuest;
      void _taken;
      return { pendingItemByGuest: rest };
    });
    return pending;
  },
}));

export const requestGuestPanelItem = (
  guestId: string, item: GuestItem, owner: string, expiresAt = Date.now() + GUEST_REQUEST_TIMEOUT_MS - 1000,
): Promise<boolean> => {
  const delay = expiresAt - Date.now();
  if (delay <= 0) return Promise.resolve(false);
  useGuestItemStore.getState().pendingItemByGuest[guestId]?.finish?.(false);
  return new Promise((resolve) => {
    let receipt: { document: symbol; port: MessagePort } | null = null;
    const makeReceipt = (document: symbol, onReceived: () => void): MessagePort | null => {
      if (receipt?.document === document) return null;
      receipt?.port.close();
      const { port1, port2 } = new MessageChannel();
      receipt = { document, port: port1 };
      port1.onmessage = onReceived;
      return port2;
    };
    const finish = (delivered: boolean) => {
      cancelTimeout();
      receipt?.port.close();
      useGuestItemStore.setState((state) => {
        if (state.pendingItemByGuest[guestId] !== pending) return state;
        const remaining = { ...state.pendingItemByGuest };
        delete remaining[guestId];
        return { pendingItemByGuest: remaining };
      });
      resolve(delivered);
    };
    const pending = { item, owner, finish, makeReceipt };
    const cancelTimeout = afterDelay(delay, () => finish(false));
    useGuestItemStore.setState((state) => ({ pendingItemByGuest: { ...state.pendingItemByGuest, [guestId]: pending } }));
  });
};
