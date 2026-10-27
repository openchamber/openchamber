import type { Session } from '@/lib/opencode/model';
import { isReviewSession } from '@/lib/sessionReviewMetadata';
import { isSessionInWork } from '@/lib/sessionWorkMetadata';
import { markOverviewSessionsDone, readWorktreeUse, sessionsInWorktree } from '@/components/overview/overviewActions';
import { archiveWorktreeWork } from '@/lib/worktrees/worktreeArchive';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { setSessionWorkState } from '@/sync/session-actions';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { leaveFinishedSessions } from '@/lib/sessionTabs';
import { isAgentWorkingInSpace } from '@/lib/spaces/space-apply';
import { runSpaceAction } from '@/lib/spaces/space-repair';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { isPathWithinProject } from '../utils';
import type { WorktreeMetadata } from '@/types/worktree';
import type { SessionNode } from '../types';

/**
 * Leave a worktree's or a space's work: close its sessions' tabs, and move
 * off it when it is on screen, as a session or as a draft in its folder.
 */
const leaveWorkFolder = (sessions: readonly Session[], folder: string, projectId: string): void => {
  leaveFinishedSessions(sessions.map((session) => session.id), { projectId });
  const state = useSessionUIStore.getState();
  if (state.currentSessionId) return;
  const directory = state.newSessionDraft.open ? state.newSessionDraft.directoryOverride : useDirectoryStore.getState().currentDirectory;
  if (isPathWithinProject(directory, folder)) state.openNewSessionDraft({ selectedProjectId: projectId });
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
  /** Done; the worktree stays where it is, out of In work. */
  | { kind: 'done' }
  /** Done, and the worktree is archived with its sessions and changes. */
  | { kind: 'archived' }
  /** Done; a session there still runs, so the worktree stays. */
  | { kind: 'busy' }
  /** Done; whether a session still runs there could not be read, so the worktree stays. */
  | { kind: 'unknown' }
  | { kind: 'failed'; error: Error; doneFailed: number };

/**
 * Done on a worktree work: its sessions in work are marked done, and with
 * `archive` the worktree is then archived with its sessions. Done alone only
 * takes it out of In work, unless the user turned archiving on Done on
 * (`worktreeArchiveOnDoneEnabled`); Archive in its menu and the row's
 * Shift action always archive. An archive keeps every change, so nothing
 * needs the user's word; only a session still running there keeps the
 * worktree. The work has left In work either way.
 */
export async function finishWorktreeWork(input: {
  sessions: readonly Session[];
  archive: boolean;
  worktree: WorktreeMetadata;
  project: { id: string; path: string };
  /** The name the row shows, which the archive keeps. */
  title?: string;
}): Promise<FinishWorktreeWorkOutcome> {
  const failed = await markOverviewSessionsDone(input.sessions.filter(isSessionInWork));
  if (failed.length > 0) {
    return { kind: 'failed', error: new Error(`Could not mark ${failed.length} session(s) done`), doneFailed: failed.length };
  }
  // Done work leaves the working set, as Mark done in the composer does: its
  // tabs close and the app moves off it, which also frees the worktree for
  // the clean-up below (it never removes one that is on screen).
  leaveWorkFolder(input.sessions, input.worktree.path, input.project.id);
  if (!input.archive) return { kind: 'done' };
  const use = await readWorktreeUse(input.worktree.path);
  if (use === 'unknown') return { kind: 'unknown' };
  if (use !== 'free') return { kind: 'busy' };
  try {
    const sessions = sessionsInWorktree(useGlobalSessionsStore.getState().activeSessions, input.worktree.path);
    await archiveWorktreeWork({ project: input.project, worktree: input.worktree, sessions, title: input.title });
    return { kind: 'archived' };
  } catch (error) {
    return { kind: 'failed', error: error instanceof Error ? error : new Error(String(error)), doneFailed: 0 };
  }
}

/**
 * Done on a space's work: its sessions in work are marked done and the work
 * is left, as a worktree's is, and the space is stopped. Stopping keeps every
 * file and gives back its memory and processor; it starts again with the next
 * message. A space an agent is still working in keeps running, so Done never
 * cuts a turn short. The space itself stays: what happens to its changes is
 * the apply dialog's question, never a side effect of Done (maintainer
 * decision 2026-10-26).
 */
export async function finishSpaceWork(input: {
  sessions: readonly Session[];
  spaceId: string;
  directory: string;
  projectId: string;
}): Promise<Extract<FinishWorktreeWorkOutcome, { kind: 'done' | 'failed' }>> {
  const failed = await markOverviewSessionsDone(input.sessions.filter(isSessionInWork));
  if (failed.length > 0) {
    return { kind: 'failed', error: new Error(`Could not mark ${failed.length} session(s) done`), doneFailed: failed.length };
  }
  leaveWorkFolder(input.sessions, input.directory, input.projectId);
  const running = useSpacesStore.getState().journey?.get(input.spaceId)?.state === 'running';
  if (running && !isAgentWorkingInSpace(useGlobalSessionStatusStore.getState(), input.spaceId)) {
    // Its progress and a failure show on the space's row, as from its menu.
    void runSpaceAction(input.spaceId, 'stop');
  }
  return { kind: 'done' };
}
