import type { GitStatus } from '@/lib/api/types';
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
 * not: no uncommitted changes, and no commit outside the PR's history. A
 * checkout behind the PR's last commit qualifies: the PR gained commits on
 * the host (Update branch, a bot, an applied suggestion) after this pull.
 */
export const decideMergedWorktreeCleanup = (input: {
  sessionsBusyOrUnknown: boolean;
  sessionOpen: boolean;
  isDirty: boolean | null;
  /** Commits here the merged PR lacks; null when git could not tell. */
  hasUnmergedCommits: boolean | null;
}): MergedWorktreeDecision => {
  if (input.sessionsBusyOrUnknown || input.sessionOpen) return { action: 'wait' };
  const nothingToLose = input.isDirty === false && input.hasUnmergedCommits === false;
  return nothingToLose ? { action: 'remove' } : { action: 'archive-only' };
};

/**
 * Whether the checkout has commits the merged PR lacks. The PR's last commit
 * answers it when this clone has that commit. A checkout behind a PR that
 * gained commits on the host may lack it, and then a branch with nothing left
 * to push has lost nothing either. Null when neither can tell.
 */
export const hasUnmergedCommits = async (input: {
  mergedHeadSha: string | null;
  status: Pick<GitStatus, 'tracking' | 'ahead'>;
  /** Rejects when `sha` is not in this clone. */
  hasCommitsAfter: (sha: string) => Promise<boolean>;
}): Promise<boolean | null> => {
  if (input.mergedHeadSha) {
    try {
      return await input.hasCommitsAfter(input.mergedHeadSha);
    } catch {
      // The PR's last commit was never fetched into this clone.
    }
  }
  return input.status.tracking ? input.status.ahead > 0 : null;
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
  /** Sessions are archived once per worktree and PR, so work continued in a kept worktree is never archived again. */
  isHandled: (candidate: MergedWorktreeCandidate) => boolean;
  markHandled: (candidate: MergedWorktreeCandidate) => void;
  getActiveSessions: () => readonly Session[];
  isSessionIdle: (sessionId: string) => boolean;
  isSessionOpen: (sessionId: string) => boolean;
  /** The worktree is the directory on screen, e.g. a new-session draft there. */
  isWorktreeOpen: (path: string) => boolean;
  readWorktreeState: (candidate: MergedWorktreeCandidate) => Promise<{ isDirty: boolean | null; hasUnmergedCommits: boolean | null }>;
  archiveSessions: (sessionIds: string[]) => Promise<{ failedIds: string[] }>;
  removeWorktree: (candidate: MergedWorktreeCandidate) => Promise<void>;
  report: (outcome: MergedWorktreeOutcome) => void;
};

/**
 * One pass over the merged worktrees. Sessions are archived at most once; a
 * kept worktree nobody works in is checked again, so it goes once its last
 * changes are cleaned up or pulled. One still in use is left for a later
 * pass, and one failure never stops the others.
 */
export async function runMergedWorktreeCleanup(
  deps: MergedWorktreeCleanupDeps,
  /** Kept worktrees cost git reads every time, so only the periodic pass rechecks them. */
  options: { recheckKept: boolean } = { recheckKept: true },
): Promise<void> {
  for (const candidate of deps.listCandidates()) {
    const handled = deps.isHandled(candidate);
    if (handled && !options.recheckKept) continue;
    const sessions = sessionsInWorktree(deps.getActiveSessions(), candidate.worktree.path);
    const sessionIds = sessions.map((session) => session.id);
    // Sessions in a kept worktree mean the work went on there.
    if (handled && sessionIds.length > 0) continue;

    let decision: MergedWorktreeDecision;
    try {
      const state = await deps.readWorktreeState(candidate);
      decision = decideMergedWorktreeCleanup({
        // Re-read after the git round trip: an agent may have started meanwhile.
        sessionsBusyOrUnknown: sessionIds.some((id) => !deps.isSessionIdle(id)),
        sessionOpen: sessionIds.some((id) => deps.isSessionOpen(id)) || deps.isWorktreeOpen(candidate.worktree.path),
        isDirty: state.isDirty,
        hasUnmergedCommits: state.hasUnmergedCommits,
      });
    } catch {
      // Git could not answer; nothing is decided on a guess. Try again next pass.
      continue;
    }
    if (decision.action === 'wait') continue;
    if (handled && decision.action !== 'remove') continue;

    if (!handled) deps.markHandled(candidate);
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
