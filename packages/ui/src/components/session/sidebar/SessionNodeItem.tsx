import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { canUseElectronDesktopIPC, invokeDesktop, isVSCodeRuntime } from '@/lib/desktop';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Icon } from "@/components/icon/Icon";
import { buildExportFilename, downloadAsMarkdown, formatSessionAsMarkdown, getExportRevealLabelKey, revealExportedMarkdown, saveAsMarkdownDesktop } from '@/lib/exportSession';
import type { ChildSessionExport } from '@/lib/exportSession';
import { buildSessionMessageRecordsSnapshot, useDirectoryStore, useGlobalSessionStatus, useSessionPermissions } from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';
import { useViewportStore, viewportSessionKey } from '@/sync/viewport-store';
import { DraggableSessionRow } from './sessionFolderDnd';
import { nodeContainsSessionId } from './sessionNodeItemUtils';
import type { SessionNodeChildRenderExtras, SessionNodeRenderExtras } from './sessionNodeItemUtils';
import type { SessionNode } from './types';
import { formatSessionCompactDateLabel, formatSessionDateLabel, normalizePath, renderHighlightedText } from './utils';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useSessionUnseenCount } from '@/sync/notification-store';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';
import { useI18n } from '@/lib/i18n';
import { useShiftKeyHeld } from '@/hooks/useShiftKeyHeld';
import { getRuntimeBearerTokenSync } from '@/lib/runtime-auth';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import { parseMultiRunSessionTitle } from '@/lib/multirun/title';
import { MultiRunFusionDialog } from '@/components/multirun/MultiRunFusionDialog';
import { FusionIcon } from '@/components/icons/FusionIcon';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';

type Folder = { id: string; name: string; sessionIds: string[] };

type SecondaryMeta = {
  projectLabel?: string | null;
  branchLabel?: string | null;
};

type Props = {
  node: SessionNode;
  depth?: number;
  groupDirectory?: string | null;
  projectId?: string | null;
  archivedBucket?: boolean;
  directoryStatus?: Map<string, 'unknown' | 'exists' | 'missing'>;
  currentSessionId: string | null;
  pinnedSessionIds: Set<string>;
  expandedParents: Set<string>;
  hasSessionSearchQuery: boolean;
  normalizedSessionSearchQuery: string;
  notifyOnSubtasks: boolean;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  editTitle: string;
  setEditTitle: (value: string) => void;
  handleSaveEdit: (titleOverride?: string) => void;
  handleCancelEdit: () => void;
  toggleParent: (expansionKey: string) => void;
  handleSessionSelect: (sessionId: string, sessionDirectory: string | null, isMissingDirectory: boolean, projectId?: string | null, serverId?: string | null) => void;
  handleSessionDoubleClick: (sessionId: string, sessionTitle: string) => void;
  togglePinnedSession: (sessionId: string) => void;
  handleShareSession: (session: Session) => void;
  copiedSessionId: string | null;
  handleCopyShareUrl: (url: string, sessionId: string) => void;
  handleUnshareSession: (sessionId: string) => void;
  openSidebarMenuKey: string | null;
  setOpenSidebarMenuKey: (key: string | null) => void;
  renamingFolderId: string | null;
  getFoldersForScope: (scopeKey: string) => Folder[];
  getSessionFolderId: (scopeKey: string, sessionId: string) => string | null;
  removeSessionFromFolder: (scopeKey: string, sessionId: string) => void;
  addSessionToFolder: (scopeKey: string, folderId: string, sessionId: string) => void;
  createFolderAndStartRename: (scopeKey: string, parentId?: string | null) => { id: string } | null;
  openContextPanelTab: (directory: string, options: { mode: 'chat'; dedupeKey: string; label: string; readOnly?: boolean }) => void;
  handleDeleteSession: (session: Session, source?: { archivedBucket?: boolean; hardDelete?: boolean; skipConfirm?: boolean }) => void;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  renderSessionNode: (
    node: SessionNode,
    depth?: number,
    groupDirectory?: string | null,
    projectId?: string | null,
    archivedBucket?: boolean,
    secondaryMeta?: SecondaryMeta | null,
    renderContext?: 'project' | 'recent',
    renderExtras?: SessionNodeRenderExtras,
  ) => React.ReactNode;
  secondaryMeta?: SecondaryMeta | null;
  renderContext?: 'project' | 'recent';
  /**
   * Precomputed set of session IDs whose subtree contains the current
   * active session. Computed once per SessionGroupSection render (when
   * currentSessionId changes) instead of being recomputed in every row's
   * React.memo comparator.
   */
  subtreeContainsActive: Set<string>;
  /**
   * Precomputed set of session IDs whose subtree contains the session
   * currently being edited. Same rationale as subtreeContainsActive.
   */
  subtreeContainsEditing: Set<string>;
  /**
   * Precomputed session ID of the row whose sidebar menu is open, or null
   * if no menu is open. Only one row can have its menu open at a time.
   */
  menuOpenSessionId: string | null;
  /**
   * Precomputed structural key for this node. Encodes the IDs and child
   * counts of all descendants so a reference-only change to `node` (e.g.
   * a fresh tree rebuild) can be detected with a single string compare
   * instead of a recursive walk per row.
   */
  nodeStructureKey: string;
  /**
   * Resolves the per-row render extras for each child node. SessionGroupSection
   * walks the whole tree once to precompute the structure key for every
   * descendant; SessionNodeItem's recursive child render uses this lookup
   * to fetch the right key for each child it produces.
   */
  childRenderExtrasFor?: (child: SessionNode) => SessionNodeChildRenderExtras;
  /**
   * Batched index of live session objects keyed by id. The previous
   * implementation called `useSession(session.id)` per row, which used
   * `findLiveSession` to iterate every child-store on every SSE event.
   * With M visible rows that's M×child-stores per event; the batched
   * map turns it into a single Map.get per row. The parent falls back
   * to `useSession` only when this map returns undefined.
   */
  liveSessionById: Map<string, Session>;
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
            'inline-flex items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 transition-opacity',
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

function SessionNodeItemComponent(props: Props): React.ReactNode {
  const { t } = useI18n();
  const {
    node,
    depth = 0,
    groupDirectory,
    projectId,
    archivedBucket = false,
    directoryStatus,
    currentSessionId,
    pinnedSessionIds,
    expandedParents,
    hasSessionSearchQuery,
    normalizedSessionSearchQuery,
    notifyOnSubtasks,
    editingId,
    setEditingId,
    editTitle,
    setEditTitle,
    handleSaveEdit,
    handleCancelEdit,
    toggleParent,
    handleSessionSelect,
    handleSessionDoubleClick,
    togglePinnedSession,
    handleShareSession,
    copiedSessionId,
    handleCopyShareUrl,
    handleUnshareSession,
    openSidebarMenuKey,
    setOpenSidebarMenuKey,
    renamingFolderId,
    getFoldersForScope,
    getSessionFolderId,
    removeSessionFromFolder,
    addSessionToFolder,
    createFolderAndStartRename,
    openContextPanelTab,
    handleDeleteSession,
    mobileVariant,
    alwaysShowActions,
    renderSessionNode,
    secondaryMeta,
    renderContext = 'project',
    subtreeContainsActive,
    subtreeContainsEditing,
    menuOpenSessionId,
    childRenderExtrasFor,
    liveSessionById,
  } = props;
  const hasSecondaryProjectLabel = Boolean(secondaryMeta?.projectLabel);
  const hasSecondaryBranchLabel = Boolean(secondaryMeta?.branchLabel);

  const displayMode = useSessionDisplayStore((state) => state.displayMode);
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  // VS Code always uses the minimal (single-line) layout: sessions are grouped
  // under workspace project headers, so the second metadata row (project/branch)
  // is redundant. The display-mode toggle is hidden there, so force it on.
  const isMinimalMode = displayMode === 'minimal' || isVSCode;
  const isElectron = React.useMemo(() => canUseElectronDesktopIPC(), []);
  const runtimeApis = React.useContext(RuntimeAPIContext);
  const revealOnHoverClass = isVSCode
    ? 'group-hover:opacity-100 group-hover:pointer-events-auto'
    : 'group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto';
  const hideOnHoverClass = isVSCode
    ? 'group-hover:opacity-0'
    : 'group-hover:opacity-0 group-focus-within:opacity-0';
  const showOpenInEditorAction = isVSCode;
  const showQuickArchiveAction = !archivedBucket && !mobileVariant;
  const revealPaddingClass = isMinimalMode
    ? (isVSCode
        // VS Code minimal rows reveal up to three actions on hover
        // (open-in-editor + quick-archive + menu, each h-4). The date sits in the
        // row flow, so the title must shrink enough to clear the actions or they
        // overlap the timestamp. Open-in-editor is always present in VS Code.
        ? (showQuickArchiveAction && showOpenInEditorAction
            ? 'group-hover:pr-18'
            : showQuickArchiveAction || showOpenInEditorAction
              ? 'group-hover:pr-14'
              : 'group-hover:pr-8')
        : 'group-hover:pr-2 group-focus-within:pr-2')
    : (isVSCode
        ? (showQuickArchiveAction && showOpenInEditorAction
            ? 'group-hover:pr-18'
            : showQuickArchiveAction || showOpenInEditorAction
              ? 'group-hover:pr-12'
              : 'group-hover:pr-5')
        : (showQuickArchiveAction ? 'group-hover:pr-12 group-focus-within:pr-12' : 'group-hover:pr-5 group-focus-within:pr-5'));
  const alwaysActionPaddingClass = showQuickArchiveAction ? 'pr-13' : 'pr-7';
  const suppressNextSelectRef = React.useRef(false);
  const [isTouchPressed, setIsTouchPressed] = React.useState(false);
  const editingIdRef = React.useRef(editingId);
  editingIdRef.current = editingId;
  const pendingRenameRef = React.useRef<{ id: string; title: string } | null>(null);
  const handleSaveEditRef = React.useRef(handleSaveEdit);
  handleSaveEditRef.current = handleSaveEdit;
  const [renameDraft, setRenameDraft] = React.useState(editTitle);
  const renameDraftRef = React.useRef(renameDraft);
  renameDraftRef.current = renameDraft;
  const renameTargetRef = React.useRef<string | null>(null);
  const formRef = React.useRef<HTMLFormElement>(null);

  const session = node.session;
  // Batched live-session lookup. `liveSessionById` is built once per
  // Sidebar render from the same `useAllLiveSessions` selector that
  // `useSession` would have iterated per child-store, so a Map.get
  // here is equivalent in observed state but O(1) per row instead of
  // O(child-stores). Falls back to the row session when the live map
  // hasn't seen this id yet (sub-render latency between when a session
  // is created and when the SSE-driven aggregate picks it up).
  const resolvedSession = liveSessionById.get(session.id) ?? session;

  const sessionDirectory =
    normalizePath((session as Session & { directory?: string | null }).directory ?? null)
    ?? normalizePath(groupDirectory ?? null);
  // Archived rows are historical and never need live state, yet they point at
  // dozens of (often deleted) worktrees — bootstrapping each from the sidebar
  // triggers a pointless session-list fetch + 6×2s empty-retry storm on startup.
  // Skip bootstrap for archived rows; the store ref is only read on-demand via
  // getState() in the export handlers (never subscribed). Active rows keep
  // bootstrapping so live cross-directory session/status still aggregates.
  const directoryStore = useDirectoryStore(sessionDirectory ?? undefined, { bootstrap: !archivedBucket });
  const sync = useSync();

  const selectionModeEnabled = useSessionMultiSelectStore((state) => state.enabled);
  const isRowSelected = useSessionMultiSelectStore(
    React.useCallback((state) => state.selectedIds.has(session.id), [session.id]),
  );
  const toggleRowSelected = useSessionMultiSelectStore((state) => state.toggleSelected);
  const setRowRange = useSessionMultiSelectStore((state) => state.setRange);

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

  const [exportDialogOpen, setExportDialogOpen] = React.useState(false);
  const [exportIncludeSubtasks, setExportIncludeSubtasks] = React.useState(true);

  const menuInstanceKey = `${renderContext}:${archivedBucket ? 'archived' : 'active'}:${session.id}`;
  const isZombie = useViewportStore(
    React.useCallback((state) => Boolean(state.sessionMemoryState.get(viewportSessionKey(session.id))?.isZombie), [session.id]),
  );
  const sessionStatus = useGlobalSessionStatus(session.id);
  const sessionPermissions = useSessionPermissions(session.id, sessionDirectory ?? undefined);
  const directoryState = sessionDirectory ? directoryStatus?.get(sessionDirectory) : null;
  const isMissingDirectory = directoryState === 'missing';
  const isActive = currentSessionId === session.id;
  const sessionTitle = resolvedSession.title || t('sessions.sidebar.session.untitled');
  const hasChildren = node.children.length > 0;
  const isPinnedSession = pinnedSessionIds.has(session.id);
  // Per-render-context expansion key: the same session can appear in both
  // the project's root and the "Recent" list, and expanding one should not
  // expand the other. Matches the format of menuInstanceKey.
  const expansionKey = menuInstanceKey;
  const isExpanded = hasSessionSearchQuery ? true : expandedParents.has(expansionKey);
  const isSubtaskSession = Boolean((resolvedSession as Session & { parentID?: string | null }).parentID);
  const unseenCount = useSessionUnseenCount(session.id);
  const needsAttention = unseenCount > 0 && (!isSubtaskSession || notifyOnSubtasks);
  const sessionTimestamp = resolvedSession.time?.updated || resolvedSession.time?.created || Date.now();
  const sessionUpdatedLabel = formatSessionDateLabel(sessionTimestamp);
  const sessionCompactUpdatedLabel = formatSessionCompactDateLabel(sessionTimestamp);
  const isMenuOpen = openSidebarMenuKey === menuInstanceKey;
  const [isContextMenuOpen, setIsContextMenuOpen] = React.useState(false);
  const isSessionMenuOpen = isMenuOpen || isContextMenuOpen;
  const isMultiRunLikeSession = React.useMemo(() => parseMultiRunSessionTitle(resolvedSession.title) !== null, [resolvedSession.title]);
  const [fusionDialogOpen, setFusionDialogOpen] = React.useState(false);
  const metadataSubsessionChevron = isVSCode && renderContext === 'recent' && !isMinimalMode;
  const inlineSubsessionChevron = isVSCode && renderContext === 'recent' && isMinimalMode;

  const descendantCount = React.useMemo(() => collectNodeDescendantIds(node).length, [collectNodeDescendantIds, node]);

  const collectChildExports = React.useCallback(async (children: SessionNode[]): Promise<{ children: ChildSessionExport[]; skipped: number }> => {
    const results: ChildSessionExport[] = [];
    let skipped = 0;
    for (const child of children) {
      try {
        await sync.ensureSessionRenderable(child.session.id);
        const childRecords = buildSessionMessageRecordsSnapshot(directoryStore.getState(), child.session.id).list;
        const childTitle = child.session.title || t('sessions.sidebar.session.export.untitledSubagent');
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
  }, [collectNodeDescendantIds, directoryStore, sync, t]);

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

    await sync.ensureSessionRenderable(session.id);

    const records = buildSessionMessageRecordsSnapshot(directoryStore.getState(), session.id).list;
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
  }, [collectChildExports, directoryStore, node.children, resolvedSession.title, session.id, sessionDirectory, showSkippedSubtasksWarning, sync, t]);
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
    if (editingId !== session.id) return;
    const handleDocMouseDown = (e: MouseEvent) => {
      if (formRef.current && !formRef.current.contains(e.target as Node)) {
        handleSaveEditRef.current(renameDraftRef.current);
      }
    };
    document.addEventListener('mousedown', handleDocMouseDown);
    return () => document.removeEventListener('mousedown', handleDocMouseDown);
  }, [editingId, session.id]);

  React.useLayoutEffect(() => {
    if (editingId !== session.id) {
      if (renameTargetRef.current === session.id) {
        renameTargetRef.current = null;
      }
      return;
    }
    if (renameTargetRef.current === session.id) return;
    renameTargetRef.current = session.id;
    setRenameDraft(editTitle);
  }, [editingId, editTitle, session.id]);

  if (editingId === session.id) {
    return (
      <div
        key={session.id}
        className={cn('group relative flex items-center rounded-sm px-1.5 py-1', depth > 0 && 'pl-[20px]')}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0">
          <form
            ref={formRef}
            className="flex w-full items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              handleSaveEdit(renameDraft);
            }}
          >
            <input
              value={renameDraft}
              onChange={(event) => setRenameDraft(event.target.value)}
              className="flex-1 min-w-0 bg-transparent typography-ui-label outline-none placeholder:text-muted-foreground"
              autoFocus
              placeholder={t('sessions.sidebar.session.menu.rename')}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Escape') {
                  handleCancelEdit();
                  return;
                }
              }}
            />
            <button
              type="submit"
              aria-label={t('sessions.sidebar.session.rename.save')}
              title={t('sessions.sidebar.session.rename.save')}
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <Icon name="check" className="size-4" />
            </button>
            <button
              type="button"
              onClick={handleCancelEdit}
              aria-label={t('sessions.sidebar.session.rename.cancel')}
              title={t('sessions.sidebar.session.rename.cancel')}
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <Icon name="close" className="size-4" />
            </button>
          </form>
          {!isMinimalMode ? (
            <div className="flex items-center justify-between gap-3 text-muted-foreground/60 min-w-0 overflow-hidden leading-tight" style={{ fontSize: 'calc(var(--text-ui-label) * 0.85)' }}>
              <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                {hasChildren ? <span className="inline-flex items-center justify-center flex-shrink-0">{isExpanded ? <Icon name="arrow-down-s" className="h-3 w-3" /> : <Icon name="arrow-right-s" className="h-3 w-3" />}</span> : null}
                <span className="flex-shrink-0">{sessionUpdatedLabel}</span>
                {hasSecondaryProjectLabel ? <span className="truncate">{secondaryMeta?.projectLabel}</span> : null}
                {hasSecondaryBranchLabel ? <span className="inline-flex min-w-0 items-center gap-0.5"><Icon name="git-branch" className="h-3 w-3 flex-shrink-0 text-muted-foreground/70" /><span className="truncate">{secondaryMeta?.branchLabel}</span></span> : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  const statusType = sessionStatus?.type ?? 'idle';
  const isStreaming = statusType === 'busy' || statusType === 'retry';
  const pendingPermissionCount = sessionPermissions.length;
  const showUnreadStatus = !isStreaming && needsAttention && !isActive;
  const showStatusMarker = isStreaming || showUnreadStatus;
  const statusMarkerContent = isStreaming
    ? (
        <span
          className="h-1.5 w-1.5 rounded-full bg-primary animate-busy-pulse"
          aria-label={t('sessions.sidebar.session.status.active')}
          title={t('sessions.sidebar.session.status.active')}
        />
      )
    : (
        <span
          className="h-1.5 w-1.5 rounded-full bg-[var(--status-info)]"
          aria-label={t('sessions.sidebar.session.status.unread')}
          title={t('sessions.sidebar.session.status.unread')}
        />
      );
  const hideLeadingIndicatorOnHover = !alwaysShowActions && hasChildren && (showStatusMarker || isPinnedSession);
  const showPinnedMarker = isPinnedSession && !showStatusMarker;
  const pinnedMarkerContent = (
    <Icon
      name="pushpin"
      className="h-3 w-3 flex-shrink-0 text-primary"
      aria-label={t('sessions.sidebar.session.status.pinned')}
    />
  );
  const leadingIndicators = showStatusMarker || showPinnedMarker ? (
    <span
      className={cn(
        'pointer-events-none absolute left-0.5 inline-flex h-3.5 w-3.5 items-center justify-center transition-opacity',
        isMinimalMode ? 'top-1/2 -translate-y-1/2' : 'top-[14.5px] -translate-y-1/2',
        hideLeadingIndicatorOnHover ? 'opacity-100 group-hover:opacity-0 group-focus-within:opacity-0' : '',
      )}
    >
      {showStatusMarker ? statusMarkerContent : null}
      {showPinnedMarker ? pinnedMarkerContent : null}
    </span>
  ) : null;
  const hideChevronUntilHover = hasChildren && !alwaysShowActions && (showStatusMarker || isPinnedSession);
  const subsessionChevron = hasChildren ? (
    <span
      role="button"
      tabIndex={0}
      onClick={(event) => {
        event.stopPropagation();
        toggleParent(expansionKey);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          toggleParent(expansionKey);
        }
      }}
      style={{ minWidth: 14, minHeight: 14 }}
      className={cn(
        'inline-flex h-3.5 w-3.5 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 transition-opacity',
        metadataSubsessionChevron
          ? 'absolute left-1.5 bottom-1'
          : inlineSubsessionChevron
          ? 'relative mr-0.5 shrink-0'
          : cn('absolute left-0.5', isMinimalMode ? 'top-1/2 -translate-y-1/2' : 'top-[14.5px] -translate-y-1/2'),
        !metadataSubsessionChevron && !inlineSubsessionChevron && hideChevronUntilHover
          ? 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto'
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

  const handleMenuOpenChange = (open: boolean) => {
    if (open) {
      setIsContextMenuOpen(false);
    }
    setOpenSidebarMenuKey(open ? menuInstanceKey : null);
  };

  const handleMenuOpenChangeComplete = (open: boolean) => {
    if (!open && pendingRenameRef.current) {
      const { id, title } = pendingRenameRef.current;
      pendingRenameRef.current = null;
      setEditingId(id);
      setEditTitle(title);
    }
  };

  const handleContextMenuOpenChange = (open: boolean) => {
    setIsContextMenuOpen(open);
  };

  const handleMenuTriggerClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setOpenSidebarMenuKey(isMenuOpen ? null : menuInstanceKey);
  };

  const handleMenuTriggerPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleMenuTriggerMouseDown = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleQuickArchivePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleQuickArchiveMouseDown = (event: React.MouseEvent<HTMLButtonElement>) => {
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

  const handleRowSelect = (event?: React.MouseEvent<HTMLButtonElement>) => {
    if (suppressNextSelectRef.current) {
      suppressNextSelectRef.current = false;
      return;
    }
    if (selectionModeEnabled) {
      event?.preventDefault();
      event?.stopPropagation();
      if (event?.shiftKey) {
        const rows = typeof document !== 'undefined'
          ? Array.from(document.querySelectorAll<HTMLElement>('[data-session-row]'))
          : [];
        const orderedIds = rows
          .map((el) => el.getAttribute('data-session-row'))
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
        const currentAnchor = useSessionMultiSelectStore.getState().anchorId;
        const descendantsById = new Map<string, string[]>();
        descendantsById.set(session.id, collectNodeDescendantIds(node));
        setRowRange(currentAnchor, session.id, orderedIds, sessionDirectory ?? null, descendantsById);
        return;
      }
      toggleRowSelected(session.id, sessionDirectory ?? null, collectNodeDescendantIds(node));
      return;
    }
    const rawServerId = (session as Record<string, unknown>).serverId
    const resolvedServerId = typeof rawServerId === 'string' && rawServerId.length > 0 ? rawServerId : undefined
    handleSessionSelect(session.id, sessionDirectory, isMissingDirectory, projectId, resolvedServerId);
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
  };
  const handleRowPointerEnd = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (mobileVariant && event.pointerType === 'touch') {
      setIsTouchPressed(false);
    }
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
      <Item onClick={() => togglePinnedSession(session.id)} className="[&>svg]:mr-1">
        {isPinnedSession ? <Icon name="unpin" className="mr-1 h-4 w-4" /> : <Icon name="pushpin" className="mr-1 h-4 w-4" />}
        {isPinnedSession ? t('sessions.sidebar.session.menu.unpin') : t('sessions.sidebar.session.menu.pin')}
      </Item>
      {!resolvedSession.share ? (
        <Item onClick={() => handleShareSession(resolvedSession)} className="[&>svg]:mr-1">
          <Icon name="share-2" className="mr-1 h-4 w-4" />
          {t('sessions.sidebar.session.menu.share')}
        </Item>
      ) : (
        <>
          <Item onClick={() => { if (resolvedSession.share?.url) handleCopyShareUrl(resolvedSession.share.url, session.id); }} className="[&>svg]:mr-1">
            {copiedSessionId === session.id
              ? <><Icon name="check" className="mr-1 h-4 w-4"  style={{ color: 'var(--status-success)' }}/>{t('sessions.sidebar.session.menu.copied')}</>
              : <><Icon name="file-copy" className="mr-1 h-4 w-4" />{t('sessions.sidebar.session.menu.copyLink')}</>}
          </Item>
          <Item onClick={() => handleUnshareSession(session.id)} className="[&>svg]:mr-1">
            <Icon name="link-unlink-m" className="mr-1 h-4 w-4" />
            {t('sessions.sidebar.session.menu.unshare')}
          </Item>
        </>
      )}
      <Item onClick={() => { void handleExportSession(); }} className="[&>svg]:mr-1">
        <Icon name="download" className="mr-1 h-4 w-4" />
        {t('sessions.sidebar.session.menu.exportMarkdown')}
      </Item>
      {isMultiRunLikeSession ? (
        <Item onClick={() => setFusionDialogOpen(true)} className="[&>svg]:mr-1">
          <FusionIcon className="mr-1 h-4 w-4" />
          {t('sessions.sidebar.session.menu.runFusion')}
        </Item>
      ) : null}

      {sessionDirectory && !archivedBucket ? (() => {
        const scopeFolders = getFoldersForScope(sessionDirectory);
        const currentFolderId = getSessionFolderId(sessionDirectory, session.id);
        return (
          <>
            <Separator />
            <Sub>
              <SubTrigger className="[&>svg]:mr-1"><Icon name="folder" className="h-4 w-4" />{t('sessions.sidebar.folders.moveToFolder')}</SubTrigger>
              <SubContent className="min-w-[180px]">
                {scopeFolders.length === 0 ? (
                  <Item disabled className="text-muted-foreground">{t('sessions.sidebar.folders.none')}</Item>
                ) : (
                  scopeFolders.map((folder) => (
                    <Item key={folder.id} onClick={() => { if (currentFolderId === folder.id) removeSessionFromFolder(sessionDirectory, session.id); else addSessionToFolder(sessionDirectory, folder.id, session.id); }}>
                      <span className="flex-1 truncate">{folder.name}</span>
                      {currentFolderId === folder.id ? <Icon name="check" className="ml-2 h-3.5 w-3.5 text-primary flex-shrink-0" /> : null}
                    </Item>
                  ))
                )}
                <Separator />
                <Item onClick={() => { const newFolder = createFolderAndStartRename(sessionDirectory); if (!newFolder) return; addSessionToFolder(sessionDirectory, newFolder.id, session.id); }}>
                  <Icon name="add" className="mr-1 h-4 w-4" />
                  {t('sessions.sidebar.folders.newFolderEllipsis')}
                </Item>
                {currentFolderId ? (
                  <Item onClick={() => { removeSessionFromFolder(sessionDirectory, session.id); }} className="text-destructive focus:text-destructive">
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
        <Item
          disabled={!sessionDirectory}
          onClick={() => {
            if (!sessionDirectory) return;
            openContextPanelTab(sessionDirectory, {
              mode: 'chat',
              dedupeKey: `session:${session.id}`,
              label: sessionTitle,
            });
          }}
          className="[&>svg]:mr-1"
        >
          <Icon name="chat-4" className="mr-1 h-4 w-4" />
          <span className="truncate">{t('sessions.sidebar.session.menu.openInSidePanel')}</span>
          <span className="shrink-0 typography-micro px-1 rounded leading-none pb-px text-[var(--status-warning)] bg-[var(--status-warning)]/10">{t('sessions.sidebar.session.menu.betaBadge')}</span>
        </Item>
      ) : null}

      {isElectron ? (
        <Item
          disabled={!sessionDirectory}
          onClick={handleOpenMiniChatWindow}
          className="[&>svg]:mr-1"
        >
          <Icon name="window" className="mr-1 h-4 w-4" />
          <span className="truncate">{t('sessions.sidebar.session.menu.openMiniChatWindow')}</span>
        </Item>
      ) : null}

      <Separator />
      {!archivedBucket ? (
        <Item className="[&>svg]:mr-1" onClick={() => handleDeleteSession(session, { archivedBucket })}>
          <Icon name="inbox-archive" className="mr-1 h-4 w-4" />
          {t('sessions.sidebar.bulkActions.archive')}
        </Item>
      ) : null}
      <Item className="text-destructive focus:text-destructive [&>svg]:mr-1" onClick={() => handleDeleteSession(session, { archivedBucket, hardDelete: true })}>
        <Icon name="delete-bin" className="mr-1 h-4 w-4" />
        {t('sessions.sidebar.bulkActions.delete')}
      </Item>
    </>
  );

  const sessionMenuContent = (
    <DropdownMenuContent align="end" className="min-w-[180px]" finalFocus={() => (renamingFolderId || editingIdRef.current) ? false : true}>
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
          finalFocus={() => (renamingFolderId || editingIdRef.current) ? false : true}
          style={{
            backgroundColor: 'var(--surface-elevated)',
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
      <DraggableSessionRow sessionId={session.id} sessionDirectory={sessionDirectory ?? null} sessionTitle={sessionTitle}>
        <ContextMenu.Root open={isContextMenuOpen} onOpenChange={handleContextMenuOpenChange} onOpenChangeComplete={handleMenuOpenChangeComplete}>
          <ContextMenu.Trigger
            render={
              <div
                data-session-row={session.id}
                data-session-scope={sessionDirectory ?? ''}
                data-session-archived={archivedBucket ? '1' : '0'}
                className={cn(
                  'group relative my-0.5 flex items-center rounded-md py-1 pr-1.5',
                  // Pull the row box left into the container gutter so the
                  // selection highlight covers the chevron/status markers
                  // (which sit in that gutter), then re-pad so the title text
                  // stays put.
                  '-ml-3',
                  depth > 0 ? 'pl-[32px]' : 'pl-[18px]',
                  isMissingDirectory ? 'opacity-75' : '',
                  // Active (currently open) session gets a subtle primary tint;
                  // multi-select highlight takes precedence when both apply.
                  isActive && !isRowSelected && 'bg-primary/10',
                  isRowSelected && 'bg-interactive-selection',
                )}
              />
            }
          >
          {leadingIndicators}
          {subsessionChevron}
          <div className="flex min-w-0 flex-1 items-center">
            {isMinimalMode ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
  	                    onPointerDown={handleRowPointerDown}
  	                    onPointerUp={handleRowPointerEnd}
  	                    onPointerCancel={handleRowPointerEnd}
  	                    onMouseDown={handleRowMouseDown}
  	                    onClick={(event) => handleRowSelect(event)}
                    disabled={isMissingDirectory}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      handleSessionDoubleClick(session.id, sessionTitle);
                    }}
                    className={cn(
	                      'flex min-w-0 flex-1 cursor-pointer flex-col gap-0 overflow-hidden rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 text-foreground select-none disabled:cursor-not-allowed transition-[padding]',
	                      isTouchPressed && 'bg-interactive-hover/70',
                      alwaysShowActions
                        ? (isVSCode ? revealPaddingClass : alwaysActionPaddingClass)
                        : revealPaddingClass,
                    )}
                  >
                    <div className={cn('flex w-full items-center min-w-0 flex-1 overflow-hidden', isMinimalMode ? 'gap-1' : 'gap-1')}>
                      <div className={cn('block min-w-0 flex-1 truncate typography-ui-label font-normal', isActive ? 'text-primary' : 'text-foreground')}>{renderHighlightedText(sessionTitle, normalizedSessionSearchQuery)}</div>
                      {alwaysShowActions ? <span className="ml-2 flex-shrink-0 text-[0.72rem] text-muted-foreground/75">{sessionCompactUpdatedLabel}</span> : null}
                      {!alwaysShowActions ? (
                        <div className="relative ml-1 flex h-4 min-w-4 flex-shrink-0 items-center justify-end">
                          <span className={cn(
                            'whitespace-nowrap text-right text-[0.72rem] text-muted-foreground/75 transition-opacity duration-150',
                            isSessionMenuOpen
                              ? 'opacity-0'
                              : hideOnHoverClass,
                          )}>
                            {sessionCompactUpdatedLabel}
                          </span>
                        </div>
                      ) : null}
                      {pendingPermissionCount > 0 ? (
                        <span className="inline-flex items-center gap-1 rounded bg-destructive/10 px-1 py-0.5 text-[0.7rem] text-destructive flex-shrink-0" title={t('sessions.sidebar.session.status.permissionRequired')} aria-label={t('sessions.sidebar.session.status.permissionRequired')}>
                          <Icon name="shield" className="h-3 w-3" />
                          <span className="leading-none">{pendingPermissionCount}</span>
                        </span>
                      ) : null}
                    </div>
                  </button>
                </TooltipTrigger>
                {/* VS Code already shows project context via workspace headers, so
                    the per-row metadata tooltip is redundant noise there. */}
                {!isVSCode ? (
                <TooltipContent side="right" sideOffset={8} className="max-w-xs text-left">
                  <div className="flex flex-col gap-1 text-left text-xs">
                    <div className={cn('flex items-center gap-3 text-left text-muted-foreground', secondaryMeta?.projectLabel ? 'justify-between' : 'justify-start')}>
                      {secondaryMeta?.projectLabel ? <div className="min-w-0 truncate">{secondaryMeta.projectLabel}</div> : null}
                      <div className="flex-shrink-0">{sessionUpdatedLabel}</div>
                    </div>
                    {secondaryMeta?.branchLabel ? (
                      <div className="flex items-center gap-3 text-left text-muted-foreground justify-start">
                        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                          <span className="inline-flex min-w-0 items-center gap-0.5"><Icon name="git-branch" className="h-3 w-3 flex-shrink-0" /><span className="truncate">{secondaryMeta.branchLabel}</span></span>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </TooltipContent>
                ) : null}
              </Tooltip>
            ) : (
              <button
                type="button"
	                onPointerDown={handleRowPointerDown}
	                onPointerUp={handleRowPointerEnd}
	                onPointerCancel={handleRowPointerEnd}
	                onMouseDown={handleRowMouseDown}
	                onClick={(event) => handleRowSelect(event)}
                disabled={isMissingDirectory}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  handleSessionDoubleClick(session.id, sessionTitle);
                }}
                className={cn(
	                  'flex min-w-0 flex-1 cursor-pointer flex-col gap-0 overflow-hidden rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 text-foreground select-none disabled:cursor-not-allowed transition-[padding]',
	                  isTouchPressed && 'bg-interactive-hover/70',
                  alwaysShowActions
                    ? (isVSCode ? revealPaddingClass : alwaysActionPaddingClass)
                    : revealPaddingClass
                )}
              >
                <div className={cn('flex w-full items-center min-w-0 flex-1 overflow-hidden', isMinimalMode ? 'gap-1' : 'gap-1')}>
                    <div className={cn('block min-w-0 flex-1 truncate typography-ui-label font-normal', isActive ? 'text-primary' : 'text-foreground')}>{renderHighlightedText(sessionTitle, normalizedSessionSearchQuery)}</div>
                    {pendingPermissionCount > 0 ? (
                      <span className="inline-flex items-center gap-1 rounded bg-destructive/10 px-1 py-0.5 text-[0.7rem] text-destructive flex-shrink-0" title={t('sessions.sidebar.session.status.permissionRequired')} aria-label={t('sessions.sidebar.session.status.permissionRequired')}>
                        <Icon name="shield" className="h-3 w-3" />
                        <span className="leading-none">{pendingPermissionCount}</span>
                      </span>
                    ) : null}
                  </div>
 
                {!isMinimalMode ? (
                  <div className="flex items-center justify-between gap-3 text-muted-foreground/60 min-w-0 overflow-hidden leading-tight" style={{ fontSize: 'calc(var(--text-ui-label) * 0.85)' }}>
                    <div className={cn('flex min-w-0 items-center gap-1.5 overflow-hidden', metadataSubsessionChevron && hasChildren ? 'pl-4' : '')}>
                      <span className="flex-shrink-0">{sessionUpdatedLabel}</span>
                      {hasSecondaryProjectLabel ? <span className="truncate">{secondaryMeta?.projectLabel}</span> : null}
                      {hasSecondaryBranchLabel ? <span className="inline-flex min-w-0 items-center gap-0.5"><Icon name="git-branch" className="h-3 w-3 flex-shrink-0 text-muted-foreground/70" /><span className="truncate">{secondaryMeta?.branchLabel}</span></span> : null}
                    </div>
                  </div>
                ) : null}
              </button>
            )}
          </div>

          {streamingIndicator && !mobileVariant ? (
            <div className={cn('absolute top-1/2 -translate-y-1/2 z-10', isMinimalMode ? 'right-0' : 'right-[30px]')}>
              {streamingIndicator}
            </div>
          ) : null}

          <div className={cn(
            'absolute right-0 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5 transition-opacity',
            isSessionMenuOpen
              ? 'opacity-100'
              : (alwaysShowActions && !isVSCode)
                ? 'opacity-100'
                : cn('opacity-0', revealOnHoverClass),
          )}>
            {showQuickArchiveAction ? (
              <QuickSessionAction
                archiveLabel={t('sessions.sidebar.bulkActions.archive')}
                deleteLabel={t('sessions.sidebar.bulkActions.delete')}
                buttonSizeClass={isMinimalMode && !alwaysShowActions ? 'h-4 w-4' : 'h-6 w-6'}
                iconSizeClass={isMinimalMode && !alwaysShowActions ? 'h-2.5 w-2.5' : 'h-3.5 w-3.5'}
                onPointerDown={handleQuickArchivePointerDown}
                onMouseDown={handleQuickArchiveMouseDown}
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
                      'inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 transition-opacity',
                      isMinimalMode && !alwaysShowActions ? 'h-4 w-4' : 'h-6 w-6',
                    )}
                    aria-label={t('sessions.sidebar.session.actions.openInEditor')}
                    onPointerDown={handleOpenInEditorPointerDown}
                    onMouseDown={handleOpenInEditorMouseDown}
                    onClick={handleOpenInEditorClick}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    <Icon name="external-link" className={cn(isMinimalMode && !alwaysShowActions ? 'h-2.5 w-2.5' : 'h-3.5 w-3.5')} />
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
                    'inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 transition-opacity',
                    isMinimalMode && !alwaysShowActions
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
                   <Icon name="more-2" className={cn(isMinimalMode && !alwaysShowActions ? 'h-2.5 w-2.5' : 'h-3.5 w-3.5')} />
                </button>
              </DropdownMenuTrigger>
              {sessionMenuContent}
            </DropdownMenu>
          </div>
          </ContextMenu.Trigger>
          {contextMenuContent}
        </ContextMenu.Root>
      </DraggableSessionRow>
      {hasChildren && isExpanded
        ? node.children.map((child): React.ReactNode => {
          const childRenderExtras: SessionNodeChildRenderExtras = childRenderExtrasFor
            ? childRenderExtrasFor(child)
            : {
                subtreeContainsActive,
                subtreeContainsEditing,
                menuOpenSessionId,
                nodeStructureKey: '',
              };
          return renderSessionNode(
            child,
            depth + 1,
            sessionDirectory ?? groupDirectory,
            projectId,
            archivedBucket,
            undefined,
            renderContext,
            childRenderExtras,
          );
        })
        : null}
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
      {isMultiRunLikeSession ? (
        <MultiRunFusionDialog
          session={resolvedSession}
          open={fusionDialogOpen}
          onOpenChange={setFusionDialogOpen}
        />
      ) : null}
    </React.Fragment>
  );
}

const getNodeSessionDirectory = (node: SessionNode): string | null => {
  return normalizePath((node.session as Session & { directory?: string | null }).directory ?? null);
};

const isSecondaryMetaEqual = (prev?: SecondaryMeta | null, next?: SecondaryMeta | null): boolean => {
  return (prev?.projectLabel ?? null) === (next?.projectLabel ?? null)
    && (prev?.branchLabel ?? null) === (next?.branchLabel ?? null);
};

const getMenuSessionIdFromKey = (props: Props): string | null => {
  if (!props.openSidebarMenuKey) return null;
  const bucketTag = props.archivedBucket ? 'archived' : 'active';
  const prefix = `${props.renderContext ?? 'project'}:${bucketTag}:`;
  return props.openSidebarMenuKey.startsWith(prefix)
    ? props.openSidebarMenuKey.slice(prefix.length)
    : null;
};

const getRelevantMenuSessionId = (props: Props): string | null => {
  return props.menuOpenSessionId ?? getMenuSessionIdFromKey(props);
};

const subtreeContainsSession = (
  props: Props,
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

const hasResolvedSessionChangeInNode = (
  prevNode: SessionNode,
  nextNode: SessionNode,
  prevLiveSessionById: Map<string, Session>,
  nextLiveSessionById: Map<string, Session>,
): boolean => {
  if (prevNode.session.id !== nextNode.session.id) return true;
  const sessionId = prevNode.session.id;
  if ((prevLiveSessionById.get(sessionId) ?? prevNode.session) !== (nextLiveSessionById.get(sessionId) ?? nextNode.session)) {
    return true;
  }
  if (prevNode.children.length !== nextNode.children.length) return true;
  for (let i = 0; i < prevNode.children.length; i += 1) {
    if (hasResolvedSessionChangeInNode(prevNode.children[i], nextNode.children[i], prevLiveSessionById, nextLiveSessionById)) {
      return true;
    }
  }
  return false;
};

const hasExpansionMembershipChange = (prev: Props, next: Props): boolean => {
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

const areSessionNodeItemPropsEqual = (prev: Props, next: Props): boolean => {
  if (prev.node.session.id !== next.node.session.id) return false;
  if (prev.depth !== next.depth) return false;
  if (prev.groupDirectory !== next.groupDirectory) return false;
  if (prev.projectId !== next.projectId) return false;
  if (prev.archivedBucket !== next.archivedBucket) return false;
  if ((prev.renderContext ?? 'project') !== (next.renderContext ?? 'project')) return false;
  if (prev.mobileVariant !== next.mobileVariant) return false;
  if (prev.alwaysShowActions !== next.alwaysShowActions) return false;
  if (prev.hasSessionSearchQuery !== next.hasSessionSearchQuery) return false;
  if (prev.normalizedSessionSearchQuery !== next.normalizedSessionSearchQuery) return false;
  if (prev.notifyOnSubtasks !== next.notifyOnSubtasks) return false;
  if (prev.nodeStructureKey !== next.nodeStructureKey) return false;
  if (getNodeSessionDirectory(prev.node) !== getNodeSessionDirectory(next.node)) return false;
  {
    const prevDir = getNodeSessionDirectory(prev.node);
    const nextDir = getNodeSessionDirectory(next.node);
    if ((prevDir ? prev.directoryStatus?.get(prevDir) : null) !== (nextDir ? next.directoryStatus?.get(nextDir) : null)) return false;
  }
  if (!isSecondaryMetaEqual(prev.secondaryMeta, next.secondaryMeta)) return false;

  if (prev.liveSessionById !== next.liveSessionById
    && hasResolvedSessionChangeInNode(prev.node, next.node, prev.liveSessionById, next.liveSessionById)) {
    return false;
  }

  if (prev.pinnedSessionIds !== next.pinnedSessionIds
    && hasSetMembershipChangeInNode(prev.node, next.node, prev.pinnedSessionIds, next.pinnedSessionIds, (node) => node.session.id)) {
    return false;
  }

  if (prev.expandedParents !== next.expandedParents && hasExpansionMembershipChange(prev, next)) {
    return false;
  }

  if (prev.currentSessionId !== next.currentSessionId
    && (
      subtreeContainsSession(prev, prev.currentSessionId, prev.subtreeContainsActive)
      || subtreeContainsSession(next, next.currentSessionId, next.subtreeContainsActive)
    )) {
    return false;
  }

  if (prev.editingId !== next.editingId
    && (
      subtreeContainsSession(prev, prev.editingId, prev.subtreeContainsEditing)
      || subtreeContainsSession(next, next.editingId, next.subtreeContainsEditing)
    )) {
    return false;
  }

  if (prev.editTitle !== next.editTitle
    && (
      subtreeContainsSession(prev, prev.editingId, prev.subtreeContainsEditing)
      || subtreeContainsSession(next, next.editingId, next.subtreeContainsEditing)
    )) {
    return false;
  }

  if (prev.copiedSessionId !== next.copiedSessionId
    && (
      nodeContainsSessionId(prev.node, prev.copiedSessionId)
      || nodeContainsSessionId(next.node, next.copiedSessionId)
    )) {
    return false;
  }

  if (prev.openSidebarMenuKey !== next.openSidebarMenuKey) {
    const prevMenuSessionId = getRelevantMenuSessionId(prev);
    const nextMenuSessionId = getRelevantMenuSessionId(next);
    if (nodeContainsSessionId(prev.node, prevMenuSessionId) || nodeContainsSessionId(next.node, nextMenuSessionId)) {
      return false;
    }
  }

  if (prev.renamingFolderId !== next.renamingFolderId) {
    const prevMenuSessionId = getRelevantMenuSessionId(prev);
    const nextMenuSessionId = getRelevantMenuSessionId(next);
    if (nodeContainsSessionId(prev.node, prevMenuSessionId) || nodeContainsSessionId(next.node, nextMenuSessionId)) {
      return false;
    }
  }

  return prev.setEditingId === next.setEditingId
    && prev.setEditTitle === next.setEditTitle
    && prev.handleSaveEdit === next.handleSaveEdit
    && prev.handleCancelEdit === next.handleCancelEdit
    && prev.toggleParent === next.toggleParent
    && prev.handleSessionSelect === next.handleSessionSelect
    && prev.handleSessionDoubleClick === next.handleSessionDoubleClick
    && prev.togglePinnedSession === next.togglePinnedSession
    && prev.handleShareSession === next.handleShareSession
    && prev.handleCopyShareUrl === next.handleCopyShareUrl
    && prev.handleUnshareSession === next.handleUnshareSession
    && prev.setOpenSidebarMenuKey === next.setOpenSidebarMenuKey
    && prev.getFoldersForScope === next.getFoldersForScope
    && prev.getSessionFolderId === next.getSessionFolderId
    && prev.removeSessionFromFolder === next.removeSessionFromFolder
    && prev.addSessionToFolder === next.addSessionToFolder
    && prev.createFolderAndStartRename === next.createFolderAndStartRename
    && prev.openContextPanelTab === next.openContextPanelTab
    && prev.handleDeleteSession === next.handleDeleteSession
    && prev.renderSessionNode === next.renderSessionNode;
};

export const SessionNodeItem = React.memo(SessionNodeItemComponent, areSessionNodeItemPropsEqual);
