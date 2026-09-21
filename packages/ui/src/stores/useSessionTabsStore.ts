import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';

import { createDeferredSafeJSONStorage } from '@/stores/utils/safeStorage';

/**
 * The header's working set of sessions, shown as tabs on web/desktop.
 *
 * Only session ids and their order are owned here — titles, directories and
 * liveness come from the session stores at render time. Tabs are a per-client
 * projection: opening a session anywhere adds it once, closing a tab only
 * removes it from the strip and never touches the session itself. Ids whose
 * session is unknown are kept (a partially loaded global list must not
 * destroy the working set) and simply do not render until the session loads.
 */
interface SessionTabsStore {
  tabIds: string[];

  ensureTab: (sessionId: string) => void;
  closeTab: (sessionId: string) => void;
  closeOtherTabs: (sessionId: string) => void;
  reorderTabs: (activeId: string, overId: string) => void;
  /** Drop ids the caller has authoritatively confirmed no longer exist. */
  removeTabs: (sessionIds: readonly string[]) => void;
}

const MAX_SESSION_TABS = 10;

type PersistedSessionTabs = { tabIds: string[] };

export const useSessionTabsStore = create<SessionTabsStore>()(
  devtools(
    persist(
      (set, get) => ({
        tabIds: [],

        ensureTab: (sessionId) => {
          if (!sessionId) return;
          const { tabIds } = get();
          if (tabIds.includes(sessionId)) return;
          // Soft cap: with auto-add the strip only ever grows, so past the cap
          // the oldest tab (never the one being opened, which lands last)
          // leaves the working set.
          const next = [...tabIds, sessionId];
          set({ tabIds: next.length > MAX_SESSION_TABS ? next.slice(next.length - MAX_SESSION_TABS) : next });
        },

        closeTab: (sessionId) => {
          const { tabIds } = get();
          if (!tabIds.includes(sessionId)) return;
          set({ tabIds: tabIds.filter((id) => id !== sessionId) });
        },

        closeOtherTabs: (sessionId) => {
          const { tabIds } = get();
          if (!tabIds.includes(sessionId)) return;
          if (tabIds.length === 1) return;
          set({ tabIds: [sessionId] });
        },

        reorderTabs: (activeId, overId) => {
          const { tabIds } = get();
          const from = tabIds.indexOf(activeId);
          const to = tabIds.indexOf(overId);
          if (from < 0 || to < 0 || from === to) return;
          const next = [...tabIds];
          next.splice(to, 0, ...next.splice(from, 1));
          set({ tabIds: next });
        },

        removeTabs: (sessionIds) => {
          if (sessionIds.length === 0) return;
          const gone = new Set(sessionIds);
          const { tabIds } = get();
          const next = tabIds.filter((id) => !gone.has(id));
          if (next.length === tabIds.length) return;
          set({ tabIds: next });
        },
      }),
      {
        name: 'session-tabs-store',
        storage: createDeferredSafeJSONStorage<PersistedSessionTabs>(),
        partialize: (state) => ({ tabIds: state.tabIds }),
      },
    ),
  ),
);
