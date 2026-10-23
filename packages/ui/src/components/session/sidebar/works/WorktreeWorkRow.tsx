import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { FileTreeChevron } from '@/components/views/files/FileTreeRowParts';
import { handleSessionRenameKeyDown } from '@/components/session/sessionRenameKeyboard';
import { useOpenTrackerItem } from '@/components/sourceBoard/openTrackerItem';
import { useShiftKeyHeld } from '@/hooks/useShiftKeyHeld';
import { setGitWorktreeTitle } from '@/lib/gitApi';
import { useI18n } from '@/lib/i18n';
import { sessionEvents } from '@/lib/sessionEvents';
import { refTintStyle } from '@/lib/source-control/prVisualState';
import { cn } from '@/lib/utils';
import { useWorktreeRemoving } from '@/lib/worktrees/worktreeRemovalState';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useSessionDraftsStore } from '@/stores/useSessionDraftsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { DirectoryActionIndicator } from '../sessions/DirectoryActionIndicator';
import { CollapsedActivityIndicator } from '../sessions/collapsedActivityIndicator';
import { useCollapsedSessionActivityState } from '../sessions/collapsedActivityState';
import { SessionActivityDuration } from '@/components/session/SessionActivityDuration';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { isSessionUnread } from '@/sync/session-unread';
import { SIDEBAR_REF_TOOLTIP_CLOSE_DELAY_MS, SidebarRefLinks } from '../sessions/SidebarRefLinks';
import { RowMarkTooltip } from '../sessions/RowMarkTooltip';
import { sessionTreeRowPaddingLeft } from '../sessions/sessionTreeGeometry';
import { useGroupRefs } from '../projects/useGroupRefs';
import type { SortableDragHandleProps } from '../projects/sortableItems';
import type { SessionGroup } from '../types';
import { formatProjectLabel, isPathWithinProject, normalizePath, renderHighlightedText } from '../utils';
import { collectWorkSessions, finishWorktreeWork, isWorkInWork, pickWorkSessionToOpen, trackWork } from './workActions';
import { worktreeFolderMemberId } from './sidebarWorks';

const NO_FOLDERS: never[] = [];

type WorkMenuSlots = {
  Item: React.ComponentType<{ className?: string; onClick?: (event: React.MouseEvent) => void; children?: React.ReactNode }>;
  Separator: React.ComponentType;
  Sub: React.ComponentType<{ children?: React.ReactNode }>;
  SubTrigger: React.ComponentType<{ children?: React.ReactNode }>;
  SubContent: React.ComponentType<{ className?: string; children?: React.ReactNode }>;
};

const DROPDOWN_SLOTS: WorkMenuSlots = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
};

const CONTEXT_MENU_SLOTS: WorkMenuSlots = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
};
const CURRENT_SESSION = '\u0000session';

type Props = {
  group: SessionGroup;
  groupKey: string;
  projectId: string | null;
  depth: number;
  collapsed: boolean;
  forceExpanded: boolean;
  empty: boolean;
  normalizedSessionSearchQuery: string;
  alwaysShowActions: boolean;
  mobileVariant: boolean;
  dragHandleProps?: SortableDragHandleProps | null;
  onToggle: (groupKey: string) => void;
  openNewSessionDraft: (options?: { selectedProjectId?: string | null; directoryOverride?: string | null }) => void;
  setActiveProjectIdOnly: (id: string) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
  activeProjectId: string | null;
};

/**
 * A worktree work: one row for the worktree and every session in it. It reads
 * like a session row (live state in the tree slot, the task's name, its PR
 * and time on one line) and opens what the user last worked on there; the
 * chevron in the slot opens the sessions under it. A worktree the agent has
 * not named yet shows its branch.
 */
export function WorktreeWorkRow(props: Props): React.ReactNode {
  const {
    group,
    groupKey,
    projectId,
    depth,
    collapsed,
    forceExpanded,
    empty,
    normalizedSessionSearchQuery,
    alwaysShowActions,
    mobileVariant,
    dragHandleProps,
    onToggle,
    openNewSessionDraft,
    setActiveProjectIdOnly,
    setSessionSwitcherOpen,
    activeProjectId,
  } = props;
  const { t } = useI18n();
  const openTrackerItem = useOpenTrackerItem();
  const shiftHeld = useShiftKeyHeld();
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
  const isCurrent = current !== null;
  // The work's row is selected while nothing under it shows the selection:
  // folded, or on a draft that has no row yet (a worktree just made).
  const selected = isCurrent && (collapsed || (current !== CURRENT_SESSION && !openDraftHasRow));
  // Folders of the project root can hold whole worktrees, filed by member id.
  const folderScopeKey = normalizePath(project?.path ?? null);
  const folderMemberId = worktreeFolderMemberId(directory);
  const projectFolders = useSessionFoldersStore((state) => (folderScopeKey ? state.foldersMap[folderScopeKey] ?? NO_FOLDERS : NO_FOLDERS));
  const currentFolderId = folderMemberId ? projectFolders.find((folder) => folder.sessionIds.includes(folderMemberId))?.id ?? null : null;
  const moveToFolder = (folderId: string | null): void => {
    if (!folderScopeKey || !folderMemberId) return;
    const folders = useSessionFoldersStore.getState();
    if (folderId) folders.addSessionToFolder(folderScopeKey, folderId, folderMemberId);
    else folders.removeSessionFromFolder(folderScopeKey, folderMemberId);
  };
  const [renaming, setRenaming] = React.useState(false);
  const renameInputRef = React.useRef<HTMLInputElement>(null);
  // Focused once the menu that started it has closed and returned focus.
  React.useEffect(() => {
    if (!renaming) return;
    const frame = requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [renaming]);
  const [renameDraft, setRenameDraft] = React.useState('');
  const [finishing, setFinishing] = React.useState(false);

  const title = worktree?.title?.trim() || null;
  const branch = group.branch?.trim() || worktree?.branch?.trim() || null;
  // Until the task is named, the row reads as the session a click opens:
  // the task in the user's words. The branch is the last resort and the
  // tooltip's second line.
  const sessionToOpen = React.useMemo(() => pickWorkSessionToOpen(group.sessions), [group.sessions]);
  const label = title ?? (sessionToOpen?.title?.trim() || null) ?? branch ?? group.label;
  const expandable = !empty;
  const expanded = forceExpanded || !collapsed;

  const prepare = (): void => {
    if (projectId && projectId !== activeProjectId) setActiveProjectIdOnly(projectId);
    if (mobileVariant) setSessionSwitcherOpen(false);
  };
  const openWork = (): void => {
    if (renaming) return;
    prepare();
    const session = sessionToOpen;
    if (session) {
      useSessionUIStore.getState().setCurrentSession(session.id, session.directory ?? directory);
      return;
    }
    openNewSessionDraft({ selectedProjectId: projectId, directoryOverride: group.directory });
  };
  const newChat = (event: React.MouseEvent): void => {
    event.stopPropagation();
    prepare();
    openNewSessionDraft({ selectedProjectId: projectId, directoryOverride: group.directory });
  };
  const startRename = (): void => {
    setRenameDraft(title ?? '');
    setRenaming(true);
  };
  const saveRename = async (): Promise<void> => {
    setRenaming(false);
    if (!group.directory || renameDraft.trim() === (title ?? '')) return;
    try {
      await setGitWorktreeTitle(group.directory, renameDraft.trim());
    } catch (error) {
      toast.error(t('sessions.sidebar.work.rename.failed'), { description: error instanceof Error ? error.message : undefined });
    }
  };
  const finish = async (): Promise<void> => {
    if (!worktree || !project || finishing) return;
    setFinishing(true);
    try {
      const outcome = await finishWorktreeWork({ sessions, worktree, project: { id: project.id, path: project.path } });
      switch (outcome.kind) {
        case 'removed':
          toast.success(t('sessions.sidebar.work.done.removed', { label }));
          break;
        case 'busy':
          toast.info(t('sessions.sidebar.work.done.keptRunning', { label }));
          break;
        case 'ask':
          // Done already; whether the worktree goes is the user's call, in
          // the dialog that shows what removing it would lose.
          sessionEvents.requestDelete({ sessions, mode: 'worktree', worktree });
          break;
        case 'failed':
          toast.error(outcome.doneFailed > 0 ? t('sessions.sidebar.work.done.failed') : t('sessions.sidebar.work.done.removeFailed'), {
            description: outcome.error.message,
          });
          break;
      }
    } finally {
      setFinishing(false);
    }
  };
  const toggleWork = (event: React.MouseEvent): void => {
    event.stopPropagation();
    if (inWork) {
      void finish();
      return;
    }
    const session = sessionToOpen;
    if (!session) return;
    void trackWork(session).catch(() => toast.error(t('sessions.sidebar.work.track.failed')));
  };
  const deleteWorktree = (event: { shiftKey?: boolean }): void => {
    if (!worktree) return;
    sessionEvents.requestDelete({ sessions, mode: 'worktree', worktree, skipDialogIfSafe: shiftHeld || event.shiftKey === true });
  };

  // Its sessions' live state, as a session row shows its own: in the slot,
  // in place of the worktree mark, with the turn's duration at the end.
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
  const durationSessionId = runningSessionId ?? unreadSessionId;
  const stateMark = worktreeRemoving || finishing
    ? <Spinner className="h-3.5 w-3.5" />
    : activityState ? <CollapsedActivityIndicator state={activityState} /> : null;
  // The slot holds the live state while there is one, otherwise the worktree
  // mark tinted by the branch's PR, so the title starts where session titles
  // do; the chevron takes its place while the row is hovered or focused, when
  // there is something to open. Touch layouts have no hover and keep the
  // chevron.
  const slotMark = stateMark ?? (
    <Icon
      name="git-branch"
      className={cn('h-3.5 w-3.5 flex-shrink-0', refs.prColor ? 'oc-ref-tint' : 'text-muted-foreground/70')}
      style={refs.prColor ? refTintStyle(refs.prColor) : undefined}
      aria-hidden={false}
      role="img"
      aria-label={t('sessions.sidebar.work.worktreeMark')}
    />
  );
  const chevron = expandable ? (
    <span
      role="button"
      tabIndex={0}
      className={cn(
        'inline-flex h-3.5 w-3.5 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        !alwaysShowActions && 'absolute inset-0 opacity-0 transition-opacity group-hover/work:opacity-100 group-has-[:focus-visible]/work:opacity-100',
      )}
      aria-label={expanded ? t('sessions.sidebar.group.collapseAria', { label }) : t('sessions.sidebar.group.expandAria', { label })}
      aria-expanded={expanded}
      onClick={(event) => {
        event.stopPropagation();
        if (!forceExpanded) onToggle(groupKey);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        if (!forceExpanded) onToggle(groupKey);
      }}
    >
      <FileTreeChevron expanded={expanded} />
    </span>
  ) : null;
  const slot = (
    <span className="relative inline-flex size-3.5 flex-shrink-0 items-center justify-center">
      {alwaysShowActions ? chevron ?? slotMark : <>
        <span className={cn('inline-flex items-center justify-center', expandable && 'transition-opacity group-hover/work:opacity-0 group-has-[:focus-visible]/work:opacity-0')}>{slotMark}</span>
        {chevron}
      </>}
    </span>
  );
  // One line leaves no room for a reference's text: its mark alone, in the
  // state's colour, named by its tooltip; a click opens it.
  const refMark = refs.prSummary
    ? { icon: 'git-pull-request' as const, color: refs.prColor, label: refs.prLabel ?? refs.prReference, url: refs.prSummary.url }
    : refs.primaryIssue
      ? { icon: refs.primaryIssue.icon, color: refs.primaryIssue.color, label: refs.issueItems.map((item) => item.text).join(', '), url: refs.primaryIssue.url }
      : null;
  const ref = refMark ? (
    <RowMarkTooltip label={refMark.label}>
      <button
        type="button"
        className={cn('inline-flex flex-shrink-0 items-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default', refMark.color ? 'oc-ref-tint' : 'text-muted-foreground')}
        style={refMark.color ? refTintStyle(refMark.color) : undefined}
        disabled={!refMark.url}
        aria-label={refMark.label}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          if (refMark.url) openTrackerItem(refMark.url, project?.path ?? group.directory ?? null, event);
        }}
      >
        <Icon name={refMark.icon} className="h-3 w-3" />
      </button>
    </RowMarkTooltip>
  ) : null;
  const tooltipLinks = refs.prSummary ? refs.prLinks : refs.issueItems;
  // Hover actions cross-fade over the meta at the row's end; the title's
  // tail fades under them (`oc-actions-mask`), so nothing moves.
  const hasWorkAction = sessionWorkEnabled && (inWork || sessions.length > 0);
  const actionsReserve = hasWorkAction ? '[--oc-actions-reserve:2.875rem]' : '[--oc-actions-reserve:1.75rem]';
  const hideOnHover = alwaysShowActions ? undefined : 'transition-opacity group-hover/work:opacity-0 group-has-[:focus-visible]/work:opacity-0';
  const maskOnHover = alwaysShowActions ? undefined : 'group-hover/work:oc-actions-mask group-has-[:focus-visible]/work:oc-actions-mask';
  const actionButtonClass = cn(
    'inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    alwaysShowActions ? 'h-6 w-6' : 'h-4 w-4',
  );
  const actionIconClass = alwaysShowActions ? 'h-3.5 w-3.5' : 'h-2.5 w-2.5';

  // One set of items for the "⋯" menu and the right-click menu.
  const renderMenuItems = (Slots: WorkMenuSlots): React.ReactNode => (
    <>
      <Slots.Item onClick={startRename}>
        <Icon name="edit" className="h-4 w-4" />
        <span>{t('sessions.sidebar.work.menu.rename')}</span>
      </Slots.Item>
      {projectFolders.length > 0 ? (
        <Slots.Sub>
          <Slots.SubTrigger>
            <Icon name="folder" className="h-4 w-4" />
            <span>{t('sessions.sidebar.folders.moveToFolder')}</span>
          </Slots.SubTrigger>
          <Slots.SubContent className="min-w-[160px]">
            {projectFolders.map((folder) => (
              <Slots.Item key={folder.id} onClick={() => moveToFolder(folder.id)} className="flex items-center justify-between">
                <span className="min-w-0 truncate">{folder.name}</span>
                {folder.id === currentFolderId ? <Icon name="check" className="h-4 w-4 text-primary" /> : null}
              </Slots.Item>
            ))}
            {currentFolderId ? <>
              <Slots.Separator />
              <Slots.Item onClick={() => moveToFolder(null)}>
                <span>{t('sessions.sidebar.folders.removeFromFolder')}</span>
              </Slots.Item>
            </> : null}
          </Slots.SubContent>
        </Slots.Sub>
      ) : null}
      {worktree && !worktreeRemoving ? <>
        <Slots.Separator />
        <Slots.Item
          className={cn(shiftHeld && 'text-destructive')}
          onClick={(event) => deleteWorktree(event)}
        >
          <Icon name="delete-bin" className="h-4 w-4" />
          <span>{shiftHeld ? t('sessions.sidebar.group.actions.deleteWorktreeAndBranch') : t('sessions.sidebar.group.actions.deleteWorktree')}</span>
        </Slots.Item>
      </> : null}
    </>
  );
  const titleNode = renaming ? (
    <form
      className="flex min-w-0 flex-1 items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        void saveRename();
      }}
      onClick={(event) => event.stopPropagation()}
    >
      {/* Saved with Enter or the check, like a session's rename: a menu
          closing hands focus back to its trigger, so a blur is no answer. */}
      <input
        ref={renameInputRef}
        value={renameDraft}
        onChange={(event) => setRenameDraft(event.target.value)}
        onKeyDown={(event) => handleSessionRenameKeyDown(event, () => setRenaming(false))}
        className="min-w-0 flex-1 bg-transparent typography-ui-label text-foreground outline-none placeholder:text-muted-foreground"
        placeholder={branch ?? t('sessions.sidebar.work.rename.placeholder')}
        aria-label={t('sessions.sidebar.work.rename.aria')}
      />
      <button
        type="submit"
        aria-label={t('sessions.sidebar.session.rename.save')}
        title={t('sessions.sidebar.session.rename.save')}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        <Icon name="check" className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={() => setRenaming(false)}
        aria-label={t('sessions.sidebar.session.rename.cancel')}
        title={t('sessions.sidebar.session.rename.cancel')}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        <Icon name="close" className="size-3.5" />
      </button>
    </form>
  ) : (
    <span
      dir="auto"
      className={cn(
        'oc-ui-start-align min-w-0 flex-1 truncate',
        'typography-ui-label',
        // The title carries the state as a session's does: news or a request
        // waiting on the user in semibold, a running turn at full strength.
        selected
          ? 'text-interactive-selection-foreground'
          : activityState === 'unread' || activityState === 'permission' || activityState === 'form'
            ? 'font-semibold text-foreground'
            : activityState === 'active' ? 'text-foreground' : 'text-muted-foreground',
        maskOnHover,
      )}
    >
      {renderHighlightedText(label, normalizedSessionSearchQuery)}
    </span>
  );

  return (
    <ContextMenu disabled={renaming}>
    <ContextMenuTrigger render={<div className={cn(worktreeRemoving && 'opacity-60')} aria-busy={worktreeRemoving || undefined} />}>
      <div
        ref={dragHandleProps?.setActivatorNodeRef}
        {...(dragHandleProps?.listeners ?? {})}
        style={{ paddingInlineStart: sessionTreeRowPaddingLeft(depth) }}
        className={cn(
          // The same box as a session row in the same place: zone rows are a
          // little taller than tree rows.
          'oc-ref-tint-scope group/work relative my-0.5 flex cursor-pointer items-center gap-1.5 rounded-md pe-2.5',
          'py-1.5',
          selected ? 'bg-interactive-selection/70' : 'hover:bg-interactive-hover/60',
        )}
      >
        {slot}
        <Tooltip>
          <TooltipTrigger asChild closeDelay={SIDEBAR_REF_TOOLTIP_CLOSE_DELAY_MS}>
            <div
              role="button"
              tabIndex={0}
              className={cn('@container relative flex h-5 min-w-0 flex-1 items-center gap-1 focus-visible:outline-none', actionsReserve)}
              aria-label={t('sessions.sidebar.work.openAria', { label })}
              onClick={openWork}
              onDoubleClick={(event) => {
                event.stopPropagation();
                startRename();
              }}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
                event.preventDefault();
                openWork();
              }}
            >
              {titleNode}
              <span className={cn('ms-auto flex flex-shrink-0 items-center gap-1', renaming && 'hidden', alwaysShowActions ? (hasWorkAction ? 'pe-20' : 'pe-14') : hideOnHover)}>
                {group.worktree?.worktreeStatus === 'missing' ? (
                  <span className="inline-flex items-center text-status-warning" title={t('sessions.sidebar.group.worktreeMissing')} aria-label={t('sessions.sidebar.group.worktreeMissing')}>
                    <Icon name="alert" className="h-3 w-3" />
                  </span>
                ) : null}
                {ref}
                {group.directory ? <DirectoryActionIndicator directory={group.directory} /> : null}
                {/* Touch layouts keep the chevron in the slot, so the state moves here. */}
                {alwaysShowActions && expandable && stateMark ? <span className="inline-flex">{stateMark}</span> : null}
                {durationSessionId ? (
                  <SessionActivityDuration sessionId={durationSessionId} running={Boolean(runningSessionId)} className="typography-micro" />
                ) : null}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8} className="max-w-xs text-start">
            <div className="flex min-w-44 flex-col gap-1.5 text-start text-xs">
              <span dir="auto" className="oc-ui-start-align min-w-0 truncate font-medium text-foreground">{label}</span>
              {projectLabel ? (
                <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                  <Icon name="folder" className="h-3 w-3 flex-shrink-0" />
                  <span className="min-w-0 truncate">{projectLabel}</span>
                </div>
              ) : null}
              {branch ? (
                <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                  <Icon name="git-branch" className="h-3 w-3 flex-shrink-0" />
                  <span className="min-w-0 truncate">{branch}</span>
                </div>
              ) : null}
              {tooltipLinks.length > 0 ? <SidebarRefLinks items={tooltipLinks} directory={project?.path ?? group.directory ?? null} /> : null}
            </div>
          </TooltipContent>
        </Tooltip>
        {/* Renaming has its own save and cancel at the row's end. */}
        <div className={cn(
          'absolute inset-e-1 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5 transition-opacity',
          renaming && 'hidden',
          alwaysShowActions ? 'opacity-100' : 'opacity-0 group-hover/work:opacity-100 group-has-[:focus-visible]/work:opacity-100 has-[[data-popup-open]]:opacity-100',
        )}>
          <TooltipProvider delayDuration={400}>
            {sessionWorkEnabled && (inWork || sessions.length > 0) ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={cn(actionButtonClass, inWork && 'text-status-success hover:text-status-success')}
                    aria-label={inWork ? t('sessions.sidebar.session.work.markDone') : t('sessions.sidebar.session.work.track')}
                    disabled={finishing || worktreeRemoving}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={toggleWork}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    <Icon name={inWork ? 'check' : 'eye'} className={inWork ? (alwaysShowActions ? 'h-4 w-4' : 'h-3 w-3') : actionIconClass} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6}>
                  {inWork ? t('sessions.sidebar.session.work.markDone') : t('sessions.sidebar.session.work.track')}
                </TooltipContent>
              </Tooltip>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className={actionButtonClass}
                  aria-label={t('sessions.sidebar.group.actions.newDraftInGroupAria', { label })}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={newChat}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <Icon name="add" className={alwaysShowActions ? 'h-4 w-4' : 'h-3 w-3'} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>{t('sessions.sidebar.project.actions.newDraftSession')}</TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={actionButtonClass}
                  aria-label={t('sessions.sidebar.work.menu.label', { label })}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <Icon name="more-2" className={actionIconClass} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[180px]">
                {renderMenuItems(DROPDOWN_SLOTS)}
              </DropdownMenuContent>
            </DropdownMenu>
          </TooltipProvider>
        </div>
      </div>
    </ContextMenuTrigger>
    <ContextMenuContent className="min-w-[180px]">
      {renderMenuItems(CONTEXT_MENU_SLOTS)}
    </ContextMenuContent>
    </ContextMenu>
  );
}
