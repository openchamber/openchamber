import React from 'react';
import { DEFAULT_PIN_LIST } from '@/lib/sidebarSections';
import { toast } from '@/components/ui';
import { canArchiveWorktrees, setGitWorktreePinned, setGitWorktreeTitle } from '@/lib/gitApi';
import { useI18n } from '@/lib/i18n';
import { useWorktreeRemoving } from '@/lib/worktrees/worktreeRemovalState';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionDraftsStore } from '@/stores/useSessionDraftsStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { isChatCoveredByPage, useUIStore } from '@/stores/useUIStore';
import { useFirstSessionWithOpenTurn } from '@/sync/global-session-status';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { markSessionRead } from '@/sync/notification-store';
import { canSessionBeUnread, isSessionUnread, markSessionUnread } from '@/sync/session-unread';
import { useCollapsedSessionActivityState } from '../sessions/collapsedActivityState';
import { useGroupRefs } from '../projects/useGroupRefs';
import type { SessionGroup } from '../types';
import { formatProjectLabel, isPathWithinProject, normalizePath } from '../utils';
import { refreshSpacesJourney, useSpaceTakesNoNewSession } from '@/lib/spaces/spaces-store';
import { setSpaceTaskTitle } from '@/lib/spaces/spaces-api';
import { spaceOfCreationRequest } from '@/lib/spaces/space-creation-requests';
import { collectWorkSessions, finishSpaceWork, finishWorktreeWork, isWorkInWork, pickWorkSessionToOpen, trackWork, type FinishWorktreeWorkOutcome } from './workActions';

const CURRENT_SESSION = '\u0000session';

export const toastFinishWorkOutcome = (
  outcome: FinishWorktreeWorkOutcome,
  label: string,
  t: ReturnType<typeof useI18n>['t'],
): void => {
  switch (outcome.kind) {
    case 'done':
    case 'cancelled':
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
};

type Args = {
  group: SessionGroup;
  projectId: string | null;
  collapsed: boolean;
  onNavigate: () => void;
};

export function useWorktreeWork({ group, projectId, collapsed, onNavigate }: Args) {
  const { t } = useI18n();
  const worktree = group.worktree;
  const space = group.space ?? null;
  const directory = normalizePath(group.directory ?? null);
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
  const pinned = worktree?.pinnedAt !== undefined;
  const pinnedInWork = useSessionDisplayStore((state) => state.pinnedInWork);
  const canBeInWork = sessionWorkEnabled && (!pinned || pinnedInWork);
  const inWork = canBeInWork && isWorkInWork(sessions);
  const current = useSessionUIStore((state): string | null => {
    if (state.currentSessionId) return sessions.some((session) => session.id === state.currentSessionId) ? CURRENT_SESSION : null;
    if (!state.newSessionDraft.open) return null;
    const draftForThisSpace = space !== null && spaceOfCreationRequest(state.newSessionDraft.pendingWorktreeRequestId) === space.id;
    if (!draftForThisSpace && !isPathWithinProject(state.newSessionDraft.directoryOverride, directory)) return null;
    return state.newSessionDraft.workDraftId ?? '';
  });
  const openDraftHasRow = useSessionDraftsStore((state) => (
    Boolean(current) && current !== CURRENT_SESSION && state.drafts.some((draft) => draft.id === current)
  ));
  const chatCovered = useUIStore(isChatCoveredByPage);
  const isCurrent = current !== null && !chatCovered;
  const selected = isCurrent && (collapsed || (current !== CURRENT_SESSION && !openDraftHasRow));
  const [finishing, setFinishing] = React.useState(false);

  const title = space ? space.taskTitle?.title?.trim() || null : worktree?.title?.trim() || null;
  const branch = group.branch?.trim() || worktree?.branch?.trim() || null;
  const spaceName = space ? group.label : null;
  const nameByBranch = useSessionDisplayStore((state) => state.worktreeNameByBranch);
  const ownName = space ? spaceName : branch;
  const label = (nameByBranch ? ownName ?? title : title ?? ownName) ?? group.label;
  const secondName = [title, ownName].find((name) => name && name !== label) ?? null;
  const sessionToOpen = React.useMemo(() => pickWorkSessionToOpen(group.sessions), [group.sessions]);
  const canRename = true;
  const canNewChat = !spaceTakesNoNewSession;

  const prepare = (): void => {
    useUIStore.getState().closeMainSurfaces();
    if (projectId && projectId !== useProjectsStore.getState().activeProjectId) useProjectsStore.getState().setActiveProjectIdOnly(projectId);
    onNavigate();
  };
  const newChat = (): void => {
    if (!canNewChat) return;
    prepare();
    useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: projectId, directoryOverride: group.directory });
  };
  const openDirectory = sessionToOpen?.directory ?? directory;
  const open = (): void => {
    const session = sessionToOpen;
    if (!session) {
      newChat();
      return;
    }
    prepare();
    useSessionUIStore.getState().setCurrentSession(session.id, openDirectory);
  };
  const pinList = pinned ? worktree?.pinList ?? DEFAULT_PIN_LIST : null;
  const canPin = Boolean(group.directory && worktree?.branch?.trim()) && !worktreeRemoving;
  const setPin = async (pin: boolean, list: string | null = null): Promise<void> => {
    if (!group.directory || !canPin) return;
    try {
      await setGitWorktreePinned(group.directory, pin, list);
    } catch (error) {
      toast.error(pin ? t('sessions.sidebar.work.pin.failed') : t('sessions.sidebar.work.unpin.failed'), {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };
  const saveTitle = async (next: string): Promise<void> => {
    if (!group.directory || !next.trim() || next.trim() === (title ?? '')) return;
    try {
      if (space) {
        await setSpaceTaskTitle(space.id, next.trim());
        await refreshSpacesJourney();
        return;
      }
      await setGitWorktreeTitle(group.directory, next.trim());
    } catch (error) {
      toast.error(t('sessions.sidebar.work.rename.failed'), { description: error instanceof Error ? error.message : undefined });
    }
  };
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
      toastFinishWorkOutcome(await pending, label, t);
    } finally {
      setFinishing(false);
    }
  };
  const workAction = canBeInWork && (inWork || sessions.length > 0);
  const toggleWork = (): void => {
    if (inWork) {
      void finish(archiveOnDone && !pinned);
      return;
    }
    const session = sessionToOpen;
    if (!session) return;
    void trackWork(session).catch(() => toast.error(t('sessions.sidebar.work.track.failed')));
  };

  const activityState = useCollapsedSessionActivityState({ nodes: group.sessions });
  const workSessionIds = React.useMemo(() => sessions.flatMap((session) => (session.parentID ? [] : [session.id])), [sessions]);
  const runningSessionId = useFirstSessionWithOpenTurn(workSessionIds);
  const unreadSessionId = useGlobalSessionsStore(React.useCallback((state) => (
    workSessionIds.find((id) => isSessionUnread(state.entityById.get(id))) ?? null
  ), [workSessionIds]));

  const toggleRead = (): void => {
    const records = useGlobalSessionsStore.getState().entityById;
    if (unreadSessionId) {
      for (const id of workSessionIds) {
        if (isSessionUnread(records.get(id))) markSessionRead(id);
      }
      return;
    }
    let target: string | null = null;
    let targetRank: [number, number] = [-1, -1];
    for (const id of workSessionIds) {
      const record = records.get(id);
      if (!canSessionBeUnread(record)) continue;
      const rank: [number, number] = record.time.idle !== undefined ? [1, record.time.idle] : [0, record.time.updated];
      if (rank[0] > targetRank[0] || (rank[0] === targetRank[0] && rank[1] > targetRank[1])) {
        target = id;
        targetRank = rank;
      }
    }
    if (!target) return;
    void markSessionUnread(target).then((saved) => {
      if (!saved) toast.error(t('sessions.sidebar.session.unread.markFailed'));
    });
  };

  return {
    worktree,
    space,
    spaceName,
    canRename,
    canNewChat,
    directory,
    openDirectory,
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
    secondName,
    finishing,
    canArchive,
    pinned,
    canPin,
    workAction,
    activityState,
    runningSessionId,
    durationSessionId: runningSessionId ?? unreadSessionId,
    hasUnread: unreadSessionId !== null,
    canMarkUnread: workSessionIds.length > 0,
    toggleRead,
    open,
    newChat,
    saveTitle,
    setPin,
    pinList,
    finish,
    toggleWork,
  };
}
