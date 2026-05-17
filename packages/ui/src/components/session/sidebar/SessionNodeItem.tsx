import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { canUseElectronDesktopIPC, invokeDesktop, isVSCodeRuntime } from '@/lib/desktop';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Icon } from "@/components/icon/Icon";
import { buildExportFilename, downloadAsMarkdown, formatSessionAsMarkdown, getExportRevealLabelKey, revealExportedMarkdown, saveAsMarkdownDesktop } from '@/lib/exportSession';
import type { ChildSessionExport } from '@/lib/exportSession';
import { buildSessionMessageRecordsSnapshot, useDirectoryStore, useGlobalSessionStatus, useSession, useSessionPermissions } from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';
import { useViewportStore } from '@/sync/viewport-store';
import { DraggableSessionRow } from './sessionFolderDnd';
import type { SessionNode, SessionSummaryMeta } from './types';
import { formatSessionCompactDateLabel, formatSessionDateLabel, normalizePath, renderHighlightedText, resolveSessionDiffStats } from './utils';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useSessionUnseenCount } from '@/sync/notification-store';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';
import { useI18n } from '@/lib/i18n';
import { parseMultiRunSessionTitle } from '@/lib/multirun/title';
import { MultiRunFusionDialog } from '@/components/multirun/MultiRunFusionDialog';
import { FusionIcon } from '@/components/icons/FusionIcon';

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
  directoryStatus: Map<string, 'unknown' | 'exists' | 'missing'>;
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
  handleSaveEdit: () => void;
  handleCancelEdit: () => void;
  toggleParent: (sessionId: string) => void;
  handleSessionSelect: (sessionId: string, sessionDirectory: string | null, isMissingDirectory: boolean, projectId?: string | null) => void;
  handleSessionDoubleClick: () => void;
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
  handleDeleteSession: (session: Session, source?: { archivedBucket?: boolean }) => void;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  renderSessionNode: (node: SessionNode, depth?: number, groupDirectory?: string | null, projectId?: string | null, archivedBucket?: boolean, secondaryMeta?: SecondaryMeta | null, renderContext?: 'project' | 'recent') => React.ReactNode;
  secondaryMeta?: SecondaryMeta | null;
  renderContext?: 'project' | 'recent';
};

const getNodeChildSignature = (node: SessionNode): string => {
  if (node.children.length === 0) {
    return '';
  }

  return node.children
    .map((child) => `${child.session.id}:${child.children.length}`)
    .join('|');
};

const treeContainsSessionId = (node: SessionNode, sessionId: string | null): boolean => {
  if (!sessionId) {
    return false;
  }

  if (node.session.id === sessionId) {
    return true;
  }

  for (const child of node.children) {
    if (treeContainsSessionId(child, sessionId)) {
      return true;
    }
  }

  return false;
};

const treeContainsMenuKey = (
  node: SessionNode,
  menuKey: string | null,
  renderContext: 'project' | 'recent',
  archivedBucket: boolean,
): boolean => {
  if (!menuKey) {
    return false;
  }

  const nodeMenuKey = `${renderContext}:${archivedBucket ? 'archived' : 'active'}:${node.session.id}`;
  if (nodeMenuKey === menuKey) {
    return true;
  }

  for (const child of node.children) {
    if (treeContainsMenuKey(child, menuKey, renderContext, archivedBucket)) {
      return true;
    }
  }

  return false;
};

const areEqual = (prev: Props, next: Props): boolean => {
  const prevSession = prev.node.session;
  const nextSession = next.node.session;
  const prevSessionId = prevSession.id;
  const nextSessionId = nextSession.id;

  if (prevSessionId !== nextSessionId) return false;
  if (prev.node.session !== next.node.session) return false;
  if (getNodeChildSignature(prev.node) !== getNodeChildSignature(next.node)) return false;
  if (prev.depth !== next.depth) return false;
  if (prev.groupDirectory !== next.groupDirectory) return false;
  if (prev.projectId !== next.projectId) return false;
  if (prev.archivedBucket !== next.archivedBucket) return false;
  if (prev.currentSessionId !== next.currentSessionId) {
    const prevActiveInTree = treeContainsSessionId(prev.node, prev.currentSessionId);
    const nextActiveInTree = treeContainsSessionId(next.node, next.currentSessionId);
    if (prevActiveInTree || nextActiveInTree) {
      return false;
    }
  }
  if (prev.pinnedSessionIds.has(prevSessionId) !== next.pinnedSessionIds.has(nextSessionId)) return false;
  if (prev.expandedParents.has(prevSessionId) !== next.expandedParents.has(nextSessionId)) return false;
  if (prev.hasSessionSearchQuery !== next.hasSessionSearchQuery) return false;
  if (prev.normalizedSessionSearchQuery !== next.normalizedSessionSearchQuery) return false;
  if (prev.notifyOnSubtasks !== next.notifyOnSubtasks) return false;
  if (prev.editingId !== next.editingId) {
    const prevEditingInTree = treeContainsSessionId(prev.node, prev.editingId);
    const nextEditingInTree = treeContainsSessionId(next.node, next.editingId);
    if (prevEditingInTree || nextEditingInTree) {
      return false;
    }
  }
  if (prev.editTitle !== next.editTitle) {
    const prevEditingInTree = treeContainsSessionId(prev.node, prev.editingId);
    const nextEditingInTree = treeContainsSessionId(next.node, next.editingId);
    if (prevEditingInTree || nextEditingInTree) {
      return false;
    }
  }
  if ((prev.copiedSessionId === prevSessionId) !== (next.copiedSessionId === nextSessionId)) return false;

  const prevMenuInTree = treeContainsMenuKey(prev.node, prev.openSidebarMenuKey, prev.renderContext ?? 'project', prev.archivedBucket ?? false);
  const nextMenuInTree = treeContainsMenuKey(next.node, next.openSidebarMenuKey, next.renderContext ?? 'project', next.archivedBucket ?? false);
  if (prevMenuInTree !== nextMenuInTree) return false;

  const prevDirectory = normalizePath((prevSession as Session & { directory?: string | null }).directory ?? null)
    ?? normalizePath(prev.groupDirectory ?? null);
  const nextDirectory = normalizePath((nextSession as Session & { directory?: string | null }).directory ?? null)
    ?? normalizePath(next.groupDirectory ?? null);
  if (prevDirectory !== nextDirectory) return false;
  if ((prevDirectory ? prev.directoryStatus.get(prevDirectory) : null) !== (nextDirectory ? next.directoryStatus.get(nextDirectory) : null)) return false;

  if ((prev.secondaryMeta?.projectLabel ?? null) !== (next.secondaryMeta?.projectLabel ?? null)) return false;
  if ((prev.secondaryMeta?.branchLabel ?? null) !== (next.secondaryMeta?.branchLabel ?? null)) return false;
  if (prev.mobileVariant !== next.mobileVariant) return false;
  if (prev.alwaysShowActions !== next.alwaysShowActions) return false;
  if ((prev.renderContext ?? 'project') !== (next.renderContext ?? 'project')) return false;
  if (prev.renamingFolderId !== next.renamingFolderId) return false;

  return true;
};

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
  } = props;
  const hasSecondaryProjectLabel = Boolean(secondaryMeta?.projectLabel);
  const hasSecondaryBranchLabel = Boolean(secondaryMeta?.branchLabel);

  const displayMode = useSessionDisplayStore((state) => state.displayMode);
  const isMinimalMode = displayMode === 'minimal';
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const isElectron = React.useMemo(() => canUseElectronDesktopIPC(), []);
  const revealOnHoverClass = isVSCode
    ? 'group-hover:opacity-100 group-hover:pointer-events-auto'
    : 'group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto';
  const hideOnHoverClass = isVSCode
    ? 'group-hover:opacity-0'
    : 'group-hover:opacity-0 group-focus-within:opacity-0';
  const showQuickArchiveAction = !archivedBucket && !mobileVariant;
  const revealPaddingClass = isMinimalMode
    ? (isVSCode
        ? 'group-hover:pr-2'
        : 'group-hover:pr-2 group-focus-within:pr-2')
    : (isVSCode
        ? (showQuickArchiveAction ? 'group-hover:pr-12' : 'group-hover:pr-5')
        : (showQuickArchiveAction ? 'group-hover:pr-12 group-focus-within:pr-12' : 'group-hover:pr-5 group-focus-within:pr-5'));
  const alwaysActionPaddingClass = showQuickArchiveAction ? 'pr-13' : 'pr-7';
  const suppressNextSelectRef = React.useRef(false);
  const [isTouchPressed, setIsTouchPressed] = React.useState(false);

  const session = node.session;
  const liveSession = useSession(session.id);
  const resolvedSession = liveSession ?? session;

  const sessionDirectory =
    normalizePath((session as Session & { directory?: string | null }).directory ?? null)
    ?? normalizePath(groupDirectory ?? null);
  const directoryStore = useDirectoryStore(sessionDirectory ?? undefined);
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
    React.useCallback((state) => Boolean(state.sessionMemoryState.get(session.id)?.isZombie), [session.id]),
  );
  const sessionStatus = useGlobalSessionStatus(session.id);
  const sessionPermissions = useSessionPermissions(session.id, sessionDirectory ?? undefined);
  const directoryState = sessionDirectory ? directoryStatus.get(sessionDirectory) : null;
  const isMissingDirectory = directoryState === 'missing';
  const isActive = currentSessionId === session.id;
  const sessionTitle = resolvedSession.title || t('sessions.sidebar.session.untitled');
  const hasChildren = node.children.length > 0;
  const isPinnedSession = pinnedSessionIds.has(session.id);
  const isExpanded = hasSessionSearchQuery ? true : expandedParents.has(session.id);
  const isSubtaskSession = Boolean((resolvedSession as Session & { parentID?: string | null }).parentID);
  const unseenCount = useSessionUnseenCount(session.id);
  const needsAttention = unseenCount > 0 && (!isSubtaskSession || notifyOnSubtasks);
  const sessionSummary = resolvedSession.summary as SessionSummaryMeta | undefined;
  const sessionDiffStats = resolveSessionDiffStats(sessionSummary);
  const sessionTimestamp = resolvedSession.time?.updated || resolvedSession.time?.created || Date.now();
  const sessionUpdatedLabel = formatSessionDateLabel(sessionTimestamp);
  const sessionCompactUpdatedLabel = formatSessionCompactDateLabel(sessionTimestamp);
  const isMenuOpen = openSidebarMenuKey === menuInstanceKey;
  const isMultiRunLikeSession = React.useMemo(() => parseMultiRunSessionTitle(resolvedSession.title) !== null, [resolvedSession.title]);
  const [fusionDialogOpen, setFusionDialogOpen] = React.useState(false);

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
    }).catch((error) => {
      console.warn('[session-sidebar] failed to open mini chat window', error);
    });
  }, [session.id, sessionDirectory]);

  if (editingId === session.id) {
    return (
      <div
        key={session.id}
        className={cn('group relative flex items-center rounded-sm px-1.5 py-1', depth > 0 && 'pl-[20px]')}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0">
          <form
            className="flex w-full items-center gap-2"

            onSubmit={(event) => {
              event.preventDefault();
              handleSaveEdit();
            }}
          >
            <input
              value={editTitle}
              onChange={(event) => setEditTitle(event.target.value)}
              className="flex-1 min-w-0 bg-transparent typography-ui-label outline-none placeholder:text-muted-foreground"
              autoFocus
              placeholder={t('sessions.sidebar.session.menu.rename')}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  handleCancelEdit();
                  return;
                }
                if (event.key === ' ' || event.key === 'Enter') {
                  event.stopPropagation();
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
                {sessionDiffStats ? <span className="flex flex-shrink-0 items-center gap-0 text-[0.92em]"><span className="text-status-success/80">+{sessionDiffStats.additions}</span><span className="text-status-error/65">/-{sessionDiffStats.deletions}</span></span> : null}
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
  const leadingIndicators = showStatusMarker || isPinnedSession ? (
    <span
      className={cn(
        'pointer-events-none absolute inline-flex h-3.5 items-center justify-center gap-0.5 transition-opacity',
        isMinimalMode ? 'top-1/2 -translate-y-1/2' : 'top-[14.5px] -translate-y-1/2',
        showStatusMarker && isPinnedSession ? 'left-[-18px] w-6' : 'left-[-10px] w-3.5',
        hasChildren && !alwaysShowActions ? 'opacity-100 group-hover:opacity-0 group-focus-within:opacity-0' : '',
      )}
    >
      {showStatusMarker ? statusMarkerContent : null}
      {isPinnedSession ? <Icon name="pushpin" className="h-3 w-3 flex-shrink-0 text-primary"  aria-label={t('sessions.sidebar.session.status.pinned')}/> : null}
    </span>
  ) : null;
  const subsessionChevron = hasChildren ? (
    <span
      role="button"
      tabIndex={0}
      onClick={(event) => {
        event.stopPropagation();
        toggleParent(session.id);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          toggleParent(session.id);
        }
      }}
      className={cn(
        'absolute left-[-10px] inline-flex h-3.5 w-3.5 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 transition-opacity',
        isMinimalMode ? 'top-1/2 -translate-y-1/2' : 'top-[14.5px] -translate-y-1/2',
        isMinimalMode && showStatusMarker && !alwaysShowActions
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
    setOpenSidebarMenuKey(open ? menuInstanceKey : null);
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
    handleSessionSelect(session.id, sessionDirectory, isMissingDirectory, projectId);
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

  const sessionMenuContent = (
    <DropdownMenuContent align="end" className="min-w-[180px]" onCloseAutoFocus={(event) => { if (renamingFolderId) event.preventDefault(); }}>
      <DropdownMenuItem
        onClick={() => {
          setEditingId(session.id);
          setEditTitle(sessionTitle);
        }}
        className="[&>svg]:mr-1"
      >
        <Icon name="pencil-ai" className="mr-1 h-4 w-4" />
        {t('sessions.sidebar.session.menu.rename')}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => togglePinnedSession(session.id)} className="[&>svg]:mr-1">
        {isPinnedSession ? <Icon name="unpin" className="mr-1 h-4 w-4" /> : <Icon name="pushpin" className="mr-1 h-4 w-4" />}
        {isPinnedSession ? t('sessions.sidebar.session.menu.unpin') : t('sessions.sidebar.session.menu.pin')}
      </DropdownMenuItem>
      {!resolvedSession.share ? (
        <DropdownMenuItem onClick={() => handleShareSession(resolvedSession)} className="[&>svg]:mr-1">
          <Icon name="share-2" className="mr-1 h-4 w-4" />
          {t('sessions.sidebar.session.menu.share')}
        </DropdownMenuItem>
      ) : (
        <>
          <DropdownMenuItem onClick={() => { if (resolvedSession.share?.url) handleCopyShareUrl(resolvedSession.share.url, session.id); }} className="[&>svg]:mr-1">
            {copiedSessionId === session.id
              ? <><Icon name="check" className="mr-1 h-4 w-4"  style={{ color: 'var(--status-success)' }}/>{t('sessions.sidebar.session.menu.copied')}</>
              : <><Icon name="file-copy" className="mr-1 h-4 w-4" />{t('sessions.sidebar.session.menu.copyLink')}</>}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleUnshareSession(session.id)} className="[&>svg]:mr-1">
            <Icon name="link-unlink-m" className="mr-1 h-4 w-4" />
            {t('sessions.sidebar.session.menu.unshare')}
          </DropdownMenuItem>
        </>
      )}
      <DropdownMenuItem onClick={() => { void handleExportSession(); }} className="[&>svg]:mr-1">
        <Icon name="download" className="mr-1 h-4 w-4" />
        {t('sessions.sidebar.session.menu.exportMarkdown')}
      </DropdownMenuItem>
      {isMultiRunLikeSession ? (
        <DropdownMenuItem onClick={() => setFusionDialogOpen(true)} className="[&>svg]:mr-1">
          <FusionIcon className="mr-1 h-4 w-4" />
          {t('sessions.sidebar.session.menu.runFusion')}
        </DropdownMenuItem>
      ) : null}

      {sessionDirectory && !archivedBucket ? (() => {
        const scopeFolders = getFoldersForScope(sessionDirectory);
        const currentFolderId = getSessionFolderId(sessionDirectory, session.id);
        return (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="[&>svg]:mr-1"><Icon name="folder" className="h-4 w-4" />{t('sessions.sidebar.folders.moveToFolder')}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-[180px]">
                {scopeFolders.length === 0 ? (
                  <DropdownMenuItem disabled className="text-muted-foreground">{t('sessions.sidebar.folders.none')}</DropdownMenuItem>
                ) : (
                  scopeFolders.map((folder) => (
                    <DropdownMenuItem key={folder.id} onClick={() => { if (currentFolderId === folder.id) removeSessionFromFolder(sessionDirectory, session.id); else addSessionToFolder(sessionDirectory, folder.id, session.id); }}>
                      <span className="flex-1 truncate">{folder.name}</span>
                      {currentFolderId === folder.id ? <Icon name="check" className="ml-2 h-3.5 w-3.5 text-primary flex-shrink-0" /> : null}
                    </DropdownMenuItem>
                  ))
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => { const newFolder = createFolderAndStartRename(sessionDirectory); if (!newFolder) return; addSessionToFolder(sessionDirectory, newFolder.id, session.id); }}>
                  <Icon name="add" className="mr-1 h-4 w-4" />
                  {t('sessions.sidebar.folders.newFolderEllipsis')}
                </DropdownMenuItem>
                {currentFolderId ? (
                  <DropdownMenuItem onClick={() => { removeSessionFromFolder(sessionDirectory, session.id); }} className="text-destructive focus:text-destructive">
                    <Icon name="close" className="mr-1 h-4 w-4" />
                    {t('sessions.sidebar.folders.removeFromFolder')}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        );
      })() : null}

      {!isVSCode ? (
        <DropdownMenuItem
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
        </DropdownMenuItem>
      ) : null}

      {isElectron ? (
        <DropdownMenuItem
          disabled={!sessionDirectory}
          onClick={handleOpenMiniChatWindow}
          className="[&>svg]:mr-1"
        >
          <Icon name="window" className="mr-1 h-4 w-4" />
          <span className="truncate">{t('sessions.sidebar.session.menu.openMiniChatWindow')}</span>
        </DropdownMenuItem>
      ) : null}

      <DropdownMenuSeparator />
      <DropdownMenuItem className="text-destructive focus:text-destructive [&>svg]:mr-1" onClick={() => handleDeleteSession(session, { archivedBucket })}>
        <Icon name="delete-bin" className="mr-1 h-4 w-4" />
        {archivedBucket ? t('sessions.sidebar.bulkActions.delete') : t('sessions.sidebar.bulkActions.archive')}
      </DropdownMenuItem>
    </DropdownMenuContent>
  );

  return (
    <React.Fragment key={session.id}>
      <DraggableSessionRow sessionId={session.id} sessionDirectory={sessionDirectory ?? null} sessionTitle={sessionTitle}>
        <div
          data-session-row={session.id}
          data-session-scope={sessionDirectory ?? ''}
          data-session-archived={archivedBucket ? '1' : '0'}
          className={cn(
            'group relative my-0.5 flex items-center rounded-sm px-1.5 py-1',
            isMissingDirectory ? 'opacity-75' : '',
            depth > 0 && 'pl-[20px]',
            isRowSelected && 'bg-primary/15',
          )}
        >
          {leadingIndicators}
          {subsessionChevron}
          <div className="flex min-w-0 flex-1 items-center">
            {isMinimalMode ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
	                    disabled={isMissingDirectory}
	                    onPointerDown={handleRowPointerDown}
	                    onPointerUp={handleRowPointerEnd}
	                    onPointerCancel={handleRowPointerEnd}
	                    onMouseDown={handleRowMouseDown}
	                    onClick={(event) => handleRowSelect(event)}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      handleSessionDoubleClick();
                    }}
                    className={cn(
	                      'flex min-w-0 flex-1 cursor-pointer flex-col gap-0 overflow-hidden rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 text-foreground select-none disabled:cursor-not-allowed transition-[padding]',
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
                            isMenuOpen
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
                <TooltipContent side="right" sideOffset={8} className="max-w-xs text-left">
                  <div className="flex flex-col gap-1 text-left text-xs">
                    <div className={cn('flex items-center gap-3 text-left text-muted-foreground', secondaryMeta?.projectLabel ? 'justify-between' : 'justify-start')}>
                      {secondaryMeta?.projectLabel ? <div className="min-w-0 truncate">{secondaryMeta.projectLabel}</div> : null}
                      <div className="flex-shrink-0">{sessionUpdatedLabel}</div>
                    </div>
                    {secondaryMeta?.branchLabel || sessionDiffStats ? (
                      <div className={cn('flex items-center gap-3 text-left text-muted-foreground', secondaryMeta?.branchLabel ? 'justify-between' : 'justify-start')}>
                        {secondaryMeta?.branchLabel ? (
                          <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                            <span className="inline-flex min-w-0 items-center gap-0.5"><Icon name="git-branch" className="h-3 w-3 flex-shrink-0" /><span className="truncate">{secondaryMeta.branchLabel}</span></span>
                          </div>
                        ) : null}
                        {sessionDiffStats ? <span className="flex flex-shrink-0 items-center gap-0.5"><span className="text-status-success">+{sessionDiffStats.additions}</span><span className="text-status-error">-{sessionDiffStats.deletions}</span></span> : null}
                      </div>
                    ) : null}
                  </div>
                </TooltipContent>
              </Tooltip>
            ) : (
              <button
                type="button"
	                disabled={isMissingDirectory}
	                onPointerDown={handleRowPointerDown}
	                onPointerUp={handleRowPointerEnd}
	                onPointerCancel={handleRowPointerEnd}
	                onMouseDown={handleRowMouseDown}
	                onClick={(event) => handleRowSelect(event)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  handleSessionDoubleClick();
                }}
                className={cn(
	                  'flex min-w-0 flex-1 cursor-pointer flex-col gap-0 overflow-hidden rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 text-foreground select-none disabled:cursor-not-allowed transition-[padding]',
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
                    <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                      <span className="flex-shrink-0">{sessionUpdatedLabel}</span>
                      {sessionDiffStats ? <span className="flex flex-shrink-0 items-center gap-0 text-[0.92em]"><span className="text-status-success/80">+{sessionDiffStats.additions}</span><span className="text-muted-foreground/60">/</span><span className="text-status-error/65">-{sessionDiffStats.deletions}</span></span> : null}
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
            isMenuOpen
              ? 'opacity-100'
              : (alwaysShowActions && !isVSCode)
                ? 'opacity-100'
                : cn('opacity-0', revealOnHoverClass),
          )}>
            {showQuickArchiveAction ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      'inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 transition-opacity',
                      isMinimalMode && !alwaysShowActions ? 'h-4 w-4' : 'h-6 w-6',
                    )}
                    aria-label={t('sessions.sidebar.bulkActions.archive')}
                    onPointerDown={handleQuickArchivePointerDown}
                    onMouseDown={handleQuickArchiveMouseDown}
                    onClick={handleQuickArchiveClick}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    <Icon name="archive" className={cn(isMinimalMode && !alwaysShowActions ? 'h-2.5 w-2.5' : 'h-3.5 w-3.5')} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="left" sideOffset={8}>
                  {t('sessions.sidebar.bulkActions.archive')}
                </TooltipContent>
              </Tooltip>
            ) : null}
            <DropdownMenu open={isMenuOpen} onOpenChange={handleMenuOpenChange}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    'inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 transition-opacity',
                    isMinimalMode && !alwaysShowActions
                      ? (isMenuOpen
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
        </div>
      </DraggableSessionRow>
      {hasChildren && isExpanded
        ? node.children.map((child) => renderSessionNode(child, depth + 1, sessionDirectory ?? groupDirectory, projectId, archivedBucket, undefined, renderContext))
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

export const SessionNodeItem = React.memo(SessionNodeItemComponent, areEqual);
