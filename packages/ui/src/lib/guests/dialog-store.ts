import { resolveAttachMode, type GuestItem } from '@openchamber/sdk';
import { create } from 'zustand';

import { pluginModeFromId } from '@/lib/surfaces/modes';
import { useUIStore } from '@/stores/useUIStore';

import { useGuestItemStore } from './item-store.ts';
import type { InstalledGuest } from './types.ts';

/**
 * A message or session action that targets a dialog-mode guest opens the
 * attach window from wherever the menu was (a transcript row, the sidebar,
 * the header). `GuestActionDialogHost` renders whatever is parked here.
 */
type GuestDialogState = {
  request: { guestId: string; item: GuestItem } | null;
  open: (guestId: string, item: GuestItem) => void;
  close: () => void;
};

export const useGuestDialogStore = create<GuestDialogState>((set) => ({
  request: null,
  open: (guestId, item) => set({ request: { guestId, item } }),
  close: () => set({ request: null }),
}));

/**
 * Open a guest with an item as `ready.item`: the attach window when the
 * manifest declared `attach: "dialog"`, otherwise the rail panel through the
 * item hand-off store. Same routing the composer chip uses.
 */
export const openGuestWithItem = (
  guest: Pick<InstalledGuest, 'id' | 'attach'>,
  item: GuestItem,
  directory: string | null | undefined,
): void => {
  if (resolveAttachMode(guest.attach) === 'dialog') {
    useGuestDialogStore.getState().open(guest.id, item);
    return;
  }
  useGuestItemStore.getState().setPendingItem(guest.id, item);
  useUIStore.getState().openContextSurface(directory || '', pluginModeFromId(guest.id));
};
