import type { GitStatus } from '@/lib/api/types';
import type { Session } from '@/lib/opencode/model';
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

export type MergedWorktreeOutcome =
  | { kind: 'archived'; candidate: MergedWorktreeCandidate; archivedCount: number }
  | { kind: 'failed'; candidate: MergedWorktreeCandidate; error: Error };

export type MergedWorktreeCleanupDeps = {
  listCandidates: () => MergedWorktreeCandidate[];
  /** Archived or taken back for this PR, or waiting out the delay after a failed archive. */
  isHandled: (candidate: MergedWorktreeCandidate) => boolean;
  /** Archived or restored: done with for this PR. */
  markHandled: (candidate: MergedWorktreeCandidate) => void;
  /** The archive failed: try again later, each time after a longer delay. */
  markFailed: (candidate: MergedWorktreeCandidate) => void;
  /** Sessions to archive with the worktree, its subdirectories and subsessions included. */
  getWorktreeSessions: (path: string) => readonly Session[];
  /**
   * Whether anything works there now: an agent or a background command runs,
   * or it is on screen. Only "free" lets the archive go; "unknown" waits.
   */
  readWorktreeUse: (path: string) => Promise<'free' | 'busy' | 'inUse' | 'unknown'>;
  /** Something here archives or removes it right now (Done, a delete). */
  isWorktreeRemoving: (path: string) => boolean;
  /** False once the app switched servers since the pass began. */
  isCurrentRuntime: () => boolean;
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
    if (deps.isHandled(candidate)) continue;
    // Restoring a merged worktree is the user taking it back: this PR is done
    // with, and only a later one cleans it up again.
    if (deps.takeRestored(candidate.worktree.path)) {
      deps.markHandled(candidate);
      continue;
    }
    // Read before the removal check: a Done may start while the host answers.
    const use = await deps.readWorktreeUse(candidate.worktree.path);
    // Another server's worktree with the same path must not be archived.
    if (!deps.isCurrentRuntime()) return;
    if (use !== 'free' || deps.isWorktreeRemoving(candidate.worktree.path)) continue;
    const sessions = deps.getWorktreeSessions(candidate.worktree.path);

    try {
      await deps.archiveWorktree(candidate, sessions);
      deps.markHandled(candidate);
      deps.report({ kind: 'archived', candidate, archivedCount: sessions.length });
    } catch (error) {
      deps.markFailed(candidate);
      deps.report({ kind: 'failed', candidate, error: error instanceof Error ? error : new Error(String(error)) });
    }
  }
}
