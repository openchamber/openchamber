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
  | { kind: 'archived'; candidate: MergedWorktreeCandidate; archivedCount: number }
  | { kind: 'failed'; candidate: MergedWorktreeCandidate; error: Error };

export type MergedWorktreeCleanupDeps = {
  listCandidates: () => MergedWorktreeCandidate[];
  /** A worktree is tried once per PR: one that failed to archive is not tried again on every pass. */
  isHandled: (candidate: MergedWorktreeCandidate) => boolean;
  markHandled: (candidate: MergedWorktreeCandidate) => void;
  getActiveSessions: () => readonly Session[];
  isSessionIdle: (sessionId: string) => boolean;
  isSessionOpen: (sessionId: string) => boolean;
  /** The worktree is the directory on screen, e.g. a new-session draft there. */
  isWorktreeOpen: (path: string) => boolean;
  /** Something here archives or removes it right now (Done, a delete). */
  isWorktreeRemoving: (path: string) => boolean;
  /** The user restored it from the archive since the last pass; answers once. */
  takeRestored: (path: string) => boolean;
  /** Archives the worktree with these sessions; rejects when either does not go. */
  archiveWorktree: (candidate: MergedWorktreeCandidate, sessions: readonly Session[]) => Promise<void>;
  report: (outcome: MergedWorktreeOutcome) => void;
};

/**
 * One pass over the merged worktrees: each one nobody works in is archived
 * with its sessions. An archive keeps every change and commit, so nothing has
 * to be checked for loss first. One still in use is left for a later pass,
 * and one failure never stops the others.
 */
export async function runMergedWorktreeCleanup(deps: MergedWorktreeCleanupDeps): Promise<void> {
  for (const candidate of deps.listCandidates()) {
    if (deps.isHandled(candidate) || deps.isWorktreeRemoving(candidate.worktree.path)) continue;
    // Restoring a merged worktree is the user taking it back: this PR is done
    // with, and only a later one cleans it up again.
    if (deps.takeRestored(candidate.worktree.path)) {
      deps.markHandled(candidate);
      continue;
    }
    const sessions = sessionsInWorktree(deps.getActiveSessions(), candidate.worktree.path);
    const busy = sessions.some((session) => !deps.isSessionIdle(session.id));
    const open = sessions.some((session) => deps.isSessionOpen(session.id)) || deps.isWorktreeOpen(candidate.worktree.path);
    if (busy || open) continue;

    deps.markHandled(candidate);
    try {
      await deps.archiveWorktree(candidate, sessions);
      deps.report({ kind: 'archived', candidate, archivedCount: sessions.length });
    } catch (error) {
      deps.report({ kind: 'failed', candidate, error: error instanceof Error ? error : new Error(String(error)) });
    }
  }
}
