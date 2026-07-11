import { create } from 'zustand';

// Narrow store for the "next message starts a goal" flag. Armed by the
// composer target button (works for existing sessions AND session drafts);
// consumed by sendMessage in session-ui-store, which turns the sent prompt
// into the goal objective.
interface SessionGoalArmStore {
  armed: boolean;
  setArmed: (armed: boolean) => void;
  /** Read-and-clear in one step at send time. */
  consume: () => boolean;
}

export const useSessionGoalArmStore = create<SessionGoalArmStore>((set, get) => ({
  armed: false,
  setArmed: (armed) => set({ armed }),
  consume: () => {
    const { armed } = get();
    if (armed) set({ armed: false });
    return armed;
  },
}));
