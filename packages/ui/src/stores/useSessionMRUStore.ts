import { create } from 'zustand';
import { subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

export const MAX_MRU_SIZE = 50;

type SessionMRUStore = {
  sessionIds: string[];
  recordVisit: (sessionId: string) => void;
  removeSessions: (sessionIds: readonly string[]) => void;
  reset: () => void;
};

export const useSessionMRUStore = create<SessionMRUStore>((set) => ({
  // Stored oldest-to-newest. The final ID is the most recently viewed session.
  sessionIds: [],

  recordVisit: (sessionId) => set((state) => {
    if (state.sessionIds.at(-1) === sessionId) return state;

    // Remove the session ID if it already exists, then push it to the end of the list.
    const updatedSessionIds = state.sessionIds.filter((id) => id !== sessionId);
    updatedSessionIds.push(sessionId);
    return { sessionIds: updatedSessionIds.slice(-MAX_MRU_SIZE) };
  }),

  removeSessions: (sessionIds) => set((state) => {
    if (sessionIds.length === 0) return state;

    const removed = new Set(sessionIds);
    const remainingSessionIds = state.sessionIds.filter((id) => !removed.has(id));
    if (remainingSessionIds.length === state.sessionIds.length) return state;

    return { sessionIds: remainingSessionIds };
  }),

  reset: () => set((state) => (
    state.sessionIds.length === 0 ? state : { sessionIds: [] }
  )),
}));

// Seed the in-memory history when this module loads after a session is already selected.
const initialSessionId = useSessionUIStore.getState().currentSessionId;
if (initialSessionId) {
  useSessionMRUStore.getState().recordVisit(initialSessionId);
}

// Record every authoritative main-session selection after it reaches the UI store.
// This includes sidebar, search, history, and MRU switches without intercepting them.
useSessionUIStore.subscribe((state, previousState) => {
  const sessionId = state.currentSessionId;
  if (!sessionId || sessionId === previousState.currentSessionId) return;
  useSessionMRUStore.getState().recordVisit(sessionId);
});

// Remove only sessions proven to have left between two published active-session
// snapshots. Do not prune every currently unresolved MRU ID: a newly created
// session can become current before its full record reaches the global catalog.
useGlobalSessionsStore.subscribe((state, previousState) => {
  const activeSessionIds = state.structure.activeSessionIds;
  const previousActiveSessionIds = previousState.structure.activeSessionIds;
  if (activeSessionIds === previousActiveSessionIds) return;

  const active = new Set(activeSessionIds);
  const removedSessionIds = previousActiveSessionIds.filter((id) => !active.has(id));
  useSessionMRUStore.getState().removeSessions(removedSessionIds);
});

// Session IDs are scoped to one runtime. Clear history before changing servers
// so IDs from separate OpenCode instances never share one MRU list.
subscribeRuntimeEndpointWillChange(() => {
  useSessionMRUStore.getState().reset();
});
