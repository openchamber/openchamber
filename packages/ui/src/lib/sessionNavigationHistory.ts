import type { Session } from '@/lib/opencode/model';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionsStore, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { opencodeClient, OpencodeApiError } from '@/lib/opencode/client';
import { isVSCodeRuntime } from '@/lib/desktop';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { getRuntimeKey, isTransientRuntimeKey, subscribeRuntimeEndpointWillChange, UNINITIALIZED_RUNTIME_KEY } from '@/lib/runtime-switch';
import { createSessionNavigationHistory, type SessionVisit } from './sessionNavigationHistoryState';

// Metadata receipts prevent a resolved lookup from overwriting a newer store mutation.
const resolvedRevisions = new WeakMap<Session, number>();
const eligible = (session: Session): boolean => {
  if (session.time.archived) return false;
  if (!isVSCodeRuntime()) return true;
  const { activeProjectId, projects } = useProjectsStore.getState();
  const workspace = activeProjectId
    ? projects.find((project) => project.id === activeProjectId)
    : projects[0];
  const directory = resolveGlobalSessionDirectory(session);
  const owner = resolveProjectForSessionDirectory(
    projects, useSessionUIStore.getState().availableWorktreesByProject, directory,
  );
  return Boolean(workspace && owner?.id === workspace.id);
};

export async function resolveSessionHistoryDestination(
  visit: SessionVisit,
  signal: AbortSignal,
): Promise<Session | null> {
  const before = useGlobalSessionsStore.getState();
  const known = before.entityById.get(visit.sessionId);
  if (known) {
    resolvedRevisions.set(known, before.mutationRevisionBySessionId.get(visit.sessionId) ?? 0);
    return eligible(known) ? known : null;
  }
  const revision = before.mutationRevisionBySessionId.get(visit.sessionId) ?? 0;
  let fetched: Session | null = null;
  try {
    fetched = await opencodeClient.getSession(visit.sessionId, visit.directory, signal);
  } catch (error) {
    if (!(visit.directory && error instanceof OpencodeApiError
      && error.status === 404 && error.tag === 'SessionNotFoundError')) throw error;
  }
  if (signal.aborted) throw new Error('Session destination lookup canceled');
  const after = useGlobalSessionsStore.getState();
  const latestRevision = after.mutationRevisionBySessionId.get(visit.sessionId) ?? 0;
  const current = after.entityById.get(visit.sessionId);
  if (latestRevision !== revision && !current) return null;
  const destination = current ?? fetched;
  if (destination) {
    resolvedRevisions.set(destination, latestRevision);
    return eligible(destination) ? destination : null;
  }
  return null;
}

export const sessionHistory = createSessionNavigationHistory({
  resolve: (visit, signal) => resolveSessionHistoryDestination(visit, signal),
  isKnownAvailable: (id) => {
    const session = useGlobalSessionsStore.getState().entityById.get(id);
    return Boolean(session && eligible(session));
  },
  select: (session) => {
    const global = useGlobalSessionsStore.getState();
    const current = global.entityById.get(session.id);
    const revision = global.mutationRevisionBySessionId.get(session.id) ?? 0;
    if (revision !== resolvedRevisions.get(session) && !current) return false;
    const destination = current ?? session;
    if (!eligible(destination)) return false;
    if (!current) global.upsertSession(destination);
    useSessionUIStore.getState().setCurrentSession(destination.id, resolveGlobalSessionDirectory(destination));
    return true;
  },
});

const recordSelection = () => {
  const state = useSessionUIStore.getState();
  sessionHistory.setBlocked(Boolean(state.newSessionDraft?.open) || !state.currentSessionId);
  if (!state.currentSessionId) return;
  const known = useGlobalSessionsStore.getState().entityById.get(state.currentSessionId);
  sessionHistory.record({
    sessionId: state.currentSessionId,
    directory: known ? resolveGlobalSessionDirectory(known) : state.getDirectoryForSession(state.currentSessionId) ?? null,
  });
};

// History is scoped by the connected server. A transient key normally means
// there is nothing to scope against, but the uninitialized default is not a
// disconnect: the browser-served web client has no injected endpoint and talks
// to the origin that served it, so that origin is its server identity. Real
// disconnects (mobile) keep the history suspended. VS Code owns its connection
// through the extension bridge for the lifetime of this webview, independently
// of the page protocol or selected workspace folder.
const webOriginScope = (): string | null => {
  const location = globalThis.window?.location;
  if (!location) return null;
  const { protocol, origin } = location;
  return (protocol === 'http:' || protocol === 'https:') && origin ? `url:${origin}` : null;
};
const resolveHistoryScope = (): string | null => {
  const key = getRuntimeKey();
  if (!isTransientRuntimeKey(key)) return key;
  if (key !== UNINITIALIZED_RUNTIME_KEY) return null;
  return isVSCodeRuntime() ? 'vscode:bridge' : webOriginScope();
};

export const pauseSessionHistory = (): void => { sessionHistory.setScope(null); };
export const resumeSessionHistory = (): void => {
  sessionHistory.setScope(resolveHistoryScope());
  recordSelection();
};

let consumers = 0;
let stopTracking: (() => void) | null = null;
export function startSessionHistoryTracking(): () => void {
  consumers += 1;
  if (consumers === 1) {
    resumeSessionHistory();
    const stopSelection = useSessionUIStore.subscribe((state, previous) => {
      if (state.currentSessionId !== previous.currentSessionId
        || state.newSessionDraft?.open !== previous.newSessionDraft?.open) recordSelection();
      if (state.availableWorktreesByProject !== previous.availableWorktreesByProject) {
        sessionHistory.refreshAvailability();
      }
    });
    const stopEndpoint = subscribeRuntimeEndpointWillChange(pauseSessionHistory);
    const stopMetadata = useGlobalSessionsStore.subscribe((state, previous) => {
      if (state.entityById !== previous.entityById) sessionHistory.refreshAvailability();
    });
    const stopWorkspace = isVSCodeRuntime() ? useProjectsStore.subscribe((state, previous) => {
      if (state.activeProjectId !== previous.activeProjectId || state.projects !== previous.projects) {
        sessionHistory.refreshAvailability();
      }
    }) : () => {};
    stopTracking = () => {
      stopSelection(); stopEndpoint(); stopMetadata(); stopWorkspace(); pauseSessionHistory();
    };
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    consumers -= 1;
    if (consumers === 0) { stopTracking?.(); stopTracking = null; }
  };
}

// Reports whether navigation was started; destination lookup settles asynchronously.
export const navigateSessionHistory = (delta: -1 | 1): boolean => {
  const state = sessionHistory.getSnapshot();
  if (!(delta === -1 ? state.canGoBack : state.canGoForward)) return false;
  void sessionHistory.navigate(delta);
  return true;
};
