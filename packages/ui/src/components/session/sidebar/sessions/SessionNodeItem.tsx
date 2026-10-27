import { DirectoryActionIndicator } from './DirectoryActionIndicator';
import { useSessionTurnActivity } from '@/sync/global-session-status';
import { getSessionActivityTime } from '@/sync/session-ordering';
import React from 'react';
import { leaveFinishedSessions } from '@/lib/sessionTabs';
import { SessionActivityIndicator } from '@/components/session/SessionActivityIndicator';
import type { Session } from '@/lib/opencode/model';
import { ContextMenu } from '@base-ui/react/context-menu';
import { ContextMenu as ContextMenuRoot } from '@/components/ui/context-menu';
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
import { dropdownMenuItemClass, dropdownMenuPopupClass, dropdownMenuSeparatorClass, dropdownMenuSubTriggerClass } from '@/components/ui/dropdown-menu.styles';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn, formatDirectoryName } from '@/lib/utils';
import { canUseElectronDesktopIPC, getMiniChatRuntimeArgs, invokeDesktop, isVSCodeRuntime } from '@/lib/desktop';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { isSessionPinned } from '@/lib/sessionPins';
import { toggleSessionPin } from '@/sync/session-pins';
import { Icon } from "@/components/icon/Icon";
import { buildExportFilename, downloadAsMarkdown, formatSessionAsMarkdown, getExportRevealLabelKey, revealExportedMarkdown, saveAsMarkdownDesktop } from '@/lib/exportSession';
import type { ChildSessionExport } from '@/lib/exportSession';
import { GuestIcon } from '@/components/layout/GuestRailIcon';
import { useGuestActions } from '@/hooks/useGuestSurfaces';
import { guestSessionActions, type GuestActionEntry } from '@/lib/guests/actions';
import { runGuestSessionAction } from '@/lib/guests/session-action';
import { SessionAiRenameMenuItem } from '@/components/session/SessionAiRenameMenuItem';
import { handleSessionRenameKeyDown } from '@/components/session/sessionRenameKeyboard';
import { useIsSessionAiRenamePending } from '@/sync/use-session-ai-rename';
import { useSessionBlockingRequests } from '@/sync/sync-context';
import { usePrefetchSessionMessages, useSessionMessageRecordsForExport } from '@/sync/use-sync';
import { useSessionHoverPrefetch } from '../list/useSessionPrefetch';
import { getSyncSessionMaterializationStatus } from '@/sync/sync-refs';
import { useViewportStore, viewportSessionKey } from '@/sync/viewport-store';
import { DraggableSessionRow } from '../folders/sessionFolderDnd';
import { useSessionRowOrderRegistry } from './sessionRowOrder';
import { canShowSessionWorktreeMenu, getSessionWorktreeMenuDisabled, nodeContainsSessionId, nodeHasPinnedMembershipChange, resolveTooltipBranchLabel, selectBlockingBadgeSessionScopes, type BlockingBadgeSessionScope } from './sessionNodeItemUtils';
import { useSessionRowMenuState } from './useSessionRowMenuState';
import { buildActiveSessionTreeFromCache, collectSessionMoveDescendants } from './sessionSubtreeActions';
import type { SessionNode } from '../types';
import { isMultiLineTimelineContext, sessionExpansionKey, type SessionSidebarRenderContext } from '../sessionSidebarRowModel';
import { SessionTimelineRowBody } from './SessionTimelineRowBody';
import { sessionDetailedRowPaddingLeft, sessionTreeRowPaddingLeft } from './sessionTreeGeometry';
import { FileTreeChevron } from '@/components/views/files/FileTreeRowParts';
import { formatProjectLabel, formatSessionCompactDateLabel, formatSessionDateLabel, normalizePath, renderHighlightedText } from '../utils';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useOpenTrackerItem } from '@/components/sourceBoard/openTrackerItem';
import { RowMarkTooltip } from './RowMarkTooltip';
import { SessionMenuItemHint } from '../../SessionMenuItemHint';
import { SIDEBAR_REF_TOOLTIP_CLOSE_DELAY_MS, SidebarRefLinks } from './SidebarRefLinks';
import { useScrollDismissedTooltip } from './useScrollDismissedTooltip';
import { refTintStyle } from '@/lib/source-control/prVisualState';
import { useSessionRefLines } from './useSessionRefLines';
import { useSessionUnread } from '@/sync/session-unread';
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
import { SessionDirectoryMissingError, setSessionWorkState } from '@/sync/session-actions';
import { toastSessionWorkFailure } from './sessionWorkFailure';
import { useSessionWarmingStore, useSessionWarmUntil } from '@/stores/useSessionWarmingStore';
import { isSpaceDirectory } from '@/lib/spaces/space-route';
import { sessionGoalStatusColor, sessionGoalStatusLabelKey } from '@/lib/sessionGoalPresentation';
import { getChatsRootFromDirectory, isChatDirectoryPath } from '@/lib/chatDirectories';
import { getMultiRunIdentity, sameMultiRunIdentity } from '@/lib/multirun/identity';
import { ArrowsMerge } from '@/components/icons/ArrowsMerge';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import {
  buildSessionTreeMoveMessages,
  requestSessionTreeMove,
  useIsSessionWorktreeMovePending,
} from '@/lib/worktrees/sessionWorktreeMove';
import { streamPerfCount } from '@/stores/utils/streamDebug';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { resolveEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import type { WorktreeMetadata } from '@/types/worktree';
import {
  getSessionWorktreeMenuState,
  type SessionWorktreeMenuTarget,
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
  handleCopySessionId: (sessionId: string) => void;
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
        {label}
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
    handleCopySessionId,
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
  const getFoldersForScope = useSessionFoldersStore((state) => state.getFoldersForScope);
  const getSessionFolderId = useSessionFoldersStore((state) => state.getSessionFolderId);
  const removeSessionFromFolder = useSessionFoldersStore((state) => state.removeSessionFromFolder);
  const addSessionToFolder = useSessionFoldersStore((state) => state.addSessionToFolder);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);

  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const isElectron = React.useMemo(() => canUseElectronDesktopIPC(), []);
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
  // every row would be noise: there it lives in the session menu only.
  const canTrackWork = sessionWorkEnabled && ownsWork && !archivedBucket && !node.session.parentID && !isChatDirectoryPath(node.session.directory);
  const showWorkAction = canTrackWork && !alwaysShowActions;
  // Hover-revealed actions besides the menu: work, quick archive, and in VS
  // Code open-in-editor.
  const extraHoverActions = (showWorkAction ? 1 : 0) + (showQuickArchiveAction ? 1 : 0) + (showOpenInEditorAction ? 1 : 0);
  // VS Code reveals its permanent-size actions on hover, so the title makes
  // room for them there.
  const vscodeAlwaysActionPaddingClass = ['group-hover:pe-8', 'group-hover:pe-14', 'group-hover:pe-18', 'group-hover:pe-22'][extraHoverActions];
  const alwaysActionPaddingClass = showQuickArchiveAction ? 'pe-13' : 'pe-7';
  const suppressNextSelectRef = React.useRef(false);
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
  // While the Pinned section is shown it holds every pinned zone session, and
  // its header already says they are pinned; In work and the list by time,
  // whose rows share the zones' context, then have none of them.
  const isZoneRow = renderContext === 'timeline-mixed' || renderContext === 'mixed-compact';
  const pinnedSectionShown = useSessionDisplayStore((state) => state.showPinnedSection);
  const hidePinnedMarker = isZoneRow && pinnedSectionShown;
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
  const runOverviewOpen = useUIStore((state) => state.runOverviewKey !== null);
  const isActive = isCurrentSession && !runOverviewOpen;

  const sessionDirectory = normalizePath(session.directory ?? null) ?? normalizePath(groupDirectory ?? null);
  // Ref chips open their item in the Tracker through the row's project. The
  // project's root path resolves without the live worktree map, which a
  // session in a worktree outside the root does not until that map arrives.
  const projectRootDirectory = useProjectsStore((state) =>
    projectId ? state.projects.find((entry) => entry.id === projectId)?.path ?? null : null,
  );
  const trackerDirectory = projectRootDirectory ?? sessionDirectory;
  // Multi-select scope: sessions are flat per project, so selection groups by
  // project (falling back to the directory when no project is known) — a
  // selection must survive mixing sessions from different worktrees.
  const selectionScopeKey = explicitSelectionScopeKey !== undefined
    ? explicitSelectionScopeKey
    : projectId ?? sessionDirectory ?? null;
  const loadExportRecords = useSessionMessageRecordsForExport();
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

  const [exportDialogOpen, setExportDialogOpen] = React.useState(false);
  const [exportIncludeSubtasks, setExportIncludeSubtasks] = React.useState(true);
  // The tree the open export dialog offers. A flat row's own node has no
  // children, so the tree is resolved when the user picks Export Markdown.
  const [exportTree, setExportTree] = React.useState<SessionNode | null>(null);

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
  const [worktreeTargets, setWorktreeTargets] = React.useState<SessionWorktreeMenuTarget[]>([]);
  const [worktreeTargetsLoadFailed, setWorktreeTargetsLoadFailed] = React.useState(false);
  const worktreeSubmenuOpenRef = React.useRef(false);
  const worktreeLoadSequenceRef = React.useRef(0);
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
  const toggleSessionWork = async () => {
    try {
      if (!isInWork) {
        await setSessionWorkState(session.id, sessionDirectory, 'open');
        return;
      }
      for (const entry of workSessionsInWork) {
        await setSessionWorkState(entry.id, normalizePath(entry.directory ?? null) ?? sessionDirectory, 'done');
      }
      // Done work leaves the working set, as Mark done in the composer does.
      leaveFinishedSessions(workSessionsInWork.map((entry) => entry.id));
    } catch (error) {
      toastSessionWorkFailure(
        error instanceof SessionDirectoryMissingError,
        () => handleDeleteSession(session, { skipConfirm: true }),
        t,
      );
    }
  };
  // Per-session warming is offered only while Settings chose it, for a root
  // session the host's OpenCode runs (a space's sessions run on its own).
  const perSessionWarming = useSessionWarmingStore((state) => state.enabled);
  const isWarmed = useSessionWarmUntil(session.id) !== undefined;
  const canKeepWarm = perSessionWarming && !archivedBucket && !node.session.parentID
    && Boolean(sessionDirectory) && !isSpaceDirectory(sessionDirectory);
  const toggleSessionWarm = async () => {
    if (!sessionDirectory) return;
    try {
      await useSessionWarmingStore.getState().setSessionWarm(session.id, sessionDirectory, !isWarmed);
    } catch {
      toast.error(t('sessions.warming.toggleFailed'));
    }
  };
  // SAFETY: sessionGoalStatusLabelKey contains an i18n key for every SessionGoalStatus.
  const sessionGoalLabel = sessionGoal ? t(sessionGoalStatusLabelKey[sessionGoal.status] as never) : '';
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
  const hasChildren = node.children.length > 0;
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
  const isSubtaskSession = Boolean(resolvedSession.parentID);
  const needsAttention = useSessionUnread(session.id);
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
  const multiRunKey = React.useMemo(() => getMultiRunIdentity(resolvedSession)?.key ?? null, [resolvedSession]);

  const descendantCount = React.useMemo(() => (exportTree ? collectNodeDescendantIds(exportTree).length : 0), [collectNodeDescendantIds, exportTree]);

  const collectChildExports = React.useCallback(async (children: SessionNode[]): Promise<{ children: ChildSessionExport[]; skipped: number }> => {
    const results: ChildSessionExport[] = [];
    let skipped = 0;
    for (const child of children) {
      try {
        if (!sessionDirectory) throw new Error('Session directory is required for export');
        const childRecords = await loadExportRecords({ directory: sessionDirectory, sessionID: child.session.id });
        if (!childRecords) throw new Error('Session runtime changed during export');
        const childTitle = child.session.title || t('sessions.sidebar.session.export.untitledSubagent');
        // SAFETY: OpenCode session payloads may carry the optional agent label used by exports.
        const childAgent = (child.session as Session & { agent?: string }).agent;
        const grandChildren = await collectChildExports(child.children);
        skipped += grandChildren.skipped;
        results.push({
          title: childTitle,
          agent: childAgent,
          records: childRecords,
          children: grandChildren.children,
        });
      } catch {
        skipped += collectNodeDescendantIds(child).length + 1;
      }
    }
    return { children: results, skipped };
  }, [collectNodeDescendantIds, loadExportRecords, sessionDirectory, t]);

  const showSkippedSubtasksWarning = React.useCallback((count: number) => {
    if (count <= 0) return;
    toast.warning(count === 1
      ? t('sessions.sidebar.session.export.skippedSubtaskSingle', { count })
      : t('sessions.sidebar.session.export.skippedSubtaskMany', { count }));
  }, [t]);

  const doExportSession = React.useCallback(async (includeSubtasks: boolean, tree: SessionNode) => {
    if (!sessionDirectory) {
      toast.error(t('sessions.sidebar.session.export.nothingToExport'));
      return;
    }

    const records = await loadExportRecords({ directory: sessionDirectory, sessionID: session.id }).catch(() => null);
    if (!records) {
      toast.error(t('sessions.sidebar.session.export.failedLoadHistory'));
      return;
    }
    if (records.length === 0) {
      toast.error(t('sessions.sidebar.session.export.nothingToExport'));
      return;
    }

    let childExports: ChildSessionExport[] | undefined;
    let skippedSubtaskCount = 0;
    if (includeSubtasks && tree.children.length > 0) {
      const collected = await collectChildExports(tree.children);
      childExports = collected.children;
      skippedSubtaskCount = collected.skipped;
    }

    const markdown = formatSessionAsMarkdown(records, resolvedSession.title ?? null, childExports);
    const filename = buildExportFilename(resolvedSession.title ?? null);
    const savedPath = await saveAsMarkdownDesktop(markdown, filename);

    if (savedPath) {
      toast.success(t('sessions.sidebar.session.export.success'), {
        action: {
          label: t(getExportRevealLabelKey()),
          onClick: () => {
            void revealExportedMarkdown(savedPath).then((revealed) => {
              if (!revealed) {
                toast.error(t('sessions.sidebar.session.export.failedRevealPath'));
              }
            });
          },
        },
      });
      showSkippedSubtasksWarning(skippedSubtaskCount);
      return;
    }

    downloadAsMarkdown(markdown, filename);
    toast.success(t('sessions.sidebar.session.export.success'));
    showSkippedSubtasksWarning(skippedSubtaskCount);
  }, [collectChildExports, loadExportRecords, resolvedSession.title, session.id, sessionDirectory, showSkippedSubtasksWarning, t]);
  const guestActionEntries = useGuestActions();
  const guestSessionActionEntries = React.useMemo(() => guestSessionActions(guestActionEntries), [guestActionEntries]);
  const handleGuestSessionAction = React.useCallback((entry: GuestActionEntry) => {
    void runGuestSessionAction({
      entry,
      t,
      session: { id: session.id, title: resolvedSession.title, directory: sessionDirectory },
      loadRecords: () => (sessionDirectory
        ? loadExportRecords({ directory: sessionDirectory, sessionID: session.id }).catch(() => null)
        : Promise.resolve(null)),
      onLoadFailed: () => toast.error(t('sessions.sidebar.session.export.failedLoadHistory')),
    });
  }, [loadExportRecords, resolvedSession.title, session.id, sessionDirectory, t]);
  const handleExportSession = React.useCallback(async () => {
    const tree = node.children.length > 0 ? node : buildActiveSessionTreeFromCache(resolvedSession);
    if (tree.children.length > 0) {
      setExportTree(tree);
      setExportIncludeSubtasks(true);
      setExportDialogOpen(true);
      return;
    }
    await doExportSession(false, tree);
  }, [doExportSession, node, resolvedSession]);

  const handleOpenMiniChatWindow = React.useCallback(() => {
    if (!sessionDirectory) return;
    void invokeDesktop('desktop_open_session_mini_chat_window', {
      sessionId: session.id,
      directory: sessionDirectory,
      ...getMiniChatRuntimeArgs(),
    }).catch((error) => {
      console.warn('[session-sidebar] failed to open mini chat window', error);
    });
  }, [session.id, sessionDirectory]);

  const handleOpenInSidePanel = () => {
    if (!sessionDirectory) return;
    // The tab lives under the main chat's directory, which is the one
    // the panel reads; the session's own directory rides along so a
    // chat from another project (or Chat) still resolves itself.
    const panelDirectory = resolveEffectiveDirectory() ?? sessionDirectory;
    openContextPanelTab(panelDirectory, {
      mode: 'chat',
      dedupeKey: `session:${session.id}`,
      label: sessionTitle,
      sessionTitleFallback: sessionTitle,
      targetDirectory: sessionDirectory,
    });
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
        className="group relative my-0.5 flex items-center gap-1.5 rounded-md py-1.5 pe-2.5"
      >
        <span aria-hidden className="h-3.5 w-3.5 flex-shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col gap-0">
          {renameForm}
        </div>
      </div>
    );
  }

  const pendingFormLabel = t('sessions.sidebar.session.status.questionPending');
  const showUnreadStatus = !isSessionActionPending && !isStreaming && needsAttention && !isActive;
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
  const actionsReserveClass = isTimelineRow && !isOneLineTimelineRow
    ? ['[--oc-actions-reserve:0.875rem]', '[--oc-actions-reserve:2.25rem]', '[--oc-actions-reserve:3.625rem]', '[--oc-actions-reserve:5rem]'][extraHoverActions]
    : ['[--oc-actions-reserve:0.625rem]', '[--oc-actions-reserve:1.75rem]', '[--oc-actions-reserve:2.875rem]', '[--oc-actions-reserve:4rem]'][extraHoverActions];
  // An open row menu (dropdown or right-click) keeps the actions shown, so
  // what they cover gives way too, hover or not.
  const actionsMaskClass = alwaysShowActions
    ? undefined
    : isSessionMenuOpen
      ? 'oc-actions-mask'
      : isVSCode
        ? 'group-hover:oc-actions-mask'
        : 'group-hover:oc-actions-mask group-has-[:focus-visible]:oc-actions-mask';
  const coveredMetaFadeClass = isSessionMenuOpen ? 'opacity-0' : hideOnHoverClass;
  const pinnedLabel = t('sessions.sidebar.session.status.pinned');
  const pinnedMarkerContent = (
    <RowMarkTooltip label={pinnedLabel}>
      <span className="inline-flex flex-shrink-0 items-center" aria-label={pinnedLabel}>
        <Icon name="pushpin" className="h-3 w-3 text-primary" />
      </span>
    </RowMarkTooltip>
  );
  const sessionActionSpinner = (
    <Icon
      name="loader-4"
      className="h-3 w-3 flex-shrink-0 animate-spin text-primary"
      aria-label={isAiRenaming ? t('sessions.aiRename.generating') : t('sessions.sidebar.session.status.movingToWorktree')}
    />
  );
  const liveStateMark = isSessionActionPending ? sessionActionSpinner : showStatusMarker ? statusMarkerContent : null;
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
    if (suppressNextSelectRef.current) {
      suppressNextSelectRef.current = false;
      return;
    }
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
    if (event.button === 2 || (event.button === 0 && event.ctrlKey && !selectionModeEnabled)) {
      suppressNextSelectRef.current = true;
    }
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

  const handleWorktreeSubmenuOpenChange = (open: boolean) => {
    worktreeSubmenuOpenRef.current = open;
    worktreeLoadSequenceRef.current += 1;
    const loadSequence = worktreeLoadSequenceRef.current;
    if (!open) {
      setWorktreeTargetsLoadFailed(false);
      return;
    }
    const load = startSessionWorktreeMenuLoad({
      projectId: projectId ?? null,
      sourceDirectory: sessionDirectory,
      currentWorktree: currentWorktreeMetadata,
    });
    setWorktreeTargets(load.cachedTargets);
    setWorktreeTargetsLoadFailed(false);
    void load.refreshTargets
      .then((freshTargets) => {
        if (!worktreeSubmenuOpenRef.current || worktreeLoadSequenceRef.current !== loadSequence) {
          return;
        }
        setWorktreeTargets(freshTargets);
        setWorktreeTargetsLoadFailed(false);
      })
      .catch(() => {
        if (!worktreeSubmenuOpenRef.current || worktreeLoadSequenceRef.current !== loadSequence) {
          return;
        }
        setWorktreeTargetsLoadFailed(true);
      });
  };

  const renderSessionMenuItems = ({
    Item,
    Separator,
    Sub,
    SubTrigger,
    SubContent,
  }: {
    Item: React.ElementType;
    Separator: React.ElementType;
    Sub: React.ElementType;
    SubTrigger: React.ElementType;
    SubContent: React.ElementType;
  }) => (
    <>
      <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.rename')}>
      <Item
        onClick={() => {
          // Defer rename until dropdown close transition completes.
          // onOpenChangeComplete fires after animation + focus cleanup are done,
          // avoiding focus stealing from Base UI's unmount cleanup.
          pendingRenameRef.current = { id: session.id, title: sessionTitle };
        }}
        className="[&>svg]:me-1"
      >
        <Icon name="pencil-ai" className="me-1 h-4 w-4" />
        {t('sessions.sidebar.session.menu.rename')}
      </Item>
      </SessionMenuItemHint>
      <SessionAiRenameMenuItem sessionID={session.id} directory={sessionDirectory} open={isSessionMenuOpen} Item={Item} />
      <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.copyId')}>
      <Item onClick={() => handleCopySessionId(session.id)} className="[&>svg]:me-1">
        <Icon name="file-copy" className="me-1 h-4 w-4" />
        {t('sessions.sidebar.session.menu.copyId')}
      </Item>
      </SessionMenuItemHint>
      <SessionMenuItemHint hint={isPinnedSession ? t('sessions.sidebar.session.menuHint.unpin') : t('sessions.sidebar.session.menuHint.pin')}>
      <Item
        onClick={() => {
          if (!sessionDirectory) return;
          const failedKey = isPinnedSession ? 'sessions.sidebar.session.pin.unpinFailed' : 'sessions.sidebar.session.pin.pinFailed';
          toggleSessionPin({ directory: sessionDirectory, sessionId: session.id }).catch(() => toast.error(t(failedKey)));
        }}
        className="[&>svg]:me-1"
      >
        {isPinnedSession ? <Icon name="unpin" className="me-1 h-4 w-4" /> : <Icon name="pushpin" className="me-1 h-4 w-4" />}
        {isPinnedSession ? t('sessions.sidebar.session.menu.unpin') : t('sessions.sidebar.session.menu.pin')}
      </Item>
      </SessionMenuItemHint>
      {canTrackWork ? (
        <SessionMenuItemHint hint={isInWork ? t('sessions.sidebar.session.menuHint.markDone') : t('sessions.sidebar.session.menuHint.track')}>
        <Item onClick={() => { void toggleSessionWork(); }} className="[&>svg]:me-1">
          <Icon name={isInWork ? 'check' : 'eye'} className="me-1 h-4 w-4" />
          {isInWork ? t('sessions.sidebar.session.work.markDone') : t('sessions.sidebar.session.work.track')}
        </Item>
        </SessionMenuItemHint>
      ) : null}
      {canKeepWarm ? (
        <SessionMenuItemHint hint={isWarmed ? t('sessions.sidebar.session.menuHint.stopWarm') : t('sessions.sidebar.session.menuHint.keepWarm')}>
        <Item onClick={() => { void toggleSessionWarm(); }} className="[&>svg]:me-1">
          <Icon name={isWarmed ? 'fire-fill' : 'fire'} className="me-1 h-4 w-4" />
          {isWarmed ? t('sessions.sidebar.session.menu.stopWarm') : t('sessions.sidebar.session.menu.keepWarm')}
        </Item>
        </SessionMenuItemHint>
      ) : null}
      <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.exportMarkdown')}>
      <Item onClick={() => { void handleExportSession(); }} className="[&>svg]:me-1">
        <Icon name="download" className="me-1 h-4 w-4" />
        {t('sessions.sidebar.session.menu.exportMarkdown')}
      </Item>
      </SessionMenuItemHint>
      {guestSessionActionEntries.map((entry) => (
        <Item key={`${entry.guest.id}:${entry.action.id}`} onClick={() => handleGuestSessionAction(entry)} className="[&>svg]:me-1">
          <GuestIcon icon={entry.icon} iconSrc={entry.iconSrc} className="me-1 size-4" />
          {entry.action.label}
        </Item>
      ))}
      {canShowSessionWorktreeMenu({ isSubtaskSession, archivedBucket: Boolean(archivedBucket), isVSCode, sessionDirectory }) ? (() => {
        const isWorktreeMenuDisabled = getSessionWorktreeMenuDisabled({
          sessionDirectory,
          isStreaming,
          isMovingToWorktree,
        });
        const worktreeMenuState = getSessionWorktreeMenuState({
          targets: worktreeTargets,
          loadFailed: worktreeTargetsLoadFailed,
        });
        const worktreeSubTrigger = (
          <SubTrigger
            disabled={isWorktreeMenuDisabled}
            className="w-full [&>svg]:me-1"
            data-session-worktree-submenu-trigger={session.id}
          >
            <Icon name="folder-shared" className="me-1 h-4 w-4" />
            {t('sessions.sidebar.session.menu.moveToWorktreeTargets')}
          </SubTrigger>
        );
        // Only a disabled item explains itself: an enabled one opens the
        // worktree list, which the hint would cover.
        const worktreeMenuHint = isMovingToWorktree
          ? t('sessions.sidebar.session.moveToWorktree.tooltipMoving')
          : isStreaming
            ? t('sessions.sidebar.session.moveToWorktree.tooltipBusy')
            : null;
        return (
          <Sub onOpenChange={handleWorktreeSubmenuOpenChange}>
            {worktreeMenuHint
              ? <SessionMenuItemHint hint={worktreeMenuHint}>{worktreeSubTrigger}</SessionMenuItemHint>
              : worktreeSubTrigger}
            <SubContent className="min-w-[220px]" data-session-worktree-submenu={session.id}>
              {worktreeTargets.map((target) => {
                const targetPath = normalizePath(target.metadata.path ?? null) ?? target.metadata.path;
                const itemLabel = target.isPrimary
                  ? t('sessions.sidebar.session.moveToWorktree.main')
                  : (target.metadata.label || target.metadata.branch || target.metadata.name || target.metadata.path);
                const isDisabled = target.isCurrent || target.metadata.worktreeStatus !== 'ready';

                return (
                  <Item
                    key={targetPath}
                    disabled={isDisabled}
                    title={target.metadata.path}
                    data-session-worktree-target={targetPath}
                    onClick={() => {
                      if (isDisabled || !sessionDirectory) {
                        return;
                      }
                      requestSessionTreeMove({
                        kind: 'existing',
                        root: resolvedSession,
                        descendants: collectSessionMoveDescendants(resolvedSession, collectNodeDescendantSessions(node)),
                        sourceDirectory: sessionDirectory,
                        destination: target.metadata,
                        messages: buildSessionTreeMoveMessages(t, {
                          success: 'sessions.sidebar.session.moveToWorktree.existingSuccess',
                          failure: 'sessions.sidebar.session.moveToWorktree.existingFailed',
                        }),
                      });
                    }}
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-1 truncate">
                      <span className="truncate">{itemLabel}</span>
                      {target.isCurrent ? <span className="sr-only">{t('sessions.sidebar.session.moveToWorktree.current')}</span> : null}
                    </span>
                    {target.isCurrent ? <Icon name="check" className="ms-2 h-3.5 w-3.5 flex-shrink-0 text-primary" aria-hidden="true" /> : null}
                  </Item>
                );
              })}
              {worktreeMenuState.refreshState === 'error' ? (
                <Item disabled data-session-worktree-refresh-state="error" className="py-0.5 text-muted-foreground typography-micro">
                  {t('sessions.sidebar.session.moveToWorktree.loadFailed')}
                </Item>
              ) : null}
              <Separator />
              {worktreeMenuState.showNewWorktreeAction ? (
                <Item
                  disabled={isWorktreeMenuDisabled}
                  data-session-worktree-new-action="true"
                  onClick={() => {
                    if (isWorktreeMenuDisabled || !sessionDirectory) return;
                    requestSessionTreeMove({
                      kind: 'quick',
                      root: resolvedSession,
                      descendants: collectSessionMoveDescendants(resolvedSession, collectNodeDescendantSessions(node)),
                      sourceDirectory: sessionDirectory,
                      messages: buildSessionTreeMoveMessages(t, {
                        success: 'sessions.sidebar.session.moveToWorktree.success',
                        failure: 'sessions.sidebar.session.moveToWorktree.failed',
                      }),
                    });
                  }}
                  className="[&>svg]:me-1"
                >
                  <Icon name="add" className="me-1 h-4 w-4" />
                  {t('sessions.sidebar.session.menu.newWorktree')}
                </Item>
              ) : null}
            </SubContent>
          </Sub>
        );
      })() : null}
      {multiRunKey ? (
        <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.openRunOverview')}>
        <Item onClick={() => useUIStore.getState().setRunOverviewKey(multiRunKey)} className="[&>svg]:me-1">
          <ArrowsMerge className="me-1 h-4 w-4" />
          {t('sessions.sidebar.session.menu.openRunOverview')}
        </Item>
        </SessionMenuItemHint>
      ) : null}

      {sessionDirectory && !archivedBucket && !isTimelineRow ? (() => {
        // Folders are flat per project: list folders from every scope of the
        // owning project (root + all worktrees) so sessions can be filed
        // across worktrees. Each action targets the folder's owning scope,
        // and moving between scopes clears the previous membership first.
        const scopes: string[] = [];
        const pushScope = (candidate: string | null | undefined) => {
          const normalized = normalizePath(candidate ?? null);
          if (normalized && !scopes.includes(normalized)) scopes.push(normalized);
        };
        if (projectId && !isVSCode) {
          const project = useProjectsStore.getState().projects.find((entry) => entry.id === projectId);
          const projectRoot = normalizePath(project?.path ?? null);
          pushScope(projectRoot);
          if (projectRoot) {
            (useSessionUIStore.getState().availableWorktreesByProject.get(projectRoot) ?? [])
              .forEach((worktree) => pushScope(worktree.path));
          }
        }
        pushScope(getChatsRootFromDirectory(sessionDirectory));
        pushScope(sessionDirectory);
        const folderEntries = scopes.flatMap((scope) =>
          getFoldersForScope(scope).map((folder) => ({ scope, folder })));
        const currentEntry = folderEntries.find(({ scope, folder }) =>
          getSessionFolderId(scope, session.id) === folder.id) ?? null;
        const defaultScope = scopes[0] ?? sessionDirectory;
        return (
          <>
            <Separator />
            <Sub>
              <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.moveToFolder')}>
                <SubTrigger className="[&>svg]:me-1"><Icon name="folder" className="h-4 w-4" />{t('sessions.sidebar.folders.moveToFolder')}</SubTrigger>
              </SessionMenuItemHint>
              <SubContent className="min-w-[180px]">
                {folderEntries.length === 0 ? (
                  <Item disabled className="text-muted-foreground">{t('sessions.sidebar.folders.none')}</Item>
                ) : (
                  folderEntries.map(({ scope, folder }) => {
                    const isCurrent = currentEntry?.folder.id === folder.id;
                    return (
                      <Item key={folder.id} onClick={() => {
                        if (isCurrent) {
                          removeSessionFromFolder(scope, session.id);
                          return;
                        }
                        if (currentEntry && currentEntry.scope !== scope) {
                          removeSessionFromFolder(currentEntry.scope, session.id);
                        }
                        addSessionToFolder(scope, folder.id, session.id);
                      }}>
                        <span className="flex-1 truncate">{folder.name}</span>
                        {isCurrent ? <Icon name="check" className="ms-2 h-3.5 w-3.5 text-primary flex-shrink-0" /> : null}
                      </Item>
                    );
                  })
                )}
                <Separator />
                <Item onClick={() => {
                   const newFolder = createFolderAndStartRename(defaultScope);
                   if (!newFolder) return;
                   pendingFolderCreateRef.current = true;
                  if (currentEntry && currentEntry.scope !== defaultScope) {
                    removeSessionFromFolder(currentEntry.scope, session.id);
                  }
                  addSessionToFolder(defaultScope, newFolder.id, session.id);
                }}>
                  <Icon name="add" className="me-1 h-4 w-4" />
                  {t('sessions.sidebar.folders.newFolderEllipsis')}
                </Item>
                {currentEntry ? (
                  <Item onClick={() => { removeSessionFromFolder(currentEntry.scope, session.id); }} className="text-destructive focus:text-destructive">
                    <Icon name="close" className="me-1 h-4 w-4" />
                    {t('sessions.sidebar.folders.removeFromFolder')}
                  </Item>
                ) : null}
              </SubContent>
            </Sub>
          </>
        );
      })() : null}

      {!isVSCode ? (
        <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.openInSidePanel')}>
        <Item
          disabled={!sessionDirectory}
          onClick={handleOpenInSidePanel}
          className="[&>svg]:me-1"
        >
          <Icon name="chat-4" className="me-1 h-4 w-4" />
          <span className="truncate">{t('sessions.sidebar.session.menu.openInSidePanel')}</span>
        </Item>
        </SessionMenuItemHint>
      ) : null}

      {isElectron ? (
        <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.openMiniChatWindow')}>
        <Item
          disabled={!sessionDirectory}
          onClick={handleOpenMiniChatWindow}
          className="[&>svg]:me-1"
        >
          <Icon name="window" className="me-1 h-4 w-4" />
          <span className="truncate">{t('sessions.sidebar.session.menu.openMiniChatWindow')}</span>
        </Item>
        </SessionMenuItemHint>
      ) : null}

      <Separator />
      {!archivedBucket ? (
        <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.archive')}>
        <Item className="[&>svg]:me-1" onClick={() => handleDeleteSession(session, { archivedBucket })}>
          <Icon name="inbox-archive" className="me-1 h-4 w-4" />
          {t('sessions.sidebar.bulkActions.archive')}
        </Item>
        </SessionMenuItemHint>
      ) : null}
      {archivedBucket ? (
        <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.restore')}>
        <Item className="[&>svg]:me-1" onClick={() => handleRestoreSession(session)}>
          <Icon name="inbox-unarchive" className="me-1 h-4 w-4" />
          {t('sessions.sidebar.bulkActions.restore')}
        </Item>
        </SessionMenuItemHint>
      ) : null}
      <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.delete')}>
      <Item className="text-destructive focus:text-destructive [&>svg]:me-1" onClick={() => handleDeleteSession(session, { archivedBucket, hardDelete: true })}>
        <Icon name="delete-bin" className="me-1 h-4 w-4" />
        {t('sessions.sidebar.bulkActions.delete')}
      </Item>
      </SessionMenuItemHint>
    </>
  );

  const handleWorkToggleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void toggleSessionWork();
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
          <span className="inline-flex flex-shrink-0 items-center rounded bg-destructive/10 px-1 py-0.5 text-destructive" aria-label={permissionLabel}>
            <Icon name="shield" className="h-3 w-3" />
          </span>
        </RowMarkTooltip>
      ) : null}
      {hasPendingForm ? (
        <RowMarkTooltip label={pendingFormLabel}>
          <span className="inline-flex flex-shrink-0 items-center rounded bg-status-info/10 px-1 py-0.5 text-status-info" aria-label={pendingFormLabel}>
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

  // Every row shares the timeline row body: grouped and Chats rows use its
  // one-line form, with the session's live state and time on the right.
  const rowBody = (
    <SessionTimelineRowBody
      compact={!isTwoLineRow}
      leadToggle={leadToggle}
      leadIconClassName={leadToggle ? leadIconClassName : undefined}
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
      timeSlot={showActivityDuration
        ? <SessionActivityDuration sessionId={session.id} running={isStreaming} className="typography-micro" />
        : null}
      // Project rows leave the action indicator to their worktree header.
      directoryIndicator={!archivedBucket && sessionDirectory && renderContext !== 'project' ? <DirectoryActionIndicator directory={sessionDirectory} /> : null}
      prBadge={timelinePrBadge}
      zombieIndicator={isTimelineRow ? streamingIndicator : null}
      goal={sessionGoalGlyph}
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
      {renderSessionMenuItems({
        Item: DropdownMenuItem,
        Separator: DropdownMenuSeparator,
        Sub: DropdownMenuSub,
        SubTrigger: DropdownMenuSubTrigger,
        SubContent: DropdownMenuSubContent,
      })}
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
          {renderSessionMenuItems({
            Item: ({ className, ...itemProps }: React.ComponentProps<typeof ContextMenu.Item>) => (
              <ContextMenu.Item className={cn(dropdownMenuItemClass, className)} {...itemProps} />
            ),
            Separator: ({ className, ...separatorProps }: React.ComponentProps<typeof ContextMenu.Separator>) => (
              <ContextMenu.Separator className={cn(dropdownMenuSeparatorClass, className)} {...separatorProps} />
            ),
            Sub: ContextMenu.SubmenuRoot,
            SubTrigger: ({ className, children, ...triggerProps }: React.ComponentProps<typeof ContextMenu.SubmenuTrigger>) => (
              <ContextMenu.SubmenuTrigger className={cn(dropdownMenuSubTriggerClass, className)} {...triggerProps}>
                {children}
                <Icon name="arrow-right-s" className="ms-auto size-3.5" />
              </ContextMenu.SubmenuTrigger>
            ),
            SubContent: ({ className, children, ...popupProps }: React.ComponentProps<typeof ContextMenu.Popup>) => (
              <ContextMenu.Portal>
                <ContextMenu.Positioner className="app-region-no-drag z-50">
                  <ContextMenu.Popup
                    data-slot="dropdown-menu-sub-content"
                    style={{
                      backgroundColor: 'var(--surface-elevated)',
                      color: 'var(--surface-elevated-foreground)',
                    }}
                    className={cn(dropdownMenuPopupClass, className)}
                    {...popupProps}
                  >
                    {children}
                  </ContextMenu.Popup>
                </ContextMenu.Positioner>
              </ContextMenu.Portal>
            ),
          })}
        </ContextMenu.Popup>
      </ContextMenu.Positioner>
    </ContextMenu.Portal>
  );

  return (
    <React.Fragment key={session.id}>
      <DraggableSessionRow sessionId={session.id} dragKey={dragKey ?? sessionRowKey} ownerKey={folderOwnerKey ?? selectionScopeKey} sessionDirectory={sessionDirectory ?? null} sessionTitle={sessionTitle} archivedBucket={archivedBucket}>
        <ContextMenuRoot open={isContextMenuOpen} onOpenChange={handleContextMenuOpenChange} onOpenChangeComplete={handleMenuOpenChangeComplete}>
          <ContextMenu.Trigger
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
                  'py-1.5',
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
                      ? (isSessionMenuOpen
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
      <Dialog open={exportDialogOpen} onOpenChange={setExportDialogOpen}>
        <DialogContent showCloseButton={false} className="max-w-sm gap-5">
          <DialogHeader>
            <DialogTitle>{t('sessions.sidebar.session.export.dialog.title')}</DialogTitle>
            <DialogDescription>
              {descendantCount === 1
                ? t('sessions.sidebar.session.export.dialog.descriptionSingle', { count: descendantCount })
                : t('sessions.sidebar.session.export.dialog.descriptionMany', { count: descendantCount })}
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-center gap-2 typography-ui-label cursor-pointer">
            <input
              type="checkbox"
              checked={exportIncludeSubtasks}
              onChange={(e) => setExportIncludeSubtasks(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-primary"
            />
            {t('sessions.sidebar.session.export.dialog.includeSubtasks')}
          </label>
          <DialogFooter>
            <Button
              type="button"
              onClick={() => setExportDialogOpen(false)}
              variant="outline"
              size="sm"
            >
              {t('sessions.sidebar.dialogs.cancel')}
            </Button>
            <Button
              type="button"
              onClick={() => {
                setExportDialogOpen(false);
                void doExportSession(exportIncludeSubtasks, exportTree ?? node);
              }}
              size="sm"
            >
              {t('sessions.sidebar.session.export.dialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
    && prev.handleCopySessionId === next.handleCopySessionId
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
