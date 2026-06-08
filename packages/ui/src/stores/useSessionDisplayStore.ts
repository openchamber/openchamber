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
      displayMode: 'default',
      showRecentSection: true,
      showArchivedSessions: true,
      setDisplayMode: (mode) => set({ displayMode: mode }),
      setShowRecentSection: (show) => set({ showRecentSection: show }),
      setShowArchivedSessions: (show) => set({ showArchivedSessions: show }),
      toggleRecentSection: () => set((state) => ({ showRecentSection: !state.showRecentSection })),
      toggleArchivedSessions: () => set((state) => ({ showArchivedSessions: !state.showArchivedSessions })),
    }),
    {
      name: 'session-display-mode',
    },
  ),
);
