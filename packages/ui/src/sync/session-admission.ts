import { requestOpenCodeTrust } from '@/lib/opencodeTrust';
import { normalizePath } from '@/lib/pathNormalization';
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { getAdmissionNavigationRevision, useSessionUIStore } from './session-ui-store';
import { subscribeGlobalSessionMoves } from './session-moves';
import { isSessionDirectoryAdmitted } from './session-admission-rule';
import { ensureChatsRootDirectory } from '@/lib/chatDirectories';
import { isVSCodeRuntime } from '@/lib/desktop';

export const isSessionAdmitted = (directory: string | null | undefined): boolean => isSessionDirectoryAdmitted(
  directory, useProjectsStore.getState().projects, useSessionUIStore.getState().availableWorktreesByProject,
);

const ADMISSION_WAIT_MS = 10_000;

const waitUntilAdmitted = (directory: string): Promise<void> => new Promise((resolve) => {
  const finish = () => { clearTimeout(timer); stopProjects(); stopTopology(); resolve(); };
  const check = () => { if (isSessionAdmitted(directory)) finish(); };
  const timer = setTimeout(finish, ADMISSION_WAIT_MS);
  const stopProjects = useProjectsStore.subscribe((state, previous) => { if (state.projects !== previous.projects) check(); });
  const stopTopology = useSessionUIStore.subscribe((state, previous) => {
    if (state.availableWorktreesByProject !== previous.availableWorktreesByProject) check();
  });
});

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
    if (!await useProjectsStore.getState().adoptSessionProject(currentId, normalized, () => currentSession() !== null)) return false;
    // A linked worktree joins its repository's project without a new entry and
    // is admitted once the worktree list (owned by the sidebar) picks it up on
    // the server's worktree-changed event. An open waits for that, bounded; it
    // never repeats the registration.
    if (!isSessionAdmitted(normalized)) await waitUntilAdmitted(normalized);
    return isSessionAdmitted(normalized);
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

/**
 * Keep raw records complete; admission affects navigation and projections only.
 * Only a move this client sees, out of an admitted folder, registers its
 * destination on its own. Sessions already in unknown folders (OpenCode's
 * whole history, a removed project) stay hidden until the user opens one.
 */
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
    // VS Code projects are the user's workspace folders: only a deliberate
    // open may add one there.
    if (!current() || isVSCodeRuntime() || !isSessionAdmitted(from) || isSessionAdmitted(to)) return;
    forgetAttempt(to);
    const attempt: AdmissionAttempt = { sessionId, retries: 0, timer: null };
    attempted.set(to, attempt);
    check(to, attempt);
  });
  // The viewed session, put aside while its folder is not admitted. It comes
  // back once a live move admits the folder; re-opening it here would count as
  // the user's choice and register any folder, a removed project included.
  let parked: { id: string; revision: number } | null = null;
  const gateSelection = () => {
    if (!current()) return;
    const ui = useSessionUIStore.getState();
    const records = useGlobalSessionsStore.getState().entityById;
    if (parked) {
      const record = records.get(parked.id);
      const directory = record ? resolveGlobalSessionDirectory(record) : null;
      // Any navigation since, a draft included, replaces the parked session.
      if (ui.currentSessionId || parked.revision !== getAdmissionNavigationRevision() || !directory) parked = null;
      else if (isSessionAdmitted(directory)) {
        const { id } = parked;
        parked = null;
        void ui.setCurrentSession(id, directory);
        return;
      }
    }
    const selectedRecord = ui.currentSessionId ? records.get(ui.currentSessionId) : null;
    const selectedDirectory = selectedRecord ? resolveGlobalSessionDirectory(selectedRecord) : ui.currentSessionDirectory;
    if (ui.currentSessionId && selectedDirectory && !isSessionAdmitted(selectedDirectory)) {
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
    if (state.currentSessionId !== previous.currentSessionId || state.currentSessionDirectory !== previous.currentSessionDirectory || state.availableWorktreesByProject !== previous.availableWorktreesByProject) gateSelection();
  });
  gateSelection();
  return () => {
    disposed = true;
    for (const directory of attempted.keys()) forgetAttempt(directory);
    stopMoves(); stopSessions(); stopProjects(); stopUI();
  };
};
