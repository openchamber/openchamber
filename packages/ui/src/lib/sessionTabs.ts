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
