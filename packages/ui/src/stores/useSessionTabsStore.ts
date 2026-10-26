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
 *
 * A session opened by browsing lands in the one preview tab, which the next
 * opened session replaces in place. Double-clicking the tab, dragging it, or
 * sending a message in the session pins it: a pinned tab stays until closed.
 */
interface SessionTabsStore {
  tabIds: string[];
  /** The replaceable preview tab; null when every tab is pinned. */
  previewTabId: string | null;
  /**
   * Sessions pinned before their tab exists (a draft's first message creates
   * the session ahead of its tab). Their tab opens pinned. Not persisted.
   */
  pinOnOpenIds: string[];

  /**
   * Opens the session's tab as the preview, replacing the current preview.
   * `slotIds` are sessions that share one tab with it (the members of a
   * multi-run): an existing tab of any of them is reused in place, keeping
   * that tab's pinned or preview state.
   */
  ensureTab: (sessionId: string, slotIds?: readonly string[]) => void;
  /** Turns the session's preview tab into a pinned one. */
  pinTab: (sessionId: string) => void;
  closeTab: (sessionId: string) => void;
  closeOtherTabs: (sessionId: string) => void;
  /** Moves a tab and pins it: arranging a tab means keeping it. */
  reorderTabs: (activeId: string, overId: string) => void;
  /** Drop ids the caller has authoritatively confirmed no longer exist. */
  removeTabs: (sessionIds: readonly string[]) => void;
}

const MAX_PINNED_SESSION_TABS = 10;

type PersistedSessionTabs = { tabIds: string[]; previewTabId: string | null };

/**
 * Soft cap on pinned tabs: past it the oldest pinned tab leaves the working
 * set. The newly opened tab lands last, so it is never the one evicted.
 */
const capPinnedTabs = (tabIds: string[], previewTabId: string | null): string[] => {
  let excess = tabIds.filter((id) => id !== previewTabId).length - MAX_PINNED_SESSION_TABS;
  if (excess <= 0) return tabIds;
  return tabIds.filter((id) => {
    if (excess <= 0 || id === previewTabId) return true;
    excess -= 1;
    return false;
  });
};

export const useSessionTabsStore = create<SessionTabsStore>()(
  devtools(
    persist(
      (set, get) => ({
        tabIds: [],
        previewTabId: null,
        pinOnOpenIds: [],

        ensureTab: (sessionId, slotIds) => {
          if (!sessionId) return;
          const { tabIds, previewTabId, pinOnOpenIds } = get();
          if (tabIds.includes(sessionId)) return;
          const pinned = pinOnOpenIds.includes(sessionId);
          const nextPinOnOpenIds = pinned ? pinOnOpenIds.filter((id) => id !== sessionId) : pinOnOpenIds;
          const currentPreview = previewTabId && tabIds.includes(previewTabId) ? previewTabId : null;

          const slot = slotIds && slotIds.length > 0 ? new Set(slotIds) : null;
          const slotIndex = slot ? tabIds.findIndex((id) => slot.has(id)) : -1;
          if (slot && slotIndex >= 0) {
            const next = tabIds.flatMap((id, index) => (index === slotIndex ? [sessionId] : slot.has(id) ? [] : [id]));
            const slotWasPreview = currentPreview !== null && slot.has(currentPreview);
            set({
              tabIds: next,
              previewTabId: slotWasPreview ? (pinned ? null : sessionId) : currentPreview,
              pinOnOpenIds: nextPinOnOpenIds,
            });
            return;
          }

          if (pinned) {
            set({
              tabIds: capPinnedTabs([...tabIds, sessionId], currentPreview),
              previewTabId: currentPreview,
              pinOnOpenIds: nextPinOnOpenIds,
            });
            return;
          }

          if (currentPreview) {
            set({ tabIds: tabIds.map((id) => (id === currentPreview ? sessionId : id)), previewTabId: sessionId });
            return;
          }
          set({ tabIds: [...tabIds, sessionId], previewTabId: sessionId });
        },

        pinTab: (sessionId) => {
          if (!sessionId) return;
          const { tabIds, previewTabId, pinOnOpenIds } = get();
          if (tabIds.includes(sessionId)) {
            if (previewTabId !== sessionId) return;
            set({ tabIds: capPinnedTabs(tabIds, null), previewTabId: null });
            return;
          }
          if (pinOnOpenIds.includes(sessionId)) return;
          set({ pinOnOpenIds: [...pinOnOpenIds, sessionId] });
        },

        closeTab: (sessionId) => {
          const { tabIds, previewTabId } = get();
          if (!tabIds.includes(sessionId)) return;
          set({
            tabIds: tabIds.filter((id) => id !== sessionId),
            previewTabId: previewTabId === sessionId ? null : previewTabId,
          });
        },

        closeOtherTabs: (sessionId) => {
          const { tabIds, previewTabId } = get();
          if (!tabIds.includes(sessionId)) return;
          if (tabIds.length === 1) return;
          set({ tabIds: [sessionId], previewTabId: previewTabId === sessionId ? sessionId : null });
        },

        reorderTabs: (activeId, overId) => {
          const { tabIds, previewTabId } = get();
          const from = tabIds.indexOf(activeId);
          const to = tabIds.indexOf(overId);
          if (from < 0 || to < 0 || from === to) return;
          const next = [...tabIds];
          next.splice(to, 0, ...next.splice(from, 1));
          const nextPreview = previewTabId === activeId ? null : previewTabId;
          set({ tabIds: capPinnedTabs(next, nextPreview), previewTabId: nextPreview });
        },

        removeTabs: (sessionIds) => {
          if (sessionIds.length === 0) return;
          const gone = new Set(sessionIds);
          const { tabIds, previewTabId } = get();
          const next = tabIds.filter((id) => !gone.has(id));
          if (next.length === tabIds.length) return;
          set({ tabIds: next, previewTabId: previewTabId && gone.has(previewTabId) ? null : previewTabId });
        },
      }),
      {
        name: 'session-tabs-store',
        storage: createDeferredSafeJSONStorage<PersistedSessionTabs>(),
        partialize: (state) => ({ tabIds: state.tabIds, previewTabId: state.previewTabId }),
      },
    ),
  ),
);
