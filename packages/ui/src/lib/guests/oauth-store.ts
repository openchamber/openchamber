import { create } from 'zustand';

import { loadGuestOauthStatus, type GuestOauthStatus } from './oauth.ts';

type GuestOauthState = {
  byId: Record<string, GuestOauthStatus>;
  setStatus: (guestId: string, status: GuestOauthStatus) => void;
  refresh: (guestId: string) => Promise<GuestOauthStatus | null>;
  resetForRuntimeSwitch: () => void;
};

export const useGuestOauthStore = create<GuestOauthState>((set) => ({
  byId: {},
  setStatus: (guestId, status) => {
    set((state) => ({ byId: { ...state.byId, [guestId]: status } }));
  },
  refresh: async (guestId) => {
    const status = await loadGuestOauthStatus(guestId);
    if (status) {
      set((state) => ({ byId: { ...state.byId, [guestId]: status } }));
    }
    return status;
  },
  resetForRuntimeSwitch: () => {
    set({ byId: {} });
  },
}));
