import { DirectoryActionIndicator } from './DirectoryActionIndicator';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { useSessionTurnActivity } from '@/sync/global-session-status';
import { getSessionActivityTime } from '@/sync/session-ordering';
import React from 'react';
import { TooltipLabelWithShortcut } from '@/components/ui/action-toolbar';
import { SessionActivityIndicator } from '@/components/session/SessionActivityIndicator';
import type { Session } from '@/lib/opencode/model';
import { ContextMenu } from '@base-ui/react/context-menu';
import { ContextMenu as ContextMenuRoot } from '@/components/ui/context-menu';
import { openContextMenuFromKeyboard } from '@/components/ui/contextMenuKeyboard';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { dropdownMenuPopupClass } from '@/components/ui/dropdown-menu.styles';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn, formatDirectoryName } from '@/lib/utils';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isSessionPinned } from '@/lib/sessionPins';
import { Icon } from "@/components/icon/Icon";
import { MoveSessionDialog } from '@/components/session/MoveSessionDialog';
import { handleSessionRenameKeyDown } from '@/components/session/sessionRenameKeyboard';
import { useIsSessionAiRenamePending } from '@/sync/use-session-ai-rename';
import { useSessionBlockingRequests } from '@/sync/sync-context';
import { usePrefetchSessionMessages } from '@/sync/use-sync';
import { useSessionHoverPrefetch } from '../list/useSessionPrefetch';
import { getSyncSessionMaterializationStatus } from '@/sync/sync-refs';
import { useViewportStore, viewportSessionKey } from '@/sync/viewport-store';
import { DraggableSessionRow } from '../folders/sessionFolderDnd';
import { useSessionRowOrderRegistry } from './sessionRowOrder';
import { nodeContainsSessionId, nodeHasPinnedMembershipChange, resolveTooltipBranchLabel, selectBlockingBadgeSessionScopes, type BlockingBadgeSessionScope } from './sessionNodeItemUtils';
import { useSessionRowMenuState } from './useSessionRowMenuState';
import { SessionActionsMenuItems } from './SessionActionsMenuItems';
import { contextSessionMenuSlots, dropdownSessionMenuSlots, type SessionMenuSlots } from './sessionMenuSlots';
import { toggleSessionWork } from './sessionWorkToggle';
import { useSessionMarkdownExport } from './useSessionMarkdownExport';
import type { SessionNode } from '../types';
import { listedChildren } from '../listedChildren';
import { isMultiLineTimelineContext, isPinnedZoneRowKey, sessionExpansionKey, type SessionSidebarRenderContext } from '../sessionSidebarRowModel';
import { SessionTimelineRowBody } from './SessionTimelineRowBody';
import { sessionDetailedRowPaddingLeft, sessionTreeRowPaddingLeft } from './sessionTreeGeometry';
import { FileTreeChevron } from '@/components/views/files/FileTreeRowParts';
import { formatProjectLabel, formatSessionCompactDateLabel, formatSessionDateLabel, normalizePath, renderHighlightedText } from '../utils';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useOpenTrackerItem } from '@/components/sourceBoard/openTrackerItem';
import { RowMarkTooltip } from './RowMarkTooltip';
import { GuestRowMarkLines, GuestRowMarks } from './GuestRowMarks';
import { useRowGuestMarks } from './useRowGuestMarks';
import { openGuestSurface } from '@/lib/guests/open-surface';
import { openGuestUrl } from '@/lib/guests/open-url';
import { resolveEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import type { RowGuestMark } from '@/lib/guests/marks';
import { isSpaceDirectory } from '@/lib/spaces/space-route';
import { pluginModeFromId } from '@/lib/surfaces/modes';
import { useGitBranchLabel } from '@/stores/useGitStore';
import { SIDEBAR_REF_TOOLTIP_CLOSE_DELAY_MS, SidebarRefLinks } from './SidebarRefLinks';
import { useScrollDismissedTooltip } from './useScrollDismissedTooltip';
import { refTintStyle } from '@/lib/source-control/prVisualState';
import { useSessionRefLines } from './useSessionRefLines';
import { useSessionMarkedUnread, useSessionUnread } from '@/sync/session-unread';
import { toggleSessionRead } from '@/components/session/sessionReadActions';
import { openSessionInSidePanel } from '@/components/session/sessionSidePanel';
import { useHasSessionTurnDuration } from '@/sync/session-turn-duration';
import { SessionActivityDuration } from '@/components/session/SessionActivityDuration';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';
import { useI18n } from '@/lib/i18n';
import { useShiftKeyHeld } from '@/hooks/useShiftKeyHeld';
import { getSessionGoal } from '@/lib/sessionGoalMetadata';
import { getCurrentSessionAssist } from '@/lib/sessionAssistMetadata';
import { isDoneSuggested } from '@/lib/sessionWorkMetadata';
import { collectSessionWorkInWork } from '../works/sidebarWorks';
import { isRowBoxClick } from './rowBoxClick';
import { sessionGoalMarkLabelKey, sessionGoalStatusColor } from '@/lib/sessionGoalPresentation';
import { isChatDirectoryPath } from '@/lib/chatDirectories';
import { sameMultiRunIdentity } from '@/lib/multirun/identity';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import {
  useIsSessionWorktreeMovePending,
} from '@/lib/worktrees/sessionWorktreeMove';
import { streamPerfCount } from '@/stores/utils/streamDebug';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import type { WorktreeMetadata } from '@/types/worktree';
import {
  type StartSessionWorktreeMenuLoadResult,
} from '../sessionWorktreeMenu';

type SecondaryMeta = {
  projectLabel?: string | null;
  branchLabel?: string | null;
  /** The branch label is an isolated space's name; the row marks it with the space's container icon. */
  inSpace?: boolean;
};

export type SessionNodeItemProps = {
  node: SessionNode;
  depth?: number;
  /** The row is a work of its own; a row inside one leaves Track / Done to it. */
  ownsWork: boolean;
  groupDirectory?: string | null;
  projectId?: string | null;
  folderOwnerKey?: string | null;
  ownerProjectId?: string | null;
  selectionScopeKey?: string | null;
  archivedBucket?: boolean;
  pinnedSessionIds: Set<string>;
  expandedParents: Set<string>;
  hasSessionSearchQuery: boolean;
  normalizedSessionSearchQuery: string;
  editingId: string | null;
  editingRowKey: string | null;
  setEditingId: (id: string | null) => void;
  setEditingRowKey: (key: string | null) => void;
  editTitle: string;
  setEditTitle: (value: string) => void;
  handleSaveEdit: (titleOverride?: string) => void;
  handleCancelEdit: () => void;
  toggleParent: (expansionKey: string) => void;
  handleSessionSelect: (sessionId: string, sessionDirectory: string | null) => void;
  handleSessionDoubleClick: (sessionId: string, sessionTitle: string) => void;
  openSidebarMenuKey: string | null;
  setOpenSidebarMenuKey: (key: string | null) => void;
  createFolderAndStartRename: (scopeKey: string, parentId?: string | null) => { id: string } | null;
  handleDeleteSession: (session: Session, source?: { archivedBucket?: boolean; hardDelete?: boolean; skipConfirm?: boolean }) => void;
  handleRestoreSession: (session: Session) => void;
  startSessionWorktreeMenuLoad: (args: {
    projectId: string | null;
    sourceDirectory: string | null;
    currentWorktree: WorktreeMetadata | null;
  }) => StartSessionWorktreeMenuLoadResult;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  secondaryMeta?: SecondaryMeta | null;
  renderContext?: SessionSidebarRenderContext;
  /** A work's row under its project with Detailed rows on: two lines, keeping the tree slot. */
  detailed?: boolean;
  blockingBadgeSessionScopes?: readonly BlockingBadgeSessionScope[];
  rowKey?: string;
  dragKey?: string;
  /**
   * Precomputed set of session IDs whose subtree contains the session
   * currently being edited. Precomputed once per group render.
   */
  subtreeContainsEditing: Set<string>;
  /**
   * Precomputed session ID of the row whose sidebar menu is open, or null
   * if no menu is open. Only one row can have its menu open at a time.
   */
  menuOpenSessionId: string | null;
  /**
   * Bumped once a minute by the Recent list so the compact relative
   * timestamp rendered below recomputes instead of freezing at the value it
   * had when the row first mounted.
   */
  relativeTimeTick?: number;
  /**
   * Precomputed structural key for this node and its badge-only scopes in
   * flat detailed zone rows. Both row memo boundaries use it to notice changes
   * to hidden descendants without adding them to the rendered node.
   */
  nodeStructureKey: string;
  /**
   * Resolves the per-row render extras for each child node. SessionGroupSection
   * walks the whole tree once to precompute the structure key for every
   * descendant; SessionNodeItem's recursive child render uses this lookup
   * to fetch the right key for each child it produces.
   */
  children?: React.ReactNode;
};

const areNodeWorktreeRenderSemanticsEqual = (prev: SessionNode, next: SessionNode): boolean => (
  normalizePath(prev.worktree?.path ?? null) === normalizePath(next.worktree?.path ?? null)
  && prev.worktree?.branch === next.worktree?.branch
);

const cancelScrollAnchorByContainer = new WeakMap<HTMLElement, () => void>();

const holdSessionRowPosition = (target: HTMLElement): void => {
  const row = target.closest<HTMLElement>('[data-session-row]');
  const container = row?.closest<HTMLElement>('.overlay-scrollbar-container');
  if (!row || !container) return;

  cancelScrollAnchorByContainer.get(container)?.();

  const initialTop = row.getBoundingClientRect().top;
  let remainingFrames = 3;
  let cancelled = false;
  let frameId: number | null = null;
  const cancel = () => {
    cancelled = true;
    if (frameId !== null) window.cancelAnimationFrame(frameId);
    frameId = null;
    cancelScrollAnchorByContainer.delete(container);
    container.removeEventListener('wheel', cancel);
    container.removeEventListener('touchstart', cancel);
  };
  const restore = () => {
    if (cancelled || !row.isConnected || !container.isConnected) {
      cancel();
      return;
    }
    const delta = row.getBoundingClientRect().top - initialTop;
    if (Math.abs(delta) > 0.5) {
      container.scrollTop += delta;
      streamPerfCount('ui.sidebar.selection_scroll_anchor_adjustment');
    }
    remainingFrames -= 1;
    if (remainingFrames <= 0) {
      cancel();
      return;
    }
    frameId = window.requestAnimationFrame(restore);
  };

  container.addEventListener('wheel', cancel, { passive: true });
  container.addEventListener('touchstart', cancel, { passive: true });
  cancelScrollAnchorByContainer.set(container, cancel);
  frameId = window.requestAnimationFrame(restore);
};

type QuickSessionActionProps = {
  shortcut?: string;
  archiveLabel: string;
  deleteLabel: string;
  buttonSizeClass: string;
  iconSizeClass: string;
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onMouseDown: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onArchive: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onDelete: (event: React.MouseEvent<HTMLButtonElement>) => void;
};

// Extracted so only this small button re-renders when Shift is pressed/released,
// instead of every mounted session row.
const QuickSessionAction = React.memo(function QuickSessionAction({
  shortcut,
  archiveLabel,
  deleteLabel,
  buttonSizeClass,
  iconSizeClass,
  onPointerDown,
  onMouseDown,
  onArchive,
  onDelete,
}: QuickSessionActionProps): React.ReactNode {
  const shiftHeld = useShiftKeyHeld();
  const label = shiftHeld ? deleteLabel : archiveLabel;

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (shiftHeld || event.shiftKey) {
      onDelete(event);
      return;
    }
    onArchive(event);
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            shiftHeld
              ? 'text-destructive hover:text-destructive'
              : 'text-muted-foreground hover:text-foreground',
            buttonSizeClass,
          )}
          aria-label={label}
          onPointerDown={onPointerDown}
          onMouseDown={onMouseDown}
          onClick={handleClick}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Icon name={shiftHeld ? 'delete-bin' : 'archive'} className={iconSizeClass} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        <TooltipLabelWithShortcut label={label} shortcut={shiftHeld ? undefined : shortcut} />
      </TooltipContent>
    </Tooltip>
  );
});

function SessionNodeItemComponent(props: SessionNodeItemProps): React.ReactNode {
  streamPerfCount('ui.sidebar_session_node.render');
  const { t } = useI18n();
  const {
    node,
    depth = 0,
    ownsWork,
    groupDirectory,
    projectId,
    folderOwnerKey,
    ownerProjectId,
    selectionScopeKey: explicitSelectionScopeKey,
    archivedBucket = false,
    pinnedSessionIds,
    expandedParents,
    hasSessionSearchQuery,
    normalizedSessionSearchQuery,
    editingId,
    editingRowKey,
    setEditingId,
    setEditingRowKey,
    editTitle,
    setEditTitle,
    handleSaveEdit,
    handleCancelEdit,
    toggleParent,
    handleSessionSelect,
    handleSessionDoubleClick,
    openSidebarMenuKey,
    setOpenSidebarMenuKey,
    createFolderAndStartRename,
    handleDeleteSession,
    handleRestoreSession,
    startSessionWorktreeMenuLoad,
    mobileVariant,
    alwaysShowActions,
    secondaryMeta,
    renderContext = 'project',
    detailed = false,
    blockingBadgeSessionScopes: timelineBadgeSessionScopes,
    rowKey,
    dragKey,
    children,
  } = props;
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const runtimeApis = React.useContext(RuntimeAPIContext);
  const revealOnHoverClass = isVSCode
    ? 'group-hover:opacity-100 group-hover:pointer-events-auto'
    : 'group-hover:opacity-100 group-hover:pointer-events-auto group-has-[:focus-visible]:opacity-100 group-has-[:focus-visible]:pointer-events-auto';
  const hideOnHoverClass = isVSCode
    ? 'group-hover:opacity-0'
    : 'group-hover:opacity-0 group-has-[:focus-visible]:opacity-0';
  const showOpenInEditorAction = isVSCode;
  const showQuickArchiveAction = !archivedBucket && !mobileVariant;
  const sessionWorkEnabled = useUIStore((state) => state.sessionWorkEnabled);
  const sessionRecapEnabled = useUIStore((state) => state.sessionRecapEnabled);
  // Track / Done belongs to the rows that are works: Chats are plain
  // conversations, never work, and a session nested in a work is tracked and
  // finished with it, or one group would mix tracked and finished sessions.
  // Touch layouts keep their actions permanently visible, where an icon on
  // every row would be noise: there it lives in the session menu only. A
  // pinned session is never in work, so it offers neither.
  const canTrackWork = sessionWorkEnabled && ownsWork && !archivedBucket && !node.session.parentID && !isChatDirectoryPath(node.session.directory)
    && !isSessionPinned(pinnedSessionIds, normalizePath(node.session.directory ?? null) ?? normalizePath(groupDirectory ?? null), node.session.id);
  const showWorkAction = canTrackWork && !alwaysShowActions;
  // Hover-revealed actions besides the menu: work, quick archive, and in VS
  // Code open-in-editor.
  const extraHoverActions = (showWorkAction ? 1 : 0) + (showQuickArchiveAction ? 1 : 0) + (showOpenInEditorAction ? 1 : 0);
  // With a mouse the row's menu is its right-click menu (Shift+F10 from the
  // keyboard), so the ⋯ button shows on touch only: always in touch layouts,
  // and on hover for a touch screen elsewhere (`pointer-fine:hidden`). Hover
  // reserves are for a mouse, so they count it only where it always shows.
  const showMenuButton = alwaysShowActions;
  const hoverButtons = extraHoverActions + (showMenuButton ? 1 : 0);
  // VS Code reveals its permanent-size actions on hover, so the title makes
  // room for them there.
  const vscodeAlwaysActionPaddingClass = hoverButtons === 0 ? undefined : ['group-hover:pe-8', 'group-hover:pe-14', 'group-hover:pe-18', 'group-hover:pe-22'][hoverButtons - 1];
  const alwaysActionPaddingClass = showQuickArchiveAction ? 'pe-13' : 'pe-7';
  const [isTouchPressed, setIsTouchPressed] = React.useState(false);
  const editingIdRef = React.useRef(editingId);
  editingIdRef.current = editingId;
  const pendingRenameRef = React.useRef<{ id: string; title: string } | null>(null);
  const pendingFolderCreateRef = React.useRef(false);
  const handleSaveEditRef = React.useRef(handleSaveEdit);
  handleSaveEditRef.current = handleSaveEdit;
  const renameDraft = editTitle;
  const renameDraftRef = React.useRef(renameDraft);
  renameDraftRef.current = renameDraft;
  const renameTargetRef = React.useRef<string | null>(null);
  const pendingRenameSelectRef = React.useRef(false);
  const renameInputRef = React.useRef<HTMLInputElement>(null);
  const formRef = React.useRef<HTMLFormElement>(null);
  const rowTooltip = useScrollDismissedTooltip();

  const session = node.session;
  const resolvedSession = session;
  // Tooltip context: recent rows receive project/branch via secondaryMeta;
  // project rows resolve them from the row's own props/node instead.
  const projectLabelFromStore = useProjectsStore(
    React.useCallback((state) => {
      if (secondaryMeta?.projectLabel || !projectId) return null;
      const project = state.projects.find((entry) => entry.id === projectId);
      if (!project) return null;
      return project.label?.trim() || formatDirectoryName(normalizePath(project.path) ?? project.path, null) || project.path;
    }, [projectId, secondaryMeta?.projectLabel]),
  );
  // Chats and the rows of zones that mix projects are one line, with the
  // tree's slot left of the title for the state and the chevron. Detailed rows
  // are two lines with no slot: the state sits on the right and the chevron
  // takes the place of the second line's first icon on hover.
  const isOneLineTimelineRow = renderContext === 'tree-chat' || renderContext === 'mixed-compact';
  // A work under its project with Detailed rows on takes the detailed row's
  // two lines too.
  const isDetailedTreeRow = detailed && renderContext === 'project';
  const isTwoLineRow = isMultiLineTimelineContext(renderContext) || isDetailedTreeRow;
  const isTimelineRow = isTwoLineRow || isOneLineTimelineRow;
  const isZoneRow = renderContext === 'timeline-mixed' || renderContext === 'mixed-compact';
  // The Pinned section's header already says its rows are pinned; anywhere
  // else a pinned session carries the mark.
  const hidePinnedMarker = rowKey !== undefined && isPinnedZoneRowKey(rowKey);
  // Detailed zone rows name the project with its icon on their second line;
  // one-line rows leave that room to the title (the row's tooltip names the
  // project). The row reads exactly that one project record, and `find` keeps
  // the reference stable between renders.
  const timelineProject = useProjectsStore(
    React.useCallback((state) => {
      if (renderContext !== 'timeline-mixed' || !projectId) return null;
      return state.projects.find((entry) => entry.id === projectId) ?? null;
    }, [renderContext, projectId]),
  );
  const tooltipProjectLabel = secondaryMeta?.projectLabel
    ?? (projectLabelFromStore ? formatProjectLabel(projectLabelFromStore) : null);
  // A null branchLabel on an explicit secondaryMeta is a deliberate filter
  // (HEAD/redundant with the project label), so it must not fall through to
  // the raw worktree branch. Project rows pass no secondaryMeta and keep the
  // worktree fallback.
  const tooltipBranchLabel = resolveTooltipBranchLabel(secondaryMeta, node.worktree?.branch ?? null);
  // A space's name stands where a branch would; the mark beside it is the space's, as on its group.
  const branchInSpace = secondaryMeta?.inSpace === true;
  const { refLines, branchPrIconColor } = useSessionRefLines(session, node.worktree, isVSCode);
  const primaryRef = refLines[0] ?? null;
  const moreRefCount = Math.max(0, refLines.length - 1);
  const openTrackerItem = useOpenTrackerItem();
  const refBadgeLabel = refLines.map((line) => line.text).join(', ');
  // The row is selected while its session is what the screen shows: a run's
  // overview covers it, and then the run's row is the selected one.
  const isCurrentSession = useSessionUIStore((state) => state.currentSessionId === session.id);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const archiveShortcut = formatShortcutForDisplay(getEffectiveShortcutCombo('archive_current_session', shortcutOverrides), '');
  const runOverviewOpen = useUIStore((state) => state.runOverviewKey !== null);
  const isActive = isCurrentSession && !runOverviewOpen;

  const sessionDirectory = normalizePath(session.directory ?? null) ?? normalizePath(groupDirectory ?? null);
  const sessionProjectId = ownerProjectId === undefined ? projectId : ownerProjectId;
  // A nested cross-project row uses its own repository for Tracker links.
  // The project root also resolves before the live worktree map arrives.
  const projectRootDirectory = useProjectsStore((state) =>
    sessionProjectId ? state.projects.find((entry) => entry.id === sessionProjectId)?.path ?? null : null,
  );
  const trackerDirectory = projectRootDirectory ?? sessionDirectory;
  // Extensions' marks (`contributes.marks`): the session's own, its branch's
  // and its folder's. An isolated space's rows show none, since no service
  // hears of a space's sessions, and VS Code loads no extensions.
  const guestMarksOff = isVSCode || isSpaceDirectory(sessionDirectory);
  const markRootDirectory = normalizePath(projectRootDirectory);
  // The folder that holds the session's own: its worktree, else the project
  // root. In the tree a row without a worktree lies in the root, whatever
  // subfolder the session started in; elsewhere only the root itself counts.
  const markContainerDirectory = guestMarksOff
    ? null
    : normalizePath(node.worktree?.path ?? null) ?? (markRootDirectory && sessionDirectory && (
      sessionDirectory === markRootDirectory
      || (renderContext === 'project' && !archivedBucket && sessionDirectory.startsWith(`${markRootDirectory}/`))
    ) ? markRootDirectory : null);
  // The row's branch is the one the sidebar already has, live Git state
  // first; a row that knows none shows no branch mark.
  const liveBranch = useGitBranchLabel(guestMarksOff ? null : sessionDirectory);
  const liveContainerBranch = useGitBranchLabel(markContainerDirectory);
  const markBranch = guestMarksOff
    ? null
    : liveBranch || liveContainerBranch || node.worktree?.branch?.trim() || (branchInSpace ? null : secondaryMeta?.branchLabel?.trim()) || null;
  const guestMarks = useRowGuestMarks({
    sessionId: guestMarksOff ? null : session.id,
    projectId: guestMarksOff ? null : sessionProjectId ?? null,
    branch: markBranch,
    folder: guestMarksOff ? null : sessionDirectory,
    containerFolder: markContainerDirectory,
  });
  // Multi-select scope: sessions are flat per project, so selection groups by
  // project (falling back to the directory when no project is known) — a
  // selection must survive mixing sessions from different worktrees.
  const selectionScopeKey = explicitSelectionScopeKey !== undefined
    ? explicitSelectionScopeKey
    : projectId ?? sessionDirectory ?? null;
  const hasFolderMutationAuthority = folderOwnerKey === undefined ? true : Boolean(folderOwnerKey);
  const prefetchSessionMessages = usePrefetchSessionMessages();
  // Same gate as the sidebar's neighbor prefetch: the VS Code webview keeps
  // its message traffic to what is actually opened.
  const prefetchOnPressDisabled = isVSCode;
  const hoverPrefetch = useSessionHoverPrefetch();

  const selectionModeEnabled = useSessionMultiSelectStore((state) => state.enabled);
  const isRowSelected = useSessionMultiSelectStore(
    React.useCallback((state) => state.selectedIds.has(session.id), [session.id]),
  );
  const toggleRowSelected = useSessionMultiSelectStore((state) => state.toggleSelected);
  const setRowRange = useSessionMultiSelectStore((state) => state.setRange);
  const sessionRowOrderRegistry = useSessionRowOrderRegistry();
  const sessionRowKey = rowKey ?? session.id;
  const isEditing = editingId === session.id && editingRowKey === sessionRowKey;

  const collectNodeDescendantIds = React.useCallback((root: SessionNode): string[] => {
    const out: string[] = [];
    const walk = (n: SessionNode) => {
      n.children.forEach((child) => {
        out.push(child.session.id);
        walk(child);
      });
    };
    walk(root);
    return out;
  }, []);

  const collectNodeDescendantSessions = React.useCallback((root: SessionNode): Session[] => {
    const out: Session[] = [];
    const walk = (current: SessionNode) => {
      current.children.forEach((child) => {
        out.push(child.session);
        walk(child);
      });
    };
    walk(root);
    return out;
  }, []);

  const sessionExport = useSessionMarkdownExport();

  const legacyContextKey = sessionExpansionKey(renderContext, archivedBucket, session.id);
  const menuInstanceKey = rowKey ? `session-menu:${rowKey}` : legacyContextKey;
  const contextMenuInstanceKey = rowKey ? `session-context:${rowKey}` : null;
  const isZombie = useViewportStore(
    React.useCallback((state) => Boolean(state.sessionMemoryState.get(viewportSessionKey(session.id))?.isZombie), [session.id]),
  );
  const turnActivity = useSessionTurnActivity(session.id);
  const isStreaming = turnActivity !== null;
  // Read as a boolean, not as the value: the row must not re-render on every
  // tick of the counter it only decides to mount.
  const hasActivityDuration = useHasSessionTurnDuration(session.id, isStreaming);
  const isMovingToWorktree = useIsSessionWorktreeMovePending(session.id);
  const isAiRenaming = useIsSessionAiRenamePending(session.id, sessionDirectory);
  const isSessionActionPending = isMovingToWorktree || isAiRenaming;
  const currentWorktreeMetadata = node.worktree ?? useSessionUIStore.getState().getWorktreeMetadata(session.id) ?? null;
  const [moveDialogOpen, setMoveDialogOpen] = React.useState(false);
  const sessionGoal = getSessionGoal(resolvedSession);
  // A root row is its work: the session with the reviews and btw sessions
  // nested under it. It is in work when any of them is,
  // and Done closes all of them.
  const workSessionsInWork = React.useMemo(
    () => (canTrackWork ? collectSessionWorkInWork(node) : []),
    [canTrackWork, node],
  );
  const isInWork = workSessionsInWork.length > 0;
  const showDoneHint = isInWork && !isStreaming && isDoneSuggested(resolvedSession);
  const workActionLabel = isInWork ? t('sessions.sidebar.session.work.markDone') : t('sessions.sidebar.session.work.track');
  const toggleWork = () => { void toggleSessionWork(session.id, sessionDirectory, workSessionsInWork, t); };
  const sessionGoalLabel = sessionGoal ? t(sessionGoalMarkLabelKey[sessionGoal.status]) : '';
  const sessionGoalGlyph = sessionGoal ? (
    <RowMarkTooltip label={sessionGoalLabel}>
      <span className="inline-flex flex-shrink-0 items-center" aria-label={sessionGoalLabel}>
        <Icon name="target" className="h-3 w-3" style={{ color: sessionGoalStatusColor[sessionGoal.status] }} />
      </span>
    </RowMarkTooltip>
  ) : null;
  const sessionTitle = resolvedSession.title || t('sessions.sidebar.session.untitled');
  // Every row opens to its subsessions, Chats, Pinned and In work rows
  // included, detailed or not.
  const hasChildren = listedChildren(node).length > 0;
  const isPinnedSession = isSessionPinned(pinnedSessionIds, sessionDirectory, session.id);
  // Per-render-context expansion key: the same session can appear in both
  // the project's root and the "Recent" list, and expanding one should not
  // expand the other. Matches the format of menuInstanceKey.
  const expansionKey = legacyContextKey;
  const isExpanded = hasSessionSearchQuery ? true : expandedParents.has(expansionKey);
  const blockingBadgeSessionScopes = React.useMemo(
    () => timelineBadgeSessionScopes ?? selectBlockingBadgeSessionScopes(node, isExpanded, sessionDirectory),
    [isExpanded, node, sessionDirectory, timelineBadgeSessionScopes],
  );
  const {
    hasPermission: hasPendingPermission,
    hasForm: hasPendingForm,
  } = useSessionBlockingRequests(blockingBadgeSessionScopes);
  const needsAttention = useSessionUnread(session.id);
  const markedUnread = useSessionMarkedUnread(session.id);
  // The last conversation, as the list orders by: a rename or a metadata
  // write must not make an old session read as just used.
  const sessionTimestamp = getSessionActivityTime(resolvedSession) || Date.now();
  const sessionUpdatedLabel = formatSessionDateLabel(sessionTimestamp);
  const sessionCompactUpdatedLabel = formatSessionCompactDateLabel(sessionTimestamp);
  const {
    isMenuOpen,
    isContextMenuOpen,
    handleMenuOpenChange,
    handleContextMenuOpenChange,
    handleMenuOpenChangeComplete,
  } = useSessionRowMenuState({
    menuInstanceKey,
    contextMenuInstanceKey,
    openSidebarMenuKey,
    setOpenSidebarMenuKey,
    hasDeferredCloseWork: () => pendingRenameRef.current !== null,
    onCloseComplete: () => {
      if (!pendingRenameRef.current) return;
      const { id, title } = pendingRenameRef.current;
      pendingRenameRef.current = null;
      setEditingId(id);
      setEditingRowKey(sessionRowKey);
      setEditTitle(title);
    },
  });
  const isSessionMenuOpen = isMenuOpen || isContextMenuOpen;

  const handleOpenInSidePanel = () => {
    if (!sessionDirectory) return;
    openSessionInSidePanel(session.id, sessionDirectory, sessionTitle);
  };

  // Capture outside-clicks to save edits — immune to focus-race with onBlur.
  React.useEffect(() => {
    if (!isEditing) return;
    const handleDocMouseDown = (e: MouseEvent) => {
      // Rename ownership is occurrence-keyed, so only this row's form keeps
      // the edit open when duplicate session rows exist elsewhere.
      // SAFETY: DOM mousedown targets are Nodes; closest is used only when the target is an Element.
      const target = e.target instanceof HTMLElement ? e.target : null;
      const withinRenameForm = target?.closest?.(`[data-session-rename-form="${CSS.escape(sessionRowKey)}"]`);
      if (formRef.current && !withinRenameForm) {
        handleSaveEditRef.current(renameDraftRef.current);
      }
    };
    document.addEventListener('mousedown', handleDocMouseDown);
    return () => document.removeEventListener('mousedown', handleDocMouseDown);
  }, [isEditing, sessionRowKey]);

  React.useLayoutEffect(() => {
    if (!isEditing) {
      if (renameTargetRef.current === sessionRowKey) {
        renameTargetRef.current = null;
      }
      return;
    }
    if (renameTargetRef.current === sessionRowKey) return;
    renameTargetRef.current = sessionRowKey;
    pendingRenameSelectRef.current = true;
  }, [editTitle, isEditing, sessionRowKey]);

  // Entering rename mode selects the whole title, so the first keystroke
  // replaces it instead of appending to it. The selection waits for the commit
  // that actually renders `editTitle`: the draft state above is seeded when the
  // row mounts, so on a session whose title changed since then the input still
  // holds the old text during the commit that opens the form.
  React.useLayoutEffect(() => {
    if (!isEditing || !pendingRenameSelectRef.current) return;
    const input = renameInputRef.current;
    if (!input || input.value !== editTitle) return;
    pendingRenameSelectRef.current = false;
    input.focus();
    input.select();
  }, [editTitle, isEditing, renameDraft]);

  if (isEditing) {
    const renameForm = (
      <form
        ref={formRef}
        data-session-rename-form={sessionRowKey}
        // Exactly one text line tall: the input and its two icon buttons must
        // not make the row taller than the title they replace.
        className="flex h-[1lh] w-full items-center gap-2 typography-ui-label"
        onSubmit={(event) => {
          event.preventDefault();
          handleSaveEdit(renameDraft);
        }}
      >
        <input
          ref={renameInputRef}
          value={renameDraft}
          onChange={(event) => setEditTitle(event.target.value)}
          className="flex-1 min-w-0 bg-transparent typography-ui-label outline-none placeholder:text-muted-foreground"
          autoFocus
          placeholder={t('sessions.sidebar.session.menu.rename')}
          onKeyDown={(event) => handleSessionRenameKeyDown(event, handleCancelEdit)}
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
          onClick={handleCancelEdit}
          aria-label={t('sessions.sidebar.session.rename.cancel')}
          title={t('sessions.sidebar.session.rename.cancel')}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <Icon name="close" className="size-3.5" />
        </button>
      </form>
    );
    if (isTwoLineRow) {
      // Renaming keeps the whole card in place: the title line becomes the
      // input, project and branch stay where they were, the slot stays empty.
      return (
        <div
          key={session.id}
          // The virtual list's 1px margins apply to the row box, rename included.
          data-session-row-box=""
          style={{ paddingInlineStart: sessionDetailedRowPaddingLeft(depth) }}
          className={cn(
            'group relative my-0.5 flex items-center rounded-md pe-2.5',
            'py-1.5',
            isActive && 'bg-interactive-selection/70 text-interactive-selection-foreground',
          )}
        >
          <SessionTimelineRowBody
            compact={isOneLineTimelineRow}
            project={timelineProject}
            projectLabel={tooltipProjectLabel}
            title={renameForm}
            titleClassName="text-foreground"
            branchLabel={tooltipBranchLabel}
            spaceMark={branchInSpace ? t('sessions.sidebar.group.space') : null}
            statusDot={null}
            pinnedMarker={null}
            timeSlot={null}
            directoryIndicator={null}
            prBadge={primaryRef ? (
              <span
                className="inline-flex flex-shrink-0 items-center gap-1 typography-micro text-muted-foreground"
              >
                <Icon name={primaryRef.icon} className={cn('h-3 w-3', primaryRef.color && 'oc-ref-tint')} style={primaryRef.color ? refTintStyle(primaryRef.color) : undefined} />
                {isOneLineTimelineRow ? null : <>
                  <span className="leading-none tabular-nums">{primaryRef.label}</span>
                  {moreRefCount > 0 ? <span className="leading-none tabular-nums text-muted-foreground">+{moreRefCount}</span> : null}
                </>}
              </span>
            ) : null}
            zombieIndicator={null}
            goal={sessionGoalGlyph}
            badges={null}
            hideMetaOnHoverClass=""
          />
        </div>
      );
    }
    return (
      <div
        key={session.id}
        data-session-row-box=""
        style={{ paddingInlineStart: sessionTreeRowPaddingLeft(depth) }}
        // my-0.5 matches the normal row box so entering rename mode does not
        // shift the row vertically; the empty slot keeps the title in place.
        className="group relative my-0.5 flex items-center gap-1.5 rounded-md py-[5px] pe-2.5"
      >
        <span aria-hidden className="h-3.5 w-3.5 flex-shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col gap-0">
          {renameForm}
        </div>
      </div>
    );
  }

  const pendingFormLabel = t('sessions.sidebar.session.status.questionPending');
  const showUnreadStatus = !isSessionActionPending && !isStreaming && needsAttention && (!isActive || markedUnread);
  const showStatusMarker = isStreaming || showUnreadStatus;
  // Running indicators are static by default; the local appearance preference
  // enables stepped motion without changing the elapsed-turn counter.
  const statusMarkerContent = <SessionActivityIndicator state={turnActivity ?? 'unread'} tooltip />;
  // The settled duration lives exactly as long as the unread marker does, so a
  // session read (or watched) while it finishes never keeps a stale total.
  const showActivityDuration = (isStreaming || showUnreadStatus) && hasActivityDuration;
  // Hover-revealed actions swap in over the row's right end instead of
  // pushing the title: the meta they cover hides and the title's tail
  // fades away under them (`oc-actions-mask`), so nothing moves. The reserve
  // is how far the actions reach in from the row content's right edge: their
  // width less the 6px they sit nearer the row edge (16px buttons, 20px on
  // two-line timeline rows, 2px apart).
  const actionsReserveClass = hoverButtons === 0
    ? undefined
    : isTimelineRow && !isOneLineTimelineRow
      ? ['[--oc-actions-reserve:0.875rem]', '[--oc-actions-reserve:2.25rem]', '[--oc-actions-reserve:3.625rem]', '[--oc-actions-reserve:5rem]'][hoverButtons - 1]
      : ['[--oc-actions-reserve:0.625rem]', '[--oc-actions-reserve:1.75rem]', '[--oc-actions-reserve:2.875rem]', '[--oc-actions-reserve:4rem]'][hoverButtons - 1];
  // An open row menu (dropdown or right-click) keeps the actions shown, so
  // what they cover gives way too, hover or not. A row with no hover actions
  // covers nothing.
  const actionsMaskClass = alwaysShowActions || hoverButtons === 0
    ? undefined
    : isSessionMenuOpen
      ? 'oc-actions-mask'
      : isVSCode
        ? 'group-hover:oc-actions-mask'
        : 'group-hover:oc-actions-mask group-has-[:focus-visible]:oc-actions-mask';
  const coveredMetaFadeClass = hoverButtons === 0 ? '' : isSessionMenuOpen ? 'opacity-0' : hideOnHoverClass;
  const pinnedLabel = t('sessions.sidebar.session.status.pinned');
  const pinnedMarkerContent = (
    <RowMarkTooltip label={pinnedLabel}>
      <span className="inline-flex flex-shrink-0 items-center" aria-label={pinnedLabel}>
        <Icon name="pushpin" className="h-3 w-3 text-muted-foreground" />
      </span>
    </RowMarkTooltip>
  );
  const sessionActionSpinner = (
    <Icon
      name="loader-4"
      className="h-3 w-3 flex-shrink-0 animate-spin text-status-info"
      aria-label={isAiRenaming ? t('sessions.aiRename.generating') : t('sessions.sidebar.session.status.movingToWorktree')}
    />
  );
  // A request waiting on the user stands for the turn: the session is stopped
  // on it, so the running mark and its timer step aside for the one warning
  // mark (the timer reads its start from the store and resumes where it is).
  const waitingOnUser = hasPendingPermission || hasPendingForm;
  const liveStateMark = isSessionActionPending ? sessionActionSpinner : showStatusMarker && !waitingOnUser ? statusMarkerContent : null;
  // Grouped rows are file tree rows: one indent per level, then a slot left
  // of the title. The slot says what a row is (a worktree's branch, a run's
  // mark, a session's chevron when it has subsessions) and never its state:
  // the live state sits on the right before the time on every row, so a
  // running mark never hides a worktree's branch (maintainer, 2026-10-26).
  const treeChevron = hasChildren && !isTwoLineRow ? (
    <span
      role="button"
      tabIndex={0}
      onClick={(event) => {
        event.stopPropagation();
        event.currentTarget.blur();
        toggleParent(expansionKey);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          toggleParent(expansionKey);
        }
      }}
      className="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={isExpanded
        ? t('sessions.sidebar.session.subsessions.collapse')
        : t('sessions.sidebar.session.subsessions.expand')}
      aria-expanded={isExpanded}
    >
      <FileTreeChevron expanded={isExpanded} />
    </span>
  ) : null;
  // A two-line row's chevron sits over the second line's first icon, shown
  // while the row is hovered or focused (always on touch layouts).
  const leadToggle = isTwoLineRow && hasChildren ? (
    <span
      role="button"
      tabIndex={0}
      onClick={(event) => {
        event.stopPropagation();
        event.currentTarget.blur();
        toggleParent(expansionKey);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          toggleParent(expansionKey);
        }
      }}
      className={cn(
        'absolute inset-0 inline-flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none',
        !alwaysShowActions && 'opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100',
      )}
      aria-label={isExpanded
        ? t('sessions.sidebar.session.subsessions.collapse')
        : t('sessions.sidebar.session.subsessions.expand')}
      aria-expanded={isExpanded}
    >
      <FileTreeChevron expanded={isExpanded} />
    </span>
  ) : null;
  const leadIconClassName = alwaysShowActions ? 'opacity-0' : 'group-hover:opacity-0 group-has-[:focus-visible]:opacity-0';
  const treeSlot = isTwoLineRow ? null : treeChevron ?? <span aria-hidden className="h-3.5 w-3.5 flex-shrink-0" />;

  const streamingIndicator = isZombie
    ? <Icon name="error-warning" className="h-4 w-4 text-status-warning" />
    : null;

  // Base UI's trigger handlers open the menu, so it records the click and
  // stays open when the pointer leaves it. A menu opened only through `open`
  // has no open event, and Base UI closes it on pointer leave like a hover menu.
  const handleMenuTriggerClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  const handleMenuTriggerPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  const handleMenuTriggerMouseDown = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  const handleRowActionPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleRowActionMouseDown = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleQuickArchiveClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setOpenSidebarMenuKey(null);
    handleDeleteSession(session, { archivedBucket });
  };

  const handleQuickDeleteClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setOpenSidebarMenuKey(null);
    handleDeleteSession(session, { archivedBucket, hardDelete: true, skipConfirm: true });
  };

  const handleOpenInEditorPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleOpenInEditorMouseDown = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleOpenInEditorClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void runtimeApis?.vscode?.executeCommand('openchamber.openSessionInEditor', session.id, sessionTitle);
  };

  const handleRowSelect = (event?: React.MouseEvent<HTMLElement>) => {
    // Ctrl+click opens the context menu on macOS. Decided from the click
    // itself: a right button press fires no click, so a flag set on press
    // stayed set and swallowed the next real click.
    if (event?.ctrlKey && !selectionModeEnabled) return;
    if (selectionModeEnabled) {
      event?.preventDefault();
      event?.stopPropagation();
      if (event?.shiftKey) {
        const registeredEntries = sessionRowOrderRegistry?.getEntries();
        // The recursive renderer remains mounted until the flat renderer cutover;
        // keep its range behavior intact when no logical registry owns the list.
        const entries = registeredEntries ?? Array.from(document.querySelectorAll<HTMLElement>('[data-session-row]'))
          .map((element) => element.getAttribute('data-session-row'))
          .filter((id): id is string => Boolean(id))
          .map((id) => ({ id, rowKey: id, scopeKey: selectionScopeKey, archived: archivedBucket }));
        const currentAnchor = registeredEntries
          ? useSessionMultiSelectStore.getState().anchorRowKey
          : useSessionMultiSelectStore.getState().anchorId;
        const descendantsById = new Map<string, string[]>();
        descendantsById.set(session.id, collectNodeDescendantIds(node));
        setRowRange(currentAnchor, sessionRowKey, entries, sessionRowOrderRegistry?.getDescendantIds() ?? [], selectionScopeKey, descendantsById);
        return;
      }
      toggleRowSelected(session.id, selectionScopeKey, collectNodeDescendantIds(node), sessionRowKey);
      return;
    }
    if (event?.shiftKey && !isVSCode && sessionDirectory) {
      handleOpenInSidePanel();
      return;
    }
    if (event?.altKey) {
      toggleSessionRead(session.id, needsAttention, t);
      return;
    }
    if (event?.currentTarget) holdSessionRowPosition(event.currentTarget);
    handleSessionSelect(session.id, sessionDirectory);
  };

  // The selection/active highlight covers the WHOLE row box (gutter, edge
  // paddings), while the primary click target is the inner title button.
  // Make the rest of the highlighted box clickable too — but only for clicks
  // that did not originate from an interactive child (title button, chevron,
  // action menu), so nothing double-fires.
  const handleRowBackgroundClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (isRowBoxClick(event)) handleRowSelect(event);
  };

  const handleRowMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    // Shift-click opens the session in the side panel; without this the
    // browser extends the text selection across the sidebar.
    if (event.button === 0 && event.shiftKey && !selectionModeEnabled) {
      event.preventDefault();
    }
  };
  const handleRowPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (mobileVariant && event.pointerType === 'touch') {
      setIsTouchPressed(true);
    }
    // The press is the earliest signal that this row is about to be opened.
    // Starting the message load here puts the request on the wire before the
    // click handler and the render it triggers, so a cold open overlaps the
    // network round trip with that work instead of waiting for it.
    if (
      event.button === 0
      && !isActive
      && !selectionModeEnabled
      && !prefetchOnPressDisabled
      && sessionDirectory
      && !getSyncSessionMaterializationStatus(session.id, sessionDirectory).renderable
    ) {
      void prefetchSessionMessages({ directory: sessionDirectory, sessionID: session.id }).catch(() => undefined);
    }
  };
  // Resting the pointer on a row, or reaching it with the keyboard, starts
  // loading its messages after a short delay, so the click that usually
  // follows opens a warm session. Touch has no hover: a tap's enter event
  // lands with the press, which the press prefetch above already covers.
  const hoverPrefetchTarget = !isActive && !selectionModeEnabled && sessionDirectory
    ? { id: session.id, directory: sessionDirectory }
    : null;
  const handleRowPointerEnter = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse' || !hoverPrefetchTarget) return;
    hoverPrefetch?.schedule(hoverPrefetchTarget);
  };
  const handleRowFocus = () => {
    if (hoverPrefetchTarget) hoverPrefetch?.schedule(hoverPrefetchTarget);
  };
  const handleRowHoverEnd = () => {
    if (hoverPrefetchTarget) hoverPrefetch?.cancel(hoverPrefetchTarget);
  };
  const handleRowPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (mobileVariant && event.pointerType === 'touch') {
      setIsTouchPressed(false);
    }
  };

  const renderSessionMenuItems = (slots: SessionMenuSlots) => (
    <SessionActionsMenuItems
      session={resolvedSession}
      directory={sessionDirectory}
      open={isSessionMenuOpen}
      slots={slots}
      archived={archivedBucket}
      pinned={isPinnedSession}
      work={canTrackWork ? { inWork: isInWork, toggle: toggleWork } : null}
      projectId={projectId ?? null}
      currentWorktree={currentWorktreeMetadata}
      descendants={collectNodeDescendantSessions(node)}
      startWorktreeLoad={startSessionWorktreeMenuLoad}
      folders={hasFolderMutationAuthority ? {
        ownerKey: folderOwnerKey ?? null,
        projectId: sessionProjectId ?? null,
        // Zone rows mix projects, so they ask for the new folder's name in a
        // dialog; a project's rows name it in place in the list.
        createInline: isZoneRow ? undefined : (scope) => {
          const newFolder = createFolderAndStartRename(scope);
          if (newFolder) pendingFolderCreateRef.current = true;
          return newFolder;
        },
      } : null}
      touch={mobileVariant}
      onRename={() => {
        // Defer rename until dropdown close transition completes.
        // onOpenChangeComplete fires after animation + focus cleanup are done,
        // avoiding focus stealing from Base UI's unmount cleanup.
        pendingRenameRef.current = { id: session.id, title: sessionTitle };
      }}
      onExport={() => sessionExport.requestExport(resolvedSession, sessionDirectory, node)}
      onMoveSession={() => setMoveDialogOpen(true)}
      onArchive={() => handleDeleteSession(session, { archivedBucket })}
      onRestore={archivedBucket ? () => handleRestoreSession(session) : null}
      onDelete={() => handleDeleteSession(session, { archivedBucket, hardDelete: true })}
    />
  );

  const handleWorkToggleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    toggleWork();
  };

  // Two-line zone rows are taller, so their hover actions step up one
  // size to match the metadata they replace (the pin marker, the dot, the time).
  const actionButtonSizeClass = alwaysShowActions ? 'h-6 w-6' : isTimelineRow && !isOneLineTimelineRow ? 'h-5 w-5' : 'h-4 w-4';
  const actionIconSizeClass = alwaysShowActions ? 'h-3.5 w-3.5' : isTimelineRow && !isOneLineTimelineRow ? 'h-3 w-3' : 'h-2.5 w-2.5';
  const checkIconSizeClass = alwaysShowActions ? 'h-4 w-4' : isTimelineRow && !isOneLineTimelineRow ? 'h-3.5 w-3.5' : 'h-3 w-3';

  // The recap of the last turn, for the whole-row tooltip, under the same
  // freshness rule the chat uses.
  const currentRecap = sessionRecapEnabled && !isStreaming
    ? getCurrentSessionAssist(resolvedSession)?.recap || null
    : null;
  // Jev thinks the work looks finished: a quiet check next to the row until a
  // new turn starts or the user closes it.
  const doneHintLabel = t('sessions.sidebar.session.work.doneSuggested');
  const doneHintBadge = (className?: string) => (showDoneHint ? (
    <RowMarkTooltip label={doneHintLabel}>
      <span className={cn('inline-flex flex-shrink-0 items-center text-muted-foreground', className)} aria-label={doneHintLabel}>
        <Icon name="check" className="h-3.5 w-3.5" />
      </span>
    </RowMarkTooltip>
  ) : null);
  const permissionLabel = t('sessions.sidebar.session.status.permissionRequired');
  const rowBadges = (hasPendingPermission || hasPendingForm) ? (
    <>
      {hasPendingPermission ? (
        <RowMarkTooltip label={permissionLabel}>
          <span className="inline-flex flex-shrink-0 items-center text-status-warning" aria-label={permissionLabel}>
            <Icon name="shield" className="h-3 w-3" />
          </span>
        </RowMarkTooltip>
      ) : null}
      {hasPendingForm ? (
        <RowMarkTooltip label={pendingFormLabel}>
          <span className="inline-flex flex-shrink-0 items-center text-status-warning" aria-label={pendingFormLabel}>
            <Icon name="question" className="h-3 w-3" />
          </span>
        </RowMarkTooltip>
      ) : null}
    </>
  ) : null;

  // The PR (or issue) badge carries its own tooltip (status text) and opens
  // it: timeline rows have no whole-row tooltip, so this is where that lives.
  const timelinePrBadge = isTimelineRow && primaryRef ? (
    <Tooltip>
      <TooltipTrigger asChild closeDelay={SIDEBAR_REF_TOOLTIP_CLOSE_DELAY_MS}>
        <button
          type="button"
          className={cn(
            'inline-flex flex-shrink-0 items-center gap-1 rounded typography-micro text-muted-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:no-underline',
          )}
          disabled={!primaryRef.url}
          aria-label={refBadgeLabel}
          onPointerDown={handleRowActionPointerDown}
          onMouseDown={handleRowActionMouseDown}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            // The `+N` only counts the others; the tooltip lists them.
            if (event.target instanceof Element && event.target.closest('[data-ref-more]')) return;
            if (primaryRef.url) openTrackerItem(primaryRef.url, trackerDirectory, event);
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {/* The state's colour is on the mark alone; the number stays neutral. */}
          <Icon name={primaryRef.icon} className={cn('h-3 w-3', primaryRef.color && 'oc-ref-tint')} style={primaryRef.color ? refTintStyle(primaryRef.color) : undefined} />
          {/* One-line rows keep the coloured mark only; its tooltip lists every link. */}
          {isOneLineTimelineRow ? null : <>
            <span className="leading-none tabular-nums">{primaryRef.label}</span>
            {moreRefCount > 0 ? <span data-ref-more className="leading-none tabular-nums text-muted-foreground">+{moreRefCount}</span> : null}
          </>}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="max-w-xs">
        <SidebarRefLinks items={refLines} directory={trackerDirectory} />
      </TooltipContent>
    </Tooltip>
  ) : null;

  // A mark opens its extension's panel on this row's session, selecting it
  // first; an extension without a panel opens the mark's link where the user
  // is, as the PR badge opens its page, and selects nothing.
  const openGuestMark = (mark: RowGuestMark) => {
    if (!mark.panel) {
      if (mark.url) void openGuestUrl(mark.url, resolveEffectiveDirectory() ?? null, true);
      return;
    }
    handleSessionSelect(session.id, sessionDirectory);
    openGuestSurface({ mode: pluginModeFromId(mark.guestId), directory: sessionDirectory, supported: true });
  };

  // Every row shares the timeline row body: grouped and Chats rows use its
  // one-line form, with the session's live state and time on the right.
  const rowBody = (
    <SessionTimelineRowBody
      compact={!isTwoLineRow}
      leadToggle={leadToggle}
      leadIconClassName={leadToggle ? leadIconClassName : undefined}
      leadMaskClassName={leadToggle && !alwaysShowActions ? 'group-hover:oc-lead-mask group-has-[:focus-visible]:oc-lead-mask' : undefined}
      project={timelineProject}
      projectLabel={tooltipProjectLabel}
      title={renderHighlightedText(sessionTitle, normalizedSessionSearchQuery)}
      // A finished turn nobody has seen and a request waiting on the user
      // read like an unread mail; a running turn at full strength; the rest
      // recede.
      titleClassName={isActive || isRowSelected
        ? 'text-interactive-selection-foreground'
        : showUnreadStatus || hasPendingPermission || hasPendingForm
          ? 'font-semibold text-foreground'
          : isStreaming ? 'text-foreground' : 'oc-title-rest'}
      branchLabel={tooltipBranchLabel}
      spaceMark={branchInSpace ? t('sessions.sidebar.group.space') : null}
      statusDot={liveStateMark}
      pinnedMarker={isPinnedSession && !isSessionActionPending && !hidePinnedMarker ? pinnedMarkerContent : null}
      // No date: the list is ordered by recency and the row's tooltip carries
      // the time. A turn's duration shows while it runs and until it is read.
      timeSlot={showActivityDuration && !waitingOnUser
        ? <SessionActivityDuration sessionId={session.id} running={isStreaming} className="typography-micro" />
        : null}
      // Project rows leave the action indicator to their worktree header.
      directoryIndicator={!archivedBucket && sessionDirectory && renderContext !== 'project' ? <DirectoryActionIndicator directory={sessionDirectory} /> : null}
      prBadge={timelinePrBadge}
      zombieIndicator={isTimelineRow ? streamingIndicator : null}
      goal={sessionGoalGlyph}
      marks={guestMarks.length > 0 ? <GuestRowMarks marks={guestMarks} onOpen={openGuestMark} /> : null}
      badges={rowBadges}
      doneHint={doneHintBadge()}
      // Grouped rows reserve room for permanent actions on their button.
      metaPaddingClass={isTimelineRow && alwaysShowActions
        ? (showQuickArchiveAction ? 'pe-13' : 'pe-7')
        : undefined}
      hideMetaOnHoverClass={alwaysShowActions && !isVSCode ? '' : coveredMetaFadeClass}
      actionsReserveClass={actionsReserveClass}
      actionsMaskClass={actionsMaskClass}
    />
  );

  const sessionMenuContent = (
    <DropdownMenuContent align="end" className="min-w-[180px]" finalFocus={() => {
      if (pendingFolderCreateRef.current) {
        pendingFolderCreateRef.current = false;
        return false;
      }
      return editingIdRef.current ? false : true;
    }}>
      {renderSessionMenuItems(dropdownSessionMenuSlots)}
    </DropdownMenuContent>
  );

  const contextMenuContent = (
    <ContextMenu.Portal>
      <ContextMenu.Positioner className="app-region-no-drag z-50">
        <ContextMenu.Popup
          data-slot="dropdown-menu-content"
          finalFocus={() => {
            if (pendingFolderCreateRef.current) {
              pendingFolderCreateRef.current = false;
              return false;
            }
            return editingIdRef.current ? false : true;
          }}
          style={{
            color: 'var(--surface-elevated-foreground)',
          }}
          className={cn(dropdownMenuPopupClass, 'min-w-[180px]')}
        >
          {renderSessionMenuItems(contextSessionMenuSlots)}
        </ContextMenu.Popup>
      </ContextMenu.Positioner>
    </ContextMenu.Portal>
  );

  return (
    <React.Fragment key={session.id}>
      <DraggableSessionRow sessionId={session.id} dragKey={dragKey ?? sessionRowKey} ownerKey={folderOwnerKey ?? selectionScopeKey} sessionDirectory={sessionDirectory ?? null} sessionTitle={sessionTitle} archivedBucket={archivedBucket}>
        <ContextMenuRoot open={isContextMenuOpen} onOpenChange={handleContextMenuOpenChange} onOpenChangeComplete={handleMenuOpenChangeComplete}>
          <ContextMenu.Trigger
            onKeyDown={openContextMenuFromKeyboard}
            render={
              <div
                data-session-row={session.id}
                data-session-row-box=""
                data-session-scope={selectionScopeKey ?? ''}
                data-session-archived={archivedBucket ? '1' : '0'}
                aria-current={isActive ? 'page' : undefined}
                onClick={handleRowBackgroundClick}
                // The file tree geometry: 12px per level from an 8px edge,
                // then the slot and a 6px gap; a two-line row has no slot.
                style={{ paddingInlineStart: isTwoLineRow ? sessionDetailedRowPaddingLeft(depth) : sessionTreeRowPaddingLeft(depth) }}
                className={cn(
                  'group relative my-0.5 flex cursor-pointer items-center rounded-md pe-2.5',
                  !isTwoLineRow && 'gap-1.5',
                  // A one-line row is a little shorter than a two-line one's
                  // padding: the list reads denser without the rows touching.
                  isTwoLineRow ? 'py-1.5' : 'py-[5px]',
                  !(isActive || isRowSelected) && 'hover:bg-interactive-hover/60',
                  (isActive || isRowSelected) && 'bg-interactive-selection/70 text-interactive-selection-foreground',
                  isRowSelected && 'ring-1 ring-inset ring-border',
                )}
              />
            }
          >
          {treeSlot}
          <div className="flex min-w-0 flex-1 items-center">
            {(
              <Tooltip actionsRef={rowTooltip.actionsRef} onOpenChange={rowTooltip.onOpenChange}>
                {/* Rows without a tooltip keep the trigger inert: an open
                    but empty row tooltip would block the marks' own. It
                    closes as soon as the pointer leaves the row; a pointer
                    heading for its links still reaches them, as the popup
                    stays open along the way. */}
                <TooltipTrigger asChild closeDelay={0} disabled={isVSCode}>
                  {/* A button by role only: the body holds the PR badge, a
                      real button, and HTML does not nest buttons. */}
                  <div
                    role="button"
                    tabIndex={0}
                    data-session-row-main=""
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
                      event.preventDefault();
                      event.currentTarget.click();
                    }}
	                    aria-pressed={selectionModeEnabled ? isRowSelected : undefined}
	                    onPointerDown={handleRowPointerDown}
 	                    onPointerUp={handleRowPointerEnd}
 	                    onPointerCancel={handleRowPointerEnd}
                    onPointerEnter={handleRowPointerEnter}
                    onPointerLeave={handleRowHoverEnd}
                    onFocus={handleRowFocus}
                    onBlur={handleRowHoverEnd}
 	                    onMouseDown={handleRowMouseDown}
 	                    onClick={(event) => handleRowSelect(event)}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      handleSessionDoubleClick(session.id, sessionTitle);
                    }}
                    className={cn(
                      'flex min-w-0 flex-1 cursor-pointer flex-col gap-0 overflow-hidden text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring text-foreground select-none',
	                      isTouchPressed && 'bg-interactive-hover/70',
                      // Hover-revealed actions overlay the body, which keeps
                      // its width; only permanent actions take room.
                      isTimelineRow || !alwaysShowActions
                        ? undefined
                        : (isVSCode ? vscodeAlwaysActionPaddingClass : alwaysActionPaddingClass),
                    )}
                  >
                    {rowBody}
                  </div>
                </TooltipTrigger>
                {/* VS Code already shows project context via workspace headers, so
                    the per-row metadata tooltip is redundant noise there. */}
                {!isVSCode ? (
                <TooltipContent side="right" sideOffset={8} className="max-w-xs text-start">
                  <div className="flex min-w-44 flex-col gap-1.5 text-start text-xs">
                    <div className="flex items-center justify-between gap-3">
                      <span dir="auto" className="oc-ui-start-align min-w-0 truncate font-medium text-foreground">{sessionTitle}</span>
                      <span className="flex-shrink-0 text-muted-foreground" title={sessionUpdatedLabel}>{sessionCompactUpdatedLabel}</span>
                    </div>
                    {tooltipProjectLabel ? (
                      <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                        <Icon name="folder" className="h-3 w-3 flex-shrink-0" />
                        <span className="min-w-0 truncate">{tooltipProjectLabel}</span>
                      </div>
                    ) : null}
                    {tooltipBranchLabel ? (
                      <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                        {branchInSpace
                          ? <Icon name="instance" className="h-3 w-3 flex-shrink-0" aria-hidden={false} role="img" aria-label={t('sessions.sidebar.group.space')} />
                          : <Icon name="git-branch" className={cn('h-3 w-3 flex-shrink-0', branchPrIconColor && 'oc-ref-tint')} style={branchPrIconColor ? refTintStyle(branchPrIconColor) : undefined} />}
                        <span className="min-w-0 truncate">{tooltipBranchLabel}</span>
                      </div>
                    ) : null}
                    {refLines.length > 0 ? <SidebarRefLinks items={refLines} directory={trackerDirectory} /> : null}
                    {/* Every mark, not only those past the two drawn: on a one-line
                        row the hover actions cover the cluster. */}
                    {guestMarks.length > 0 ? <GuestRowMarkLines marks={guestMarks} /> : null}
                    {currentRecap ? (
                      <p className="min-w-0 line-clamp-4 text-muted-foreground">{currentRecap}</p>
                    ) : null}
                  </div>
                </TooltipContent>
                ) : null}
              </Tooltip>
            )}
          </div>

          {streamingIndicator && !mobileVariant && !isTimelineRow ? (
            <div className="absolute inset-e-1 top-1/2 -translate-y-1/2 z-10">
              {streamingIndicator}
            </div>
          ) : null}

          <div className={cn(
            'absolute inset-e-1 z-10 flex items-center gap-0.5',
            // Timeline actions overlay the first line's right cluster, not the
            // row's vertical centre.
            // Two-line rows: the row's 6px top padding plus the fixed 20px
            // first line, so the 20px buttons cover that line exactly.
            isTimelineRow && !isOneLineTimelineRow ? 'top-1.5 h-5' : 'top-1/2 -translate-y-1/2',
            isSessionMenuOpen
              ? 'opacity-100'
              : (alwaysShowActions && !isVSCode)
                ? 'opacity-100'
                : cn('opacity-0', revealOnHoverClass),
          )}>
            {/* Their own tooltip group: the pointer crosses these buttons on
                its way into the row's tooltip, which a tooltip of the same
                group would replace on the spot. */}
            <TooltipProvider delayDuration={400}>
            {showWorkAction ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      'inline-flex items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      actionButtonSizeClass,
                      isInWork ? 'text-status-success' : 'text-muted-foreground hover:text-foreground',
                    )}
                    aria-label={workActionLabel}
                    onPointerDown={handleRowActionPointerDown}
                    onMouseDown={handleRowActionMouseDown}
                    onClick={handleWorkToggleClick}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    {/* The check glyph draws smaller than the others at the same
                        box, so it takes the next icon size; the button stays put. */}
                    <Icon name={isInWork ? 'check' : 'eye'} className={isInWork ? checkIconSizeClass : actionIconSizeClass} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6}>
                  {workActionLabel}
                </TooltipContent>
              </Tooltip>
            ) : null}
            {showQuickArchiveAction ? (
              <QuickSessionAction
                archiveLabel={t('sessions.sidebar.bulkActions.archive')}
                shortcut={isCurrentSession ? archiveShortcut : undefined}
                deleteLabel={t('sessions.sidebar.bulkActions.delete')}
                buttonSizeClass={actionButtonSizeClass}
                iconSizeClass={actionIconSizeClass}
                onPointerDown={handleRowActionPointerDown}
                onMouseDown={handleRowActionMouseDown}
                onArchive={handleQuickArchiveClick}
                onDelete={handleQuickDeleteClick}
              />
            ) : null}
            {showOpenInEditorAction ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      'inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      actionButtonSizeClass,
                    )}
                    aria-label={t('sessions.sidebar.session.actions.openInEditor')}
                    onPointerDown={handleOpenInEditorPointerDown}
                    onMouseDown={handleOpenInEditorMouseDown}
                    onClick={handleOpenInEditorClick}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    <Icon name="external-link" className={actionIconSizeClass} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6}>
                  {t('sessions.sidebar.session.actions.openInEditor')}
                </TooltipContent>
              </Tooltip>
            ) : null}
            <DropdownMenu open={isMenuOpen} onOpenChange={handleMenuOpenChange} onOpenChangeComplete={handleMenuOpenChangeComplete}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    'inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    !alwaysShowActions
                      ? cn('pointer-fine:hidden', isSessionMenuOpen
                          ? 'h-4 w-4 opacity-100'
                          : cn('h-4 w-4 opacity-0', revealOnHoverClass))
                      : 'h-6 w-6 opacity-100',
                  )}
                  aria-label={t('sessions.sidebar.session.menu.label')}
                  onPointerDown={handleMenuTriggerPointerDown}
                  onMouseDown={handleMenuTriggerMouseDown}
                  onClick={handleMenuTriggerClick}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                   <Icon name="more-2" className={actionIconSizeClass} />
                </button>
              </DropdownMenuTrigger>
              {sessionMenuContent}
            </DropdownMenu>
            </TooltipProvider>
          </div>
          </ContextMenu.Trigger>
          {contextMenuContent}
        </ContextMenuRoot>
      </DraggableSessionRow>
      {hasChildren && isExpanded ? children : null}
      {moveDialogOpen && sessionDirectory ? (
        <MoveSessionDialog open onOpenChange={setMoveDialogOpen} sessionId={session.id} sourceDirectory={sessionDirectory} />
      ) : null}
      {sessionExport.dialog}
    </React.Fragment>
  );
}

const getNodeSessionDirectory = (node: SessionNode): string | null => {
  return normalizePath(node.session.directory ?? null);
};

const isSecondaryMetaEqual = (prev?: SecondaryMeta | null, next?: SecondaryMeta | null): boolean => {
  return (prev?.projectLabel ?? null) === (next?.projectLabel ?? null)
    && (prev?.branchLabel ?? null) === (next?.branchLabel ?? null)
    && (prev?.inSpace ?? false) === (next?.inSpace ?? false);
};

const getMenuSessionIdFromKey = (props: SessionNodeItemProps): string | null => {
  if (!props.openSidebarMenuKey) return null;
  if (props.rowKey && (
    props.openSidebarMenuKey === `session-menu:${props.rowKey}`
    || props.openSidebarMenuKey === `session-context:${props.rowKey}`
  )) return props.node.session.id;
  const bucketTag = props.archivedBucket ? 'archived' : 'active';
  const prefix = `${props.renderContext ?? 'project'}:${bucketTag}:`;
  return props.openSidebarMenuKey.startsWith(prefix)
    ? props.openSidebarMenuKey.slice(prefix.length)
    : null;
};

const getRelevantMenuSessionId = (props: SessionNodeItemProps): string | null => {
  return props.menuOpenSessionId ?? getMenuSessionIdFromKey(props);
};

const subtreeContainsSession = (
  props: SessionNodeItemProps,
  sessionId: string | null,
  precomputed: Set<string>,
): boolean => {
  if (!sessionId) return false;
  if (precomputed.has(props.node.session.id)) return true;
  return nodeContainsSessionId(props.node, sessionId);
};

const hasSetMembershipChangeInNode = (
  prevNode: SessionNode,
  nextNode: SessionNode,
  prevSet: Set<string>,
  nextSet: Set<string>,
  getKey: (node: SessionNode) => string,
): boolean => {
  if (prevNode.session.id !== nextNode.session.id) return true;
  const key = getKey(prevNode);
  if (prevSet.has(key) !== nextSet.has(key)) return true;
  if (prevNode.children.length !== nextNode.children.length) return true;
  for (let i = 0; i < prevNode.children.length; i += 1) {
    if (hasSetMembershipChangeInNode(prevNode.children[i], nextNode.children[i], prevSet, nextSet, getKey)) {
      return true;
    }
  }
  return false;
};

const hasExpansionMembershipChange = (prev: SessionNodeItemProps, next: SessionNodeItemProps): boolean => {
  if (prev.hasSessionSearchQuery || next.hasSessionSearchQuery) return false;
  const prevBucketTag = prev.archivedBucket ? 'archived' : 'active';
  const nextBucketTag = next.archivedBucket ? 'archived' : 'active';
  return hasSetMembershipChangeInNode(
    prev.node,
    next.node,
    prev.expandedParents,
    next.expandedParents,
    (node) => `${prev.renderContext ?? 'project'}:${prevBucketTag}:${node.session.id}`,
  ) || hasSetMembershipChangeInNode(
    prev.node,
    next.node,
    prev.expandedParents,
    next.expandedParents,
    (node) => `${next.renderContext ?? 'project'}:${nextBucketTag}:${node.session.id}`,
  );
};

const areSessionRenderSemanticsEqual = (prev: Session, next: Session): boolean => (
  prev.id === next.id
  && prev.title === next.title
  && prev.directory === next.directory
  && prev.parentID === next.parentID
  && prev.time?.created === next.time?.created
  && prev.time?.updated === next.time?.updated
  && prev.time?.archived === next.time?.archived
  // The row renders from metadata (goal, in-work state, the recap tooltip) and
  // judges the done hint and the recap against `time.idle`. A metadata change
  // arrives as a new object, so the reference is the cheap exact signal.
  && prev.time?.idle === next.time?.idle
  && prev.metadata === next.metadata
  && sameMultiRunIdentity(prev, next)
);

// Returns the name of the first prop whose change requires a render, or null
// when the row can skip it. The name feeds the stream perf counters so sidebar
// churn is explained, not only counted.
const sessionNodeItemPropsChange = (prev: SessionNodeItemProps, next: SessionNodeItemProps): string | null => {
  if (prev.node.session.id !== next.node.session.id) return 'node';
  if (!areSessionRenderSemanticsEqual(prev.node.session, next.node.session)) return 'node';
  if (!areNodeWorktreeRenderSemanticsEqual(prev.node, next.node)) return 'node';
  if (prev.depth !== next.depth) return 'depth';
  if (prev.ownsWork !== next.ownsWork) return 'ownsWork';
  if (prev.groupDirectory !== next.groupDirectory) return 'groupDirectory';
  if (prev.projectId !== next.projectId) return 'projectId';
  if (prev.ownerProjectId !== next.ownerProjectId) return 'ownerProjectId';
  if (prev.folderOwnerKey !== next.folderOwnerKey) return 'folderOwnerKey';
  if (prev.selectionScopeKey !== next.selectionScopeKey) return 'selectionScopeKey';
  if (prev.archivedBucket !== next.archivedBucket) return 'archivedBucket';
  if ((prev.renderContext ?? 'project') !== (next.renderContext ?? 'project')) return 'renderContext';
  if ((prev.detailed ?? false) !== (next.detailed ?? false)) return 'detailed';
  if (prev.mobileVariant !== next.mobileVariant) return 'mobileVariant';
  if (prev.alwaysShowActions !== next.alwaysShowActions) return 'alwaysShowActions';
  if (prev.hasSessionSearchQuery !== next.hasSessionSearchQuery) return 'hasSessionSearchQuery';
  if (prev.normalizedSessionSearchQuery !== next.normalizedSessionSearchQuery) return 'normalizedSessionSearchQuery';
  if (prev.nodeStructureKey !== next.nodeStructureKey) return 'nodeStructureKey';
  if (prev.relativeTimeTick !== next.relativeTimeTick) return 'relativeTimeTick';
  if (getNodeSessionDirectory(prev.node) !== getNodeSessionDirectory(next.node)) return 'nodeDirectory';
  if (!isSecondaryMetaEqual(prev.secondaryMeta, next.secondaryMeta)) return 'secondaryMeta';

  if (prev.pinnedSessionIds !== next.pinnedSessionIds
    && nodeHasPinnedMembershipChange(
      prev.node,
      next.node,
      prev.pinnedSessionIds,
      next.pinnedSessionIds,
      prev.groupDirectory,
      next.groupDirectory,
    )) {
    return 'pinnedSessionIds';
  }

  if (prev.expandedParents !== next.expandedParents && hasExpansionMembershipChange(prev, next)) {
    return 'expandedParents';
  }

  if (prev.editingId !== next.editingId
    && (
      subtreeContainsSession(prev, prev.editingId, prev.subtreeContainsEditing)
      || subtreeContainsSession(next, next.editingId, next.subtreeContainsEditing)
    )) {
    return 'editingId';
  }

  if (prev.editingRowKey !== next.editingRowKey
    && (prev.editingRowKey === prev.rowKey || next.editingRowKey === next.rowKey)) {
    return 'editingRowKey';
  }

  if (prev.editTitle !== next.editTitle
    && (
      subtreeContainsSession(prev, prev.editingId, prev.subtreeContainsEditing)
      || subtreeContainsSession(next, next.editingId, next.subtreeContainsEditing)
    )) {
    return 'editTitle';
  }

  if (prev.openSidebarMenuKey !== next.openSidebarMenuKey) {
    const prevMenuSessionId = getRelevantMenuSessionId(prev);
    const nextMenuSessionId = getRelevantMenuSessionId(next);
    if (nodeContainsSessionId(prev.node, prevMenuSessionId) || nodeContainsSessionId(next.node, nextMenuSessionId)) {
      return 'openSidebarMenuKey';
    }
  }

  const callbacksEqual = prev.setEditingId === next.setEditingId
    && prev.setEditingRowKey === next.setEditingRowKey
    && prev.setEditTitle === next.setEditTitle
    && prev.handleSaveEdit === next.handleSaveEdit
    && prev.handleCancelEdit === next.handleCancelEdit
    && prev.toggleParent === next.toggleParent
    && prev.handleSessionSelect === next.handleSessionSelect
    && prev.handleSessionDoubleClick === next.handleSessionDoubleClick
    && prev.setOpenSidebarMenuKey === next.setOpenSidebarMenuKey
    && prev.createFolderAndStartRename === next.createFolderAndStartRename
    && prev.handleDeleteSession === next.handleDeleteSession
    && prev.handleRestoreSession === next.handleRestoreSession
    && prev.startSessionWorktreeMenuLoad === next.startSessionWorktreeMenuLoad
    && prev.children === next.children;
  if (!callbacksEqual) return 'callbacks';
  return null;
};

const areSessionNodeItemPropsEqual = (prev: SessionNodeItemProps, next: SessionNodeItemProps): boolean => {
  const changed = sessionNodeItemPropsChange(prev, next);
  if (changed === null) return true;
  streamPerfCount(`ui.sidebar_session_node.props_changed.${changed}`);
  return false;
};

export const SessionNodeItem = React.memo(SessionNodeItemComponent, areSessionNodeItemPropsEqual);
