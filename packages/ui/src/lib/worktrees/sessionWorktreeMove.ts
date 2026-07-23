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

const rollbackMovedSessions = async (
  sessions: Session[],
  rootSessionId: string,
  sourceDirectory: string,
  worktreeDirectory: string,
  previousMetadata: ReadonlyMap<string, WorktreeMetadata | undefined>,
): Promise<unknown[]> => {
  const failures: unknown[] = [];
  for (const session of [...sessions].reverse()) {
    try {
      await moveSessionToDirectory(
        session,
        worktreeDirectory,
        sourceDirectory,
        session.id === rootSessionId,
      );
      useSessionUIStore.getState().setWorktreeMetadata(session.id, previousMetadata.get(session.id) ?? null);
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
};

const removeFailedWorktree = async (
  project: ProjectRef,
  worktree: WorktreeMetadata,
  moveError: unknown,
): Promise<never> => {
  try {
    await removeProjectWorktree(project, worktree, { deleteLocalBranch: true });
  } catch {
    const message = moveError instanceof Error ? moveError.message : String(moveError);
    throw new Error(`Session move failed and the new worktree could not be removed: ${message}`);
  }
  throw moveError;
};

const moveSessionTreeToQuickWorktree = async (input: {
  root: Session;
  descendants: Session[];
  sourceDirectory: string;
}): Promise<string> => {
  if (useSessionMoveState.getState().pendingSessionIds.has(input.root.id)) {
    throw new Error('Session move already in progress');
  }
  setSessionMovePending(input.root.id, true);

  try {
    const project = resolveProjectRef(input.sourceDirectory);
    if (!project) throw new Error('Unable to find the project for this session');

    const sessions = [input.root, ...input.descendants];
    const previousMetadata = new Map(
      sessions.map((session) => [
        session.id,
        useSessionUIStore.getState().getWorktreeMetadata(session.id),
      ]),
    );
    assertSessionsIdle(sessions, input.sourceDirectory);

    const sourceBranch = await resolveSourceBranch(input.sourceDirectory, project.path);
    const worktree = await createQuickWorktree(project, { startRef: sourceBranch });

    const moved: Session[] = [];
    try {
      await waitForWorktreeGitReady(worktree.path);
      // Branch/status discovery and worktree creation can take long enough for a
      // session to start running, so verify the whole tree again before moving.
      assertSessionsIdle(sessions, input.sourceDirectory);
      for (const [index, session] of sessions.entries()) {
        // Transfer the checkout changes once with the root. Descendants only
        // need their execution location updated.
        await moveSessionToDirectory(session, input.sourceDirectory, worktree.path, index === 0);
        moved.push(session);
        useSessionUIStore.getState().setWorktreeMetadata(session.id, getLatestWorktreeMetadata(worktree));
      }
    } catch (error) {
      const rollbackFailures = await rollbackMovedSessions(
        moved,
        input.root.id,
        input.sourceDirectory,
        worktree.path,
        previousMetadata,
      );
      if (rollbackFailures.length > 0) {
        throw new Error(`Session move partially failed and could not be fully rolled back: ${error instanceof Error ? error.message : String(error)}`);
      }
      return removeFailedWorktree(project, worktree, error);
    }

    try {
      await refreshGlobalSessionsForDirectories([input.sourceDirectory, worktree.path]);
    } catch (error) {
      // Direct action updates already reconciled both stores. Keep the move
      // successful if this best-effort authoritative refresh is unavailable.
      console.warn('[session-worktree-move] Failed to refresh moved sessions', error);
    }
    return worktree.path;
  } finally {
    setSessionMovePending(input.root.id, false);
  }
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
