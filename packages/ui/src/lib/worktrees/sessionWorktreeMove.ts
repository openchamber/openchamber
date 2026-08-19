import type { Session } from '@opencode-ai/sdk/v2';
import { toast } from '@/components/ui';
import { getGitStatus } from '@/lib/gitApi';
import { normalizePath } from '@/lib/pathNormalization';
import { createQuickWorktree, resolveProjectRef } from '@/lib/worktreeSessionCreator';
import { getLatestWorktreeMetadata, removeProjectWorktree, type ProjectRef } from '@/lib/worktrees/worktreeManager';
import { refreshGlobalSessionsForDirectories } from '@/stores/useGlobalSessionsStore';
import { moveSessionToDirectory } from '@/sync/session-actions';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getDirectoryState } from '@/sync/sync-refs';
import type { WorktreeMetadata } from '@/types/worktree';
import { waitForWorktreeGitReady } from '@/lib/worktrees/worktreeBootstrap';
import { create } from 'zustand';

const useSessionMoveState = create<{ pendingSessionIds: Set<string> }>(() => ({
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
    return { pendingSessionIds };
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
  const metadata = (worktrees.get(normalizedProjectDirectory) ?? worktrees.get(projectDirectory) ?? [])
    .find((worktree) => normalizePath(worktree.path) === normalizedDirectory);
  const mappedBranch = metadata?.branch?.trim();
  if (mappedBranch) return mappedBranch;

  throw new Error('Unable to determine the current branch');
};

const assertSessionsIdle = (sessions: Session[], sourceDirectory: string): void => {
  const directoryState = getDirectoryState(sourceDirectory);
  if (!directoryState) throw new Error('Session status is unavailable');

  const statuses = directoryState.session_status;
  const hasActiveSession = sessions.some((session) => {
    const status = statuses[session.id]?.type;
    return status === 'busy' || status === 'retry';
  });
  if (hasActiveSession) throw new Error('Session is not idle');
};

type RollbackFailure = {
  sessionId: string;
  error: Error;
};

const createIncompleteRollbackError = (moveError: Error, rollbackFailures: RollbackFailure[]): Error => {
  const rollbackSummary = rollbackFailures
    .map(({ sessionId, error }) => `${sessionId}: ${error.message}`)
    .join(', ');
  return new Error(
    `Session move partially failed and could not be fully rolled back: ${moveError.message}. Rollback failures: ${rollbackSummary}`,
    { cause: { moveError, rollbackFailures } },
  );
};

const isSessionBusyOrRetrying = (session: Session, directory: string): boolean => {
  const status = getDirectoryState(directory)?.session_status[session.id]?.type;
  return status === 'busy' || status === 'retry';
};

const rollbackMovedSessions = async (
  sessions: Session[],
  rootSessionId: string,
  sourceDirectory: string,
  worktreeDirectory: string,
  previousMetadata: ReadonlyMap<string, WorktreeMetadata | undefined>,
): Promise<RollbackFailure[]> => {
  const failures: RollbackFailure[] = [];
  for (const session of [...sessions].reverse()) {
    if (isSessionBusyOrRetrying(session, worktreeDirectory)) {
      failures.push({ sessionId: session.id, error: new Error('Session is not idle') });
      continue;
    }
    try {
      await moveSessionToDirectory(
        session,
        worktreeDirectory,
        sourceDirectory,
        session.id === rootSessionId,
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

const moveSessionTreeTransaction = async (
  input: {
    root: Session;
    descendants: Session[];
    sourceDirectory: string;
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
    const sessions = [input.root, ...input.descendants];
    const previousMetadata = new Map(
      sessions.map((session) => [
        session.id,
        useSessionUIStore.getState().getWorktreeMetadata(session.id),
      ]),
    );
    assertSessionsIdle(sessions, input.sourceDirectory);

    let destination: Awaited<ReturnType<typeof prepareDestination>> | null = null;
    const moved: Session[] = [];
    try {
      destination = await prepareDestination();
      // Setup can take long enough for one of the sessions to start running, so
      // verify the whole tree again immediately before the first move.
      assertSessionsIdle(sessions, input.sourceDirectory);
      for (const [index, session] of sessions.entries()) {
        // Transfer the checkout changes once with the root. Descendants only
        // need their execution location updated.
        await moveSessionToDirectory(session, input.sourceDirectory, destination.directory, index === 0);
        moved.push(session);
        useSessionUIStore.getState().setWorktreeMetadata(session.id, getLatestWorktreeMetadata(destination.metadata));
      }
    } catch (error) {
      const moveError = error instanceof Error ? error : new Error(String(error));
      const rollbackFailures = await rollbackMovedSessions(
        moved,
        input.root.id,
        input.sourceDirectory,
        destination?.directory ?? input.sourceDirectory,
        previousMetadata,
      );
      if (rollbackFailures.length > 0) {
        throw createIncompleteRollbackError(moveError, rollbackFailures);
      }
      if (destination?.onMoveFailure) {
        return destination.onMoveFailure(moveError);
      }
      throw moveError;
    }

    try {
      await refreshGlobalSessionsForDirectories([input.sourceDirectory, destination.directory]);
    } catch (error) {
      // Direct action updates already reconciled both stores. Keep the move
      // successful if this best-effort authoritative refresh is unavailable.
      console.warn('[session-worktree-move] Failed to refresh moved sessions', error);
    }
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
}): Promise<string> => {
  return moveSessionTreeTransaction(input, async () => {
    const project = resolveProjectRef(input.sourceDirectory);
    if (!project) throw new Error('Unable to find the project for this session');

    const sourceBranch = await resolveSourceBranch(input.sourceDirectory, project.path);
    const worktree = await createQuickWorktree(project, { startRef: sourceBranch });
    try {
      await waitForWorktreeGitReady(worktree.path);
    } catch (error) {
      const setupError = error instanceof Error ? error : new Error(String(error));
      return removeFailedWorktree(project, worktree, setupError);
    }
    return {
      directory: worktree.path,
      metadata: worktree,
      onMoveFailure: (error) => removeFailedWorktree(project, worktree, error),
    };
  });
};

export const startSessionTreeExistingWorktreeMove = (input: {
  root: Session;
  descendants: Session[];
  sourceDirectory: string;
  destination: WorktreeMetadata;
  successMessage: string;
  failureMessage: string;
}): void => {
  void moveSessionTreeToExistingWorktree(input)
    .then(() => toast.success(input.successMessage))
    .catch((error) => toast.error(input.failureMessage, {
      description: error instanceof Error ? error.message : String(error),
    }));
};

export const startSessionTreeWorktreeMove = (input: {
  root: Session;
  descendants: Session[];
  sourceDirectory: string;
  successMessage: string;
  failureMessage: string;
}): void => {
  void moveSessionTreeToQuickWorktree(input)
    .then(() => toast.success(input.successMessage))
    .catch((error) => toast.error(input.failureMessage, {
      description: error instanceof Error ? error.message : String(error),
    }));
};
