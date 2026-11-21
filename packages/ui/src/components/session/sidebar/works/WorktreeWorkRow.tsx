import React from 'react';
import { PinToMenu } from '../sections/PinToMenu';
import { TakeOverWorktreeItem } from './TakeOverWorktreeItem';
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
import { SessionReadShortcut } from '@/components/session/SessionReadMenuItem';
import { sessionEvents } from '@/lib/sessionEvents';
import { refTintStyle } from '@/lib/source-control/prVisualState';
import { cn, formatDirectoryName } from '@/lib/utils';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { DirectoryActionIndicator } from '../sessions/DirectoryActionIndicator';
import { CollapsedActivityIndicator } from '../sessions/collapsedActivityIndicator';
import { SessionActivityDuration } from '@/components/session/SessionActivityDuration';
import { SIDEBAR_REF_TOOLTIP_CLOSE_DELAY_MS, SidebarRefLinks } from '../sessions/SidebarRefLinks';
import { RowMarkTooltip } from '../sessions/RowMarkTooltip';
import { GuestRowMarkLines, GuestRowMarks } from '../sessions/GuestRowMarks';
import { useWorkRowGuestMarks } from '../sessions/useRowGuestMarks';
import type { RowGuestMark } from '@/lib/guests/marks';
import { openGuestSurface } from '@/lib/guests/open-surface';
import { openGuestUrl } from '@/lib/guests/open-url';
import { resolveEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { pluginModeFromId } from '@/lib/surfaces/modes';
import { isRowBoxClick } from '../sessions/rowBoxClick';
import { TimelineProjectIcon, TimelineProjectName } from '../sessions/SessionTimelineRowBody';
import { useZoneProjectNames } from '../sessions/useZoneProjectNames';
import { sessionDetailedRowPaddingLeft, sessionTreeRowPaddingLeft } from '../sessions/sessionTreeGeometry';
import type { SessionGroup } from '../types';
import { normalizePath } from '../utils';
import { useWorktreeWork } from './useWorktreeWork';
import { requestNewFolder } from '../folders/newFolderRequest';
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
  detailed: boolean;
  mixed: boolean;
  inPinnedZone: boolean;
  collapsed: boolean;
  empty: boolean;
  alwaysShowActions: boolean;
  mobileVariant: boolean;
  onToggle: (groupKey: string) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
};

export function WorktreeWorkRow(props: Props): React.ReactNode {
  const {
    group,
    groupKey,
    projectId,
    depth,
    detailed,
    mixed,
    inPinnedZone,
    collapsed,
    empty,
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
    worktree, space, spaceName, directory, openDirectory, worktreeRemoving, sessions, project, projectLabel, refs, selected,
    title, branch, label, secondName, finishing, canArchive, canRename, canNewChat, pinned, canPin, workAction, inWork, activityState,
    runningSessionId, durationSessionId,
  } = work;
  const projectNamed = useZoneProjectNames();
  const namesProject = mixed && projectNamed && project !== null && project !== undefined;
  const lineName = namesProject && secondName === title ? null : secondName;
  const guestMarks = useWorkRowGuestMarks({ space: Boolean(space), projectId: project?.id ?? projectId ?? null, projectPath: project?.path ?? null, directory, branch });
  const openGuestMark = (mark: RowGuestMark): void => {
    if (!mark.panel) {
      if (mark.url) void openGuestUrl(mark.url, resolveEffectiveDirectory() ?? null, true);
      return;
    }
    work.open();
    openGuestSurface({ mode: pluginModeFromId(mark.guestId), directory: openDirectory, supported: true });
  };
  const marks = guestMarks.length > 0 ? <GuestRowMarks marks={guestMarks} onOpen={openGuestMark} /> : null;
  const pinnedLabel = t('sessions.sidebar.session.status.pinned');
  const pinnedMark = pinned && !inPinnedZone ? (
    <RowMarkTooltip label={pinnedLabel}>
      <span className="inline-flex flex-shrink-0 items-center" aria-label={pinnedLabel}>
        <Icon name="pushpin" className="h-3 w-3 text-muted-foreground" />
      </span>
    </RowMarkTooltip>
  ) : null;
  const folderScopeKey = normalizePath(project?.path ?? null);
  const folderMemberId = worktreeFolderMemberId(directory);
  const projectFolders = useSessionFoldersStore((state) => (folderScopeKey ? state.foldersMap[folderScopeKey] ?? NO_FOLDERS : NO_FOLDERS));
  const currentFolderId = folderMemberId ? projectFolders.find((folder) => folder.sessionIds.includes(folderMemberId))?.id ?? null : null;
  const canFile = Boolean(folderScopeKey && folderMemberId);
  const moveToFolder = (folderId: string | null): void => {
    if (!folderScopeKey || !folderMemberId) return;
    const folders = useSessionFoldersStore.getState();
    if (folderId) folders.addSessionToFolder(folderScopeKey, folderId, folderMemberId);
    else folders.removeSessionFromFolder(folderScopeKey, folderMemberId);
  };
  const [renaming, setRenaming] = React.useState(false);
  const renameInputRef = React.useRef<HTMLInputElement>(null);
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
  const expanded = !collapsed;

  const openWork = (event?: React.MouseEvent): void => {
    if (renaming) return;
    if (event?.altKey && work.canMarkUnread) {
      work.toggleRead();
      return;
    }
    work.open();
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

  const stateMark = worktreeRemoving || finishing
    ? <Spinner className="h-3 w-3" />
    : activityState ? <CollapsedActivityIndicator state={activityState} /> : null;
  const workMark = (className: string) => space ? (
    <Icon name="instance" className={cn(className, 'flex-shrink-0 text-muted-foreground')} aria-hidden={false} role="img" aria-label={t('sessions.sidebar.group.space')} />
  ) : (
    <Icon
      name="worktree"
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
        onToggle(groupKey);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        onToggle(groupKey);
      }}
    >
      <FileTreeChevron expanded={expanded} />
    </span>
  ) : null;
  const leadIcon = mixed && project
    ? <TimelineProjectIcon project={project} label={namesProject ? null : projectLabel} />
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
          onToggle(groupKey);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          event.stopPropagation();
          onToggle(groupKey);
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
  const refMark = refs.prSummary
    ? space ? { icon: 'git-pull-request' as const, color: refs.prColor, label: refs.prLabel ?? refs.prReference, text: refs.prReference, url: refs.prSummary.url } : null
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
  const hasWorkAction = workAction;
  const showMenuButton = alwaysShowActions;
  const hoverButtons = (hasWorkAction ? 1 : 0) + (shiftArchive || canNewChat ? 1 : 0) + (showMenuButton ? 1 : 0);
  const actionsReserve = [undefined, '[--oc-actions-reserve:0.625rem]', '[--oc-actions-reserve:1.75rem]', '[--oc-actions-reserve:2.875rem]'][hoverButtons];
  const hideOnHover = alwaysShowActions || hoverButtons === 0 ? undefined : 'group-hover/work:opacity-0 group-has-[:focus-visible]/work:opacity-0';
  const maskOnHover = alwaysShowActions || hoverButtons === 0 ? undefined : 'group-hover/work:oc-actions-mask group-has-[:focus-visible]/work:oc-actions-mask';
  const actionButtonClass = cn(
    'inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    alwaysShowActions ? 'h-6 w-6' : 'h-4 w-4',
  );
  const actionIconClass = alwaysShowActions ? 'h-3.5 w-3.5' : 'h-2.5 w-2.5';

  const renderMenuItems = (Slots: WorkMenuSlots): React.ReactNode => (
    <>
      {canRename ? (
        <Slots.Item onClick={startRename}>
          <Icon name="edit" className="h-4 w-4" />
          <span>{t('sessions.sidebar.work.menu.rename')}</span>
        </Slots.Item>
      ) : null}
      {work.canMarkUnread ? (
        <Slots.Item onClick={work.toggleRead}>
          <Icon name={work.hasUnread ? 'chat-check' : 'checkbox-circle'} className="h-4 w-4" />
          <span>{work.hasUnread ? t('sessions.sidebar.session.menu.markRead') : t('sessions.sidebar.session.menu.markUnread')}</span>
          {alwaysShowActions ? null : <SessionReadShortcut />}
        </Slots.Item>
      ) : null}
      {canPin ? (
        <PinToMenu
          slots={Slots}
          current={work.pinList}
          onPin={(list) => { void work.setPin(true, list); }}
          onUnpin={() => { void work.setPin(false); }}
        />
      ) : null}
      {worktree ? <TakeOverWorktreeItem path={directory} Item={Slots.Item} /> : null}
      {canFile ? (
        <Slots.Sub>
          <Slots.SubTrigger>
            <Icon name="folder" className="h-4 w-4" />
            <span>{t('sessions.sidebar.folders.moveToFolder')}</span>
          </Slots.SubTrigger>
          <Slots.SubContent className="min-w-[160px]">
            {projectFolders.map((folder) => (
              <Slots.Item key={folder.id} onClick={() => moveToFolder(folder.id)} className="flex items-center justify-between">
                <span dir="auto" className="min-w-0 truncate">{folder.name}</span>
                {folder.id === currentFolderId ? <Icon name="check" className="h-4 w-4 text-primary" /> : null}
              </Slots.Item>
            ))}
            {projectFolders.length > 0 ? <Slots.Separator /> : null}
            <Slots.Item onClick={() => requestNewFolder({
              projectLabel: project?.label?.trim() || (project ? formatDirectoryName(project.path, null) : null),
              create: (name) => { if (folderScopeKey) moveToFolder(useSessionFoldersStore.getState().createFolder(folderScopeKey, name).id); },
            })}>
              <Icon name="add" className="h-4 w-4" />
              <span>{t('sessions.sidebar.folders.newFolderEllipsis')}</span>
            </Slots.Item>
            {currentFolderId ? (
              <Slots.Item onClick={() => moveToFolder(null)}>
                <span>{t('sessions.sidebar.folders.removeFromFolder')}</span>
              </Slots.Item>
            ) : null}
          </Slots.SubContent>
        </Slots.Sub>
      ) : null}
      {space ? <>
        {canFile ? <Slots.Separator /> : null}
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
        selected
          ? 'text-interactive-selection-foreground'
          : activityState === 'unread' || activityState === 'permission' || activityState === 'form'
            ? 'font-semibold text-foreground'
            : activityState === 'active' ? 'text-foreground' : 'oc-title-rest',
        maskOnHover,
      )}
    >
      {label}
    </span>
  );

  return (
    <ContextMenu disabled={renaming}>
    <ContextMenuTrigger render={<div className={cn(worktreeRemoving && 'opacity-60')} aria-busy={worktreeRemoving || undefined} />}>
      <div
        style={{ paddingInlineStart: detailed ? sessionDetailedRowPaddingLeft(depth) : sessionTreeRowPaddingLeft(depth) }}
        onClick={(event) => {
          if (isRowBoxClick(event)) openWork(event);
        }}
        className={cn(
          'group/work relative my-0.5 flex cursor-pointer select-none rounded-md pe-2.5',
          detailed ? 'py-1.5' : 'py-[5px]',
          detailed ? 'flex-col gap-px' : 'items-center gap-1.5',
          selected ? 'oc-selected' : 'hover:bg-interactive-hover/60',
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
                {detailed ? null : marks}
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
              <span dir="auto" className="oc-ui-start-align min-w-0 truncate font-medium text-foreground">{title ?? label}</span>
              {projectLabel ? (
                <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                  <Icon name="folder" className="h-3 w-3 flex-shrink-0" />
                  <span className="min-w-0 truncate">{projectLabel}</span>
                </div>
              ) : null}
              {branch && branch !== (title ?? label) ? (
                <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                  <Icon name="git-branch" className="h-3 w-3 flex-shrink-0" />
                  <span className="min-w-0 truncate">{branch}</span>
                </div>
              ) : null}
              {spaceName && spaceName !== (title ?? label) ? (
                <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                  <Icon name="instance" className="h-3 w-3 flex-shrink-0" />
                  <span className="min-w-0 truncate">{spaceName}</span>
                </div>
              ) : null}
              {tooltipLinks.length > 0 ? <SidebarRefLinks items={tooltipLinks} directory={project?.path ?? group.directory ?? null} /> : null}
              {guestMarks.length > 0 ? <GuestRowMarkLines marks={guestMarks} /> : null}
              {space ? <SpaceStatusLines spaceId={space.id} /> : null}
            </div>
          </TooltipContent>
        </Tooltip>
        </div>
        {detailed ? (
          <div className="flex h-4 w-full min-w-0 items-center gap-1">
            {lead}
            {namesProject ? <TimelineProjectName project={project} fallback={projectLabel} separated={false} /> : null}
            {mixed && project && space ? workMark('h-3 w-3') : null}
            {mixed && project && !space && lineName && lineName === branch ? workMark('h-3 w-3') : null}
            {lineName ? (
              <span dir="auto" className="min-w-0 truncate typography-micro text-muted-foreground">{lineName}</span>
            ) : null}
            <span className="ms-auto flex flex-shrink-0 items-center gap-1">{ref}{marks}</span>
          </div>
        ) : null}
        <div className={cn(
          'absolute inset-e-1 z-10 flex items-center gap-0.5',
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
            {(
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={cn(actionButtonClass, !showMenuButton && 'pointer-fine:hidden')}
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
            )}
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
