import React from 'react';
import { Icon } from '@/components/icon/Icon';
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
import { useI18n } from '@/lib/i18n';
import { sessionEvents } from '@/lib/sessionEvents';
import { refTintStyle } from '@/lib/source-control/prVisualState';
import { cn } from '@/lib/utils';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { DirectoryActionIndicator } from '../sessions/DirectoryActionIndicator';
import { CollapsedActivityIndicator } from '../sessions/collapsedActivityIndicator';
import { SessionActivityDuration } from '@/components/session/SessionActivityDuration';
import { SIDEBAR_REF_TOOLTIP_CLOSE_DELAY_MS, SidebarRefLinks } from '../sessions/SidebarRefLinks';
import { RowMarkTooltip } from '../sessions/RowMarkTooltip';
import { isRowBoxClick } from '../sessions/rowBoxClick';
import { TimelineProjectIcon } from '../sessions/SessionTimelineRowBody';
import { sessionDetailedRowPaddingLeft, sessionTreeRowPaddingLeft } from '../sessions/sessionTreeGeometry';
import type { SessionGroup } from '../types';
import { normalizePath, renderHighlightedText } from '../utils';
import { useWorktreeWork } from './useWorktreeWork';
import { worktreeFolderMemberId } from './sidebarWorks';
import { SpaceMenuItems } from '@/components/session/spaces/SpaceActions';
import { SpaceStatusLines, SpaceStatusMark } from '@/components/session/spaces/SpaceStatus';

const NO_FOLDERS: never[] = [];

type WorkMenuSlots = {
  Item: React.ComponentType<{ className?: string; disabled?: boolean; onClick?: (event: React.MouseEvent) => void; children?: React.ReactNode }>;
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

type Props = {
  group: SessionGroup;
  groupKey: string;
  projectId: string | null;
  depth: number;
  /** Two lines, as the detailed rows around it: the project (in a zone), branch and reference go to the second. */
  detailed: boolean;
  /** Listed among other projects' works (In work, the list by time), so it names its project. */
  mixed: boolean;
  collapsed: boolean;
  forceExpanded: boolean;
  empty: boolean;
  normalizedSessionSearchQuery: string;
  alwaysShowActions: boolean;
  mobileVariant: boolean;
  onToggle: (groupKey: string) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
};

/**
 * A worktree work: one row for the worktree and every session in it. It reads
 * like a session row (live state in the tree slot, the task's name, its PR
 * and time on one line) and opens what the user last worked on there; the
 * chevron in the slot opens the sessions under it. A worktree the agent has
 * not named yet shows its branch. With detailed zone rows it takes their two
 * lines: the second names the project, the branch and the reference, as a
 * detailed session row's does, while its sessions stay one-line rows under it.
 *
 * An isolated space is a work the same way and has this row too: its instance
 * icon where the worktree mark goes, its task's name for the title (its own
 * name under it, where a worktree's branch goes), its state as one mark
 * at the end (`SpaceStatusMark`), and the space's actions for the menu.
 */
export function WorktreeWorkRow(props: Props): React.ReactNode {
  const {
    group,
    groupKey,
    projectId,
    depth,
    detailed,
    mixed,
    collapsed,
    forceExpanded,
    empty,
    normalizedSessionSearchQuery,
    alwaysShowActions,
    mobileVariant,
    onToggle,
    setSessionSwitcherOpen,
  } = props;
  const { t } = useI18n();
  const openTrackerItem = useOpenTrackerItem();
  const shiftHeld = useShiftKeyHeld();
  const work = useWorktreeWork({
    group,
    projectId,
    collapsed,
    onNavigate: () => {
      if (mobileVariant) setSessionSwitcherOpen(false);
    },
  });
  const {
    worktree, space, spaceName, directory, worktreeRemoving, sessions, project, projectLabel, refs, selected,
    title, branch, label, finishing, canArchive, canRename, canNewChat, pinned, canPin, workAction, inWork, activityState,
    runningSessionId, durationSessionId,
  } = work;
  // With the Pinned section shown a pinned work is listed there, whose header
  // already says so; otherwise the row carries the mark, as a session's does.
  const pinnedSectionShown = useSessionDisplayStore((state) => state.showPinnedSection);
  const pinnedLabel = t('sessions.sidebar.session.status.pinned');
  const pinnedMark = pinned && !pinnedSectionShown ? (
    <RowMarkTooltip label={pinnedLabel}>
      <span className="inline-flex flex-shrink-0 items-center" aria-label={pinnedLabel}>
        <Icon name="pushpin" className="h-3 w-3 text-primary" />
      </span>
    </RowMarkTooltip>
  ) : null;
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
  const expandable = !empty;
  const expanded = forceExpanded || !collapsed;

  const openWork = (): void => {
    if (!renaming) work.open();
  };
  const newChat = (event: React.MouseEvent): void => {
    event.stopPropagation();
    work.newChat();
  };
  const startRename = (): void => {
    if (!canRename) return;
    setRenameDraft(title ?? '');
    setRenaming(true);
  };
  const saveRename = async (): Promise<void> => {
    setRenaming(false);
    await work.saveTitle(renameDraft);
  };
  const finish = work.finish;
  const shiftArchive = shiftHeld && canArchive;
  const toggleWork = (event: React.MouseEvent): void => {
    event.stopPropagation();
    work.toggleWork();
  };
  const deleteWorktree = (event: { shiftKey?: boolean }): void => {
    if (!worktree) return;
    sessionEvents.requestDelete({ sessions, mode: 'worktree', worktree, skipDialogIfSafe: shiftHeld || event.shiftKey === true });
  };

  // The live state sits on the right before the time, as on every row.
  const stateMark = worktreeRemoving || finishing
    ? <Spinner className="h-3 w-3" />
    : activityState ? <CollapsedActivityIndicator state={activityState} /> : null;
  // The slot always says what the row is: the worktree mark tinted by the
  // branch's PR, or a space's instance icon, so the title starts where session titles
  // do and a running work never reads as a chat; the chevron takes its place
  // while the row is hovered or focused, when there is something to open.
  // Touch layouts have no hover and keep the chevron.
  const workMark = (className: string) => space ? (
    <Icon name="instance" className={cn(className, 'flex-shrink-0 text-muted-foreground')} aria-hidden={false} role="img" aria-label={t('sessions.sidebar.group.space')} />
  ) : (
    <Icon
      name="git-branch"
      className={cn(className, 'flex-shrink-0', refs.prColor ? 'oc-ref-tint' : 'text-muted-foreground')}
      style={refs.prColor ? refTintStyle(refs.prColor) : undefined}
      aria-hidden={false}
      role="img"
      aria-label={t('sessions.sidebar.work.worktreeMark')}
    />
  );
  const slotMark = workMark('h-3.5 w-3.5');
  const chevron = expandable ? (
    <span
      role="button"
      tabIndex={0}
      className={cn(
        'inline-flex h-3.5 w-3.5 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        !alwaysShowActions && 'absolute inset-0 opacity-0 group-hover/work:opacity-100 group-has-[:focus-visible]/work:opacity-100',
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
  // A detailed row has no slot: its state sits at the end of the first line
  // and its chevron takes the place of the second line's first icon (the
  // project's in a zone, else the worktree mark) while the row is hovered.
  const leadIcon = mixed && project
    ? <TimelineProjectIcon project={project} label={projectLabel} />
    : workMark('h-3 w-3');
  const lead = expandable ? (
    <span className="relative inline-flex size-3 flex-shrink-0 items-center justify-center">
      <span className={cn('inline-flex', alwaysShowActions ? 'opacity-0' : 'group-hover/work:opacity-0 group-has-[:focus-visible]/work:opacity-0')}>{leadIcon}</span>
      <span
        role="button"
        tabIndex={0}
        className={cn(
          'absolute inset-0 inline-flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none',
          !alwaysShowActions && 'opacity-0 group-hover/work:opacity-100 group-has-[:focus-visible]/work:opacity-100',
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
    </span>
  ) : leadIcon;
  const slot = (
    <span className="relative inline-flex size-3.5 flex-shrink-0 items-center justify-center">
      {alwaysShowActions ? chevron ?? slotMark : <>
        <span className={cn('inline-flex items-center justify-center', expandable && 'group-hover/work:opacity-0 group-has-[:focus-visible]/work:opacity-0')}>{slotMark}</span>
        {chevron}
      </>}
    </span>
  );
  // One line leaves no room for a reference's text: its mark alone, in the
  // state's colour, named by its tooltip; a click opens it.
  // The second line of a detailed row has room for its number too, which
  // stays neutral: the mark alone carries the state.
  const refMark = refs.prSummary
    ? { icon: 'git-pull-request' as const, color: refs.prColor, label: refs.prLabel ?? refs.prReference, text: refs.prReference, url: refs.prSummary.url }
    : refs.primaryIssue
      ? { icon: refs.primaryIssue.icon, color: refs.primaryIssue.color, label: refs.issueItems.map((item) => item.text).join(', '), text: refs.primaryIssue.label, url: refs.primaryIssue.url }
      : null;
  const ref = refMark ? (
    <RowMarkTooltip label={refMark.label}>
      <button
        type="button"
        className="inline-flex flex-shrink-0 items-center gap-0.5 rounded typography-micro text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
        disabled={!refMark.url}
        aria-label={refMark.label}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          if (refMark.url) openTrackerItem(refMark.url, project?.path ?? group.directory ?? null, event);
        }}
      >
        <Icon name={refMark.icon} className={cn('h-3 w-3', refMark.color && 'oc-ref-tint')} style={refMark.color ? refTintStyle(refMark.color) : undefined} />
        {detailed && refMark.text ? <span className="leading-none tabular-nums">{refMark.text}</span> : null}
      </button>
    </RowMarkTooltip>
  ) : null;
  const tooltipLinks = refs.prSummary ? refs.prLinks : refs.issueItems;
  // Hover actions swap in over the meta at the row's end; the title's
  // tail fades under them (`oc-actions-mask`), so nothing moves.
  const hasWorkAction = workAction;
  const actionsReserve = hasWorkAction ? '[--oc-actions-reserve:2.875rem]' : '[--oc-actions-reserve:1.75rem]';
  const hideOnHover = alwaysShowActions ? undefined : 'group-hover/work:opacity-0 group-has-[:focus-visible]/work:opacity-0';
  const maskOnHover = alwaysShowActions ? undefined : 'group-hover/work:oc-actions-mask group-has-[:focus-visible]/work:oc-actions-mask';
  const actionButtonClass = cn(
    'inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    alwaysShowActions ? 'h-6 w-6' : 'h-4 w-4',
  );
  const actionIconClass = alwaysShowActions ? 'h-3.5 w-3.5' : 'h-2.5 w-2.5';

  // One set of items for the "⋯" menu and the right-click menu.
  const renderMenuItems = (Slots: WorkMenuSlots): React.ReactNode => (
    <>
      {canRename ? (
        <Slots.Item onClick={startRename}>
          <Icon name="edit" className="h-4 w-4" />
          <span>{t('sessions.sidebar.work.menu.rename')}</span>
        </Slots.Item>
      ) : null}
      {canPin ? (
        <Slots.Item onClick={() => { void work.togglePin(); }}>
          <Icon name={pinned ? 'unpin' : 'pushpin'} className="h-4 w-4" />
          <span>{pinned ? t('sessions.sidebar.work.menu.unpin') : t('sessions.sidebar.work.menu.pin')}</span>
        </Slots.Item>
      ) : null}
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
      {space ? <>
        {projectFolders.length > 0 ? <Slots.Separator /> : null}
        <SpaceMenuItems spaceId={space.id} slots={Slots} />
      </> : null}
      {worktree && !worktreeRemoving ? <>
        <Slots.Separator />
        {canArchive ? (
          <Slots.Item onClick={() => { void finish(true); }}>
            <Icon name="archive" className="h-4 w-4" />
            <span>{t('sessions.sidebar.work.menu.archive')}</span>
          </Slots.Item>
        ) : null}
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
        placeholder={branch ?? spaceName ?? t('sessions.sidebar.work.rename.placeholder')}
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
            : activityState === 'active' ? 'text-foreground' : 'oc-title-rest',
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
        style={{ paddingInlineStart: detailed ? sessionDetailedRowPaddingLeft(depth) : sessionTreeRowPaddingLeft(depth) }}
        // The whole box opens the work, its second line and paddings too.
        onClick={(event) => {
          if (isRowBoxClick(event)) openWork();
        }}
        className={cn(
          // The same box as a session row in the same place: zone rows are a
          // little taller than tree rows.
          'group/work relative my-0.5 flex cursor-pointer select-none rounded-md pe-2.5',
          'py-1.5',
          detailed ? 'flex-col gap-px' : 'items-center gap-1.5',
          selected ? 'bg-interactive-selection/70' : 'hover:bg-interactive-hover/60',
        )}
      >
        <div className={cn('flex w-full min-w-0 flex-1 items-center gap-1.5', detailed && 'h-5')}>
        {detailed ? null : slot}
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
                {space ? <SpaceStatusMark spaceId={space.id} /> : null}
                {pinnedMark}
                {detailed ? null : ref}
                {group.directory ? <DirectoryActionIndicator directory={group.directory} /> : null}
                {stateMark ? <span className="inline-flex">{stateMark}</span> : null}
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
              {spaceName ? (
                <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                  <Icon name="instance" className="h-3 w-3 flex-shrink-0" />
                  <span className="min-w-0 truncate">{spaceName}</span>
                </div>
              ) : null}
              {tooltipLinks.length > 0 ? <SidebarRefLinks items={tooltipLinks} directory={project?.path ?? group.directory ?? null} /> : null}
              {space ? <SpaceStatusLines spaceId={space.id} /> : null}
            </div>
          </TooltipContent>
        </Tooltip>
        </div>
        {detailed ? (
          // Fixed 16px, always rendered, like a detailed session row's second
          // line: the lead icon (or the chevron), then the branch, left out
          // where it already is the title.
          <div className="flex h-4 w-full min-w-0 items-center gap-1">
            {lead}
            {mixed && project && space ? workMark('h-3 w-3') : null}
            {mixed && project && branch && branch !== label ? (
              <Icon name="git-branch" className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
            ) : null}
            {branch && branch !== label ? (
              <span className="min-w-0 truncate typography-micro text-muted-foreground">{branch}</span>
            ) : null}
            {spaceName && spaceName !== label ? (
              <span className="min-w-0 truncate typography-micro text-muted-foreground">{spaceName}</span>
            ) : null}
            <span className="ms-auto flex flex-shrink-0 items-center gap-1">{ref}</span>
          </div>
        ) : null}
        {/* Renaming has its own save and cancel at the row's end. */}
        <div className={cn(
          'absolute inset-e-1 z-10 flex items-center gap-0.5',
          // On the first line: a detailed row's second line has none.
          detailed ? 'top-1.5 h-5' : 'top-1/2 -translate-y-1/2',
          renaming && 'hidden',
          alwaysShowActions ? 'opacity-100' : 'opacity-0 group-hover/work:opacity-100 group-has-[:focus-visible]/work:opacity-100 has-[[data-popup-open]]:opacity-100',
        )}>
          <TooltipProvider delayDuration={400}>
            {workAction ? (
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
            {/* With Shift held the new-chat button archives the worktree on
                the spot, as a session row's archive turns into delete. */}
            {shiftArchive ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={actionButtonClass}
                    aria-label={t('sessions.sidebar.work.menu.archive')}
                    disabled={finishing}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      void finish(true);
                    }}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    <Icon name="archive" className={alwaysShowActions ? 'h-4 w-4' : 'h-3 w-3'} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6}>{t('sessions.sidebar.work.menu.archive')}</TooltipContent>
              </Tooltip>
            ) : canNewChat ? (
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
            ) : null}
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
