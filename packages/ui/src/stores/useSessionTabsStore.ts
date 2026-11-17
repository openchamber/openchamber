import { z } from 'zod';
import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';

import { createDeferredSafeJSONStorage } from '@/stores/utils/safeStorage';

interface SessionTabsStore {
  tabIds: string[];
  previewTabId: string | null;
  scope: string;
  sets: Record<string, SessionTabSet>;
  pinOnOpenIds: string[];

  ensureTab: (sessionId: string, slotIds?: readonly string[]) => void;
  pinTab: (sessionId: string) => void;
  closeTab: (sessionId: string) => void;
  closeOtherTabs: (sessionId: string) => void;
  reorderTabs: (activeId: string, overId: string) => void;
  removeTabs: (sessionIds: readonly string[]) => void;
  followSessionMove: (sessionId: string, scope: string, scopePrefix: string, seed: () => readonly string[] | null) => void;
  enterScope: (scope: string, seed: () => readonly string[]) => void;
}

type SessionTabSet = { tabIds: string[]; previewTabId: string | null };

export const GLOBAL_SESSION_TAB_SCOPE = 'global';

const MAX_PINNED_SESSION_TABS = 10;
const MAX_STORED_SCOPES = 40;

type PersistedSessionTabs = { tabIds: string[]; previewTabId: string | null; scope: string; sets: Record<string, SessionTabSet> };

const tabSetSchema = z.object({ tabIds: z.array(z.string()), previewTabId: z.string().nullable() });
const persistedSchema = z.object({
  tabIds: z.array(z.string()).catch([]),
  previewTabId: z.string().nullable().catch(null),
  scope: z.string().catch(GLOBAL_SESSION_TAB_SCOPE),
  sets: z.record(z.string(), tabSetSchema).catch({}),
});

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
        scope: GLOBAL_SESSION_TAB_SCOPE,
        sets: {},
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
          const without = (tabSet: SessionTabSet): SessionTabSet | null => {
            const next = tabSet.tabIds.filter((id) => !gone.has(id));
            if (next.length === tabSet.tabIds.length) return null;
            return { tabIds: next, previewTabId: tabSet.previewTabId && gone.has(tabSet.previewTabId) ? null : tabSet.previewTabId };
          };
          const { tabIds, previewTabId, sets } = get();
          const shown = without({ tabIds, previewTabId });
          let nextSets: Record<string, SessionTabSet> | null = null;
          for (const [scope, tabSet] of Object.entries(sets)) {
            const next = without(tabSet);
            if (!next) continue;
            nextSets ??= { ...sets };
            nextSets[scope] = next;
          }
          if (!shown && !nextSets) return;
          set({
            tabIds: shown?.tabIds ?? tabIds,
            previewTabId: shown ? shown.previewTabId : previewTabId,
            sets: nextSets ?? sets,
          });
        },

        followSessionMove: (sessionId, scope, scopePrefix, seed) => {
          const { scope: shownScope, tabIds, previewTabId, sets } = get();
          const all = { ...sets, [shownScope]: { tabIds, previewTabId } };
          const next: Record<string, SessionTabSet> = {};
          for (const [key, tabSet] of Object.entries(all)) {
            if (key === scope || !key.startsWith(scopePrefix) || !tabSet.tabIds.includes(sessionId)) continue;
            next[key] = {
              tabIds: tabSet.tabIds.filter((id) => id !== sessionId),
              previewTabId: tabSet.previewTabId === sessionId ? null : tabSet.previewTabId,
            };
          }
          if (Object.keys(next).length === 0) return;
          const seeded = all[scope] ? null : seed();
          const target = all[scope] ?? (seeded ? { tabIds: [...new Set(seeded)].slice(0, MAX_PINNED_SESSION_TABS), previewTabId: null } : null);
          if (target) {
            next[scope] = target.tabIds.includes(sessionId)
              ? target
              : { tabIds: capPinnedTabs([...target.tabIds, sessionId], target.previewTabId), previewTabId: target.previewTabId };
          }
          const { [shownScope]: shown, ...stored } = next;
          set({
            tabIds: shown?.tabIds ?? tabIds,
            previewTabId: shown ? shown.previewTabId : previewTabId,
            sets: { ...sets, ...stored },
          });
        },

        enterScope: (scope, seed) => {
          const { scope: shownScope, tabIds, previewTabId, sets } = get();
          if (scope === shownScope) return;
          const { [scope]: stored, ...others } = sets;
          const kept = Object.entries({ ...others, [shownScope]: { tabIds, previewTabId } });
          const nextSets = Object.fromEntries(kept.slice(Math.max(0, kept.length - MAX_STORED_SCOPES)));
          const next = stored ?? { tabIds: [...new Set(seed())].slice(0, MAX_PINNED_SESSION_TABS), previewTabId: null };
          set({ scope, tabIds: next.tabIds, previewTabId: next.previewTabId, sets: nextSets });
        },
      }),
      {
        name: 'session-tabs-store',
        version: 1,
        storage: createDeferredSafeJSONStorage<PersistedSessionTabs>(),
        partialize: (state) => ({ tabIds: state.tabIds, previewTabId: state.previewTabId, scope: state.scope, sets: state.sets }),
        migrate: (persisted): PersistedSessionTabs => persistedSchema.parse(persisted ?? {}),
      },
    ),
  ),
);
