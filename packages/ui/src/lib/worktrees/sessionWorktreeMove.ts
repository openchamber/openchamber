import type { Session } from '@/lib/opencode/model';
import type { I18nKey } from '@/lib/i18n';
import { toast } from '@/components/ui';
import { checkIsGitRepository, getGitStatus, setGitWorktreeTitle } from '@/lib/gitApi';
import { carriedWorkTitleOwner } from '@/lib/sessionWorkTitle';
import { normalizePath } from '@/lib/pathNormalization';
import { createQuickWorktree, resolveFolderProjectRef, resolveProjectRef } from '@/lib/worktreeSessionCreator';
import { getLatestWorktreeMetadata, removeProjectWorktree, type ProjectRef } from '@/lib/worktrees/worktreeManager';
import { checkoutHoldsDirectory, findWorktreeHoldingDirectory } from '@/lib/worktrees/worktreePaths';
import { resolveWorktreeStartDirectory } from '@/lib/worktrees/worktreeStartDirectory';
import { refreshGlobalSessionsForDirectories } from '@/stores/useGlobalSessionsStore';
import { isAmbiguousSendFailure } from '@/sync/send-failure-classification';
import { isSessionBusyNow, moveSessionToDirectory, readSessionsLiveActivity } from '@/sync/session-actions';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { WorktreeMetadata } from '@/types/worktree';
import { waitForWorktreeGitReady } from '@/lib/worktrees/worktreeBootstrap';
import { moveSessionsThenRemoveWorktree, WorktreeKeepStoppedError, type WorktreeKeepStop } from '@/lib/worktrees/worktreeRemovalFlow';
import { captureRuntimeInstance } from '@/lib/runtime-switch';
import { opencodeClient } from '@/lib/opencode/client';
import { create } from 'zustand';

export type SessionTreeMoveMessages = {
  success: string;
  failure: string;
  /** Description under the failure toast when the answer was lost and the new worktree was kept. */
  outcomeUnknown: string;
};

export const buildSessionTreeMoveMessages = (
  t: (key: I18nKey) => string,
  keys: { success: I18nKey; failure: I18nKey },
): SessionTreeMoveMessages => ({
  success: t(keys.success),
  failure: t(keys.failure),
  outcomeUnknown: t('sessions.sidebar.session.moveToWorktree.outcomeUnknown'),
});

/** The move request lost its answer, so the session may already be in the destination; what it left behind stays. */
export class SessionMoveOutcomeUnknownError extends Error {
  constructor(cause: Error) {
    super(cause.message, { cause });
    this.name = 'SessionMoveOutcomeUnknownError';
  }
}

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
    }
  | {
      // The conversation moves to a folder the user picked, usually a
      // project's root; files the session wrote stay where they are.
      kind: 'project';
      root: Session;
      descendants: Session[];
      sourceDirectory: string;
      projectDirectory: string;
      messages: SessionTreeMoveMessages;
    };

// OpenCode 2.x `session.move` relocates the session only; uncommitted changes
// stay in the source worktree. v1 could carry them along and asked the user
// which to do, so this module once held a confirmation step. There is nothing
// to choose now, and a move starts as soon as it is requested.
type SessionMoveState = {
  pendingSessionIds: Set<string>;
};

const useSessionMoveState = create<SessionMoveState>(() => ({
  pendingSessionIds: new Set(),
}));

export const useIsSessionWorktreeMovePending = (sessionId: string): boolean =>
  useSessionMoveState((state) => state.pendingSessionIds.has(sessionId));

const setSessionMovePending = (sessionId: string, pending: boolean): void => {
  useSessionMoveState.setState((state) => {
    if (state.pendingSessionIds.has(sessionId) === pending) return state;
    const pendingSessionIds = new Set(state.pendingSessionIds);
    if (pending) pendingSessionIds.add(sessionId);
    else pendingSessionIds.delete(sessionId);
    return { ...state, pendingSessionIds };
  });
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
  const metadata = findWorktreeHoldingDirectory(
    worktrees.get(normalizedProjectDirectory) ?? worktrees.get(projectDirectory) ?? [],
    normalizedDirectory ?? directory,
  );
  const mappedBranch = metadata?.branch?.trim();
  if (mappedBranch) return mappedBranch;

  throw new Error('Unable to determine the current branch');
};

// A session's live status can be reported by a directory other than the one
// that wins the directory dedup, so the answer covers every child store. The
// source directory only picks the server asked when no store knows: the host,
// or the isolated space that holds it.
const assertSessionsIdle = async (sessions: Session[], sourceDirectory: string): Promise<void> => {
  const activity = await readSessionsLiveActivity(sessions.map((session) => session.id), sourceDirectory);
  if (activity === 'unknown') throw new Error('Session status is unavailable');
  if (activity === 'active') throw new Error('Session is not idle');
};

type RollbackFailure = {
  sessionId: string;
  error: Error;
};

/** Rollback left sessions in the destination; the toast names them. */
class IncompleteRollbackError extends Error {
  readonly moveError: Error;

  constructor(message: string, cause: { moveError: Error; rollbackFailures: RollbackFailure[] }) {
    super(message, { cause });
    this.name = 'IncompleteRollbackError';
    this.moveError = cause.moveError;
  }
}

const createIncompleteRollbackError = (moveError: Error, rollbackFailures: RollbackFailure[]): Error => {
  const rollbackSummary = rollbackFailures
    .map(({ sessionId, error }) => `${sessionId}: ${error.message}`)
    .join(', ');
  return new IncompleteRollbackError(
    `Session move partially failed and could not be fully rolled back: ${moveError.message}. Rollback failures: ${rollbackSummary}`,
    { moveError, rollbackFailures },
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
      await moveSessionToDirectory(session, worktreeDirectory, sourceDirectory);
      useSessionUIStore.getState().setWorktreeMetadata(session.id, previousMetadata.get(session.id) ?? null, sourceDirectory);
    } catch (error) {
      failures.push({
        sessionId: session.id,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  return failures;
};

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
  },
  prepareDestination: () => Promise<{
    directory: string;
    /** Null for a project root, which is not a worktree. */
    metadata: WorktreeMetadata | null;
    onMoveFailure?: (error: Error) => Promise<never>;
  }>,
  assertIdle: (sessions: Session[]) => Promise<void> = (sessions) => assertSessionsIdle(sessions, input.sourceDirectory),
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
    await assertIdle(sessions);

    let destination: Awaited<ReturnType<typeof prepareDestination>> | null = null;
    const moved: Session[] = [];
    let moveOutcomeUnknown = false;
    try {
      destination = await prepareDestination();
      for (const [index, session] of sessions.entries()) {
        // Setup and earlier moves can take long enough for a not-yet-moved
        // session to start running, so re-check the remaining source tree
        // immediately before each move. The root moves last.
        await assertIdle(sessions.slice(index));
        try {
          await moveSessionToDirectory(session, input.sourceDirectory, destination.directory);
        } catch (error) {
          // A transport failure leaves the outcome unknown: the server may have
          // moved the session before the response was lost. Definite rejections
          // keep this false.
          if (isAmbiguousSendFailure(error)) moveOutcomeUnknown = true;
          throw error;
        }
        moved.push(session);
        if (session.id === input.root.id) continue;
        useSessionUIStore.getState().setWorktreeMetadata(session.id, destination.metadata ? getLatestWorktreeMetadata(destination.metadata) : null, destination.directory);
      }
    } catch (error) {
      const moveError = error instanceof Error ? error : new Error(String(error));
      const rollbackFailures = await rollbackMovedSessions(
        moved,
        input.sourceDirectory,
        destination?.directory ?? input.sourceDirectory,
        previousMetadata,
      );
      if (moveOutcomeUnknown) {
        // The move request may have completed server-side, so the session's
        // directory is unknown too. Reconcile both directories now instead of
        // letting the sidebar contradict the toast until the next poll.
        await refreshMovedDirectories(input.sourceDirectory, destination?.directory);
      }
      if (rollbackFailures.length > 0) {
        throw createIncompleteRollbackError(moveError, rollbackFailures);
      }
      // OpenCode admits a move durably before it answers, so a lost response
      // does not cancel it: the session may already sit in the destination or
      // land there once the inbox drains. Only a definite rejection proves the
      // destination is unused and safe to delete.
      if (destination?.onMoveFailure && !moveOutcomeUnknown) {
        return destination.onMoveFailure(moveError);
      }
      if (destination?.onMoveFailure && moveOutcomeUnknown) {
        throw new SessionMoveOutcomeUnknownError(moveError);
      }
      throw moveError;
    }
    useSessionUIStore.getState().setWorktreeMetadata(input.root.id, destination.metadata ? getLatestWorktreeMetadata(destination.metadata) : null, destination.directory);

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
}): Promise<string> => {
  const normalizedSourceDirectory = normalizePath(input.sourceDirectory) ?? input.sourceDirectory;
  const normalizedDestinationDirectory = normalizePath(input.destination.path) ?? input.destination.path;
  if (checkoutHoldsDirectory(normalizedDestinationDirectory, normalizedSourceDirectory)) {
    throw new Error('Source and destination are the same');
  }
  if (input.destination.worktreeStatus !== 'ready') {
    throw new Error('Destination worktree is not ready');
  }

  return moveSessionTreeTransaction(input, async () => {
    // The project of the session being moved decides the folder, as the server does;
    // the destination worktree can be shared by several projects of one repository.
    const project = await resolveFolderProjectRef(input.sourceDirectory);
    return {
      directory: project ? await resolveWorktreeStartDirectory(project, input.destination.path) : input.destination.path,
      metadata: input.destination,
    };
  });
};

const moveSessionTreeToProject = async (input: {
  root: Session;
  descendants: Session[];
  sourceDirectory: string;
  projectDirectory: string;
}): Promise<string> => {
  if ((normalizePath(input.sourceDirectory) ?? input.sourceDirectory) === (normalizePath(input.projectDirectory) ?? input.projectDirectory)) {
    throw new Error('Source and destination are the same');
  }
  return moveSessionTreeTransaction(input, async () => ({ directory: input.projectDirectory, metadata: null }));
};

// The tree move's own check, with the reason the delete's toast names: a
// session the server reports running stops it as busy, a status nobody can
// read as unknown.
const assertSessionsIdleToKeep = (sourceDirectory: string) => async (sessions: Session[]): Promise<void> => {
  const activity = await readSessionsLiveActivity(sessions.map((session) => session.id), sourceDirectory);
  if (activity === 'unknown') throw new WorktreeKeepStoppedError('unknown');
  if (activity === 'active') throw new WorktreeKeepStoppedError('busy');
};

const MOVE_CONFIRM_TIMEOUT_MS = 10_000;
const MOVE_CONFIRM_POLL_MS = 200;

// OpenCode answers `session.move` once the move is queued in the session's
// inbox; a runner of the source folder applies it right after. A session read
// is the server's own answer to where the session is now. A failed read counts
// as not moved yet, so only a confirmed placement lets the folder go.
const waitUntilSessionsMoved = async (
  targets: readonly { sessionId: string; directory: string }[],
  timeoutMs = MOVE_CONFIRM_TIMEOUT_MS,
): Promise<boolean> => {
  const startedAt = Date.now();
  let pending = [...targets];
  while (pending.length > 0) {
    const reads = await Promise.all(pending.map(async (target) => {
      try {
        // Read through the destination, which belongs to the session's server;
        // without a folder the read goes to the folder on screen, which can be
        // an isolated space that does not know the session.
        const session = await opencodeClient.getSession(target.sessionId, target.directory);
        return normalizePath(session.directory) === normalizePath(target.directory);
      } catch {
        return false;
      }
    }));
    pending = pending.filter((_, index) => !reads[index]);
    if (pending.length === 0) return true;
    if (Date.now() - startedAt >= timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, MOVE_CONFIRM_POLL_MS));
  }
  return true;
};

/**
 * Deletes a worktree and keeps its sessions: each tree moves to the project
 * its folder belongs to (the worktree's own project when that folder's project
 * sits inside the checkout), with the tree move a chat takes into a project,
 * then the worktree is removed. `moveSessionsThenRemoveWorktree` has the order
 * and the failure rules.
 */
export const moveWorktreeSessionsThenRemove = (input: {
  worktreePath: string;
  /** The worktree's project folder. */
  projectDirectory: string;
  /** The active sessions working in the worktree now, its subfolders included. */
  readSessions: () => readonly Session[];
  removeWorktree: () => Promise<boolean>;
}): Promise<{ removed: boolean }> => {
  const worktreePath = normalizePath(input.worktreePath) ?? input.worktreePath;
  return moveSessionsThenRemoveWorktree({
    worktreePath,
    readSessions: input.readSessions,
    readActivity: (sessions) => readSessionsLiveActivity(sessions.map((session) => session.id), worktreePath),
    resolveDestination: async (directory) => {
      const projectPath = normalizePath((await resolveFolderProjectRef(directory))?.path ?? null);
      return projectPath && !checkoutHoldsDirectory(worktreePath, projectPath) ? projectPath : input.projectDirectory;
    },
    moveTree: async (tree) => {
      try {
        await moveSessionTreeTransaction(
          tree,
          async () => ({ directory: tree.projectDirectory, metadata: null }),
          assertSessionsIdleToKeep(tree.sourceDirectory),
        );
      } catch (error) {
        // A rollback that failed too wraps the move's own error.
        const moveError = error instanceof IncompleteRollbackError ? error.moveError : error;
        if (moveError instanceof Error && isAmbiguousSendFailure(moveError)) throw new SessionMoveOutcomeUnknownError(moveError);
        throw error;
      }
    },
    confirmMoves: (moves) => waitUntilSessionsMoved(moves.flatMap((move) => [move.root, ...move.descendants]
      .map((session) => ({ sessionId: session.id, directory: move.projectDirectory })))),
    removeWorktree: input.removeWorktree,
    isCurrent: captureRuntimeInstance(),
  });
};

const KEEP_STOP_KEYS = {
  busy: 'sessions.sidebar.work.archive.keptRunning',
  unknown: 'sessions.sidebar.work.archive.keptUnknown',
  added: 'sessions.sidebar.dialogs.worktreeDelete.keepAdded',
  unconfirmed: 'sessions.sidebar.dialogs.worktreeDelete.keepUnconfirmed',
  switched: 'sessions.sidebar.dialogs.worktreeDelete.keepSwitched',
} satisfies Record<WorktreeKeepStop, I18nKey>;

/** What to tell the user when keeping a worktree's sessions stopped; null for an error that explains itself. */
export const describeWorktreeKeepError = (error: Error, t: (key: I18nKey) => string): string | null => {
  if (error instanceof WorktreeKeepStoppedError) return t(KEEP_STOP_KEYS[error.reason]);
  if (error instanceof SessionMoveOutcomeUnknownError) return t('sessions.sidebar.dialogs.worktreeDelete.keepOutcomeUnknown');
  return null;
};

const moveSessionTreeToQuickWorktree = async (input: {
  root: Session;
  descendants: Session[];
  sourceDirectory: string;
}): Promise<string> => {
  const directory = await moveSessionTreeTransaction(input, async () => {
    const project = resolveProjectRef(input.sourceDirectory);
    if (!project) throw new Error('Unable to find the project for this session');

    const sourceBranch = await checkIsGitRepository(input.sourceDirectory)
      ? await resolveSourceBranch(input.sourceDirectory, project.path)
      : null;
    const worktree = await createQuickWorktree(project, sourceBranch ? { startRef: sourceBranch } : {});
    if (!worktree) throw new Error('Worktree creation cancelled');
    try {
      await waitForWorktreeGitReady(worktree.path);
    } catch (error) {
      const setupError = error instanceof Error ? error : new Error(String(error));
      return removeFailedWorktree(project, worktree, setupError);
    }
    // The worktree belongs to the project that owns the list; the session keeps its own project's folder.
    const folderProject = await resolveFolderProjectRef(input.sourceDirectory) ?? project;
    return {
      directory: await resolveWorktreeStartDirectory(folderProject, worktree.path),
      metadata: worktree,
      // removeFailedWorktree force-deletes the worktree and its branch; the
      // session's files never move, so nothing of the user's is in it yet.
      // Called only for a definite rejection; the transaction keeps the
      // worktree when the move outcome is unknown.
      onMoveFailure: async (error) => removeFailedWorktree(project, worktree, error),
    };
  });
  // Seed from the current session title. Generated titles stay agent-owned so
  // work.name can replace them; an explicit user title keeps its ownership.
  const taskTitle = input.root.title?.trim();
  if (taskTitle) {
    await setGitWorktreeTitle(directory, taskTitle, carriedWorkTitleOwner(input.root.metadata)).catch((error) => {
      console.warn('[session-worktree-move] Failed to carry the task name into the new worktree', error);
    });
  }
  return directory;
};

const executeSessionTreeMove = (intent: SessionTreeMoveIntent): void => {
  const movePromise = intent.kind === 'existing'
    ? moveSessionTreeToExistingWorktree({
        root: intent.root,
        descendants: intent.descendants,
        sourceDirectory: intent.sourceDirectory,
        destination: intent.destination,
      })
    : intent.kind === 'project'
    ? moveSessionTreeToProject({
        root: intent.root,
        descendants: intent.descendants,
        sourceDirectory: intent.sourceDirectory,
        projectDirectory: intent.projectDirectory,
      })
    : moveSessionTreeToQuickWorktree({
        root: intent.root,
        descendants: intent.descendants,
        sourceDirectory: intent.sourceDirectory,
      });

  void movePromise
    .then(() => toast.success(intent.messages.success))
    .catch((error) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      toast.error(intent.messages.failure, {
        description: failure instanceof SessionMoveOutcomeUnknownError ? intent.messages.outcomeUnknown : failure.message,
      });
    });
};

export const requestSessionTreeMove = (intent: SessionTreeMoveIntent): void => {
  if (useSessionMoveState.getState().pendingSessionIds.has(intent.root.id)) return;
  executeSessionTreeMove(intent);
};
