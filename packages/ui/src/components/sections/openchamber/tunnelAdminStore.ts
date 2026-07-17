import { create } from 'zustand';

interface TunnelAdminStore {
  canAdminister: boolean | null;
  setCanAdminister: (canAdminister: boolean | null) => void;
}

export const useTunnelAdminStore = create<TunnelAdminStore>((set) => ({
  canAdminister: null,
  setCanAdminister: (canAdminister) => set({ canAdminister }),
}));
