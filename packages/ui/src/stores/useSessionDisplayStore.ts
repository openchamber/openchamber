import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type SessionDisplayMode = 'default' | 'minimal';

type SessionDisplayStore = {
  displayMode: SessionDisplayMode;
  showRecentSection: boolean;
  showArchivedSessions: boolean;
  setDisplayMode: (mode: SessionDisplayMode) => void;
  setShowRecentSection: (show: boolean) => void;
  setShowArchivedSessions: (show: boolean) => void;
  toggleRecentSection: () => void;
  toggleArchivedSessions: () => void;
};

export const useSessionDisplayStore = create<SessionDisplayStore>()(
  persist(
    (set) => ({
      displayMode: 'minimal',
      showRecentSection: true,
      // Default to HIDDEN so the pre-hydration state matches the quiet/safe
      // option: archived sessions must never flash visible on startup and then
      // disappear once the persisted preference rehydrates. Users who opted into
      // showing archived have `true` persisted, which is preserved on rehydrate.
      showArchivedSessions: false,
      setDisplayMode: (mode) => set({ displayMode: mode }),
      setShowRecentSection: (show) => set({ showRecentSection: show }),
      setShowArchivedSessions: (show) => set({ showArchivedSessions: show }),
      toggleRecentSection: () => set((state) => ({ showRecentSection: !state.showRecentSection })),
      toggleArchivedSessions: () => set((state) => ({ showArchivedSessions: !state.showArchivedSessions })),
    }),
    {
      name: 'session-display-mode',
      version: 1,
      // v0 shipped 'default' as the only/initial mode, so most existing users
      // have it persisted by accident rather than choice. Nudge everyone onto
      // minimal once so the mode can be evaluated before removing it entirely.
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Partial<SessionDisplayStore>;
        if (version < 1) {
          return { ...state, displayMode: 'minimal' };
        }
        return state;
      },
    },
  ),
);
