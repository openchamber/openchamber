import { normalizePath } from '@/lib/pathNormalization';
import { captureRuntimeInstance, getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { requestOpenCodeTrust } from '@/lib/opencodeTrust';
import type { WorktreeMetadata } from '@/types/worktree';
import { resolveProjectForDirectory, resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { getAdmissionNavigationRevision, useSessionUIStore } from './session-ui-store';
import { subscribeGlobalSessionMoves } from './session-moves';
import { isSessionDirectoryAdmitted, resolveAdmittedLineageDirectory } from './session-admission-rule';
import { ensureChatsRootDirectory } from '@/lib/chatDirectories';
import { isVSCodeRuntime } from '@/lib/desktop';
import type { ProjectEntry } from '@/lib/api/types';
import { git } from '@/lib/gitApi';
import { listedLinkedWorktrees } from '@/lib/worktrees/readOnlySessionAssociation';
import { checkoutHoldsDirectory } from '@/lib/worktrees/worktreePaths';

export const isSessionAdmitted = (directory: string | null | undefined): boolean => isSessionDirectoryAdmitted(
  directory, useProjectsStore.getState().projects, useSessionUIStore.getState().availableWorktreesByProject,
);

function nestedSessionProject(sessionId: string, directory: string) {
  if (isVSCodeRuntime()) return null;
  const owner = useSessionUIStore.getState().nestedSessionOwners.get(sessionId);
  if (!owner || owner.directory !== normalizePath(directory)) return null;
  const session = useGlobalSessionsStore.getState().entityById.get(sessionId);
  if (!session || session.parentID || session.time?.archived || resolveGlobalSessionDirectory(session) !== owner.directory) return null;
  return useProjectsStore.getState().projects.find((p) => p.id === owner.projectId && normalizePath(p.path) === owner.projectRoot) ?? null;
}

export const useSelectedNestedSessionFolder = (id: string | null, directory: string | null): boolean =>
  useSessionUIStore((state) => Boolean(id && directory && state.currentSessionId === id && state.currentSessionDirectory === directory
    && state.nestedSessionOwners.get(id)?.directory === directory));

const admittedLineageDirectory = (sessionId: string): string | null => resolveAdmittedLineageDirectory(
  sessionId, useGlobalSessionsStore.getState().entityById,
  (directory, id) => isSessionAdmitted(directory) || Boolean(directory && nestedSessionProject(id, directory)),
);

export const nestedLineageProject = (id: string, directory: string): ProjectEntry | null => {
  const ui = useSessionUIStore.getState();
  if (!ui.nestedSessionOwners.size) return null;
  let project: ProjectEntry | null = null;
  resolveAdmittedLineageDirectory(id, useGlobalSessionsStore.getState().entityById, (path, ancestorId) => {
    if (!path) return false;
    if (isSessionAdmitted(path)) return true;
    project = path === directory ? nestedSessionProject(ancestorId, path) : null;
    return Boolean(project);
  });
  return project;
};

export const confirmNestedSessionTrust = async (directory: string, isCurrent: () => boolean): Promise<boolean> => {
  const current = captureRuntimeInstance();
  return await requestOpenCodeTrust(directory, { deliberate: true }) && current() && isCurrent();
};

export const resolveAdmittedSessionProject = (
  id: string | null,
  directory: string,
  projects: ProjectEntry[],
  worktrees: Map<string, WorktreeMetadata[]>,
): ProjectEntry | null => resolveProjectForSessionDirectory(projects, worktrees, directory)
  ?? (id ? nestedLineageProject(id, directory) : null);

export const resolveProjectRefForWorktreeDirectory = (directory: string | null, projectId?: string | null) => {
  const projects = useProjectsStore.getState().projects;
  if (projectId) {
    const project = projects.find((entry) => entry.id === projectId);
    if (project?.path) return { id: project.id, path: project.path };
  }
  const resolved = resolveProjectForSessionDirectory(projects, useSessionUIStore.getState().availableWorktreesByProject, directory);
  return resolved?.path ? { id: resolved.id, path: resolved.path } : null;
};

export const withAdmittedLineage = (sessionId: string, directory: string | null): string | null => (
  directory && !isSessionAdmitted(directory) ? admittedLineageDirectory(sessionId) ?? directory : directory
);

const ADMISSION_WAIT_MS = 10_000;

const waitForAdmissionState = (read: () => boolean | null, subscribe: (check: () => void) => () => void): Promise<boolean> => {
  const initial = read();
  if (initial !== null) return Promise.resolve(initial);
  return new Promise((resolve) => {
    const finish = (ok: boolean) => { clearTimeout(timer); stop(); resolve(ok); };
    const timer = setTimeout(() => finish(false), ADMISSION_WAIT_MS);
    const stop = subscribe(() => { const ok = read(); if (ok !== null) finish(ok); });
  });
};

const waitForProjectRegistry = () => waitForAdmissionState(() => {
  const { hasServerSnapshot, serverSnapshotFailed } = useProjectsStore.getState();
  return serverSnapshotFailed ? false : hasServerSnapshot ? true : null;
}, useProjectsStore.subscribe);

const waitUntilAdmitted = (directory: string, nestedSessionId?: string) => waitForAdmissionState(
  () => isSessionAdmitted(directory) || (nestedSessionId && nestedSessionProject(nestedSessionId, directory)) ? true : null,
  (check) => {
    const projects = useProjectsStore.subscribe((state, previous) => { if (state.projects !== previous.projects) check(); });
    const topology = useSessionUIStore.subscribe((state, previous) => {
      if (state.availableWorktreesByProject !== previous.availableWorktreesByProject || state.nestedSessionOwners !== previous.nestedSessionOwners) check();
    });
    return () => { projects(); topology(); };
  },
);

const waitUntilRecordedIn = (sessionId: string, directory: string) => waitForAdmissionState(() => {
  const session = useGlobalSessionsStore.getState().entityById.get(sessionId);
  return !session || resolveGlobalSessionDirectory(session) === directory ? true : null;
}, (check) => useGlobalSessionsStore.subscribe((state, previous) => { if (state.entityById !== previous.entityById) check(); }));

const pending = new Map<string, { sessionIds: Map<string, boolean>; request: Promise<string | null> }>();
let generation = 0;
subscribeRuntimeEndpointWillChange(() => { generation += 1; pending.clear(); });

const tryAdmitSession = (sessionId: string, directory: string, deliberate = false): Promise<string | null> => {
  const normalized = normalizePath(directory);
  if (!normalized) return Promise.resolve(null);
  if (isSessionAdmitted(normalized)) return Promise.resolve(normalized);
  const runtimeKey = getRuntimeKey();
  const version = generation;
  const key = `${runtimeKey}:${normalized}`;
  const existing = pending.get(key);
  const indexed = useGlobalSessionsStore.getState().entityById.has(sessionId);
  if (existing) { existing.sessionIds.set(sessionId, indexed); return existing.request; }
  const sessionIds = new Map([[sessionId, indexed]]);
  const currentSession = (canonical: string | null = null): string | null => {
    if (runtimeKey !== getRuntimeKey() || version !== generation) return null;
    for (const [id, wasIndexed] of sessionIds) {
      const session = useGlobalSessionsStore.getState().entityById.get(id);
      if (!session) {
        if (!wasIndexed) return id;
        continue;
      }
      const recorded = normalizePath(resolveGlobalSessionDirectory(session));
      if (recorded === normalized || (canonical !== null && recorded === canonical)) return id;
    }
    return null;
  };
  const request = (async () => {
    if (!isVSCodeRuntime()) await ensureChatsRootDirectory();
    if (!currentSession()) return null;
    if (isSessionAdmitted(normalized)) return normalized;
    if (!await requestOpenCodeTrust(normalized, { deliberate, background: !deliberate, throwOnError: true })) return null;
    const currentId = currentSession();
    if (!currentId) return null;
    if (isSessionAdmitted(normalized) || nestedLineageProject(currentId, normalized)) return normalized;
    if (deliberate && !isVSCodeRuntime()) {
      if (!await waitForProjectRegistry() || !currentSession()) return null;
      if (isSessionAdmitted(normalized) || nestedLineageProject(currentId, normalized)) return normalized;
      const rows = await git.worktree.list(normalized);
      if (!currentSession()) return null;
      const primary = normalizePath(rows[0]?.path);
      const owner = resolveProjectForDirectory(useProjectsStore.getState().projects, primary);
      if (primary && owner && normalizePath(owner.path) !== primary
        && [...listedLinkedWorktrees(primary, rows)].some((checkout) => checkoutHoldsDirectory(checkout, normalized))) {
        if (!nestedSessionProject(currentId, normalized)) await waitUntilAdmitted(normalized, currentId);
        return currentSession() && (isSessionAdmitted(normalized) || nestedSessionProject(currentId, normalized)) ? normalized : null;
      }
      if (!currentSession()) return null;
      if (isSessionAdmitted(normalized) || nestedLineageProject(currentId, normalized)) return normalized;
    }
    const confirmed = normalizePath(await useProjectsStore.getState().adoptSessionProject(
      currentId, normalized, (directory) => currentSession(normalizePath(directory)) !== null,
    ));
    if (!confirmed) return null;
    if (confirmed !== normalized && !await waitUntilRecordedIn(currentId, confirmed)) return null;
    if (!isSessionAdmitted(confirmed)) await waitUntilAdmitted(confirmed);
    return isSessionAdmitted(confirmed) ? confirmed : null;
  })().finally(() => { if (pending.get(key)?.request === request) pending.delete(key); });
  pending.set(key, { sessionIds, request });
  return request;
};

export const admitSession = (sessionId: string, directory: string, deliberate = false): Promise<string | null> => (
  tryAdmitSession(sessionId, directory, deliberate).catch((error) => {
    console.warn('[session-admission] Could not register the session project:', error);
    return null;
  })
);

const RETRY_DELAYS = [1000, 2000, 4000];
type AdmissionAttempt = { sessionId: string; retries: number; timer: ReturnType<typeof setTimeout> | null };

export const subscribeSessionAdmission = (): (() => void) => {
  let disposed = false;
  const runtimeKey = getRuntimeKey();
  const version = generation;
  const attempted = new Map<string, AdmissionAttempt>();
  const current = () => !disposed && runtimeKey === getRuntimeKey() && version === generation;
  const forgetAttempt = (directory: string) => {
    const attempt = attempted.get(directory);
    if (attempt && attempt.timer !== null) clearTimeout(attempt.timer);
    attempted.delete(directory);
  };
  const check = (directory: string, attempt: AdmissionAttempt) => {
    if (!current() || attempted.get(directory) !== attempt) return;
    void tryAdmitSession(attempt.sessionId, directory).then(() => {
      if (attempted.get(directory) === attempt) attempted.delete(directory);
      gateSelection();
    }, (error) => {
      if (!current() || attempted.get(directory) !== attempt) return;
      console.warn('[session-admission] Could not register the session project:', error);
      const delay = RETRY_DELAYS[attempt.retries++];
      if (delay === undefined) { attempted.delete(directory); return; }
      attempt.timer = setTimeout(() => { attempt.timer = null; check(directory, attempt); }, delay);
    });
  };
  const stopMoves = subscribeGlobalSessionMoves(({ sessionId, from, to }) => {
    if (!current() || isVSCodeRuntime() || !isSessionAdmitted(from) || isSessionAdmitted(to)) return;
    forgetAttempt(to);
    const attempt: AdmissionAttempt = { sessionId, retries: 0, timer: null };
    attempted.set(to, attempt);
    check(to, attempt);
  });
  let parked: { id: string; revision: number } | null = null;
  const gateSelection = () => {
    if (!current()) return;
    const ui = useSessionUIStore.getState();
    const records = useGlobalSessionsStore.getState().entityById;
    if (parked) {
      const record = records.get(parked.id);
      const directory = record ? resolveGlobalSessionDirectory(record) : null;
      if (ui.currentSessionId || parked.revision !== getAdmissionNavigationRevision() || !directory) parked = null;
      else if (isSessionAdmitted(directory) || nestedSessionProject(parked.id, directory)) {
        const { id } = parked;
        parked = null;
        void ui.setCurrentSession(id, directory);
        return;
      }
    }
    const selectedRecord = ui.currentSessionId ? records.get(ui.currentSessionId) : null;
    const selectedDirectory = selectedRecord ? resolveGlobalSessionDirectory(selectedRecord) : ui.currentSessionDirectory;
    if (ui.currentSessionId && selectedDirectory && !isSessionAdmitted(selectedDirectory) && !nestedSessionProject(ui.currentSessionId, selectedDirectory) && !admittedLineageDirectory(ui.currentSessionId)) {
      const id = ui.currentSessionId;
      ui.setCurrentSession(null);
      parked = { id, revision: getAdmissionNavigationRevision() };
    }
  };
  const stopSessions = useGlobalSessionsStore.subscribe((state, previous) => {
    if (state.entityById !== previous.entityById) gateSelection();
  });
  const stopProjects = useProjectsStore.subscribe((state, previous) => { if (state.projects !== previous.projects) gateSelection(); });
  const stopUI = useSessionUIStore.subscribe((state, previous) => {
    if (state.currentSessionId !== previous.currentSessionId || state.currentSessionDirectory !== previous.currentSessionDirectory || state.availableWorktreesByProject !== previous.availableWorktreesByProject || state.nestedSessionOwners !== previous.nestedSessionOwners) gateSelection();
  });
  gateSelection();
  return () => {
    disposed = true;
    for (const directory of attempted.keys()) forgetAttempt(directory);
    stopMoves(); stopSessions(); stopProjects(); stopUI();
  };
};
