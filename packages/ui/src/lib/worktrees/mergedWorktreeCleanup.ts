import type { Session } from '@/lib/opencode/model';
import { normalizePath } from '@/lib/pathNormalization';
import type { WorktreeMetadata } from '@/types/worktree';
import type { SourceControlProvider } from '@/lib/source-control/types';

/** A linked worktree whose branch's PR (GitHub) or merge request (GitLab) is reported merged. */
export type MergedWorktreeCandidate = {
  worktree: WorktreeMetadata;
  project: { id: string; path: string };
  prNumber: number;
  /** Where the change request lives; GitLab's toasts say merge request. */
  provider?: SourceControlProvider | null;
  /** Last commit of the merged PR; null when the status did not carry it. */
  mergedHeadSha: string | null;
};

export type MergedWorktreeDecision =
  /** Someone is still there: a running agent or the session on screen. Ask again later. */
  | { action: 'wait' }
  /** Nothing can be lost: archive the sessions, remove the worktree and its local branch. */
  | { action: 'remove' }
  /** Something exists only here (uncommitted work or commits after the merge): archive, keep the worktree. */
  | { action: 'archive-only' };

/**
 * The worktree is removable only when it holds nothing the merged PR does
 * not: no uncommitted changes, and its checkout sits exactly on the PR's last
 * commit. That second test is stronger than "pushed": GitHub often deletes
 * the remote branch on merge, while the PR keeps every one of those commits.
 */
export const decideMergedWorktreeCleanup = (input: {
  sessionsBusyOrUnknown: boolean;
  sessionOpen: boolean;
  isDirty: boolean | null;
  headCommit: string | null;
  mergedHeadSha: string | null;
}): MergedWorktreeDecision => {
  if (input.sessionsBusyOrUnknown || input.sessionOpen) return { action: 'wait' };
  const nothingToLose = input.isDirty === false
    && Boolean(input.headCommit)
    && Boolean(input.mergedHeadSha)
    && input.headCommit === input.mergedHeadSha;
  return nothingToLose ? { action: 'remove' } : { action: 'archive-only' };
};

/** Sessions working in the worktree, its subdirectories included. */
const sessionsInWorktree = (sessions: readonly Session[], worktreePath: string): Session[] => {
  const root = normalizePath(worktreePath);
  if (!root) return [];
  return sessions.filter((session) => {
    const directory = normalizePath(session.directory);
    return directory === root || Boolean(directory?.startsWith(`${root}/`));
  });
};

export type MergedWorktreeOutcome =
  | { kind: 'removed'; candidate: MergedWorktreeCandidate; archivedCount: number }
  | { kind: 'archived'; candidate: MergedWorktreeCandidate; archivedCount: number }
  | { kind: 'failed'; candidate: MergedWorktreeCandidate; error: Error };

export type MergedWorktreeCleanupDeps = {
  listCandidates: () => MergedWorktreeCandidate[];
  /** Done once per worktree and PR, so work continued in a kept worktree is never archived again. */
  isHandled: (candidate: MergedWorktreeCandidate) => boolean;
  markHandled: (candidate: MergedWorktreeCandidate) => void;
  getActiveSessions: () => readonly Session[];
  isSessionIdle: (sessionId: string) => boolean;
  isSessionOpen: (sessionId: string) => boolean;
  /** The worktree is the directory on screen, e.g. a new-session draft there. */
  isWorktreeOpen: (path: string) => boolean;
  readWorktreeState: (path: string) => Promise<{ isDirty: boolean | null; headCommit: string | null }>;
  archiveSessions: (sessionIds: string[]) => Promise<{ failedIds: string[] }>;
  removeWorktree: (candidate: MergedWorktreeCandidate) => Promise<void>;
  report: (outcome: MergedWorktreeOutcome) => void;
};

/**
 * One pass over the merged worktrees. Each is handled at most once; one
 * still in use is left for a later pass, and one failure never stops the
 * others.
 */
export async function runMergedWorktreeCleanup(deps: MergedWorktreeCleanupDeps): Promise<void> {
  for (const candidate of deps.listCandidates()) {
    if (deps.isHandled(candidate)) continue;
    const sessions = sessionsInWorktree(deps.getActiveSessions(), candidate.worktree.path);
    const sessionIds = sessions.map((session) => session.id);

    let decision: MergedWorktreeDecision;
    try {
      const state = await deps.readWorktreeState(candidate.worktree.path);
      decision = decideMergedWorktreeCleanup({
        // Re-read after the git round trip: an agent may have started meanwhile.
        sessionsBusyOrUnknown: sessionIds.some((id) => !deps.isSessionIdle(id)),
        sessionOpen: sessionIds.some((id) => deps.isSessionOpen(id)) || deps.isWorktreeOpen(candidate.worktree.path),
        isDirty: state.isDirty,
        headCommit: state.headCommit,
        mergedHeadSha: candidate.mergedHeadSha,
      });
    } catch {
      // Git could not answer; nothing is decided on a guess. Try again next pass.
      continue;
    }
    if (decision.action === 'wait') continue;

    deps.markHandled(candidate);
    try {
      if (sessionIds.length > 0) {
        const { failedIds } = await deps.archiveSessions(sessionIds);
        if (failedIds.length > 0) throw new Error(`Could not archive ${failedIds.length} session(s)`);
      }
      if (decision.action === 'remove') {
        await deps.removeWorktree(candidate);
        deps.report({ kind: 'removed', candidate, archivedCount: sessionIds.length });
      } else if (sessionIds.length > 0) {
        // A kept worktree with no sessions changed nothing worth a toast.
        deps.report({ kind: 'archived', candidate, archivedCount: sessionIds.length });
      }
    } catch (error) {
      deps.report({ kind: 'failed', candidate, error: error instanceof Error ? error : new Error(String(error)) });
    }
  }
}
