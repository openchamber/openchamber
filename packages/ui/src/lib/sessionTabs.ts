import { useSessionTabsStore } from '@/stores/useSessionTabsStore';
import { useGlobalSessionsStore, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

/**
 * Close one header session tab. Closing the active tab activates its right
 * neighbour (falling back left), or opens a new-session draft when it was the
 * last tab. Only tabs whose session is present in the loaded session list
 * count as neighbours — the same rule the strip uses for rendering. The
 * session itself is never touched.
 */
/**
 * Activate the nth (0-based) header session tab, counting only tabs whose
 * session is present in the loaded session list — the same rule the strip
 * uses for rendering, so the digit matches what the user sees.
 */
export const activateSessionTabByIndex = (index: number): boolean => {
  const { tabIds } = useSessionTabsStore.getState();
  const sessionsById = new Map(
    useGlobalSessionsStore.getState().activeSessions.map((session) => [session.id, session] as const),
  );
  const renderable = tabIds.filter((id) => sessionsById.has(id));
  const session = renderable[index] ? sessionsById.get(renderable[index]) : null;
  if (!session) return false;
  useSessionUIStore.getState().setCurrentSession(session.id, resolveGlobalSessionDirectory(session));
  return true;
};

/**
 * Activate the tab one step right (+1) or left (-1) of the current session
 * in the rendered strip order, wrapping around the ends. Returns false when
 * the current session has no tab or there is nothing to move to.
 */
export const activateAdjacentSessionTab = (delta: -1 | 1): boolean => {
  const { tabIds } = useSessionTabsStore.getState();
  const { currentSessionId, setCurrentSession } = useSessionUIStore.getState();
  const sessionsById = new Map(
    useGlobalSessionsStore.getState().activeSessions.map((session) => [session.id, session] as const),
  );
  const renderable = tabIds.filter((id) => sessionsById.has(id));
  if (!currentSessionId || renderable.length < 2) return false;
  const index = renderable.indexOf(currentSessionId);
  if (index === -1) return false;
  const nextId = renderable[(index + delta + renderable.length) % renderable.length];
  const next = sessionsById.get(nextId);
  if (!next) return false;
  setCurrentSession(next.id, resolveGlobalSessionDirectory(next));
  return true;
};

export const closeSessionTabAndActivateNeighbour = (sessionId: string): void => {
  const { tabIds, closeTab } = useSessionTabsStore.getState();
  if (!tabIds.includes(sessionId)) return;

  const { currentSessionId, setCurrentSession, openNewSessionDraft } = useSessionUIStore.getState();
  if (sessionId === currentSessionId) {
    const sessionsById = new Map(
      useGlobalSessionsStore.getState().activeSessions.map((session) => [session.id, session] as const),
    );
    const renderable = tabIds.filter((id) => sessionsById.has(id));
    const index = renderable.indexOf(sessionId);
    const neighbourId = renderable[index + 1] ?? renderable[index - 1] ?? null;
    const neighbour = neighbourId ? sessionsById.get(neighbourId) : null;
    if (neighbour) {
      setCurrentSession(neighbour.id, resolveGlobalSessionDirectory(neighbour));
    } else {
      openNewSessionDraft();
    }
  }

  closeTab(sessionId);
};
