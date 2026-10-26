import React from 'react';
import { toast } from '@/components/ui';
import { canArchiveWorktrees, setGitWorktreeTitle } from '@/lib/gitApi';
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
import { collectWorkSessions, finishWorktreeWork, isWorkInWork, pickWorkSessionToOpen, trackWork } from './workActions';

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
 * What a worktree work's row knows and does, whatever draws it: the desktop
 * row with hover actions and menus, the phone's with swipe actions. The row
 * reads like a session row (live state, the task's name, its reference) and
 * opens what the user last worked on there.
 */
export function useWorktreeWork({ group, projectId, collapsed, onNavigate }: Args) {
  const { t } = useI18n();
  const worktree = group.worktree;
  const directory = normalizePath(group.directory ?? null);
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
  const current = useSessionUIStore((state): string | null => {
    if (state.currentSessionId) return sessions.some((session) => session.id === state.currentSessionId) ? CURRENT_SESSION : null;
    if (!state.newSessionDraft.open || !isPathWithinProject(state.newSessionDraft.directoryOverride, directory)) return null;
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

  const title = worktree?.title?.trim() || null;
  const branch = group.branch?.trim() || worktree?.branch?.trim() || null;
  // Until the task is named, the row reads as the session a click opens:
  // the task in the user's words. The branch is the last resort.
  const sessionToOpen = React.useMemo(() => pickWorkSessionToOpen(group.sessions), [group.sessions]);
  const label = title ?? (sessionToOpen?.title?.trim() || null) ?? branch ?? group.label;

  const prepare = (): void => {
    // Leaves a full-page surface (a run's overview, Archive), as selecting a
    // session row does, even when the session is already the current one.
    useUIStore.getState().closeMainSurfaces();
    if (projectId && projectId !== useProjectsStore.getState().activeProjectId) useProjectsStore.getState().setActiveProjectIdOnly(projectId);
    onNavigate();
  };
  const newChat = (): void => {
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
  const saveTitle = async (next: string): Promise<void> => {
    if (!group.directory || next.trim() === (title ?? '')) return;
    try {
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
  const finish = async (archive: boolean): Promise<void> => {
    if (!worktree || !project || finishing) return;
    setFinishing(true);
    try {
      const outcome = await finishWorktreeWork({ sessions, worktree, project: { id: project.id, path: project.path }, title: label, archive: archive && canArchive });
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
    workAction,
    activityState,
    runningSessionId,
    durationSessionId: runningSessionId ?? unreadSessionId,
    open,
    newChat,
    saveTitle,
    finish,
    toggleWork,
  };
}
