import React from 'react';
import { toast } from '@/components/ui';
import { canArchiveWorktrees, setGitWorktreePinned, setGitWorktreeTitle } from '@/lib/gitApi';
import { useI18n } from '@/lib/i18n';
import { useWorktreeRemoving } from '@/lib/worktrees/worktreeRemovalState';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionDraftsStore } from '@/stores/useSessionDraftsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { isSessionUnread } from '@/sync/session-unread';
import { useCollapsedSessionActivityState } from '../sessions/collapsedActivityState';
import { useGroupRefs } from '../projects/useGroupRefs';
import type { SessionGroup } from '../types';
import { formatProjectLabel, isPathWithinProject, normalizePath } from '../utils';
import { useSpaceTakesNoNewSession } from '@/lib/spaces/spaces-store';
import { spaceOfCreationRequest } from '@/lib/spaces/space-creation-requests';
import { hasWorkTitle } from '@/lib/sessionWorkTitle';
import { updateSessionTitle } from '@/sync/session-actions';
import { collectWorkSessions, finishSpaceWork, finishWorktreeWork, isWorkInWork, pickWorkSessionToOpen, trackWork } from './workActions';

const CURRENT_SESSION = '\u0000session';

type Args = {
  group: SessionGroup;
  projectId: string | null;
  /** Its sessions are hidden: the work's row is then the one that shows the selection. */
  collapsed: boolean;
  /** Called when the row opens something, after the project is made active: closes a phone's list. */
  onNavigate: () => void;
};

/**
 * What a worktree's or a space's work row knows and does, whatever draws it:
 * the desktop row with hover actions and menus, the phone's with swipe
 * actions. The row reads like a session row (live state, the task's name, its
 * reference) and opens what the user last worked on there. A space's task
 * name lives on its sessions, its own name stands where a branch would, it has
 * no pin or archive, and its Done leaves the space as it is.
 */
export function useWorktreeWork({ group, projectId, collapsed, onNavigate }: Args) {
  const { t } = useI18n();
  const worktree = group.worktree;
  const space = group.space ?? null;
  const directory = normalizePath(group.directory ?? null);
  // A space whose making failed, whose container is gone or whose machine is
  // out of reach would open a new chat in an empty folder, or fail.
  const spaceTakesNoNewSession = useSpaceTakesNoNewSession(space?.id);
  const worktreeRemoving = useWorktreeRemoving(worktree ? worktree.path : null);
  const sessions = React.useMemo(() => collectWorkSessions(group.sessions), [group.sessions]);
  const project = useProjectsStore(React.useCallback(
    (state) => projectId ? state.projects.find((entry) => entry.id === projectId) ?? null : null,
    [projectId],
  ));
  const projectLabel = project ? formatProjectLabel(project.label?.trim() || project.path) : null;
  const refs = useGroupRefs(group, sessions, true);
  const sessionWorkEnabled = useUIStore((state) => state.sessionWorkEnabled);
  const inWork = sessionWorkEnabled && isWorkInWork(sessions);
  // Where the user is: the open session (`CURRENT_SESSION`) or the open
  // draft (its id, '' before it has one) in this worktree; null elsewhere.
  // A space's draft waits on the project root while the space is made, and
  // names it by its creation request.
  const current = useSessionUIStore((state): string | null => {
    if (state.currentSessionId) return sessions.some((session) => session.id === state.currentSessionId) ? CURRENT_SESSION : null;
    if (!state.newSessionDraft.open) return null;
    const draftForThisSpace = space !== null && spaceOfCreationRequest(state.newSessionDraft.pendingWorktreeRequestId) === space.id;
    if (!draftForThisSpace && !isPathWithinProject(state.newSessionDraft.directoryOverride, directory)) return null;
    return state.newSessionDraft.workDraftId ?? '';
  });
  // A draft with nothing in it yet has no row of its own.
  const openDraftHasRow = useSessionDraftsStore((state) => (
    Boolean(current) && current !== CURRENT_SESSION && state.drafts.some((draft) => draft.id === current)
  ));
  // A run's overview covers the session, and then the run's row is the selected one.
  const runOverviewOpen = useUIStore((state) => state.runOverviewKey !== null);
  const isCurrent = current !== null && !runOverviewOpen;
  // The work's row is selected while nothing under it shows the selection:
  // folded, or on a draft that has no row yet (a worktree just made).
  const selected = isCurrent && (collapsed || (current !== CURRENT_SESSION && !openDraftHasRow));
  const [finishing, setFinishing] = React.useState(false);

  // A space's task is named as a main-checkout task is: the agent's
  // `work.name` from inside the space names the root session it works in, and
  // the user's rename of it wins (`metadata.openchamber.workTitle`). Its most
  // recent named session names the space's row, as a worktree's branch
  // description names its own.
  const namedSpaceSession = React.useMemo(
    () => (space ? group.sessions.find((node) => hasWorkTitle(node.session.metadata))?.session ?? null : null),
    [group.sessions, space],
  );
  const title = space ? namedSpaceSession?.title?.trim() || null : worktree?.title?.trim() || null;
  const branch = group.branch?.trim() || worktree?.branch?.trim() || null;
  // The space's own name stands where a worktree's branch does: under the
  // task's name, and the row's name until there is a task.
  const spaceName = space ? group.label : null;
  // Until the task is named, the row reads as the session a click opens:
  // the task in the user's words. The branch, or the space's name, is the last resort.
  const sessionToOpen = React.useMemo(() => pickWorkSessionToOpen(group.sessions), [group.sessions]);
  const label = title ?? (sessionToOpen?.title?.trim() || null) ?? branch ?? group.label;
  // A space's task name lives on a session, so a space without one has nothing to rename.
  const spaceTitleSession = namedSpaceSession ?? sessionToOpen;
  const canRename = !space || spaceTitleSession !== null;
  const canNewChat = !spaceTakesNoNewSession;

  const prepare = (): void => {
    // Leaves a full-page surface (a run's overview, Archive), as selecting a
    // session row does, even when the session is already the current one.
    useUIStore.getState().closeMainSurfaces();
    if (projectId && projectId !== useProjectsStore.getState().activeProjectId) useProjectsStore.getState().setActiveProjectIdOnly(projectId);
    onNavigate();
  };
  const newChat = (): void => {
    if (!canNewChat) return;
    prepare();
    useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: projectId, directoryOverride: group.directory });
  };
  const open = (): void => {
    const session = sessionToOpen;
    if (!session) {
      newChat();
      return;
    }
    prepare();
    useSessionUIStore.getState().setCurrentSession(session.id, session.directory ?? directory);
  };
  // The pin lives in the branch's config, so a detached worktree has none.
  // The row moves once the server's topology event lists the change.
  const pinned = worktree?.pinnedAt !== undefined;
  const canPin = Boolean(group.directory && worktree?.branch?.trim()) && !worktreeRemoving;
  const togglePin = async (): Promise<void> => {
    if (!group.directory || !canPin) return;
    try {
      await setGitWorktreePinned(group.directory, !pinned);
    } catch (error) {
      toast.error(pinned ? t('sessions.sidebar.work.unpin.failed') : t('sessions.sidebar.work.pin.failed'), {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };
  const saveTitle = async (next: string): Promise<void> => {
    if (!group.directory || !next.trim() || next.trim() === (title ?? '')) return;
    try {
      if (space) {
        if (spaceTitleSession) await updateSessionTitle(spaceTitleSession.id, next.trim(), { directory: spaceTitleSession.directory ?? directory, byUser: true });
        return;
      }
      await setGitWorktreeTitle(group.directory, next.trim());
    } catch (error) {
      toast.error(t('sessions.sidebar.work.rename.failed'), { description: error instanceof Error ? error.message : undefined });
    }
  };
  // Archive and Done both end the work: in-work sessions are marked done. Archive
  // always archives the worktree; Done only when the user turned that on. VS
  // Code keeps its own list, without archives.
  const canArchive = canArchiveWorktrees() && Boolean(worktree) && !worktreeRemoving;
  const archiveOnDone = useUIStore((state) => state.worktreeArchiveOnDoneEnabled);
  const finishWork = (archive: boolean) => {
    if (!project) return null;
    if (worktree) return finishWorktreeWork({ sessions, worktree, project: { id: project.id, path: project.path }, title: label, archive: archive && canArchive });
    if (space && directory) return finishSpaceWork({ sessions, spaceId: space.id, directory, projectId: project.id });
    return null;
  };
  const finish = async (archive: boolean): Promise<void> => {
    if (finishing) return;
    const pending = finishWork(archive);
    if (!pending) return;
    setFinishing(true);
    try {
      const outcome = await pending;
      switch (outcome.kind) {
        case 'done':
          break;
        case 'archived':
          toast.success(t('sessions.sidebar.work.archive.done'), { description: label });
          break;
        case 'busy':
          toast.info(t('sessions.sidebar.work.archive.kept'), { description: t('sessions.sidebar.work.archive.keptRunning') });
          break;
        case 'unknown':
          toast.info(t('sessions.sidebar.work.archive.kept'), { description: t('sessions.sidebar.work.archive.keptUnknown') });
          break;
        case 'failed':
          toast.error(outcome.doneFailed > 0 ? t('sessions.sidebar.work.done.failed') : t('sessions.sidebar.work.archive.failed'), {
            description: outcome.error.message,
          });
          break;
      }
    } finally {
      setFinishing(false);
    }
  };
  /** Done or Track: present while the feature is on and there is a session to track. */
  const workAction = sessionWorkEnabled && (inWork || sessions.length > 0);
  const toggleWork = (): void => {
    if (inWork) {
      void finish(archiveOnDone);
      return;
    }
    const session = sessionToOpen;
    if (!session) return;
    void trackWork(session).catch(() => toast.error(t('sessions.sidebar.work.track.failed')));
  };

  // Its sessions' live state, as a session row shows its own, with the
  // turn's duration at the end.
  const activityState = useCollapsedSessionActivityState({ nodes: group.sessions });
  const workSessionIds = React.useMemo(() => sessions.flatMap((session) => (session.parentID ? [] : [session.id])), [sessions]);
  const runningSessionId = useGlobalSessionStatusStore(React.useCallback((state) => (
    workSessionIds.find((id) => {
      const status = state.statusById.get(id)?.status.type;
      return status === 'busy' || status === 'retry';
    }) ?? null
  ), [workSessionIds]));
  const unreadSessionId = useGlobalSessionsStore(React.useCallback((state) => (
    workSessionIds.find((id) => isSessionUnread(state.entityById.get(id))) ?? null
  ), [workSessionIds]));

  return {
    worktree,
    space,
    spaceName,
    canRename,
    canNewChat,
    directory,
    worktreeRemoving,
    sessions,
    project,
    projectLabel,
    refs,
    sessionWorkEnabled,
    inWork,
    selected,
    title,
    branch,
    label,
    finishing,
    canArchive,
    pinned,
    canPin,
    workAction,
    activityState,
    runningSessionId,
    durationSessionId: runningSessionId ?? unreadSessionId,
    open,
    newChat,
    saveTitle,
    togglePin,
    finish,
    toggleWork,
  };
}
