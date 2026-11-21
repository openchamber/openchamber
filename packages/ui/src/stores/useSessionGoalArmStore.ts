import { create } from 'zustand';

interface SessionGoalArmStore {
  armed: boolean;
  objectiveOverride: string | null;
  setArmed: (armed: boolean, objectiveOverride?: string | null) => void;
  consume: () => { armed: boolean; objectiveOverride: string | null };
}

export const useSessionGoalArmStore = create<SessionGoalArmStore>((set, get) => ({
  armed: false,
  objectiveOverride: null,
  setArmed: (armed, objectiveOverride = null) => set({
    armed,
    objectiveOverride: armed ? objectiveOverride : null,
  }),
  consume: () => {
    const { armed, objectiveOverride } = get();
    if (armed) set({ armed: false, objectiveOverride: null });
    return { armed, objectiveOverride };
  },
}));
