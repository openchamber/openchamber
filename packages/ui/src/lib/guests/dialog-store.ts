import { resolveAttachMode, type GuestItem } from '@openchamber/sdk';
import { create } from 'zustand';

import { pluginModeFromId } from '@/lib/surfaces/modes';
import { normalizeContextPanelDirectoryKey } from '@/stores/useUIStore';

import { useGuestItemStore } from './item-store.ts';
import { openGuestSurface } from './open-surface.ts';
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
 * item hand-off store. Same routing the composer chip uses. The panel only
 * ever opens here, never toggles closed, and nothing is parked when there is
 * no folder to open it in, so a later rail click cannot receive a stale item.
 * False when it could not open.
 */
export const openGuestWithItem = (
  guest: Pick<InstalledGuest, 'id' | 'attach'>,
  item: GuestItem,
  directory: string | null | undefined,
): boolean => {
  if (resolveAttachMode(guest.attach) === 'dialog') {
    useGuestDialogStore.getState().open(guest.id, item);
    return true;
  }
  const key = directory ? normalizeContextPanelDirectoryKey(directory) : '';
  if (!key) return false;
  useGuestItemStore.getState().setPendingItem(guest.id, item);
  const opened = openGuestSurface({ mode: pluginModeFromId(guest.id), directory: key, supported: true });
  if (!opened.ok) useGuestItemStore.getState().takePendingItem(guest.id);
  return opened.ok;
};
