import { create } from 'zustand';

// Narrow store for the "next message starts a goal" flag. Armed by the
// composer target button (works for existing sessions AND session drafts)
// and by the run-as-goal flows (fork dialog, plan send); consumed by
// sendMessage in session-ui-store, which turns the sent prompt into the
// goal objective — unless the arming flow supplied a richer objective
// override (e.g. the plan content instead of "Implement this plan: X").
interface SessionGoalArmStore {
  armed: boolean;
  objectiveOverride: string | null;
  setArmed: (armed: boolean, objectiveOverride?: string | null) => void;
  /** Read-and-clear in one step at send time. */
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
