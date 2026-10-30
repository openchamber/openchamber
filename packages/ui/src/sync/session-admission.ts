import { requestOpenCodeTrust, subscribeOpenCodeTrustAnswers } from '@/lib/opencodeTrust';
import { normalizePath } from '@/lib/pathNormalization';
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from './session-ui-store';
import { isSessionDirectoryAdmitted } from './session-admission-rule';
import { ensureChatsRootDirectory } from '@/lib/chatDirectories';
import { isVSCodeRuntime } from '@/lib/desktop';

export const isSessionAdmitted = (directory: string | null | undefined): boolean => isSessionDirectoryAdmitted(
  directory, useProjectsStore.getState().projects, useSessionUIStore.getState().availableWorktreesByProject,
);

const pending = new Map<string, { sessionIds: Map<string, boolean>; request: Promise<boolean> }>();
let generation = 0;
subscribeRuntimeEndpointWillChange(() => { generation += 1; pending.clear(); });

/** The same trust prompt serves background discoveries and explicit navigation. */
const tryAdmitSession = (sessionId: string, directory: string, deliberate = false): Promise<boolean> => {
  const normalized = normalizePath(directory);
  if (!normalized) return Promise.resolve(false);
  if (isSessionAdmitted(normalized)) return Promise.resolve(true);
  const runtimeKey = getRuntimeKey();
  const version = generation;
  const key = `${runtimeKey}:${normalized}`;
  const existing = pending.get(key);
  const indexed = useGlobalSessionsStore.getState().entityById.has(sessionId);
  if (existing) { existing.sessionIds.set(sessionId, indexed); return existing.request; }
  const sessionIds = new Map([[sessionId, indexed]]);
  const currentSession = (): string | null => {
    if (runtimeKey !== getRuntimeKey() || version !== generation) return null;
    for (const [id, wasIndexed] of sessionIds) {
      const session = useGlobalSessionsStore.getState().entityById.get(id);
      if (session ? normalizePath(resolveGlobalSessionDirectory(session)) === normalized : !wasIndexed) return id;
    }
    return null;
  };
  const request = (async () => {
    // Persisted managed chats can arrive before their server-owned root does.
    // Never import those directories as ordinary projects during cold startup.
    if (!isVSCodeRuntime()) await ensureChatsRootDirectory();
    if (!currentSession()) return false;
    if (isSessionAdmitted(normalized)) return true;
    if (!await requestOpenCodeTrust(normalized, { deliberate, background: !deliberate, throwOnError: true })) return false;
    const currentId = currentSession();
    if (!currentId) return false;
    if (isSessionAdmitted(normalized)) return true;
    return useProjectsStore.getState().adoptSessionProject(currentId, normalized, () => currentSession() !== null);
  })().finally(() => { if (pending.get(key)?.request === request) pending.delete(key); });
  pending.set(key, { sessionIds, request });
  return request;
};

export const admitSession = (sessionId: string, directory: string, deliberate = false): Promise<boolean> => (
  tryAdmitSession(sessionId, directory, deliberate).catch((error) => {
    console.warn('[session-admission] Could not register the session project:', error);
    return false;
  })
);

const RETRY_DELAYS = [1000, 2000, 4000];
type AdmissionAttempt = { sessionId: string; retries: number; timer: ReturnType<typeof setTimeout> | null };

/** Keep raw records complete; admission affects navigation and projections only. */
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
  const clearAttempts = () => { for (const directory of attempted.keys()) forgetAttempt(directory); };
  const check = (directory: string, attempt: AdmissionAttempt) => {
    if (!current() || attempted.get(directory) !== attempt) return;
    void tryAdmitSession(attempt.sessionId, directory).catch((error) => {
      if (!current() || attempted.get(directory) !== attempt) return;
      console.warn('[session-admission] Could not register the session project:', error);
      const delay = RETRY_DELAYS[attempt.retries++];
      if (delay === undefined) return;
      attempt.timer = setTimeout(() => { attempt.timer = null; check(directory, attempt); }, delay);
    });
  };
  const scan = () => {
    if (!current()) return;
    const directories = new Map<string, string>();
    const sessions = useGlobalSessionsStore.getState();
    for (const [directory, ids] of sessions.structure.activeIdsByDirectory) {
      if (ids[0] && !isSessionAdmitted(directory)) directories.set(directory, ids[0]);
    }
    for (const session of sessions.archivedSessions) {
      const directory = normalizePath(resolveGlobalSessionDirectory(session));
      if (directory && !directories.has(directory) && !isSessionAdmitted(directory)) directories.set(directory, session.id);
    }
    for (const directory of attempted.keys()) if (!directories.has(directory)) forgetAttempt(directory);
    for (const [directory, sessionId] of directories) {
      if (attempted.get(directory)?.sessionId === sessionId) continue;
      forgetAttempt(directory);
      const attempt: AdmissionAttempt = { sessionId, retries: 0, timer: null };
      attempted.set(directory, attempt);
      check(directory, attempt);
    }
    const ui = useSessionUIStore.getState();
    const selectedRecord = ui.currentSessionId ? useGlobalSessionsStore.getState().entityById.get(ui.currentSessionId) : null;
    const selectedDirectory = selectedRecord ? resolveGlobalSessionDirectory(selectedRecord) : ui.currentSessionDirectory;
    if (ui.currentSessionId && selectedDirectory && !isSessionAdmitted(selectedDirectory)) {
      // A move of the viewed session must stop mounting its destination before
      // a trust answer; the raw record remains available for the prompt.
      const id = ui.currentSessionId;
      const directory = selectedDirectory;
      ui.setCurrentSession(null);
      void ui.setCurrentSession(id, directory);
    }
  };
  const stopSessions = useGlobalSessionsStore.subscribe((state, previous) => {
    if (state.structure.activeIdsByDirectory !== previous.structure.activeIdsByDirectory || state.archivedSessions !== previous.archivedSessions || state.status !== previous.status) {
      if (state.status === 'ready' && previous.status !== 'ready') clearAttempts();
      scan();
    }
  });
  const stopProjects = useProjectsStore.subscribe((state, previous) => { if (state.projects !== previous.projects) scan(); });
  const stopUI = useSessionUIStore.subscribe((state, previous) => {
    if (state.currentSessionDirectory !== previous.currentSessionDirectory || state.availableWorktreesByProject !== previous.availableWorktreesByProject) scan();
  });
  const stopAnswers = subscribeOpenCodeTrustAnswers(() => { clearAttempts(); scan(); });
  scan();
  return () => { disposed = true; clearAttempts(); stopSessions(); stopProjects(); stopUI(); stopAnswers(); };
};
