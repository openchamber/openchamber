import { create } from 'zustand';
import { getRuntimeKey } from '@/lib/runtime-switch';

import { loadGuestOauthStatus, type GuestOauthStatus } from './oauth.ts';

type GuestOauthState = {
  byId: Record<string, GuestOauthStatus>;
  setStatus: (guestId: string, status: GuestOauthStatus) => void;
  refresh: (guestId: string) => Promise<GuestOauthStatus | null>;
  resetForRuntimeSwitch: () => void;
};

let generation = 0;

export const useGuestOauthStore = create<GuestOauthState>((set) => ({
  byId: {},
  setStatus: (guestId, status) => {
    set((state) => ({ byId: { ...state.byId, [guestId]: status } }));
  },
  refresh: async (guestId) => {
    const requestGeneration = generation;
    const runtimeKey = getRuntimeKey();
    const status = await loadGuestOauthStatus(guestId);
    if (requestGeneration !== generation || getRuntimeKey() !== runtimeKey) return null;
    if (status) {
      set((state) => ({ byId: { ...state.byId, [guestId]: status } }));
    }
    return status;
  },
  resetForRuntimeSwitch: () => {
    generation++;
    set({ byId: {} });
  },
}));
