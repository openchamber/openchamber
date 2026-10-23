import type { Session } from '@/lib/opencode/model';
import { isReviewSession } from '@/lib/sessionReviewMetadata';
import { isSessionInWork } from '@/lib/sessionWorkMetadata';
import { markOverviewSessionsDone, removeOverviewWorktree } from '@/components/overview/overviewActions';
import { resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { setSessionWorkState } from '@/sync/session-actions';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { leaveFinishedSessions } from '@/lib/sessionTabs';
import { isPathWithinProject } from '../utils';
import type { WorktreeMetadata } from '@/types/worktree';
import type { SessionNode } from '../types';

/**
 * Leave a worktree's work: close its sessions' tabs, and move off it when it
 * is on screen, as a session or as a draft in its folder.
 */
const leaveWorktree = (sessions: readonly Session[], worktreePath: string, projectId: string): void => {
  leaveFinishedSessions(sessions.map((session) => session.id), { projectId });
  const state = useSessionUIStore.getState();
  if (state.currentSessionId) return;
  const directory = state.newSessionDraft.open ? state.newSessionDraft.directoryOverride : useDirectoryStore.getState().currentDirectory;
  if (isPathWithinProject(directory, worktreePath)) state.openNewSessionDraft({ selectedProjectId: projectId });
};

/** Every session of a work's trees, parents before their children. */
export const collectWorkSessions = (nodes: readonly SessionNode[]): Session[] => {
  const sessions: Session[] = [];
  const stack = [...nodes].reverse();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    sessions.push(node.session);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child) stack.push(child);
    }
  }
  return sessions;
};

/** A session that grew out of another one (a review, a fork, a promoted `/btw`), not the work itself. */
const isOffshoot = (session: Session): boolean => isReviewSession(session) || Boolean(session.fork?.sessionID);

/**
 * The session a click on a worktree work opens: the one the user last worked
 * in, past reviews and forks, or the latest of any when there is nothing
 * else. `nodes` are the work's root sessions in the sidebar's order, most
 * recent first. Null when the worktree has no session, where a draft opens.
 */
export const pickWorkSessionToOpen = (nodes: readonly SessionNode[]): Session | null => (
  nodes.find((node) => !isOffshoot(node.session))?.session ?? nodes[0]?.session ?? null
);

/** Whether the work is in the In work block: any of its sessions is in work. */
export const isWorkInWork = (sessions: readonly Session[]): boolean => sessions.some(isSessionInWork);

/** Puts a work back into In work through the session the user last worked in. */
export const trackWork = async (session: Session): Promise<void> => {
  await setSessionWorkState(session.id, resolveGlobalSessionDirectory(session) ?? session.directory, 'open');
};

export type FinishWorktreeWorkOutcome =
  /** Done, and the worktree with its local branch is gone: nothing could be lost. */
  | { kind: 'removed' }
  /** Done; a session there still runs, so the worktree stays. */
  | { kind: 'busy' }
  /** Done; removing it could lose work or could not be checked, so the user decides. */
  | { kind: 'ask' }
  | { kind: 'failed'; error: Error; doneFailed: number };

/**
 * Done on a worktree work: its sessions in work are marked done, then the
 * worktree is cleaned up by the Overview's rules (sessions archived, worktree
 * and local branch removed) when that loses nothing. Anything else leaves it
 * for the user to decide; the work has left In work either way.
 */
export async function finishWorktreeWork(input: {
  sessions: readonly Session[];
  worktree: WorktreeMetadata;
  project: { id: string; path: string };
}): Promise<FinishWorktreeWorkOutcome> {
  const failed = await markOverviewSessionsDone(input.sessions.filter(isSessionInWork));
  if (failed.length > 0) {
    return { kind: 'failed', error: new Error(`Could not mark ${failed.length} session(s) done`), doneFailed: failed.length };
  }
  // Done work leaves the working set, as Mark done in the composer does: its
  // tabs close and the app moves off it, which also frees the worktree for
  // the clean-up below (it never removes one that is on screen).
  leaveWorktree(input.sessions, input.worktree.path, input.project.id);
  const outcome = await removeOverviewWorktree({
    target: { worktree: input.worktree, project: input.project, mergedHeadSha: null },
    agreed: { uncommittedFiles: 0, unpushed: false },
  });
  switch (outcome.kind) {
    case 'removed':
      return { kind: 'removed' };
    case 'busy':
      return { kind: 'busy' };
    case 'failed':
      return { kind: 'failed', error: outcome.error, doneFailed: 0 };
    default:
      return { kind: 'ask' };
  }
}
