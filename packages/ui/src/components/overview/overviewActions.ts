import { getGitLog, getGitStatus } from '@/lib/gitApi';
import type { Session } from '@/lib/opencode/model';
import { isNothingLost, type OverviewWorktreeLosses } from '@/lib/overview/overviewModel';
import { isSessionInWork } from '@/lib/sessionWorkMetadata';
import { hasUnmergedCommits } from '@/lib/worktrees/mergedWorktreeCleanup';
import { removeProjectWorktree } from '@/lib/worktrees/worktreeManager';
import { readWorktreeUse, sessionsInWorktree } from '@/lib/worktrees/worktreeUse';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { archiveSessions, setSessionWorkState } from '@/sync/session-actions';
import type { WorktreeMetadata } from '@/types/worktree';

export type OverviewWorktreeGit = { losses: OverviewWorktreeLosses; lastCommitAt: number | null };

export type OverviewWorktreeTarget = {
  worktree: WorktreeMetadata;
  project: { id: string; path: string };
  mergedHeadSha: string | null;
};

export async function readOverviewWorktreeGit(target: OverviewWorktreeTarget): Promise<OverviewWorktreeGit> {
  const path = target.worktree.path;
  const status = await getGitStatus(path, { fresh: true });
  const unpushed = target.mergedHeadSha
    ? await hasUnmergedCommits({
      mergedHeadSha: target.mergedHeadSha,
      status,
      hasCommitsAfter: async (sha) => (await getGitLog(path, { from: sha, to: 'HEAD', maxCount: 1 })).all.length > 0,
    })
    : (status.tracking || status.aheadBase ? status.ahead > 0 : null);
  const log = await getGitLog(path, { maxCount: 1 });
  const lastCommitAt = log.latest ? Date.parse(log.latest.date) : Number.NaN;
  return {
    losses: { uncommittedFiles: status.files.length, unpushed },
    lastCommitAt: Number.isFinite(lastCommitAt) ? lastCommitAt : null,
  };
}

export async function markOverviewSessionsDone(sessions: readonly Session[]): Promise<Session[]> {
  const failed: Session[] = [];
  for (const session of sessions) {
    try {
      await setSessionWorkState(session.id, resolveGlobalSessionDirectory(session) ?? session.directory, 'done');
    } catch {
      failed.push(session);
    }
  }
  return failed;
}

export type OverviewRemoveOutcome =
  | { kind: 'removed' }
  | { kind: 'busy' | 'inUse' | 'unknown' }
  | { kind: 'changed' }
  | { kind: 'failed'; error: Error };

const losesMore = (now: OverviewWorktreeLosses, agreed: OverviewWorktreeLosses): boolean => (
  now.uncommittedFiles > agreed.uncommittedFiles
  || (now.unpushed !== false && agreed.unpushed === false)
  || (now.unpushed === null && agreed.unpushed !== null)
);

export async function removeOverviewWorktree(input: {
  target: OverviewWorktreeTarget;
  agreed: OverviewWorktreeLosses;
  skipTeardown?: boolean;
}): Promise<OverviewRemoveOutcome> {
  const { target, agreed } = input;
  const path = target.worktree.path;
  try {
    const before = await readWorktreeUse(path);
    if (before !== 'free') return { kind: before };
    const git = await readOverviewWorktreeGit(target);
    if (isNothingLost(agreed) ? !isNothingLost(git.losses) : losesMore(git.losses, agreed)) return { kind: 'changed' };
    const after = await readWorktreeUse(path);
    if (after !== 'free') return { kind: after };

    const sessions = sessionsInWorktree(useGlobalSessionsStore.getState().activeSessions, path);
    await markOverviewSessionsDone(sessions.filter((session) => !session.parentID && isSessionInWork(session)));
    if (sessions.length > 0) {
      const { failedIds } = await archiveSessions(sessions.map((session) => session.id));
      if (failedIds.length > 0) throw new Error(`Could not archive ${failedIds.length} session(s)`);
    }
    await removeProjectWorktree(target.project, target.worktree, { deleteLocalBranch: true, skipTeardown: input.skipTeardown });
    return { kind: 'removed' };
  } catch (error) {
    return { kind: 'failed', error: error instanceof Error ? error : new Error(String(error)) };
  }
}
