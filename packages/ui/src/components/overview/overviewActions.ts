import { getGitLog, getGitStatus } from '@/lib/gitApi';
import { opencodeClient } from '@/lib/opencode/client';
import type { Session } from '@/lib/opencode/model';
import { isNothingLost, type OverviewWorktreeLosses } from '@/lib/overview/overviewModel';
import { normalizePath } from '@/lib/pathNormalization';
import { isSessionInWork } from '@/lib/sessionWorkMetadata';
import { hasUnmergedCommits } from '@/lib/worktrees/mergedWorktreeCleanup';
import { removeProjectWorktree } from '@/lib/worktrees/worktreeManager';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useBackgroundShellsStore } from '@/sync/background-shells';
import { archiveSessions, setSessionWorkState } from '@/sync/session-actions';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { WorktreeMetadata } from '@/types/worktree';

export type OverviewWorktreeGit = { losses: OverviewWorktreeLosses; lastCommitAt: number | null };

/** A worktree the overview can remove, with what its branch's change request says. */
export type OverviewWorktreeTarget = {
  worktree: WorktreeMetadata;
  project: { id: string; path: string };
  /** The merged change request's last commit; removal checks nothing is past it. */
  mergedHeadSha: string | null;
};

const isInside = (directory: string | null | undefined, root: string): boolean => {
  const normalized = normalizePath(directory ?? null);
  return normalized === root || Boolean(normalized?.startsWith(`${root}/`));
};

/** Sessions working in the worktree, its subdirectories and subsessions included. */
export const sessionsInWorktree = (sessions: readonly Session[], path: string): Session[] => {
  const root = normalizePath(path);
  return root ? sessions.filter((session) => isInside(resolveGlobalSessionDirectory(session), root)) : [];
};

/**
 * What removing the worktree would lose. Merged: anything past the PR's last
 * commit. Otherwise: anything its upstream (or the base `ahead` was counted
 * against) lacks; with neither, git cannot tell and the answer is null.
 */
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

/** Marks sessions done one by one; one failure never stops the rest. Returns the ones that failed. */
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

export type WorktreeUse = 'free' | 'busy' | 'inUse' | 'unknown';

/**
 * Whether anything works in the worktree right now, read at the moment of the
 * action. On screen: the directory shown or the open session is there. Busy: a
 * background command runs there, or the host reports a session there running;
 * a failed read is unknown, never free.
 */
export async function readWorktreeUse(path: string): Promise<WorktreeUse> {
  const root = normalizePath(path) ?? path;
  const sessions = sessionsInWorktree(useGlobalSessionsStore.getState().activeSessions, root);
  const currentSessionId = useSessionUIStore.getState().currentSessionId;
  if (isInside(useDirectoryStore.getState().currentDirectory, root) || sessions.some((session) => session.id === currentSessionId)) return 'inUse';
  const shells = useBackgroundShellsStore.getState();
  if ([...shells.byId.values()].some((shell) => isInside(shell.directory, root)) || sessions.some((session) => shells.sessionIds.has(session.id))) {
    return 'busy';
  }
  // One read of the host's map covers every directory; a session missing from it is idle.
  const statuses = await opencodeClient.getActiveSessionStatuses(root);
  if (!statuses) return 'unknown';
  return sessions.some((session) => session.id in statuses) ? 'busy' : 'free';
}

export type OverviewRemoveOutcome =
  | { kind: 'removed' }
  /** Something works there, it is open on screen, or that could not be read; nothing was touched. */
  | { kind: 'busy' | 'inUse' | 'unknown' }
  /** Git now reports more to lose than the user agreed to; nothing was touched. */
  | { kind: 'changed' }
  | { kind: 'failed'; error: Error };

const losesMore = (now: OverviewWorktreeLosses, agreed: OverviewWorktreeLosses): boolean => (
  now.uncommittedFiles > agreed.uncommittedFiles
  || (now.unpushed !== false && agreed.unpushed === false)
  || (now.unpushed === null && agreed.unpushed !== null)
);

/**
 * "Clean up": the sessions in work there are marked done, every session there
 * is archived, and the worktree is removed with its local branch. Everything
 * is read at the moment of the action, not when the page drew the row: what
 * works there (before and after the git read), git itself, and the sessions
 * to archive. `agreed` is nothing for a clean worktree and the losses the user
 * confirmed otherwise; git reporting more stops it. A failed archive stops
 * before removal; a failed removal leaves the sessions in the archive, from
 * which they come back.
 */
export async function removeOverviewWorktree(input: {
  target: OverviewWorktreeTarget;
  agreed: OverviewWorktreeLosses;
}): Promise<OverviewRemoveOutcome> {
  const { target, agreed } = input;
  const path = target.worktree.path;
  try {
    const before = await readWorktreeUse(path);
    if (before !== 'free') return { kind: before };
    const git = await readOverviewWorktreeGit(target);
    if (isNothingLost(agreed) ? !isNothingLost(git.losses) : losesMore(git.losses, agreed)) return { kind: 'changed' };
    // An agent may have started during the git round trip.
    const after = await readWorktreeUse(path);
    if (after !== 'free') return { kind: after };

    const sessions = sessionsInWorktree(useGlobalSessionsStore.getState().activeSessions, path);
    await markOverviewSessionsDone(sessions.filter((session) => !session.parentID && isSessionInWork(session)));
    if (sessions.length > 0) {
      const { failedIds } = await archiveSessions(sessions.map((session) => session.id));
      if (failedIds.length > 0) throw new Error(`Could not archive ${failedIds.length} session(s)`);
    }
    await removeProjectWorktree(target.project, target.worktree, { deleteLocalBranch: true });
    return { kind: 'removed' };
  } catch (error) {
    return { kind: 'failed', error: error instanceof Error ? error : new Error(String(error)) };
  }
}
