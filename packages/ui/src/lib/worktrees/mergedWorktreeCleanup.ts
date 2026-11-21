import type { GitStatus } from '@/lib/api/types';
import type { Session } from '@/lib/opencode/model';
import type { WorktreeMetadata } from '@/types/worktree';
import type { SourceControlProvider } from '@/lib/source-control/types';

export type MergedWorktreeCandidate = {
  worktree: WorktreeMetadata;
  project: { id: string; path: string };
  prNumber: number;
  provider?: SourceControlProvider | null;
  mergedHeadSha: string | null;
};

export const hasUnmergedCommits = async (input: {
  mergedHeadSha: string | null;
  status: Pick<GitStatus, 'tracking' | 'ahead'>;
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
  isHandled: (candidate: MergedWorktreeCandidate) => boolean;
  markHandled: (candidate: MergedWorktreeCandidate) => void;
  markFailed: (candidate: MergedWorktreeCandidate) => void;
  getWorktreeSessions: (path: string) => readonly Session[];
  readWorktreeUse: (path: string) => Promise<'free' | 'busy' | 'inUse' | 'unknown'>;
  isWorktreeRemoving: (path: string) => boolean;
  isCurrentRuntime: () => boolean;
  takeRestored: (path: string) => boolean;
  archiveWorktree: (candidate: MergedWorktreeCandidate, sessions: readonly Session[]) => Promise<void>;
  report: (outcome: MergedWorktreeOutcome) => void;
};

export async function runMergedWorktreeCleanup(deps: MergedWorktreeCleanupDeps): Promise<void> {
  for (const candidate of deps.listCandidates()) {
    if (deps.isHandled(candidate)) continue;
    if (deps.takeRestored(candidate.worktree.path)) {
      deps.markHandled(candidate);
      continue;
    }
    const use = await deps.readWorktreeUse(candidate.worktree.path);
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
