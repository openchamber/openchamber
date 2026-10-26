import type { GuestItem } from '@openchamber/sdk';
import { create } from 'zustand';

/**
 * Hand-off slot between the composer chip (or a message / session action)
 * and a rail-mounted guest pane. The click cannot pass a prop to the rail, so
 * it parks the item here under the guest id; the pane takes it (and clears
 * the slot) when it mounts or, if already up, as soon as it lands. Dialog
 * panes get the item as a prop and never touch this store.
 */
type GuestItemState = {
  pendingItemByGuest: Record<string, GuestItem>;
  setPendingItem: (guestId: string, item: GuestItem) => void;
  takePendingItem: (guestId: string) => GuestItem | null;
};

export const useGuestItemStore = create<GuestItemState>((set, get) => ({
  pendingItemByGuest: {},
  setPendingItem: (guestId, item) => {
    set((state) => ({ pendingItemByGuest: { ...state.pendingItemByGuest, [guestId]: item } }));
  },
  takePendingItem: (guestId) => {
    const item = get().pendingItemByGuest[guestId] ?? null;
    if (item) {
      set((state) => {
        const { [guestId]: _taken, ...rest } = state.pendingItemByGuest;
        void _taken;
        return { pendingItemByGuest: rest };
      });
    }
    return item;
  },
}));
