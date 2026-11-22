import type { GuestItem } from '@openchamber/sdk';
import { create } from 'zustand';

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
