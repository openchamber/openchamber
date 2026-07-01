import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Persisted per-directory preference for whether the embedded browser is handed
 * to the agent. Default is shared; only "stopped" directories are stored
 * (presence === stopped), so stopping agent control sticks across pane remounts,
 * tab close/reopen, pop-out windows, and full app restarts.
 */
type BrowserSharingStore = {
  stopped: Record<string, boolean>;
  setShared: (directory: string, shared: boolean) => void;
};

export const useBrowserSharingStore = create<BrowserSharingStore>()(
  persist(
    (set) => ({
      stopped: {},
      setShared: (directory, shared) =>
        set((state) => {
          if (Boolean(state.stopped[directory]) === !shared) return state;
          const next = { ...state.stopped };
          if (shared) delete next[directory];
          else next[directory] = true;
          return { stopped: next };
        }),
    }),
    { name: 'browser-agent-sharing', version: 1 },
  ),
);
