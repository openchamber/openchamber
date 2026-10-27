import { useSessionTabsStore } from '@/stores/useSessionTabsStore';
import { useGlobalSessionsStore, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { isChatDirectoryPath } from '@/lib/chatDirectories';

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
      // With tabs per workspace the new draft stays in the workspace whose
      // last tab closed, so the strip keeps showing its set.
      const directory = useSessionUIStore.getState().currentSessionDirectory;
      const stayInWorkspace = useUIStore.getState().sessionTabsPerWorkspace && directory && !isChatDirectoryPath(directory);
      openNewSessionDraft(stayInWorkspace ? { directoryOverride: directory } : undefined);
    }
  }

  closeTab(sessionId);
};

/**
 * Work that is done or removed leaves the working set, as Mark done in the
 * composer does: the header tabs of `sessionIds` close, and when the open
 * session is one of them the app moves to the neighbouring tab still at work,
 * or with none to a new draft in `projectId` or the active project (never in the folder of
 * the work just closed, which may be gone). Without header tabs (mobile,
 * VS Code, tabs off) only the move away from the open session applies.
 */
export const leaveFinishedSessions = (sessionIds: readonly string[], options?: { projectId?: string | null }): void => {
  if (sessionIds.length === 0) return;
  const finished = new Set(sessionIds);
  const { tabIds, removeTabs } = useSessionTabsStore.getState();
  const { currentSessionId, setCurrentSession, openNewSessionDraft } = useSessionUIStore.getState();
  if (currentSessionId && finished.has(currentSessionId)) {
    const sessionsById = new Map(
      useGlobalSessionsStore.getState().activeSessions.map((session) => [session.id, session] as const),
    );
    const index = tabIds.indexOf(currentSessionId);
    const atWork = (id: string): boolean => !finished.has(id) && sessionsById.has(id);
    const neighbourId = index === -1
      ? null
      : tabIds.slice(index + 1).find(atWork) ?? [...tabIds.slice(0, index)].reverse().find(atWork) ?? null;
    const neighbour = neighbourId ? sessionsById.get(neighbourId) : null;
    if (neighbour) {
      setCurrentSession(neighbour.id, resolveGlobalSessionDirectory(neighbour));
    } else {
      const projectId = options?.projectId ?? useProjectsStore.getState().activeProjectId;
      openNewSessionDraft(projectId ? { selectedProjectId: projectId } : undefined);
    }
  }
  removeTabs(sessionIds);
};
