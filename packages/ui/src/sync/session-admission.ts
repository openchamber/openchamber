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

/** True once the indexed record of `sessionId` names `directory`, bounded; an unindexed session has no record to wait for. */
const waitUntilRecordedIn = (sessionId: string, directory: string): Promise<boolean> => new Promise((resolve) => {
  const recorded = (): boolean | null => {
    const session = useGlobalSessionsStore.getState().entityById.get(sessionId);
    return session ? normalizePath(resolveGlobalSessionDirectory(session)) === directory : null;
  };
  const initial = recorded();
  if (initial !== false) { resolve(true); return; }
  const finish = (value: boolean) => { clearTimeout(timer); stop(); resolve(value); };
  const timer = setTimeout(() => finish(false), ADMISSION_WAIT_MS);
  const stop = useGlobalSessionsStore.subscribe((state, previous) => {
    if (state.entityById !== previous.entityById && recorded() !== false) finish(true);
  });
});

const pending = new Map<string, { sessionIds: Map<string, boolean>; request: Promise<string | null> }>();
let generation = 0;
subscribeRuntimeEndpointWillChange(() => { generation += 1; pending.clear(); });

/**
 * The same trust prompt serves background discoveries and explicit navigation.
 * Resolves to the admitted folder, which is the canonical one when the server
 * moved a session recorded under a symlinked spelling, or null.
 */
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
  // `canonical`: the folder the server moves the session to when OpenCode
  // recorded it under a symlinked spelling. The session stays current in both.
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
    // Persisted managed chats can arrive before their server-owned root does.
    // Never import those directories as ordinary projects during cold startup.
    if (!isVSCodeRuntime()) await ensureChatsRootDirectory();
    if (!currentSession()) return null;
    if (isSessionAdmitted(normalized)) return normalized;
    if (!await requestOpenCodeTrust(normalized, { deliberate, background: !deliberate, throwOnError: true })) return null;
    const currentId = currentSession();
    if (!currentId) return null;
    if (isSessionAdmitted(normalized)) return normalized;
    const confirmed = normalizePath(await useProjectsStore.getState().adoptSessionProject(
      currentId, normalized, (directory) => currentSession(normalizePath(directory)) !== null,
    ));
    if (!confirmed) return null;
    // A session moved to its canonical folder is admitted once its record
    // follows; until then every view still finds it under the old spelling.
    if (confirmed !== normalized && !await waitUntilRecordedIn(currentId, confirmed)) return null;
    // A linked worktree joins its repository's project without a new entry and
    // is admitted once the worktree list (owned by the sidebar) picks it up on
    // the server's worktree-changed event. An open waits for that, bounded; it
    // never repeats the registration.
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
