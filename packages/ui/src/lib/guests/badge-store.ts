import { create } from 'zustand';

type GuestBadgeState = {
  countByGuest: Record<string, number>;
  setBadge: (guestId: string, count: number | null) => void;
  clearBadge: (guestId: string) => void;
  resetForRuntimeSwitch: () => void;
};

export const useGuestBadgeStore = create<GuestBadgeState>((set, get) => ({
  countByGuest: {},
  setBadge: (guestId, count) => {
    if (count === null || count <= 0) {
      get().clearBadge(guestId);
      return;
    }
    if (get().countByGuest[guestId] === count) return;
    set((state) => ({ countByGuest: { ...state.countByGuest, [guestId]: count } }));
  },
  clearBadge: (guestId) => {
    if (!(guestId in get().countByGuest)) return;
    set((state) => {
      const { [guestId]: _cleared, ...rest } = state.countByGuest;
      void _cleared;
      return { countByGuest: rest };
    });
  },
  resetForRuntimeSwitch: () => {
    if (Object.keys(get().countByGuest).length > 0) set({ countByGuest: {} });
  },
}));
