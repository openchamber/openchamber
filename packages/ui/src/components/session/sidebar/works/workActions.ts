import type { Session } from '@/lib/opencode/model';
import { isReviewSession } from '@/lib/sessionReviewMetadata';
import { isSessionInWork } from '@/lib/sessionWorkMetadata';
import { markOverviewSessionsDone } from '@/components/overview/overviewActions';
import { readWorktreeUse, sessionsInWorktree } from '@/lib/worktrees/worktreeUse';
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
import { recordSessionActionFailure } from '@/sync/session-action-failures';
import { mapWithConcurrency } from '@/lib/concurrency';
import { captureRuntimeInstance } from '@/lib/runtime-switch';
import { canArchiveWorktrees } from '@/lib/gitApi';
import { isWorktreeRemoving } from '@/lib/worktrees/worktreeRemovalState';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { isPathWithinProject, normalizePath } from '../utils';
import type { WorktreeMetadata } from '@/types/worktree';
import type { SessionGroup, SessionNode } from '../types';
import type { SessionRowOrderWork } from '../sessions/sessionRowOrder';

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

const MARK_DONE_CONCURRENCY = 4;

/**
 * The sidebar's bulk Mark done: each session alone, as the composer's Mark
 * done takes one, four at a time. Done sessions leave the working set; one
 * failure never stops the rest. Bound to the server it was clicked on: once
 * the runtime changes (away and back included), queued sessions are not sent
 * and the result is null, so nothing reaches the new server's tabs or
 * selection.
 */
export const markSessionsDone = async (
  sessions: readonly Session[],
  write: typeof setSessionWorkState = setSessionWorkState,
): Promise<{ doneIds: string[]; failedIds: string[] } | null> => {
  const isCurrentRuntime = captureRuntimeInstance();
  const outcomes = await mapWithConcurrency([...sessions], MARK_DONE_CONCURRENCY, async (session) => {
    if (!isCurrentRuntime()) return 'stale';
    try {
      const updated = await write(session.id, resolveGlobalSessionDirectory(session) ?? session.directory, 'done');
      return updated ? 'done' : 'stale';
    } catch (error) {
      // The bulk bar's failure toast quotes it, as bulk Archive's does.
      recordSessionActionFailure(session.id, error instanceof Error ? error : new Error(String(error)));
      return 'failed';
    }
  });
  if (!isCurrentRuntime() || outcomes.includes('stale')) return null;
  const doneIds = sessions.flatMap((session, index) => (outcomes[index] === 'done' ? [session.id] : []));
  const failedIds = sessions.flatMap((session, index) => (outcomes[index] === 'failed' ? [session.id] : []));
  leaveFinishedSessions(doneIds);
  return { doneIds, failedIds };
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

/** Sessions of a work still to mark done: in work, and not marked already (by bulk Mark done). */
const sessionsToMarkDone = (sessions: readonly Session[], alreadyDone?: ReadonlySet<string>): Session[] => (
  sessions.filter((session) => isSessionInWork(session) && !alreadyDone?.has(session.id))
);

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
  alreadyDone?: ReadonlySet<string>;
}): Promise<FinishWorktreeWorkOutcome> {
  const failed = await markOverviewSessionsDone(sessionsToMarkDone(input.sessions, input.alreadyDone));
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
  alreadyDone?: ReadonlySet<string>;
}): Promise<Extract<FinishWorktreeWorkOutcome, { kind: 'done' | 'failed' }>> {
  const failed = await markOverviewSessionsDone(sessionsToMarkDone(input.sessions, input.alreadyDone));
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

/**
 * The works a bulk Mark done finished whole: unpinned worktree and space works
 * whose every session that Mark done takes (a root session in work, not
 * archived) is in `doneIds`. Each then gets the work's own Done.
 */
export const selectFinishedWorks = (works: readonly SessionRowOrderWork[], doneIds: ReadonlySet<string>): SessionRowOrderWork[] => {
  const seen = new Set<string>();
  return works.filter((work) => {
    const directory = normalizePath(work.group.directory ?? null);
    if (!directory || seen.has(directory) || work.group.worktree?.pinnedAt !== undefined) return false;
    const marked = collectWorkSessions(work.group.sessions).filter((session) => !session.parentID && !session.time?.archived && isSessionInWork(session));
    if (marked.length === 0 || !marked.every((session) => doneIds.has(session.id))) return false;
    seen.add(directory);
    return true;
  });
};

/** A worktree work's name for its archive and toast: its task, else the branch, else the folder. */
export const bulkDoneWorkLabel = (group: SessionGroup): string => (
  group.worktree?.title?.trim() || group.branch?.trim() || group.worktree?.branch?.trim() || group.label
);

/**
 * Done on a work whose sessions bulk Mark done just marked (`alreadyDone`):
 * the work's own Done, as its row's Done runs it, with archive on Done for a
 * worktree and the stop for a space. Null when the project is gone.
 */
export const finishBulkDoneWork = (
  work: SessionRowOrderWork,
  alreadyDone: ReadonlySet<string>,
  archiveOnDone: boolean,
): Promise<FinishWorktreeWorkOutcome> | null => {
  const project = useProjectsStore.getState().projects.find((entry) => entry.id === work.projectId);
  if (!project) return null;
  const { group } = work;
  const sessions = collectWorkSessions(group.sessions);
  const worktree = group.worktree;
  if (worktree) {
    const title = bulkDoneWorkLabel(group);
    const archive = archiveOnDone && canArchiveWorktrees() && !isWorktreeRemoving(worktree.path);
    return finishWorktreeWork({ sessions, worktree, project: { id: project.id, path: project.path }, title, archive, alreadyDone });
  }
  const directory = normalizePath(group.directory ?? null);
  if (group.space && directory) return finishSpaceWork({ sessions, spaceId: group.space.id, directory, projectId: project.id, alreadyDone });
  return null;
};
