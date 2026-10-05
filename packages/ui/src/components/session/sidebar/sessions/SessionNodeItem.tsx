import { DirectoryActionIndicator } from './DirectoryActionIndicator';
import { useSessionTurnActivity } from '@/sync/global-session-status';
import React from 'react';
import { SessionActivityIndicator } from '@/components/session/SessionActivityIndicator';
import type { Session } from '@/lib/opencode/model';
import { ContextMenu } from '@base-ui/react/context-menu';
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
import { getPrStatusLabel } from '../prStatusLabel';
import { cn, formatDirectoryName } from '@/lib/utils';
import { canUseElectronDesktopIPC, invokeDesktop, isVSCodeRuntime } from '@/lib/desktop';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { isSessionPinned, useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
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
import { useSessionBlockingRequestCounts } from '@/sync/sync-context';
import { usePrefetchSessionMessages, useSessionMessageRecordsForExport } from '@/sync/use-sync';
import { getSyncSessionMaterializationStatus } from '@/sync/sync-refs';
import { useViewportStore, viewportSessionKey } from '@/sync/viewport-store';
import { DraggableSessionRow } from '../folders/sessionFolderDnd';
import { useSessionRowOrderRegistry } from './sessionRowOrder';
import { canShowSessionWorktreeMenu, getSessionWorktreeMenuDisabled, nodeContainsSessionId, nodeHasPinnedMembershipChange, resolveSessionPrLookup, resolveTooltipBranchLabel, selectBlockingBadgeSessionScopes, selectRowBadgeVisibilityClass, type BlockingBadgeSessionScope } from './sessionNodeItemUtils';
import { useSessionRowMenuState } from './useSessionRowMenuState';
import type { SessionNode } from '../types';
import type { SessionSidebarRenderContext } from '../sessionSidebarRowModel';
import { SessionTimelineRowBody } from './SessionTimelineRowBody';
import { formatProjectLabel, formatSessionCompactDateLabel, formatSessionDateLabel, normalizePath, renderHighlightedText } from '../utils';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { openExternalUrl } from '@/lib/url';
import { SessionMenuItemHint } from '../../SessionMenuItemHint';
import { SIDEBAR_REF_TOOLTIP_CLOSE_DELAY_MS, SidebarRefLinks, type SidebarRefLink } from './SidebarRefLinks';
import { useFreshestSourceControlVisualSummaryForBranch, type PrVisualSummary } from '@/stores/useGitHubPrStatusStore';
import { useTrackedIssueStates, useTrackedLinearStates, useTrackedPullVisualSummaries } from '@/stores/useTrackedItemsStore';
import { githubThread, gitlabThread, linearIssue } from '@/lib/trackedItems/fromLinks';
import { formatChangeRequestReference } from '@/lib/source-control/identity';
import { getLinkedGitHubPullRequests, getLinkedSidebarChanges, getLinkedSidebarIssues, type LinkedGitHubPullRequest, type LinkedSidebarChange, type LinkedSidebarIssue } from '@/lib/linkedIssues';
import { buildSessionIssueItems, combineSessionPrSummaries, findLinkedPrsWithoutState } from './sessionPrSummaries';
import { useSessionUnseenCount } from '@/sync/notification-store';
import { useHasSessionActivityDuration } from '@/sync/session-activity-timing';
import { SessionActivityDuration } from '@/components/session/SessionActivityDuration';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';
import { useI18n } from '@/lib/i18n';
import { useShiftKeyHeld } from '@/hooks/useShiftKeyHeld';
import { getSessionGoal } from '@/lib/sessionGoalMetadata';
import { getCurrentSessionAssist } from '@/lib/sessionAssistMetadata';
import { isDoneSuggested, isSessionInWork } from '@/lib/sessionWorkMetadata';
import { setSessionWorkState } from '@/sync/session-actions';
import { sessionGoalStatusColor, sessionGoalStatusLabelKey } from '@/lib/sessionGoalPresentation';
import { getRuntimeBearerTokenSync } from '@/lib/runtime-auth';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
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
};

export type SessionNodeItemProps = {
  node: SessionNode;
  depth?: number;
  groupDirectory?: string | null;
  projectId?: string | null;
  folderOwnerKey?: string | null;
  selectionScopeKey?: string | null;
  archivedBucket?: boolean;
  pinnedSessionIds: Set<string>;
  expandedParents: Set<string>;
  hasSessionSearchQuery: boolean;
  normalizedSessionSearchQuery: string;
  notifyOnSubtasks: boolean;
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
  /** Timeline rows have no project header above them, so their menu offers
      the project's edit dialog directly. */
  onEditProject?: (projectId: string) => void;
  secondaryMeta?: SecondaryMeta | null;
  renderContext?: SessionSidebarRenderContext;
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
   * flat Timeline rows. Both row memo boundaries use it to notice changes
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

// Shared row geometry: the gutter edge matches the zone-header band padding
// (px-1.5 = 6px), the marker slot is icon-wide (14px) with a 6px gap, so row
// text starts exactly where the zone-header label starts. Nested children
// shift by one gutter step per depth level.
const EMPTY_LINKED_PULL_REQUESTS: readonly LinkedGitHubPullRequest[] = [];
const EMPTY_LINKED_SIDEBAR_ISSUES: readonly LinkedSidebarIssue[] = [];
const EMPTY_LINKED_SIDEBAR_CHANGES: readonly LinkedSidebarChange[] = [];

/** One PR or issue a session row lists in its badge and tooltips. */
type SessionRefLine = SidebarRefLink & {
  /** The badge's short form: `#12` or the tracker identifier. */
  label: string;
};
const ROW_GUTTER_LEFT_PX = 6;
const ROW_DEPTH_STEP_PX = 14;
const ROW_TEXT_LEFT_PX = ROW_GUTTER_LEFT_PX + 14 + 6;

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
            'inline-flex items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-opacity',
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
      <TooltipContent side="left" sideOffset={8}>
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
    groupDirectory,
    projectId,
    folderOwnerKey,
    selectionScopeKey: explicitSelectionScopeKey,
    archivedBucket = false,
    pinnedSessionIds,
    expandedParents,
    hasSessionSearchQuery,
    normalizedSessionSearchQuery,
    notifyOnSubtasks,
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
    onEditProject,
    mobileVariant,
    alwaysShowActions,
    secondaryMeta,
    renderContext = 'project',
    blockingBadgeSessionScopes: timelineBadgeSessionScopes,
    rowKey,
    dragKey,
    children,
  } = props;
  const togglePinnedSession = useSessionPinnedStore((state) => state.toggle);
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
  // Track / Done belongs to top-level project sessions: Chats are plain
  // conversations, never work. Touch layouts keep their actions permanently
  // visible, where an icon on every row would be noise: there it lives in the
  // session menu only.
  const canTrackWork = sessionWorkEnabled && !archivedBucket && !node.session.parentID && !isChatDirectoryPath(node.session.directory);
  const showWorkAction = canTrackWork && !alwaysShowActions;
  // Hover-revealed actions besides the menu: work, quick archive, and in VS
  // Code open-in-editor.
  const extraHoverActions = (showWorkAction ? 1 : 0) + (showQuickArchiveAction ? 1 : 0) + (showOpenInEditorAction ? 1 : 0);
  // VS Code reveals its permanent-size actions on hover, so the title makes
  // room for them there.
  const vscodeAlwaysActionPaddingClass = ['group-hover:pr-8', 'group-hover:pr-14', 'group-hover:pr-18', 'group-hover:pr-22'][extraHoverActions];
  const alwaysActionPaddingClass = showQuickArchiveAction ? 'pr-13' : 'pr-7';
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
  const isTimelineRow = renderContext === 'timeline' || renderContext === 'timeline-chat';
  const isTimelineChatRow = renderContext === 'timeline-chat';
  // Timeline rows show the project's own icon; the row reads exactly that one
  // project record, and `find` keeps the reference stable between renders.
  const timelineProject = useProjectsStore(
    React.useCallback((state) => {
      if (!isTimelineRow || !projectId) return null;
      return state.projects.find((entry) => entry.id === projectId) ?? null;
    }, [isTimelineRow, projectId]),
  );
  const tooltipProjectLabel = secondaryMeta?.projectLabel
    ?? (projectLabelFromStore ? formatProjectLabel(projectLabelFromStore) : null);
  // A null branchLabel on an explicit secondaryMeta is a deliberate filter
  // (HEAD/redundant with the project label), so it must not fall through to
  // the raw worktree branch. Project rows pass no secondaryMeta and keep the
  // worktree fallback.
  const tooltipBranchLabel = resolveTooltipBranchLabel(secondaryMeta, node.worktree?.branch ?? null);
  const prLookup = React.useMemo(
    () => resolveSessionPrLookup(node.worktree, isVSCode),
    [isVSCode, node.worktree],
  );
  const branchPrSummary = useFreshestSourceControlVisualSummaryForBranch(prLookup?.directory ?? null, prLookup?.branch ?? null);
  const linkedPullRequests = React.useMemo(
    () => (isVSCode ? EMPTY_LINKED_PULL_REQUESTS : getLinkedGitHubPullRequests(session)),
    [isVSCode, session],
  );
  const linkedPullLinks = React.useMemo(
    () => linkedPullRequests.map((link) => ({ item: githubThread('pull', link), url: link.url, title: link.title })),
    [linkedPullRequests],
  );
  const linkedPullVisuals = useTrackedPullVisualSummaries(linkedPullLinks);
  const linkedPrSummaries = React.useMemo(
    () => linkedPullVisuals.filter((summary): summary is PrVisualSummary => summary !== null),
    [linkedPullVisuals],
  );
  // Merge and pull requests on other services follow the GitHub ones. GitLab
  // merge requests carry live state once it arrives; the rest show by
  // identifier, uncoloured.
  const linkedChanges = React.useMemo(
    () => (isVSCode ? EMPTY_LINKED_SIDEBAR_CHANGES : getLinkedSidebarChanges(session)),
    [isVSCode, session],
  );
  const linkedGitLabChanges = React.useMemo(
    () => linkedChanges.flatMap((change) => (change.gitlab ? [{ item: gitlabThread('pull', change.gitlab), url: change.url, title: change.title }] : [])),
    [linkedChanges],
  );
  const gitlabChangeSummaries = useTrackedPullVisualSummaries(linkedGitLabChanges);
  // The branch's PR and the PRs and merge requests linked to the session; the
  // row leads with the one that needs attention first.
  const prSummaries = React.useMemo(
    () => combineSessionPrSummaries(branchPrSummary, [
      ...linkedPrSummaries,
      ...gitlabChangeSummaries.filter((summary): summary is PrVisualSummary => summary !== null),
    ]),
    [branchPrSummary, gitlabChangeSummaries, linkedPrSummaries],
  );
  // GitLab merge requests whose state is known are among the PR lines above.
  const uncolouredChanges = React.useMemo(() => {
    let gitlabIndex = 0;
    return linkedChanges.filter((change) => {
      if (!change.gitlab) return true;
      const known = gitlabChangeSummaries[gitlabIndex] !== null;
      gitlabIndex += 1;
      return !known;
    });
  }, [gitlabChangeSummaries, linkedChanges]);
  const linkedPrsWithoutState = React.useMemo(
    () => findLinkedPrsWithoutState(linkedPullRequests, prSummaries),
    [linkedPullRequests, prSummaries],
  );
  // The branch icon speaks for the branch, not for PRs linked from elsewhere.
  const branchPrIconColor = branchPrSummary ? `var(--pr-${branchPrSummary.visualState})` : undefined;
  // The project tree already shows the branch on the worktree sub-header, so
  // the per-row marker only appears in the mixed-context recent list.
  const showInlineBranchMarker = Boolean(tooltipBranchLabel) && renderContext === 'recent';
  // Linked issues show only while the session has no PR: once a PR exists it
  // is the thing to follow, and it usually closes the issue anyway.
  const linkedIssues = React.useMemo(
    () => (isVSCode ? EMPTY_LINKED_SIDEBAR_ISSUES : getLinkedSidebarIssues(session)),
    [isVSCode, session],
  );
  const linkedGitHubIssueItems = React.useMemo(
    () => linkedIssues.flatMap((issue) => (issue.source === 'github' ? [githubThread('issue', issue)] : [])),
    [linkedIssues],
  );
  const linkedIssueStates = useTrackedIssueStates(linkedGitHubIssueItems);
  const linkedGitLabIssueItems = React.useMemo(
    () => linkedIssues.flatMap((issue) => (issue.source === 'gitlab' ? [gitlabThread('issue', issue.ref)] : [])),
    [linkedIssues],
  );
  const linkedGitLabIssueStates = useTrackedIssueStates(linkedGitLabIssueItems);
  const linkedLinearItems = React.useMemo(
    () => linkedIssues.flatMap((issue) => (issue.source === 'linear' ? [linearIssue(issue.identifier)] : [])),
    [linkedIssues],
  );
  const linkedLinearStates = useTrackedLinearStates(linkedLinearItems);
  // What the row's badge and tooltips list: its PRs, or else its issues.
  const refLines = React.useMemo((): SessionRefLine[] => {
    if (prSummaries.length > 0 || linkedPrsWithoutState.length > 0 || uncolouredChanges.length > 0) {
      const githubLines = prSummaries.map((summary): SessionRefLine => {
        const label = getPrStatusLabel(summary, t);
        const reference = formatChangeRequestReference(summary.provider, summary.number);
        return {
          key: `${summary.provider ?? ''}:${summary.repo?.owner ?? ''}/${summary.repo?.repo ?? ''}#${summary.number}`,
          icon: 'git-pull-request',
          label: reference,
          color: `var(--pr-${summary.visualState})`,
          url: summary.url,
          title: summary.title,
          text: label ? `${reference} · ${label}` : reference,
        };
      });
      const pendingLines = linkedPrsWithoutState.map((link): SessionRefLine => ({
        key: `${link.owner}/${link.repo}#${link.number}`,
        icon: 'git-pull-request',
        label: `#${link.number}`,
        url: link.url,
        title: link.title,
        text: `#${link.number}`,
      }));
      const otherLines = uncolouredChanges.map((change): SessionRefLine => ({
        key: change.key,
        icon: 'git-pull-request',
        label: change.identifier,
        url: change.url,
        title: change.title,
        text: change.identifier,
      }));
      return [...githubLines, ...pendingLines, ...otherLines];
    }
    return buildSessionIssueItems(linkedIssues, linkedIssueStates, linkedLinearStates, linkedGitLabIssueStates).map((item) => ({
      key: item.key,
      icon: item.icon,
      label: item.label,
      color: item.color ?? undefined,
      url: item.url,
      title: item.title,
      text: item.statusKey ? `${item.label} · ${t(item.statusKey)}` : item.statusText ? `${item.label} · ${item.statusText}` : item.label,
    }));
  }, [linkedGitLabIssueStates, linkedIssueStates, linkedIssues, linkedLinearStates, linkedPrsWithoutState, prSummaries, t, uncolouredChanges]);
  const primaryRef = refLines[0] ?? null;
  const moreRefCount = Math.max(0, refLines.length - 1);
  const refBadgeLabel = refLines.map((line) => line.text).join(', ');
  const isActive = useSessionUIStore((state) => state.currentSessionId === session.id);

  const sessionDirectory = normalizePath(session.directory ?? null) ?? normalizePath(groupDirectory ?? null);
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

  const legacyContextKey = `${renderContext}:${archivedBucket ? 'archived' : 'active'}:${session.id}`;
  const menuInstanceKey = rowKey ? `session-menu:${rowKey}` : legacyContextKey;
  const contextMenuInstanceKey = rowKey ? `session-context:${rowKey}` : null;
  const isZombie = useViewportStore(
    React.useCallback((state) => Boolean(state.sessionMemoryState.get(viewportSessionKey(session.id))?.isZombie), [session.id]),
  );
  const turnActivity = useSessionTurnActivity(session.id);
  const isStreaming = turnActivity !== null;
  // Read as a boolean, not as the value: the row must not re-render on every
  // tick of the counter it only decides to mount.
  const hasActivityDuration = useHasSessionActivityDuration(session.id, isStreaming);
  const isMovingToWorktree = useIsSessionWorktreeMovePending(session.id);
  const isAiRenaming = useIsSessionAiRenamePending(session.id, sessionDirectory);
  const isSessionActionPending = isMovingToWorktree || isAiRenaming;
  const currentWorktreeMetadata = node.worktree ?? useSessionUIStore.getState().getWorktreeMetadata(session.id) ?? null;
  const [worktreeTargets, setWorktreeTargets] = React.useState<SessionWorktreeMenuTarget[]>([]);
  const [worktreeTargetsLoading, setWorktreeTargetsLoading] = React.useState(false);
  const [worktreeTargetsLoadFailed, setWorktreeTargetsLoadFailed] = React.useState(false);
  const worktreeSubmenuOpenRef = React.useRef(false);
  const worktreeLoadSequenceRef = React.useRef(0);
  const sessionGoal = getSessionGoal(resolvedSession);
  const isInWork = canTrackWork && isSessionInWork(resolvedSession);
  const showDoneHint = isInWork && !isStreaming && isDoneSuggested(resolvedSession);
  const workActionLabel = isInWork ? t('sessions.sidebar.session.work.markDone') : t('sessions.sidebar.session.work.track');
  const toggleSessionWork = async () => {
    try {
      await setSessionWorkState(session.id, sessionDirectory, isInWork ? 'done' : 'open');
    } catch {
      toast.error(t('sessions.sidebar.session.work.updateFailed'));
    }
  };
  const sessionGoalGlyph = sessionGoal ? (
    // SAFETY: sessionGoalStatusLabelKey contains an i18n key for every SessionGoalStatus.
    <span
      className="inline-flex flex-shrink-0 items-center"
      title={t(sessionGoalStatusLabelKey[sessionGoal.status] as never)}
      aria-label={t(sessionGoalStatusLabelKey[sessionGoal.status] as never)}
    >
      <Icon name="target" className="h-3 w-3" style={{ color: sessionGoalStatusColor[sessionGoal.status] }} />
    </span>
  ) : null;
  const sessionTitle = resolvedSession.title || t('sessions.sidebar.session.untitled');
  // Timeline is a flat list: a node that still carries children renders as a
  // leaf, without a chevron and without an expansion state.
  const hasChildren = !isTimelineRow && node.children.length > 0;
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
    permissionCount: pendingPermissionCount,
    formCount: pendingFormCount,
  } = useSessionBlockingRequestCounts(blockingBadgeSessionScopes);
  const isSubtaskSession = Boolean(resolvedSession.parentID);
  const unseenCount = useSessionUnseenCount(session.id);
  const needsAttention = unseenCount > 0 && (!isSubtaskSession || notifyOnSubtasks);
  const sessionTimestamp = resolvedSession.time?.updated || resolvedSession.time?.created || Date.now();
  const sessionUpdatedLabel = formatSessionDateLabel(sessionTimestamp);
  const sessionCompactUpdatedLabel = formatSessionCompactDateLabel(sessionTimestamp);
  const {
    isMenuOpen,
    isContextMenuOpen,
    handleMenuOpenChange,
    handleContextMenuOpenChange,
    handleMenuOpenChangeComplete,
    toggleMenu,
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

  const descendantCount = React.useMemo(() => collectNodeDescendantIds(node).length, [collectNodeDescendantIds, node]);

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

  const doExportSession = React.useCallback(async (includeSubtasks: boolean) => {
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
    if (includeSubtasks && node.children.length > 0) {
      const collected = await collectChildExports(node.children);
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
  }, [collectChildExports, loadExportRecords, node.children, resolvedSession.title, session.id, sessionDirectory, showSkippedSubtasksWarning, t]);
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
    if (node.children.length > 0) {
      setExportIncludeSubtasks(true);
      setExportDialogOpen(true);
      return;
    }
    await doExportSession(false);
  }, [doExportSession, node.children.length]);

  const handleOpenMiniChatWindow = React.useCallback(() => {
    if (!sessionDirectory) return;
    void invokeDesktop('desktop_open_session_mini_chat_window', {
      sessionId: session.id,
      directory: sessionDirectory,
      apiBaseUrl: getRuntimeApiBaseUrl(),
      clientToken: getRuntimeBearerTokenSync(),
    }).catch((error) => {
      console.warn('[session-sidebar] failed to open mini chat window', error);
    });
  }, [session.id, sessionDirectory]);

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
    if (isTimelineRow) {
      // Renaming keeps the whole card in place: the title line becomes the
      // input, project and branch stay where they were.
      return (
        <div
          key={session.id}
          style={{ paddingLeft: ROW_GUTTER_LEFT_PX + 4 }}
          className={cn(
            'group relative my-0.5 flex items-center rounded-md pr-2.5',
            isTimelineChatRow ? 'py-1' : 'py-1.5',
            isActive && 'bg-interactive-selection/70 text-interactive-selection-foreground',
          )}
        >
          <SessionTimelineRowBody
            compact={isTimelineChatRow}
            project={timelineProject}
            projectLabel={tooltipProjectLabel}
            title={renameForm}
            titleClassName="text-foreground"
            branchLabel={tooltipBranchLabel}
            statusDot={null}
            pinnedMarker={null}
            timeSlot={sessionCompactUpdatedLabel}
            directoryIndicator={null}
            prBadge={primaryRef ? (
              <span
                className={cn('inline-flex flex-shrink-0 items-center gap-1 typography-micro', !primaryRef.color && 'text-muted-foreground')}
                style={primaryRef.color ? { color: primaryRef.color } : undefined}
              >
                <Icon name={primaryRef.icon} className="h-3 w-3" />
                <span className="leading-none tabular-nums">{primaryRef.label}</span>
                {moreRefCount > 0 ? <span className="leading-none tabular-nums text-muted-foreground">+{moreRefCount}</span> : null}
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
        style={{ paddingLeft: ROW_TEXT_LEFT_PX + depth * ROW_DEPTH_STEP_PX }}
        // my-0.5 matches the normal row box so entering rename mode does not
        // shift the row vertically.
        className="group relative my-0.5 flex items-center rounded-sm py-1 pr-1.5"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0">
          {renameForm}
        </div>
      </div>
    );
  }

  const pendingFormLabel = pendingFormCount === 1
    ? t('sessions.sidebar.session.status.questionPendingSingle')
    : t('sessions.sidebar.session.status.questionPendingMany', { count: pendingFormCount });
  // Actions are permanently visible (with matching permanent padding) only in
  // the non-VSCode alwaysShowActions layout; every other layout hover-reveals
  // them over the row's right edge, where the badges live (#2284).
  const badgeVisibilityClass = selectRowBadgeVisibilityClass({
    actionsAlwaysVisible: alwaysShowActions && !isVSCode,
    menuOpen: isSessionMenuOpen,
    hideOnHoverClass,
  });
  const showUnreadStatus = !isSessionActionPending && !isStreaming && needsAttention && !isActive;
  const showStatusMarker = isStreaming || showUnreadStatus;
  // Running indicators are static by default; the local appearance preference
  // enables stepped motion without changing the elapsed-turn counter.
  const statusMarkerContent = <SessionActivityIndicator state={turnActivity ?? 'unread'} />;
  // The settled duration lives exactly as long as the unread marker does, so a
  // session read (or watched) while it finishes never keeps a stale total.
  const showActivityDuration = (isStreaming || showUnreadStatus) && hasActivityDuration;
  // Hover-revealed actions cross-fade over the row's right end instead of
  // pushing the title: the meta they cover fades out and the title's tail
  // fades away under them (`oc-actions-mask`), so nothing moves. The reserve
  // is how far the actions reach in from the row content's right edge: their
  // width less the 6px they sit nearer the row edge (16px buttons, 20px on
  // three-line timeline rows, 2px apart).
  const actionsReserveClass = isTimelineRow && !isTimelineChatRow
    ? ['[--oc-actions-reserve:14px]', '[--oc-actions-reserve:36px]', '[--oc-actions-reserve:58px]', '[--oc-actions-reserve:80px]'][extraHoverActions]
    : ['[--oc-actions-reserve:10px]', '[--oc-actions-reserve:28px]', '[--oc-actions-reserve:46px]', '[--oc-actions-reserve:64px]'][extraHoverActions];
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
  const hideLeadingIndicatorOnHover = !alwaysShowActions && hasChildren && (isSessionActionPending || showStatusMarker || isPinnedSession);
  const showPinnedMarker = isPinnedSession && !isSessionActionPending && !showStatusMarker;
  const pinnedMarkerContent = (
    <Icon
      name="pushpin"
      className="h-3 w-3 flex-shrink-0 text-primary"
      aria-label={t('sessions.sidebar.session.status.pinned')}
    />
  );
  const sessionActionSpinner = (
    <Icon
      name="loader-4"
      className="h-3 w-3 flex-shrink-0 animate-spin text-primary"
      aria-label={isAiRenaming ? t('sessions.aiRename.generating') : t('sessions.sidebar.session.status.movingToWorktree')}
    />
  );
  const leadingIndicators = isSessionActionPending || showStatusMarker || showPinnedMarker ? (
    <span
      style={{ left: ROW_GUTTER_LEFT_PX + depth * ROW_DEPTH_STEP_PX }}
      className={cn(
        'pointer-events-none absolute top-1/2 inline-flex h-3.5 w-3.5 -translate-y-1/2 items-center justify-center transition-opacity',
        hideLeadingIndicatorOnHover ? 'opacity-100 group-hover:opacity-0 group-has-[:focus-visible]:opacity-0' : '',
      )}
    >
      {isSessionActionPending ? sessionActionSpinner : showStatusMarker ? statusMarkerContent : showPinnedMarker ? pinnedMarkerContent : null}
    </span>
  ) : null;
  const hideChevronUntilHover = hasChildren && !alwaysShowActions && (isSessionActionPending || showStatusMarker || isPinnedSession);
  const subsessionChevron = hasChildren ? (
    <span
      role="button"
      tabIndex={0}
      onClick={(event) => {
        event.stopPropagation();
        // Blur mouse-click focus so the hover-only chevron/indicator swap
        // resets on mouse-leave instead of sticking via :focus-within.
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
      style={{ minWidth: 14, minHeight: 14, left: ROW_GUTTER_LEFT_PX + depth * ROW_DEPTH_STEP_PX }}
      className={cn(
        'absolute top-1/2 inline-flex h-3.5 w-3.5 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-opacity',
        hideChevronUntilHover
          ? 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-has-[:focus-visible]:opacity-100 group-has-[:focus-visible]:pointer-events-auto'
          : '',
      )}
      aria-label={isExpanded
        ? t('sessions.sidebar.session.subsessions.collapse')
        : t('sessions.sidebar.session.subsessions.expand')}
    >
      {isExpanded ? <Icon name="arrow-down-s" className="h-3 w-3" /> : <Icon name="arrow-right-s" className="h-3 w-3" />}
    </span>
  ) : null;

  const streamingIndicator = isZombie
    ? <Icon name="error-warning" className="h-4 w-4 text-status-warning" />
    : null;

  const handleMenuTriggerClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    toggleMenu();
  };

  const handleMenuTriggerPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleMenuTriggerMouseDown = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
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
    if (event?.currentTarget) holdSessionRowPosition(event.currentTarget);
    handleSessionSelect(session.id, sessionDirectory);
  };

  // The selection/active highlight covers the WHOLE row box (gutter, edge
  // paddings), while the primary click target is the inner title button.
  // Make the rest of the highlighted box clickable too — but only for clicks
  // that did not originate from an interactive child (title button, chevron,
  // action menu), so nothing double-fires.
  const handleRowBackgroundClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    // SAFETY: React click targets are DOM EventTargets; closest is valid only for HTMLElements.
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest('button, a, input, [role="menuitem"], [role="menu"]')) return;
    handleRowSelect(event);
  };

  const handleRowMouseDown = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (event.button === 2 || (event.button === 0 && event.ctrlKey && !selectionModeEnabled)) {
      suppressNextSelectRef.current = true;
    }
  };
  const handleRowPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
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
  const handleRowPointerEnd = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (mobileVariant && event.pointerType === 'touch') {
      setIsTouchPressed(false);
    }
  };

  const handleWorktreeSubmenuOpenChange = (open: boolean) => {
    worktreeSubmenuOpenRef.current = open;
    worktreeLoadSequenceRef.current += 1;
    const loadSequence = worktreeLoadSequenceRef.current;
    if (!open) {
      setWorktreeTargetsLoading(false);
      setWorktreeTargetsLoadFailed(false);
      return;
    }
    const load = startSessionWorktreeMenuLoad({
      projectId: projectId ?? null,
      sourceDirectory: sessionDirectory,
      currentWorktree: currentWorktreeMetadata,
    });
    setWorktreeTargets(load.cachedTargets);
    setWorktreeTargetsLoading(true);
    setWorktreeTargetsLoadFailed(false);
    void load.refreshTargets
      .then((freshTargets) => {
        if (!worktreeSubmenuOpenRef.current || worktreeLoadSequenceRef.current !== loadSequence) {
          return;
        }
        setWorktreeTargets(freshTargets);
        setWorktreeTargetsLoading(false);
        setWorktreeTargetsLoadFailed(false);
      })
      .catch(() => {
        if (!worktreeSubmenuOpenRef.current || worktreeLoadSequenceRef.current !== loadSequence) {
          return;
        }
        setWorktreeTargetsLoading(false);
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
        className="[&>svg]:mr-1"
      >
        <Icon name="pencil-ai" className="mr-1 h-4 w-4" />
        {t('sessions.sidebar.session.menu.rename')}
      </Item>
      </SessionMenuItemHint>
      <SessionAiRenameMenuItem sessionID={session.id} directory={sessionDirectory} open={isSessionMenuOpen} Item={Item} />
      <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.copyId')}>
      <Item onClick={() => handleCopySessionId(session.id)} className="[&>svg]:mr-1">
        <Icon name="file-copy" className="mr-1 h-4 w-4" />
        {t('sessions.sidebar.session.menu.copyId')}
      </Item>
      </SessionMenuItemHint>
      <SessionMenuItemHint hint={isPinnedSession ? t('sessions.sidebar.session.menuHint.unpin') : t('sessions.sidebar.session.menuHint.pin')}>
      <Item onClick={() => sessionDirectory && togglePinnedSession({ directory: sessionDirectory, sessionId: session.id })} className="[&>svg]:mr-1">
        {isPinnedSession ? <Icon name="unpin" className="mr-1 h-4 w-4" /> : <Icon name="pushpin" className="mr-1 h-4 w-4" />}
        {isPinnedSession ? t('sessions.sidebar.session.menu.unpin') : t('sessions.sidebar.session.menu.pin')}
      </Item>
      </SessionMenuItemHint>
      {canTrackWork ? (
        <SessionMenuItemHint hint={isInWork ? t('sessions.sidebar.session.menuHint.markDone') : t('sessions.sidebar.session.menuHint.track')}>
        <Item onClick={() => { void toggleSessionWork(); }} className="[&>svg]:mr-1">
          <Icon name={isInWork ? 'check' : 'eye'} className="mr-1 h-4 w-4" />
          {isInWork ? t('sessions.sidebar.session.work.markDone') : t('sessions.sidebar.session.work.track')}
        </Item>
        </SessionMenuItemHint>
      ) : null}
      <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.exportMarkdown')}>
      <Item onClick={() => { void handleExportSession(); }} className="[&>svg]:mr-1">
        <Icon name="download" className="mr-1 h-4 w-4" />
        {t('sessions.sidebar.session.menu.exportMarkdown')}
      </Item>
      </SessionMenuItemHint>
      {guestSessionActionEntries.map((entry) => (
        <Item key={`${entry.guest.id}:${entry.action.id}`} onClick={() => handleGuestSessionAction(entry)} className="[&>svg]:mr-1">
          <GuestIcon icon={entry.icon} iconSrc={entry.iconSrc} className="mr-1 size-4" />
          {entry.action.label}
        </Item>
      ))}
      {isTimelineRow && projectId && onEditProject ? (
        <Item onClick={() => onEditProject(projectId)} className="[&>svg]:mr-1">
          <Icon name="pencil-ai" className="h-4 w-4" />
          {t('sessions.sidebar.project.actions.edit')}
        </Item>
      ) : null}
      {canShowSessionWorktreeMenu({ isSubtaskSession, archivedBucket: Boolean(archivedBucket), isVSCode, sessionDirectory }) ? (() => {
        const isWorktreeMenuDisabled = getSessionWorktreeMenuDisabled({
          sessionDirectory,
          isStreaming,
          isMovingToWorktree,
        });
        const worktreeMenuState = getSessionWorktreeMenuState({
          targets: worktreeTargets,
          isRefreshing: worktreeTargetsLoading,
          loadFailed: worktreeTargetsLoadFailed,
        });
        return (
          <Sub onOpenChange={handleWorktreeSubmenuOpenChange}>
            <SessionMenuItemHint hint={isMovingToWorktree
              ? t('sessions.sidebar.session.moveToWorktree.tooltipMoving')
              : isStreaming
                ? t('sessions.sidebar.session.moveToWorktree.tooltipBusy')
                : t('sessions.sidebar.session.moveToWorktree.tooltipTargets')}>
              <SubTrigger
                disabled={isWorktreeMenuDisabled}
                className="w-full [&>svg]:mr-1"
                data-session-worktree-submenu-trigger={session.id}
              >
                <Icon name="folder-shared" className="mr-1 h-4 w-4" />
                {t('sessions.sidebar.session.menu.moveToWorktreeTargets')}
              </SubTrigger>
            </SessionMenuItemHint>
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
                        descendants: collectNodeDescendantSessions(node),
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
                    {target.isCurrent ? <Icon name="check" className="ml-2 h-3.5 w-3.5 flex-shrink-0 text-primary" aria-hidden="true" /> : null}
                  </Item>
                );
              })}
              {worktreeMenuState.refreshState === 'loading' ? (
                <Item disabled data-session-worktree-refresh-state="loading" className="py-0.5 text-muted-foreground typography-micro">
                  {t('sessions.sidebar.session.moveToWorktree.refreshing')}
                </Item>
              ) : null}
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
                      descendants: collectNodeDescendantSessions(node),
                      sourceDirectory: sessionDirectory,
                      messages: buildSessionTreeMoveMessages(t, {
                        success: 'sessions.sidebar.session.moveToWorktree.success',
                        failure: 'sessions.sidebar.session.moveToWorktree.failed',
                      }),
                    });
                  }}
                  className="[&>svg]:mr-1"
                >
                  <Icon name="add" className="mr-1 h-4 w-4" />
                  {t('sessions.sidebar.session.menu.newWorktree')}
                </Item>
              ) : null}
            </SubContent>
          </Sub>
        );
      })() : null}
      {multiRunKey ? (
        <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.openRunOverview')}>
        <Item onClick={() => useUIStore.getState().setRunOverviewKey(multiRunKey)} className="[&>svg]:mr-1">
          <ArrowsMerge className="mr-1 h-4 w-4" />
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
                <SubTrigger className="[&>svg]:mr-1"><Icon name="folder" className="h-4 w-4" />{t('sessions.sidebar.folders.moveToFolder')}</SubTrigger>
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
                        {isCurrent ? <Icon name="check" className="ml-2 h-3.5 w-3.5 text-primary flex-shrink-0" /> : null}
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
                  <Icon name="add" className="mr-1 h-4 w-4" />
                  {t('sessions.sidebar.folders.newFolderEllipsis')}
                </Item>
                {currentEntry ? (
                  <Item onClick={() => { removeSessionFromFolder(currentEntry.scope, session.id); }} className="text-destructive focus:text-destructive">
                    <Icon name="close" className="mr-1 h-4 w-4" />
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
          onClick={() => {
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
          }}
          className="[&>svg]:mr-1"
        >
          <Icon name="chat-4" className="mr-1 h-4 w-4" />
          <span className="truncate">{t('sessions.sidebar.session.menu.openInSidePanel')}</span>
          <span className="shrink-0 typography-micro px-1 rounded leading-none pb-px text-[var(--status-warning)] bg-[var(--status-warning)]/10">{t('sessions.sidebar.session.menu.betaBadge')}</span>
        </Item>
        </SessionMenuItemHint>
      ) : null}

      {isElectron ? (
        <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.openMiniChatWindow')}>
        <Item
          disabled={!sessionDirectory}
          onClick={handleOpenMiniChatWindow}
          className="[&>svg]:mr-1"
        >
          <Icon name="window" className="mr-1 h-4 w-4" />
          <span className="truncate">{t('sessions.sidebar.session.menu.openMiniChatWindow')}</span>
        </Item>
        </SessionMenuItemHint>
      ) : null}

      <Separator />
      {!archivedBucket ? (
        <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.archive')}>
        <Item className="[&>svg]:mr-1" onClick={() => handleDeleteSession(session, { archivedBucket })}>
          <Icon name="inbox-archive" className="mr-1 h-4 w-4" />
          {t('sessions.sidebar.bulkActions.archive')}
        </Item>
        </SessionMenuItemHint>
      ) : null}
      {archivedBucket ? (
        <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.restore')}>
        <Item className="[&>svg]:mr-1" onClick={() => handleRestoreSession(session)}>
          <Icon name="inbox-unarchive" className="mr-1 h-4 w-4" />
          {t('sessions.sidebar.bulkActions.restore')}
        </Item>
        </SessionMenuItemHint>
      ) : null}
      <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.delete')}>
      <Item className="text-destructive focus:text-destructive [&>svg]:mr-1" onClick={() => handleDeleteSession(session, { archivedBucket, hardDelete: true })}>
        <Icon name="delete-bin" className="mr-1 h-4 w-4" />
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

  // Three-line timeline rows are taller, so their hover actions step up one
  // size to match the metadata they replace (the pin marker, the dot, the time).
  const actionButtonSizeClass = alwaysShowActions ? 'h-6 w-6' : isTimelineRow && !isTimelineChatRow ? 'h-5 w-5' : 'h-4 w-4';
  const actionIconSizeClass = alwaysShowActions ? 'h-3.5 w-3.5' : isTimelineRow && !isTimelineChatRow ? 'h-3 w-3' : 'h-2.5 w-2.5';
  const checkIconSizeClass = alwaysShowActions ? 'h-4 w-4' : isTimelineRow && !isTimelineChatRow ? 'h-3.5 w-3.5' : 'h-3 w-3';

  // The recap of the last turn, for the whole-row tooltip, under the same
  // freshness rule the chat uses.
  const currentRecap = sessionRecapEnabled && !isStreaming
    ? getCurrentSessionAssist(resolvedSession)?.recap || null
    : null;
  // Jev thinks the work looks finished: a quiet check next to the row until a
  // new turn starts or the user closes it.
  const doneHintLabel = t('sessions.sidebar.session.work.doneSuggested');
  const doneHintBadge = (className?: string) => (showDoneHint ? (
    <span className={cn('inline-flex flex-shrink-0 items-center text-muted-foreground/75', className)} title={doneHintLabel} aria-label={doneHintLabel}>
      <Icon name="check" className="h-3.5 w-3.5" />
    </span>
  ) : null);
  // Timeline rows carry the done hint in their first line instead.
  const badgeDoneHint = !isTimelineRow && showDoneHint;
  const rowBadges = (pendingPermissionCount > 0 || pendingFormCount > 0 || badgeDoneHint) ? (
    <>
      {badgeDoneHint ? doneHintBadge() : null}
      {pendingPermissionCount > 0 ? (
        <span className="inline-flex flex-shrink-0 items-center gap-1 rounded bg-destructive/10 px-1 py-0.5 text-[0.7rem] text-destructive" title={t('sessions.sidebar.session.status.permissionRequired')} aria-label={t('sessions.sidebar.session.status.permissionRequired')}>
          <Icon name="shield" className="h-3 w-3" />
          <span className="leading-none">{pendingPermissionCount}</span>
        </span>
      ) : null}
      {pendingFormCount > 0 ? (
        <span className="inline-flex flex-shrink-0 items-center gap-1 rounded bg-status-info/10 px-1 py-0.5 text-[0.7rem] text-status-info" title={pendingFormLabel} aria-label={pendingFormLabel}>
          <Icon name="question" className="h-3 w-3" />
          <span className="leading-none">{pendingFormCount}</span>
        </span>
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
            'inline-flex flex-shrink-0 items-center gap-1 rounded typography-micro hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:no-underline',
            !primaryRef.color && 'text-muted-foreground',
          )}
          style={primaryRef.color ? { color: primaryRef.color } : undefined}
          disabled={!primaryRef.url}
          aria-label={refBadgeLabel}
          onPointerDown={handleRowActionPointerDown}
          onMouseDown={handleRowActionMouseDown}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (primaryRef.url) void openExternalUrl(primaryRef.url);
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Icon name={primaryRef.icon} className="h-3 w-3" />
          <span className="leading-none tabular-nums">{primaryRef.label}</span>
          {moreRefCount > 0 ? <span className="leading-none tabular-nums text-muted-foreground">+{moreRefCount}</span> : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="max-w-xs">
        <SidebarRefLinks items={refLines} />
      </TooltipContent>
    </Tooltip>
  ) : null;

  const timelineRowBody = isTimelineRow ? (
    <SessionTimelineRowBody
      compact={isTimelineChatRow}
      project={timelineProject}
      projectLabel={tooltipProjectLabel}
      title={renderHighlightedText(sessionTitle, normalizedSessionSearchQuery)}
      titleClassName={isActive || isRowSelected
        ? 'text-interactive-selection-foreground'
        : needsAttention ? 'text-foreground' : 'text-foreground/80'}
      branchLabel={tooltipBranchLabel}
      statusDot={isSessionActionPending ? sessionActionSpinner : showStatusMarker ? statusMarkerContent : null}
      pinnedMarker={isPinnedSession && !isSessionActionPending ? pinnedMarkerContent : null}
      timeSlot={showActivityDuration
        ? <SessionActivityDuration sessionId={session.id} running={isStreaming} className="typography-micro" />
        : sessionCompactUpdatedLabel}
      directoryIndicator={!archivedBucket && sessionDirectory ? <DirectoryActionIndicator directory={sessionDirectory} /> : null}
      prBadge={timelinePrBadge}
      zombieIndicator={streamingIndicator}
      goal={sessionGoalGlyph}
      badges={rowBadges}
      doneHint={doneHintBadge()}
      providerId={resolvedSession.model?.providerID ?? null}
      metaPaddingClass={alwaysShowActions
        ? (showQuickArchiveAction ? 'pr-13' : 'pr-7')
        : undefined}
      hideMetaOnHoverClass={alwaysShowActions && !isVSCode ? '' : coveredMetaFadeClass}
      actionsReserveClass={actionsReserveClass}
      actionsMaskClass={actionsMaskClass}
    />
  ) : null;

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
                <Icon name="arrow-right-s" className="ml-auto size-3.5" />
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
        <ContextMenu.Root open={isContextMenuOpen} onOpenChange={handleContextMenuOpenChange} onOpenChangeComplete={handleMenuOpenChangeComplete}>
          <ContextMenu.Trigger
            render={
              <div
                data-session-row={session.id}
                data-session-scope={selectionScopeKey ?? ''}
                data-session-archived={archivedBucket ? '1' : '0'}
                aria-current={isActive ? 'page' : undefined}
                onClick={handleRowBackgroundClick}
                // Row geometry mirrors the zone-header band: full container
                // width, px-1.5 inner edge, a 14px icon-wide gutter (status
                // marker / chevron) plus a 6px gap, so the title starts at the
                // same x as the header text. Children indent one gutter step.
                // Content sits 4px further from the row's inner edges than the
                // gutter itself: timeline rows on both sides, project rows only
                // on the right (their left edge is the status/chevron gutter).
                style={{ paddingLeft: isTimelineRow ? ROW_GUTTER_LEFT_PX + 4 : ROW_TEXT_LEFT_PX + depth * ROW_DEPTH_STEP_PX }}
                className={cn(
                  'group relative my-0.5 flex cursor-pointer items-center rounded-md pr-2.5',
                  isTimelineRow && !isTimelineChatRow ? 'py-1.5' : 'py-1',
                  isTimelineRow && !(isActive || isRowSelected) && 'hover:bg-interactive-hover/60',
                  (isActive || isRowSelected) && 'bg-interactive-selection/70 text-interactive-selection-foreground',
                  isRowSelected && 'ring-1 ring-inset ring-border',
                )}
              />
            }
          >
          {isTimelineRow ? null : leadingIndicators}
          {isTimelineRow ? null : subsessionChevron}
          <div className="flex min-w-0 flex-1 items-center">
            {(
              <Tooltip>
                {/* Rows without a tooltip keep the trigger inert: an open
                    but empty row tooltip would block the PR badge's own. */}
                <TooltipTrigger asChild closeDelay={SIDEBAR_REF_TOOLTIP_CLOSE_DELAY_MS} disabled={isVSCode || isTimelineRow}>
                  <button
                    type="button"
	                    aria-pressed={selectionModeEnabled ? isRowSelected : undefined}
	                    onPointerDown={handleRowPointerDown}
 	                    onPointerUp={handleRowPointerEnd}
 	                    onPointerCancel={handleRowPointerEnd}
 	                    onMouseDown={handleRowMouseDown}
 	                    onClick={(event) => handleRowSelect(event)}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      handleSessionDoubleClick(session.id, sessionTitle);
                    }}
                    className={cn(
                      'flex min-w-0 flex-1 cursor-pointer flex-col gap-0 overflow-hidden text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring text-foreground select-none',
	                      isTouchPressed && 'bg-interactive-hover/70',
                      // Hover-revealed actions overlay the body, which keeps
                      // its width; only permanent actions take room.
                      isTimelineRow || !alwaysShowActions
                        ? undefined
                        : (isVSCode ? vscodeAlwaysActionPaddingClass : alwaysActionPaddingClass),
                    )}
                  >
                    {isTimelineRow ? timelineRowBody : (
                    <div className={cn('@container flex w-full items-center min-w-0 flex-1 gap-1 overflow-hidden', actionsReserveClass)}>
                      {/* Unread emphasis is color-only: a font-weight change
                          would reflow the truncated title and cause a micro
                          horizontal shift when the status flips. */}
                      <div dir="auto" className={cn('block min-w-0 flex-1 truncate typography-ui-label font-normal', actionsMaskClass, isActive || isRowSelected ? 'text-interactive-selection-foreground' : needsAttention ? 'text-foreground' : 'text-foreground/80')}>{renderHighlightedText(sessionTitle, normalizedSessionSearchQuery)}</div>
                      {!archivedBucket && sessionDirectory && renderContext === 'recent' ? (
                        <DirectoryActionIndicator
                          directory={sessionDirectory}
                          className={alwaysShowActions ? undefined : cn('transition-opacity', coveredMetaFadeClass)}
                        />
                      ) : null}
                      {/* The done hint leads the date/branch cluster, the
                          way the Timeline row puts it before the time. */}
                      {doneHintBadge(cn(badgeVisibilityClass, alwaysShowActions ? 'ml-2' : 'ml-1'))}
                      {/* While a turn runs (and until its result is read) the
                          elapsed counter takes over this slot from the usual
                          goal/branch/date metadata, which stays one hover or
                          one read away. */}
                      {alwaysShowActions ? (
                        // Touch runtimes have no hover tooltip, so the compact
                        // date stays inline there.
                        <span className={cn('inline-flex flex-shrink-0 items-center gap-1 typography-micro text-muted-foreground/75', !showDoneHint && 'ml-2')}>
                          {showActivityDuration ? (
                            <SessionActivityDuration sessionId={session.id} running={isStreaming} />
                          ) : (
                            <>
                              {sessionGoalGlyph}
                              {showInlineBranchMarker ? (
                                <Icon
                                  name="git-branch"
                                  className={cn('h-3 w-3', !branchPrIconColor && 'text-muted-foreground/60')}
                                  style={branchPrIconColor ? { color: branchPrIconColor } : undefined}
                                />
                              ) : null}
                              {sessionCompactUpdatedLabel}
                            </>
                          )}
                        </span>
                      ) : (showActivityDuration || sessionGoalGlyph || showInlineBranchMarker || renderContext === 'recent') ? (
                        <div className={cn(
                            'relative flex h-4 flex-shrink-0 items-center justify-end transition-opacity',
                            !showDoneHint && 'ml-1',
                            coveredMetaFadeClass,
                          )}>
                          <span className="inline-flex items-center gap-1 whitespace-nowrap text-right">
                            {showActivityDuration ? (
                              <SessionActivityDuration
                                sessionId={session.id}
                                running={isStreaming}
                                className="typography-micro"
                              />
                            ) : (
                              <>
                                {sessionGoalGlyph}
                                {showInlineBranchMarker ? (
                                  <Icon
                                    name="git-branch"
                                    className={cn('h-3 w-3', !branchPrIconColor && 'text-muted-foreground/60')}
                                    style={branchPrIconColor ? { color: branchPrIconColor } : undefined}
                                  />
                                ) : null}
                                {/* The recent activity list shows its compact
                                    timestamp inline (touch runtimes already get
                                    it through the alwaysShowActions branch);
                                    it shares the slot with the goal/branch
                                    metadata and hides on hover exactly like
                                    them, so the revealed row actions never
                                    overlap it. */}
                                {renderContext === 'recent' ? (
                                  <span className="flex-shrink-0 typography-micro leading-none text-muted-foreground/75 tabular-nums">
                                    {sessionCompactUpdatedLabel}
                                  </span>
                                ) : null}
                              </>
                            )}
                          </span>
                        </div>
                      ) : null}
                      {pendingPermissionCount > 0 ? (
                        <span className={cn('inline-flex items-center gap-1 rounded bg-destructive/10 px-1 py-0.5 text-[0.7rem] text-destructive flex-shrink-0', badgeVisibilityClass)} title={t('sessions.sidebar.session.status.permissionRequired')} aria-label={t('sessions.sidebar.session.status.permissionRequired')}>
                          <Icon name="shield" className="h-3 w-3" />
                          <span className="leading-none">{pendingPermissionCount}</span>
                        </span>
                      ) : null}
                      {pendingFormCount > 0 ? (
                        <span className={cn('inline-flex items-center gap-1 rounded bg-status-info/10 px-1 py-0.5 text-[0.7rem] text-status-info flex-shrink-0', badgeVisibilityClass)} title={pendingFormLabel} aria-label={pendingFormLabel}>
                          <Icon name="question" className="h-3 w-3" />
                          <span className="leading-none">{pendingFormCount}</span>
                        </span>
                      ) : null}
                    </div>
                    )}
                  </button>
                </TooltipTrigger>
                {/* VS Code already shows project context via workspace headers, so
                    the per-row metadata tooltip is redundant noise there. */}
                {!isVSCode && !isTimelineRow ? (
                <TooltipContent side="right" sideOffset={8} className="max-w-xs text-left">
                  <div className="flex min-w-44 flex-col gap-1.5 text-left text-xs">
                    <div className="flex items-center justify-between gap-3">
                      <span dir="auto" className="min-w-0 truncate font-medium text-foreground">{sessionTitle}</span>
                      <span className="flex-shrink-0 text-muted-foreground" title={sessionUpdatedLabel}>{sessionCompactUpdatedLabel}</span>
                    </div>
                    {tooltipProjectLabel && !isTimelineRow ? (
                      <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                        <Icon name="folder" className="h-3 w-3 flex-shrink-0" />
                        <span className="min-w-0 truncate">{tooltipProjectLabel}</span>
                      </div>
                    ) : null}
                    {tooltipBranchLabel ? (
                      <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                        <Icon name="git-branch" className="h-3 w-3 flex-shrink-0" style={branchPrIconColor ? { color: branchPrIconColor } : undefined} />
                        <span className="min-w-0 truncate">{tooltipBranchLabel}</span>
                      </div>
                    ) : null}
                    {refLines.length > 0 ? <SidebarRefLinks items={refLines} /> : null}
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
            <div className="absolute right-1 top-1/2 -translate-y-1/2 z-10">
              {streamingIndicator}
            </div>
          ) : null}

          <div className={cn(
            'absolute right-1 z-10 flex items-center gap-0.5 transition-opacity',
            // Timeline actions overlay the first line's right cluster, not the
            // row's vertical centre.
            // Three-line rows: the row's 6px top padding plus the fixed 20px
            // first line, so the 20px buttons cover that line exactly.
            isTimelineRow && !isTimelineChatRow ? 'top-1.5 h-5' : 'top-1/2 -translate-y-1/2',
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
                      'inline-flex items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-opacity',
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
                <TooltipContent side="left" sideOffset={8}>
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
                      'inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-opacity',
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
                <TooltipContent side="left" sideOffset={8}>
                  {t('sessions.sidebar.session.actions.openInEditor')}
                </TooltipContent>
              </Tooltip>
            ) : null}
            <DropdownMenu open={isMenuOpen} onOpenChange={handleMenuOpenChange} onOpenChangeComplete={handleMenuOpenChangeComplete}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    'inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-opacity',
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
        </ContextMenu.Root>
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
                void doExportSession(exportIncludeSubtasks);
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
    && (prev?.branchLabel ?? null) === (next?.branchLabel ?? null);
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
  if (prev.groupDirectory !== next.groupDirectory) return 'groupDirectory';
  if (prev.projectId !== next.projectId) return 'projectId';
  if (prev.archivedBucket !== next.archivedBucket) return 'archivedBucket';
  if ((prev.renderContext ?? 'project') !== (next.renderContext ?? 'project')) return 'renderContext';
  if (prev.mobileVariant !== next.mobileVariant) return 'mobileVariant';
  if (prev.alwaysShowActions !== next.alwaysShowActions) return 'alwaysShowActions';
  if (prev.hasSessionSearchQuery !== next.hasSessionSearchQuery) return 'hasSessionSearchQuery';
  if (prev.normalizedSessionSearchQuery !== next.normalizedSessionSearchQuery) return 'normalizedSessionSearchQuery';
  if (prev.notifyOnSubtasks !== next.notifyOnSubtasks) return 'notifyOnSubtasks';
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
    && prev.onEditProject === next.onEditProject
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
