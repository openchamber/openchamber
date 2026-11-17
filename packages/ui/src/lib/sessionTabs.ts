import { useSessionTabsStore } from '@/stores/useSessionTabsStore';
import { useGlobalSessionsStore, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { isChatDirectoryPath } from '@/lib/chatDirectories';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { sessionTabScopeFor, sessionTabSeedFor } from '@/lib/sessionTabScope';

export const activateSessionTabByIndex = (index: number): boolean => {
  const { tabIds } = useSessionTabsStore.getState();
  const sessionsById = new Map(
    useGlobalSessionsStore.getState().activeSessions.map((session) => [session.id, session] as const),
  );
  const renderable = tabIds.filter((id) => sessionsById.has(id));
  const id = renderable.at(index);
  const session = id ? sessionsById.get(id) : null;
  if (!session) return false;
  useSessionUIStore.getState().setCurrentSession(session.id, resolveGlobalSessionDirectory(session));
  return true;
};

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
      const directory = useSessionUIStore.getState().currentSessionDirectory;
      const stayInWorkspace = useUIStore.getState().sessionTabsPerWorkspace && directory && !isChatDirectoryPath(directory);
      openNewSessionDraft(stayInWorkspace ? { directoryOverride: directory } : undefined);
    }
  }

  closeTab(sessionId);
};

export const followSessionTabMove = (sessionId: string, destinationDirectory: string): void => {
  const runtimeKey = getRuntimeKey();
  const scope = sessionTabScopeFor(runtimeKey, destinationDirectory);
  if (!scope) return;
  useSessionTabsStore.getState().followSessionMove(sessionId, scope, `${runtimeKey}|`, () => {
    const { hasLoaded, activeSessions } = useGlobalSessionsStore.getState();
    if (!hasLoaded) return null;
    return sessionTabSeedFor(destinationDirectory, activeSessions, useProjectsStore.getState().projects.map((project) => project.path));
  });
};

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
