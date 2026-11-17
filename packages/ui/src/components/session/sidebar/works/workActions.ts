import type { Session } from '@/lib/opencode/model';
import { isReviewSession } from '@/lib/sessionReviewMetadata';
import { isSessionInWork } from '@/lib/sessionWorkMetadata';
import { markOverviewSessionsDone } from '@/components/overview/overviewActions';
import { readWorktreeUse, sessionsInWorktree } from '@/lib/worktrees/worktreeUse';
import { archiveWorktreeWork } from '@/lib/worktrees/worktreeArchive';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { setSessionWorkState } from '@/sync/session-actions';
import { settleRunningOperatorChildren } from '@/sync/operator-children-done';
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

const leaveWorkFolder = (sessions: readonly Session[], folder: string, projectId: string): void => {
  leaveFinishedSessions(sessions.map((session) => session.id), { projectId });
  const state = useSessionUIStore.getState();
  if (state.currentSessionId) return;
  const directory = state.newSessionDraft.open ? state.newSessionDraft.directoryOverride : useDirectoryStore.getState().currentDirectory;
  if (isPathWithinProject(directory, folder)) state.openNewSessionDraft({ selectedProjectId: projectId });
};

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

const isOffshoot = (session: Session): boolean => isReviewSession(session) || Boolean(session.fork?.sessionID);

export const pickWorkSessionToOpen = (nodes: readonly SessionNode[]): Session | null => (
  nodes.find((node) => !isOffshoot(node.session))?.session ?? nodes[0]?.session ?? null
);

export const isWorkInWork = (sessions: readonly Session[]): boolean => sessions.some(isSessionInWork);

export const trackWork = async (session: Session): Promise<void> => {
  await setSessionWorkState(session.id, resolveGlobalSessionDirectory(session) ?? session.directory, 'open');
};

const MARK_DONE_CONCURRENCY = 4;

export const markSessionsDone = async (
  sessions: readonly Session[],
  write: typeof setSessionWorkState = setSessionWorkState,
): Promise<{ doneIds: string[]; failedIds: string[] } | null> => {
  const isCurrentRuntime = captureRuntimeInstance();
  const settled = settleRunningOperatorChildren(sessions.map((session) => session.id));
  if (settled !== true && !await settled) return { doneIds: [], failedIds: [] };
  const outcomes = await mapWithConcurrency([...sessions], MARK_DONE_CONCURRENCY, async (session) => {
    if (!isCurrentRuntime()) return 'stale';
    try {
      const updated = await write(session.id, resolveGlobalSessionDirectory(session) ?? session.directory, 'done');
      return updated ? 'done' : 'stale';
    } catch (error) {
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
  | { kind: 'done' }
  | { kind: 'archived' }
  | { kind: 'busy' }
  | { kind: 'unknown' }
  | { kind: 'failed'; error: Error; doneFailed: number }
  | { kind: 'cancelled' };

const sessionsToMarkDone = (sessions: readonly Session[], alreadyDone?: ReadonlySet<string>): Session[] => (
  sessions.filter((session) => isSessionInWork(session) && !alreadyDone?.has(session.id))
);

export async function finishWorktreeWork(input: {
  sessions: readonly Session[];
  archive: boolean;
  worktree: WorktreeMetadata;
  project: { id: string; path: string };
  title?: string;
  alreadyDone?: ReadonlySet<string>;
}): Promise<FinishWorktreeWorkOutcome> {
  if (!await settleRunningOperatorChildren(sessionsToMarkDone(input.sessions, input.alreadyDone).map((session) => session.id))) return { kind: 'cancelled' };
  const failed = await markOverviewSessionsDone(sessionsToMarkDone(input.sessions, input.alreadyDone));
  if (failed.length > 0) {
    return { kind: 'failed', error: new Error(`Could not mark ${failed.length} session(s) done`), doneFailed: failed.length };
  }
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

export async function finishSpaceWork(input: {
  sessions: readonly Session[];
  spaceId: string;
  directory: string;
  projectId: string;
  alreadyDone?: ReadonlySet<string>;
}): Promise<Extract<FinishWorktreeWorkOutcome, { kind: 'done' | 'failed' | 'cancelled' }>> {
  if (!await settleRunningOperatorChildren(sessionsToMarkDone(input.sessions, input.alreadyDone).map((session) => session.id))) return { kind: 'cancelled' };
  const failed = await markOverviewSessionsDone(sessionsToMarkDone(input.sessions, input.alreadyDone));
  if (failed.length > 0) {
    return { kind: 'failed', error: new Error(`Could not mark ${failed.length} session(s) done`), doneFailed: failed.length };
  }
  leaveWorkFolder(input.sessions, input.directory, input.projectId);
  const running = useSpacesStore.getState().journey?.get(input.spaceId)?.state === 'running';
  if (running && !isAgentWorkingInSpace(useGlobalSessionStatusStore.getState(), input.spaceId)) {
    void runSpaceAction(input.spaceId, 'stop');
  }
  return { kind: 'done' };
}

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

export const bulkDoneWorkLabel = (group: SessionGroup): string => (
  group.worktree?.title?.trim() || group.branch?.trim() || group.worktree?.branch?.trim() || group.label
);

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
