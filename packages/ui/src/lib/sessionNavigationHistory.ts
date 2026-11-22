import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionsStore, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';


const MAX_HISTORY = 100;

let visitedSessionIds: string[] = [];
let cursor = -1;
let navigating = false;

const recordVisit = (sessionId: string): void => {
  if (visitedSessionIds[cursor] === sessionId) return;
  visitedSessionIds = [...visitedSessionIds.slice(0, cursor + 1), sessionId].slice(-MAX_HISTORY);
  cursor = visitedSessionIds.length - 1;
};

useSessionUIStore.subscribe((state, previousState) => {
  if (state.currentSessionId === previousState.currentSessionId) return;
  if (!state.currentSessionId || navigating) return;
  recordVisit(state.currentSessionId);
});

export const navigateSessionHistory = (delta: -1 | 1): boolean => {
  const sessionsById = new Map(
    useGlobalSessionsStore.getState().activeSessions.map((session) => [session.id, session] as const),
  );
  let nextCursor = cursor + delta;
  while (nextCursor >= 0 && nextCursor < visitedSessionIds.length) {
    const session = sessionsById.get(visitedSessionIds[nextCursor]);
    if (session) {
      cursor = nextCursor;
      navigating = true;
      try {
        useSessionUIStore.getState().setCurrentSession(session.id, resolveGlobalSessionDirectory(session));
      } finally {
        navigating = false;
      }
      return true;
    }
    visitedSessionIds = [
      ...visitedSessionIds.slice(0, nextCursor),
      ...visitedSessionIds.slice(nextCursor + 1),
    ];
    if (nextCursor < cursor) cursor -= 1;
    if (delta < 0) nextCursor -= 1;
  }
  return false;
};
