import type { Session } from '@opencode-ai/sdk/v2';
import type { I18nKey } from '@/lib/i18n';
import { toast } from '@/components/ui';
import { checkIsGitRepository, getGitStatus } from '@/lib/gitApi';
import { normalizePath } from '@/lib/pathNormalization';
import { createQuickWorktree, resolveProjectRef } from '@/lib/worktreeSessionCreator';
import { getLatestWorktreeMetadata, removeProjectWorktree, type ProjectRef } from '@/lib/worktrees/worktreeManager';
import { refreshGlobalSessionsForDirectories } from '@/stores/useGlobalSessionsStore';
import { isAmbiguousSendFailure } from '@/sync/send-failure-classification';
import { getSessionLiveActivity, isSessionBusyNow, moveSessionToDirectory } from '@/sync/session-actions';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { WorktreeMetadata } from '@/types/worktree';
import { waitForWorktreeGitReady } from '@/lib/worktrees/worktreeBootstrap';
import { create } from 'zustand';

export type SessionTreeMoveMessages = {
  success: string;
  failure: string;
  sourceVerificationFailed: string;
  applyChangesFailed: string;
  changesMayBeInDestination: string;
};

/** Every move surface differs only in the success/failure pair, so the shared
 *  failure copy is resolved once here instead of at each call site. */
export const buildSessionTreeMoveMessages = (
  t: (key: I18nKey) => string,
  keys: { success: I18nKey; failure: I18nKey },
): SessionTreeMoveMessages => ({
  success: t(keys.success),
  failure: t(keys.failure),
  sourceVerificationFailed: t('sessions.sidebar.session.moveToWorktree.sourceVerificationFailed'),
  applyChangesFailed: t('sessions.sidebar.session.moveToWorktree.applyChangesFailed'),
  changesMayBeInDestination: t('sessions.sidebar.session.moveToWorktree.changesMayBeInDestination'),
});

export type SessionTreeMoveIntent =
  | {
      kind: 'existing';
      root: Session;
      descendants: Session[];
      sourceDirectory: string;
      destination: WorktreeMetadata;
      messages: SessionTreeMoveMessages;
    }
  | {
      kind: 'quick';
      root: Session;
      descendants: Session[];
      sourceDirectory: string;
      messages: SessionTreeMoveMessages;
    };

export type SessionTreeMoveConfirmation = {
  intent: SessionTreeMoveIntent;
  dirtyFileCount: number;
  stagedFileCount: number;
};

type SessionMoveState = {
  pendingSessionIds: Set<string>;
  requestingSessionIds: Set<string>;
  confirmation: SessionTreeMoveConfirmation | null;
};

const useSessionMoveState = create<SessionMoveState>(() => ({
  pendingSessionIds: new Set(),
  requestingSessionIds: new Set(),
  confirmation: null,
}));

export const useIsSessionWorktreeMovePending = (sessionId: string): boolean =>
  useSessionMoveState((state) => state.pendingSessionIds.has(sessionId) || state.requestingSessionIds.has(sessionId));

export const useSessionTreeMoveConfirmation = (): SessionTreeMoveConfirmation | null =>
  useSessionMoveState((state) => state.confirmation);

export const getSessionTreeMoveConfirmation = (): SessionTreeMoveConfirmation | null =>
  useSessionMoveState.getState().confirmation;

const setSessionMoveConfirmation = (confirmation: SessionTreeMoveConfirmation | null): void => {
  useSessionMoveState.setState((state) => (state.confirmation === confirmation ? state : { ...state, confirmation }));
};

const setSessionMovePending = (sessionId: string, pending: boolean): void => {
  useSessionMoveState.setState((state) => {
    if (state.pendingSessionIds.has(sessionId) === pending) return state;
    const pendingSessionIds = new Set(state.pendingSessionIds);
    if (pending) pendingSessionIds.add(sessionId);
    else pendingSessionIds.delete(sessionId);
    return { ...state, pendingSessionIds };
  });
};

const setSessionMoveRequesting = (sessionId: string, requesting: boolean): void => {
  useSessionMoveState.setState((state) => {
    if (state.requestingSessionIds.has(sessionId) === requesting) return state;
    const requestingSessionIds = new Set(state.requestingSessionIds);
    if (requesting) requestingSessionIds.add(sessionId);
    else requestingSessionIds.delete(sessionId);
    return { ...state, requestingSessionIds };
  });
};

// The control plane flattens every move failure into a single
// `MoveSessionError` carrying only `data.message`, so there is no status or
// error code to match on. This prefix is the exact text OpenCode's
// `message(MoveSession.ApplyChangesError)` returns in
// `packages/opencode/src/server/routes/instance/httpapi/handlers/control-plane.ts`.
// If upstream reworks that wording the friendlier toast silently degrades to
// the raw message, which is why the fallback stays readable.
const APPLY_CHANGES_MESSAGE = 'Unable to apply your changes in the destination directory';

const isApplyChangesError = (error: Error): boolean => {
  // SAFETY: move failures originate from our own SDK/runtime layer, which may
  // attach an optional numeric HTTP status to an Error instance.
  const errorWithStatus = error as Error & { status?: number };
  return errorWithStatus.status === 400 && error.message.includes(APPLY_CHANGES_MESSAGE);
};

const resolveSourceBranch = async (directory: string, projectDirectory: string): Promise<string> => {
  try {
    const status = await getGitStatus(directory, { mode: 'light' });
    const currentBranch = status.current?.trim();
    if (currentBranch) return currentBranch;
  } catch {
    // Fall back to discovered worktree metadata below.
  }

  const normalizedDirectory = normalizePath(directory);
  const normalizedProjectDirectory = normalizePath(projectDirectory) ?? projectDirectory;
  const worktrees = useSessionUIStore.getState().availableWorktreesByProject;
  const metadata = (worktrees.get(normalizedProjectDirectory) ?? worktrees.get(projectDirectory) ?? [])
    .find((worktree) => normalizePath(worktree.path) === normalizedDirectory);
  const mappedBranch = metadata?.branch?.trim();
  if (mappedBranch) return mappedBranch;

  throw new Error('Unable to determine the current branch');
};

// Scans every child store instead of the source directory's: a session's live
// status can be reported by a directory other than the one that wins the
// directory dedup, and a directory-scoped read would then see no status at all
// and move a running session.
const assertSessionsIdle = (sessions: Session[]): void => {
  for (const session of sessions) {
    const activity = getSessionLiveActivity(session.id);
    if (activity === 'unknown') throw new Error('Session status is unavailable');
    if (activity === 'active') throw new Error('Session is not idle');
  }
};

type RollbackFailure = {
  sessionId: string;
  error: Error;
};

/** Rollback left sessions in the destination. `changesMayBeInDestination` says
 *  the same failure also carried the working tree changes with an unknown
 *  outcome, so the toast must keep that guidance instead of dropping it. */
class IncompleteRollbackError extends Error {
  readonly changesMayBeInDestination: boolean;

  constructor(message: string, cause: unknown, changesMayBeInDestination: boolean) {
    super(message, { cause });
    this.name = 'IncompleteRollbackError';
    this.changesMayBeInDestination = changesMayBeInDestination;
  }
}

const createIncompleteRollbackError = (
  moveError: Error,
  rollbackFailures: RollbackFailure[],
  changesMayBeInDestination: boolean,
): Error => {
  const rollbackSummary = rollbackFailures
    .map(({ sessionId, error }) => `${sessionId}: ${error.message}`)
    .join(', ');
  return new IncompleteRollbackError(
    `Session move partially failed and could not be fully rolled back: ${moveError.message}. Rollback failures: ${rollbackSummary}`,
    { moveError, rollbackFailures },
    changesMayBeInDestination,
  );
};

const rollbackMovedSessions = async (
  sessions: Session[],
  sourceDirectory: string,
  worktreeDirectory: string,
  previousMetadata: ReadonlyMap<string, WorktreeMetadata | undefined>,
): Promise<RollbackFailure[]> => {
  const failures: RollbackFailure[] = [];
  for (const session of [...sessions].reverse()) {
    if (isSessionBusyNow(session.id)) {
      failures.push({ sessionId: session.id, error: new Error('Session is not idle') });
      continue;
    }
    try {
      await moveSessionToDirectory(
        session,
        worktreeDirectory,
        sourceDirectory,
        false,
      );
      useSessionUIStore.getState().setWorktreeMetadata(session.id, previousMetadata.get(session.id) ?? null);
    } catch (error) {
      failures.push({
        sessionId: session.id,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  return failures;
};

/** The move failed after the change-carrying request was already dispatched, so
 *  the user's changes may already be in the destination. A freshly created
 *  worktree is kept rather than deleted, because it may hold the only copy. */
class ChangesMayBeInDestinationError extends Error {
  constructor(moveError: Error) {
    super(moveError.message, { cause: moveError });
    this.name = 'ChangesMayBeInDestinationError';
  }
}

const removeFailedWorktree = async (
  project: ProjectRef,
  worktree: WorktreeMetadata,
  moveError: Error,
): Promise<never> => {
  try {
    await removeProjectWorktree(project, worktree, { deleteLocalBranch: true });
  } catch {
    throw new Error(`Session move failed and the new worktree could not be removed: ${moveError.message}`);
  }
  throw moveError;
};

const refreshMovedDirectories = async (sourceDirectory: string, destinationDirectory: string | undefined): Promise<void> => {
  const directories = destinationDirectory ? [sourceDirectory, destinationDirectory] : [sourceDirectory];
  try {
    await refreshGlobalSessionsForDirectories(directories);
  } catch (error) {
    // Direct action updates already reconciled both stores. Keep the outcome
    // unchanged if this best-effort authoritative refresh is unavailable.
    console.warn('[session-worktree-move] Failed to refresh moved sessions', error);
  }
};

const moveSessionTreeTransaction = async (
  input: {
    root: Session;
    descendants: Session[];
    sourceDirectory: string;
    moveChanges: boolean;
  },
  prepareDestination: () => Promise<{
    directory: string;
    metadata: WorktreeMetadata;
    onMoveFailure?: (error: Error) => Promise<never>;
  }>,
): Promise<string> => {
  if (useSessionMoveState.getState().pendingSessionIds.has(input.root.id)) {
    throw new Error('Session move already in progress');
  }
  setSessionMovePending(input.root.id, true);

  try {
    const sessions = [...input.descendants, input.root];
    const previousMetadata = new Map(
      sessions.map((session) => [
        session.id,
        useSessionUIStore.getState().getWorktreeMetadata(session.id),
      ]),
    );
    assertSessionsIdle(sessions);

    let destination: Awaited<ReturnType<typeof prepareDestination>> | null = null;
    const moved: Session[] = [];
    let changesMoveOutcomeUnknown = false;
    try {
      destination = await prepareDestination();
      for (const [index, session] of sessions.entries()) {
        // Setup and earlier moves can take long enough for a not-yet-moved
        // session to start running, so re-check the remaining source tree
        // immediately before each move. The root moves last so no later
        // descendant failure can require replaying a transferred patch.
        assertSessionsIdle(sessions.slice(index));
        const movesChanges = session.id === input.root.id && input.moveChanges;
        try {
          await moveSessionToDirectory(session, input.sourceDirectory, destination.directory, movesChanges);
        } catch (error) {
          // A transport failure on the change-carrying request leaves the
          // destination unknown: the server may have applied the patch before
          // the response was lost. Definite rejections (the destination refused
          // the patch) keep this false.
          if (movesChanges && isAmbiguousSendFailure(error)) changesMoveOutcomeUnknown = true;
          throw error;
        }
        moved.push(session);
        if (session.id === input.root.id) continue;
        useSessionUIStore.getState().setWorktreeMetadata(session.id, getLatestWorktreeMetadata(destination.metadata));
      }
    } catch (error) {
      const moveError = error instanceof Error ? error : new Error(String(error));
      const rollbackFailures = await rollbackMovedSessions(
        moved,
        input.sourceDirectory,
        destination?.directory ?? input.sourceDirectory,
        previousMetadata,
      );
      if (changesMoveOutcomeUnknown) {
        // The move request may have completed server-side, so the session's
        // directory is unknown too. Reconcile both directories now instead of
        // letting the sidebar contradict the toast until the next poll.
        await refreshMovedDirectories(input.sourceDirectory, destination?.directory);
      }
      if (rollbackFailures.length > 0) {
        throw createIncompleteRollbackError(moveError, rollbackFailures, changesMoveOutcomeUnknown);
      }
      // Checked before `onMoveFailure` so the quick path's worktree removal
      // never runs while the user's changes may be sitting in it. Both intent
      // kinds share the messaging.
      if (changesMoveOutcomeUnknown) throw new ChangesMayBeInDestinationError(moveError);
      if (destination?.onMoveFailure) {
        return destination.onMoveFailure(moveError);
      }
      throw moveError;
    }
    useSessionUIStore.getState().setWorktreeMetadata(input.root.id, getLatestWorktreeMetadata(destination.metadata));

    await refreshMovedDirectories(input.sourceDirectory, destination.directory);
    return destination.directory;
  } finally {
    setSessionMovePending(input.root.id, false);
  }
};

export const moveSessionTreeToExistingWorktree = async (input: {
  root: Session;
  descendants: Session[];
  sourceDirectory: string;
  destination: WorktreeMetadata;
  moveChanges: boolean;
}): Promise<string> => {
  const normalizedSourceDirectory = normalizePath(input.sourceDirectory) ?? input.sourceDirectory;
  const normalizedDestinationDirectory = normalizePath(input.destination.path) ?? input.destination.path;
  if (normalizedSourceDirectory === normalizedDestinationDirectory) {
    throw new Error('Source and destination are the same');
  }
  if (input.destination.worktreeStatus !== 'ready') {
    throw new Error('Destination worktree is not ready');
  }

  return moveSessionTreeTransaction(input, async () => ({
    directory: input.destination.path,
    metadata: input.destination,
  }));
};

const moveSessionTreeToQuickWorktree = async (input: {
  root: Session;
  descendants: Session[];
  sourceDirectory: string;
  moveChanges: boolean;
}): Promise<string> => {
  return moveSessionTreeTransaction(input, async () => {
    const project = resolveProjectRef(input.sourceDirectory);
    if (!project) throw new Error('Unable to find the project for this session');

    const sourceBranch = await checkIsGitRepository(input.sourceDirectory)
      ? await resolveSourceBranch(input.sourceDirectory, project.path)
      : null;
    const worktree = await createQuickWorktree(project, sourceBranch ? { startRef: sourceBranch } : {});
    try {
      await waitForWorktreeGitReady(worktree.path);
    } catch (error) {
      const setupError = error instanceof Error ? error : new Error(String(error));
      return removeFailedWorktree(project, worktree, setupError);
    }
    return {
      directory: worktree.path,
      metadata: worktree,
      // removeFailedWorktree force-deletes the worktree and its branch. The
      // transaction skips this callback when the change transfer's outcome is
      // unknown, so the worktree survives whenever it may hold the only copy.
      onMoveFailure: async (error) => removeFailedWorktree(project, worktree, error),
    };
  });
};

const describeMoveFailure = (
  messages: SessionTreeMoveMessages,
  failure: Error,
  moveChanges: boolean,
): string => {
  if (failure instanceof ChangesMayBeInDestinationError) return messages.changesMayBeInDestination;
  if (failure instanceof IncompleteRollbackError && failure.changesMayBeInDestination) {
    return `${failure.message} ${messages.changesMayBeInDestination}`;
  }
  if (moveChanges && isApplyChangesError(failure)) return messages.applyChangesFailed;
  return failure.message;
};

const executeSessionTreeMove = (intent: SessionTreeMoveIntent, moveChanges: boolean): void => {
  const movePromise = intent.kind === 'existing'
    ? moveSessionTreeToExistingWorktree({
        root: intent.root,
        descendants: intent.descendants,
        sourceDirectory: intent.sourceDirectory,
        destination: intent.destination,
        moveChanges,
      })
    : moveSessionTreeToQuickWorktree({
        root: intent.root,
        descendants: intent.descendants,
        sourceDirectory: intent.sourceDirectory,
        moveChanges,
      });

  void movePromise
    .then(() => toast.success(intent.messages.success))
    .catch((error) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      toast.error(intent.messages.failure, {
        description: describeMoveFailure(intent.messages, failure, moveChanges),
      });
    });
};

export const cancelSessionTreeMove = (): void => {
  const confirmation = getSessionTreeMoveConfirmation();
  if (!confirmation) return;
  setSessionMoveRequesting(confirmation.intent.root.id, false);
  setSessionMoveConfirmation(null);
};

export const confirmSessionTreeMove = (moveChanges: boolean): void => {
  const confirmation = getSessionTreeMoveConfirmation();
  if (!confirmation) return;
  const { intent } = confirmation;
  setSessionMoveConfirmation(null);
  setSessionMoveRequesting(intent.root.id, false);
  executeSessionTreeMove(intent, moveChanges);
};

export const requestSessionTreeMove = (intent: SessionTreeMoveIntent): void => {
  const state = useSessionMoveState.getState();
  if (state.confirmation) return;
  if (state.pendingSessionIds.has(intent.root.id) || state.requestingSessionIds.has(intent.root.id)) return;

  setSessionMoveRequesting(intent.root.id, true);

  void (async () => {
    try {
      const isGitRepository = await checkIsGitRepository(intent.sourceDirectory);
      if (!isGitRepository) {
        setSessionMoveRequesting(intent.root.id, false);
        executeSessionTreeMove(intent, false);
        return;
      }

      const status = await getGitStatus(intent.sourceDirectory);
      if (status.isClean) {
        setSessionMoveRequesting(intent.root.id, false);
        executeSessionTreeMove(intent, false);
        return;
      }

      const stagedFileCount = status.files.filter((file) => {
        const indexStatus = file.index.trim();
        return indexStatus !== '' && indexStatus !== '?';
      }).length;
      setSessionMoveConfirmation({
        intent,
        dirtyFileCount: status.files.length,
        stagedFileCount,
      });
    } catch {
      toast.error(intent.messages.failure, {
        description: intent.messages.sourceVerificationFailed,
      });
      setSessionMoveRequesting(intent.root.id, false);
    }
  })();
};
