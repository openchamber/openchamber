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
import { GridLoader } from '@/components/ui/grid-loader';
import { OpenCodeIcon } from '@/components/ui/OpenCodeIcon';
import {
  RiAddLine,
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiChat4Line,
  RiCheckLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiErrorWarningLine,
  RiFileCopyLine,
  RiFolderLine,
  RiLinkUnlinkM,
  RiMore2Line,
  RiPencilAiLine,
  RiPushpinLine,
  RiShare2Line,
  RiShieldLine,
  RiUnpinLine,
  RiGitBranchLine,
} from '@remixicon/react';
import { cn } from '@/lib/utils';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useProviderLogo } from '@/hooks/useProviderLogo';
import { useGlobalSessionStatus, useSession, useSessionPermissions, useSessionQuestions } from '@/sync/sync-context';
import { useSelectionStore } from '@/sync/selection-store';
import { useViewportStore } from '@/sync/viewport-store';
import { DraggableSessionRow } from './sessionFolderDnd';
import type { SessionNode, SessionSummaryMeta } from './types';
import { formatSessionCompactDateLabel, formatSessionDateLabel, normalizePath, renderHighlightedText, resolveSessionDiffStats } from './utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useSessionUnseenCount } from '@/sync/notification-store';

const ATTENTION_DIAMOND_INDICES = new Set([1, 3, 4, 5, 7]);

const getAttentionDiamondDelay = (index: number): string => {
  return index === 4 ? '0ms' : '130ms';
};

const formatBackendLabel = (backendId: string | null | undefined): string | null => {
  if (typeof backendId !== 'string' || backendId.trim().length === 0) {
    return null;
  }

  const normalized = backendId.trim().toLowerCase();
  if (normalized === 'opencode') {
    return 'OpenCode';
  }
  if (normalized === 'codex') {
    return 'Codex';
  }

  return normalized
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
};

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
  openContextPanelTab: (directory: string, options: { mode: 'chat'; dedupeKey: string; label: string }) => void;
  handleDeleteSession: (session: Session, source?: { archivedBucket?: boolean }) => void;
  mobileVariant: boolean;
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
  if ((prev.currentSessionId === prevSessionId) !== (next.currentSessionId === nextSessionId)) return false;
  if (prev.pinnedSessionIds.has(prevSessionId) !== next.pinnedSessionIds.has(nextSessionId)) return false;
  if (prev.expandedParents.has(prevSessionId) !== next.expandedParents.has(nextSessionId)) return false;
  if (prev.hasSessionSearchQuery !== next.hasSessionSearchQuery) return false;
  if (prev.normalizedSessionSearchQuery !== next.normalizedSessionSearchQuery) return false;
  if (prev.notifyOnSubtasks !== next.notifyOnSubtasks) return false;
  if ((prev.editingId === prevSessionId) !== (next.editingId === nextSessionId)) return false;
  if (prev.editTitle !== next.editTitle && ((prev.editingId === prevSessionId) || (next.editingId === nextSessionId))) return false;
  if ((prev.copiedSessionId === prevSessionId) !== (next.copiedSessionId === nextSessionId)) return false;

  const prevMenuKey = `${prev.renderContext ?? 'project'}:${prev.archivedBucket ? 'archived' : 'active'}:${prevSessionId}`;
  const nextMenuKey = `${next.renderContext ?? 'project'}:${next.archivedBucket ? 'archived' : 'active'}:${nextSessionId}`;
  if ((prev.openSidebarMenuKey === prevMenuKey) !== (next.openSidebarMenuKey === nextMenuKey)) return false;

  const prevDirectory = normalizePath((prevSession as Session & { directory?: string | null }).directory ?? null)
    ?? normalizePath(prev.groupDirectory ?? null);
  const nextDirectory = normalizePath((nextSession as Session & { directory?: string | null }).directory ?? null)
    ?? normalizePath(next.groupDirectory ?? null);
  if (prevDirectory !== nextDirectory) return false;
  if ((prevDirectory ? prev.directoryStatus.get(prevDirectory) : null) !== (nextDirectory ? next.directoryStatus.get(nextDirectory) : null)) return false;

  if ((prev.secondaryMeta?.projectLabel ?? null) !== (next.secondaryMeta?.projectLabel ?? null)) return false;
  if ((prev.secondaryMeta?.branchLabel ?? null) !== (next.secondaryMeta?.branchLabel ?? null)) return false;
  if (prev.mobileVariant !== next.mobileVariant) return false;
  if ((prev.renderContext ?? 'project') !== (next.renderContext ?? 'project')) return false;

  return true;
};

function SessionNodeItemComponent(props: Props): React.ReactNode {
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
    renderSessionNode,
    secondaryMeta,
    renderContext = 'project',
  } = props;
  const hasSecondaryProjectLabel = Boolean(secondaryMeta?.projectLabel);
  const hasSecondaryBranchLabel = Boolean(secondaryMeta?.branchLabel);

  const displayMode = useSessionDisplayStore((state) => state.displayMode);
  const isMinimalMode = displayMode === 'minimal';
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const revealOnHoverClass = isVSCode
    ? 'group-hover:opacity-100 group-hover:pointer-events-auto'
    : 'group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto';
  const hideOnHoverClass = isVSCode
    ? 'group-hover:opacity-0'
    : 'group-hover:opacity-0 group-focus-within:opacity-0';
  const revealPaddingClass = isVSCode
    ? 'group-hover:pr-5'
    : 'group-hover:pr-5 group-focus-within:pr-5';
  const suppressNextSelectRef = React.useRef(false);

  const session = node.session;
  const liveSession = useSession(session.id);
  const resolvedSession = liveSession ?? session;
  const menuInstanceKey = `${renderContext}:${archivedBucket ? 'archived' : 'active'}:${session.id}`;
  const sessionDirectory =
    normalizePath((session as Session & { directory?: string | null }).directory ?? null)
    ?? normalizePath(groupDirectory ?? null);
  const isZombie = useViewportStore(
    React.useCallback((state) => Boolean(state.sessionMemoryState.get(session.id)?.isZombie), [session.id]),
  );
  const sessionStatus = useGlobalSessionStatus(session.id);
  const sessionPermissions = useSessionPermissions(session.id, sessionDirectory ?? undefined);
  const sessionQuestions = useSessionQuestions(session.id, sessionDirectory ?? undefined);
  const sessionAgentSelection = useSelectionStore(
    React.useCallback((state) => state.sessionAgentSelections.get(session.id) ?? null, [session.id]),
  );
  const sessionAgentModelSelection = useSelectionStore(
    React.useCallback((state) => {
      if (!sessionAgentSelection) {
        return null;
      }
      return state.sessionAgentModelSelections.get(session.id)?.get(sessionAgentSelection) ?? null;
    }, [session.id, sessionAgentSelection]),
  );
  const sessionModelSelection = useSelectionStore(
    React.useCallback((state) => state.sessionModelSelections.get(session.id) ?? null, [session.id]),
  );
  const sessionBackendSelection = useSelectionStore(
    React.useCallback((state) => state.sessionBackendSelections.get(session.id) ?? null, [session.id]),
  );
  const directoryState = sessionDirectory ? directoryStatus.get(sessionDirectory) : null;
  const isMissingDirectory = directoryState === 'missing';
  const isActive = currentSessionId === session.id;
  const sessionTitle = resolvedSession.title || 'Untitled Session';
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
  const providerBadgeId = sessionAgentModelSelection?.providerId
    ?? sessionModelSelection?.providerId
    ?? null;
  const providerBadgeName = useConfigStore(
    React.useCallback((state) => {
      if (!providerBadgeId) {
        return null;
      }
      const providers = [...state.providers, ...state.virtualProviders];
      return providers.find((provider) => provider.id === providerBadgeId)?.name ?? null;
    }, [providerBadgeId]),
  );
  const backendBadgeId = (resolvedSession as Session & { backendId?: string | null }).backendId
    ?? sessionBackendSelection
    ?? null;
  const backendBadgeLabel = formatBackendLabel(backendBadgeId);
  const providerBadgeLabel = providerBadgeName
    ?? (providerBadgeId && providerBadgeId.trim().length > 0 ? providerBadgeId : null);
  const sessionRuntimeLabel = providerBadgeLabel ?? backendBadgeLabel;
  const tooltipRuntimeLabel = providerBadgeLabel && backendBadgeLabel && providerBadgeLabel !== backendBadgeLabel
    ? `${providerBadgeLabel} via ${backendBadgeLabel}`
    : sessionRuntimeLabel;
  const runtimeLogoId = backendBadgeId ?? providerBadgeId ?? undefined;
  const { src: runtimeLogoSrc, onError: handleRuntimeLogoError, hasLogo: hasRuntimeLogo } = useProviderLogo(runtimeLogoId);
  const shouldUseOpenCodeIcon = backendBadgeId === 'opencode';
  const shouldShowRuntimeLogo = shouldUseOpenCodeIcon || (hasRuntimeLogo && runtimeLogoSrc);
  const runtimeMetaLogo = shouldShowRuntimeLogo ? (
    <span
      className="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-sm text-foreground/90"
      title={tooltipRuntimeLabel ?? undefined}
      aria-hidden="true"
    >
      {shouldUseOpenCodeIcon ? (
        <OpenCodeIcon width={12} height={12} className="text-foreground/90" />
      ) : runtimeLogoSrc ? (
        <img
          src={runtimeLogoSrc}
          alt=""
          className="h-3.5 w-3.5 object-contain brightness-0 invert opacity-90"
          onError={handleRuntimeLogoError}
        />
      ) : null}
    </span>
  ) : null;

  if (editingId === session.id) {
    return (
      <div
        key={session.id}
        className={cn('group relative flex items-center rounded-sm px-1.5 py-1', depth > 0 && 'pl-[20px]')}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0">
          <form
            className="flex w-full items-center gap-2"
            data-keyboard-avoid="true"
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
              placeholder="Rename session"
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
            <button type="submit" className="shrink-0 text-muted-foreground hover:text-foreground"><RiCheckLine className="size-4" /></button>
            <button type="button" onClick={handleCancelEdit} className="shrink-0 text-muted-foreground hover:text-foreground"><RiCloseLine className="size-4" /></button>
          </form>
          {!isMinimalMode ? (
            <div className="flex items-center justify-between gap-3 text-muted-foreground/60 min-w-0 overflow-hidden leading-tight" style={{ fontSize: 'calc(var(--text-ui-label) * 0.85)' }}>
              <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                {runtimeMetaLogo}
                {hasChildren ? <span className="inline-flex items-center justify-center flex-shrink-0">{isExpanded ? <RiArrowDownSLine className="h-3 w-3" /> : <RiArrowRightSLine className="h-3 w-3" />}</span> : null}
                <span className="flex-shrink-0">{sessionUpdatedLabel}</span>
                {(hasSecondaryProjectLabel || hasSecondaryBranchLabel) ? <span className="flex-shrink-0 text-muted-foreground/45">•</span> : null}
                {hasSecondaryProjectLabel ? <span className="truncate">{secondaryMeta?.projectLabel}</span> : null}
                {hasSecondaryProjectLabel && hasSecondaryBranchLabel ? <span className="flex-shrink-0 text-muted-foreground/45">•</span> : null}
                {hasSecondaryBranchLabel ? <span className="inline-flex min-w-0 items-center gap-0.5"><RiGitBranchLine className="h-3 w-3 flex-shrink-0 text-muted-foreground/70" /><span className="truncate">{secondaryMeta?.branchLabel}</span></span> : null}
                {sessionDiffStats ? <span className="flex flex-shrink-0 items-center gap-0 text-[0.92em]"><span className="text-status-success/80">+{sessionDiffStats.additions}</span><span className="text-status-error/65">/-{sessionDiffStats.deletions}</span></span> : null}
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
  const pendingQuestionCount = sessionQuestions.length;
  const isWaitingForInput = isStreaming && (pendingPermissionCount > 0 || pendingQuestionCount > 0);
  const showUnreadStatus = !isStreaming && needsAttention && !isActive;
  const showStatusMarker = isStreaming || showUnreadStatus;
  const statusMarkerContent = isStreaming
    ? (isWaitingForInput
        ? <GridLoader size="xs" className="text-[var(--status-warning)]" />
        : <GridLoader size="xs" className="text-primary" />)
    : (
        <span className="grid grid-cols-3 gap-[1px] text-[var(--status-info)]" aria-label="Unread updates" title="Unread updates">
          {Array.from({ length: 9 }, (_, i) => (
            ATTENTION_DIAMOND_INDICES.has(i) ? (
              <span key={i} className="h-[3px] w-[3px] rounded-full bg-current animate-attention-diamond-pulse" style={{ animationDelay: getAttentionDiamondDelay(i) }} />
            ) : (
              <span key={i} className="h-[3px] w-[3px]" />
            )
          ))}
        </span>
      );
  const minimalLeadingStatusMarker = isMinimalMode && showStatusMarker ? (
    <span
      className={cn(
        'pointer-events-none absolute left-[-10px] top-1/2 inline-flex h-3.5 w-3.5 -translate-y-1/2 items-center justify-center transition-opacity',
        hasChildren ? 'opacity-100 group-hover:opacity-0 group-focus-within:opacity-0' : '',
      )}
    >
      {statusMarkerContent}
    </span>
  ) : null;
  const normalLeadingStatusMarker = !isMinimalMode && showStatusMarker ? (
    <span className="pointer-events-none absolute left-[-12px] top-[7px] inline-flex h-3.5 w-3.5 items-center justify-center">
      {statusMarkerContent}
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
        'absolute left-[-10px] top-1/2 inline-flex h-3.5 w-3.5 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 transition-opacity',
        isMinimalMode && showStatusMarker
          ? 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto'
          : '',
      )}
      aria-label={isExpanded ? 'Collapse subsessions' : 'Expand subsessions'}
    >
      {isExpanded ? <RiArrowDownSLine className="h-3 w-3" /> : <RiArrowRightSLine className="h-3 w-3" />}
    </span>
  ) : null;

  const streamingIndicator = isZombie
    ? <RiErrorWarningLine className="h-4 w-4 text-status-warning" />
    : null;

  const handleMenuOpenChange = (open: boolean) => {
    setOpenSidebarMenuKey(open ? menuInstanceKey : null);
  };

  const handleMenuTriggerClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  const handleRowSelect = () => {
    if (suppressNextSelectRef.current) {
      suppressNextSelectRef.current = false;
      return;
    }
    handleSessionSelect(session.id, sessionDirectory, isMissingDirectory, projectId);
  };

  const handleRowMouseDown = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (event.button === 2 || (event.button === 0 && event.ctrlKey)) {
      suppressNextSelectRef.current = true;
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
        <RiPencilAiLine className="mr-1 h-4 w-4" />
        Rename
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => togglePinnedSession(session.id)} className="[&>svg]:mr-1">
        {isPinnedSession ? <RiUnpinLine className="mr-1 h-4 w-4" /> : <RiPushpinLine className="mr-1 h-4 w-4" />}
        {isPinnedSession ? 'Unpin session' : 'Pin session'}
      </DropdownMenuItem>
      {!resolvedSession.share ? (
        <DropdownMenuItem onClick={() => handleShareSession(resolvedSession)} className="[&>svg]:mr-1">
          <RiShare2Line className="mr-1 h-4 w-4" />
          Share
        </DropdownMenuItem>
      ) : (
        <>
          <DropdownMenuItem onClick={() => { if (resolvedSession.share?.url) handleCopyShareUrl(resolvedSession.share.url, session.id); }} className="[&>svg]:mr-1">
            {copiedSessionId === session.id ? <><RiCheckLine className="mr-1 h-4 w-4" style={{ color: 'var(--status-success)' }} />Copied</> : <><RiFileCopyLine className="mr-1 h-4 w-4" />Copy link</>}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleUnshareSession(session.id)} className="[&>svg]:mr-1">
            <RiLinkUnlinkM className="mr-1 h-4 w-4" />
            Unshare
          </DropdownMenuItem>
        </>
      )}

      {sessionDirectory && !archivedBucket ? (() => {
        const scopeFolders = getFoldersForScope(sessionDirectory);
        const currentFolderId = getSessionFolderId(sessionDirectory, session.id);
        return (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="[&>svg]:mr-1"><RiFolderLine className="h-4 w-4" />Move to folder</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-[180px]">
                {scopeFolders.length === 0 ? (
                  <DropdownMenuItem disabled className="text-muted-foreground">No folders yet</DropdownMenuItem>
                ) : (
                  scopeFolders.map((folder) => (
                    <DropdownMenuItem key={folder.id} onClick={() => { if (currentFolderId === folder.id) removeSessionFromFolder(sessionDirectory, session.id); else addSessionToFolder(sessionDirectory, folder.id, session.id); }}>
                      <span className="flex-1 truncate">{folder.name}</span>
                      {currentFolderId === folder.id ? <RiCheckLine className="ml-2 h-3.5 w-3.5 text-primary flex-shrink-0" /> : null}
                    </DropdownMenuItem>
                  ))
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => { const newFolder = createFolderAndStartRename(sessionDirectory); if (!newFolder) return; addSessionToFolder(sessionDirectory, newFolder.id, session.id); }}>
                  <RiAddLine className="mr-1 h-4 w-4" />
                  New folder...
                </DropdownMenuItem>
                {currentFolderId ? (
                  <DropdownMenuItem onClick={() => { removeSessionFromFolder(sessionDirectory, session.id); }} className="text-destructive focus:text-destructive">
                    <RiCloseLine className="mr-1 h-4 w-4" />
                    Remove from folder
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
          <RiChat4Line className="mr-1 h-4 w-4" />
          <span className="truncate">Open in Side Panel</span>
          <span className="shrink-0 typography-micro px-1 rounded leading-none pb-px text-[var(--status-warning)] bg-[var(--status-warning)]/10">beta</span>
        </DropdownMenuItem>
      ) : null}

      <DropdownMenuSeparator />
      <DropdownMenuItem className="text-destructive focus:text-destructive [&>svg]:mr-1" onClick={() => handleDeleteSession(session, { archivedBucket })}>
        <RiDeleteBinLine className="mr-1 h-4 w-4" />
        {archivedBucket ? 'Delete' : 'Archive'}
      </DropdownMenuItem>
    </DropdownMenuContent>
  );

  return (
    <React.Fragment key={session.id}>
      <DraggableSessionRow sessionId={session.id} sessionDirectory={sessionDirectory ?? null} sessionTitle={sessionTitle}>
        <div
          className={cn('group relative flex items-center rounded-sm px-1.5 py-1', isMissingDirectory ? 'opacity-75' : '', depth > 0 && 'pl-[20px]')}
        >
          {minimalLeadingStatusMarker}
          {normalLeadingStatusMarker}
          {subsessionChevron}
          <div className="flex min-w-0 flex-1 items-center">
            {isMinimalMode ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    disabled={isMissingDirectory}
                    onMouseDown={handleRowMouseDown}
                    onClick={handleRowSelect}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      handleSessionDoubleClick();
                    }}
                    className={cn(
                      'flex min-w-0 flex-1 cursor-pointer flex-col gap-0 overflow-hidden rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 text-foreground select-none disabled:cursor-not-allowed transition-[padding]',
                      mobileVariant
                        ? (isVSCode ? revealPaddingClass : 'pr-7')
                        : '',
                    )}
                  >
                    <div className={cn('flex w-full items-center min-w-0 flex-1 overflow-hidden', isMinimalMode ? 'gap-1' : 'gap-1')}>
                      {isPinnedSession ? <RiPushpinLine className="h-3 w-3 flex-shrink-0 text-primary" aria-label="Pinned session" /> : null}
                      <div className={cn('block min-w-0 flex-1 truncate typography-ui-label font-normal', isActive ? 'text-primary' : 'text-foreground')}>{renderHighlightedText(sessionTitle, normalizedSessionSearchQuery)}</div>
                      {mobileVariant ? (
                        <span className="ml-2 inline-flex flex-shrink-0 items-center gap-1 text-[0.72rem] text-muted-foreground/75">
                          {runtimeMetaLogo}
                          <span>{sessionCompactUpdatedLabel}</span>
                        </span>
                      ) : null}
                      {!mobileVariant ? (
                        <div className="relative ml-1 flex h-4 min-w-4 flex-shrink-0 items-center justify-end">
                          <span className={cn(
                            'inline-flex items-center gap-1 whitespace-nowrap text-right text-[0.72rem] text-muted-foreground/75 transition-opacity duration-150',
                            isMenuOpen
                              ? 'opacity-0'
                              : hideOnHoverClass,
                          )}>
                            {runtimeMetaLogo}
                            <span>{sessionCompactUpdatedLabel}</span>
                          </span>
                          <DropdownMenu open={isMenuOpen} onOpenChange={handleMenuOpenChange}>
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                className={cn(
                                  'absolute inset-y-0 right-0 inline-flex h-4 w-4 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 transition-opacity',
                                  isMenuOpen
                                    ? 'opacity-100 pointer-events-auto'
                                    : cn('opacity-0 pointer-events-none', revealOnHoverClass),
                                )}
                                aria-label="Session menu"
                                onClick={handleMenuTriggerClick}
                                onKeyDown={(event) => event.stopPropagation()}
                              >
                                <RiMore2Line className="h-2.5 w-2.5" />
                              </button>
                            </DropdownMenuTrigger>
                            {sessionMenuContent}
                          </DropdownMenu>
                        </div>
                      ) : null}
                      {pendingPermissionCount > 0 ? (
                        <span className="inline-flex items-center gap-1 rounded bg-destructive/10 px-1 py-0.5 text-[0.7rem] text-destructive flex-shrink-0" title="Permission required" aria-label="Permission required">
                          <RiShieldLine className="h-3 w-3" />
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
                    {tooltipRuntimeLabel ? (
                      <div className="text-left text-muted-foreground">{tooltipRuntimeLabel}</div>
                    ) : null}
                    {secondaryMeta?.branchLabel || sessionDiffStats ? (
                      <div className={cn('flex items-center gap-3 text-left text-muted-foreground', secondaryMeta?.branchLabel ? 'justify-between' : 'justify-start')}>
                        {secondaryMeta?.branchLabel ? (
                          <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                            <span className="inline-flex min-w-0 items-center gap-0.5"><RiGitBranchLine className="h-3 w-3 flex-shrink-0" /><span className="truncate">{secondaryMeta.branchLabel}</span></span>
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
                onMouseDown={handleRowMouseDown}
                onClick={handleRowSelect}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  handleSessionDoubleClick();
                }}
                className={cn(
                  'flex min-w-0 flex-1 cursor-pointer items-start gap-0 overflow-hidden rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 text-foreground select-none disabled:cursor-not-allowed transition-[padding]',
                  mobileVariant
                    ? (isVSCode ? revealPaddingClass : 'pr-7')
                    : revealPaddingClass
                )}
              >
                {/* Content column */}
                <div className="flex min-w-0 flex-1 flex-col gap-0 overflow-hidden">
                  <div className="flex w-full items-center min-w-0 flex-1 overflow-hidden gap-1">
                    {isPinnedSession ? <RiPushpinLine className="h-3 w-3 flex-shrink-0 text-primary" aria-label="Pinned session" /> : null}
                    <div className={cn('block min-w-0 flex-1 truncate typography-ui-label font-normal', isActive ? 'text-primary' : 'text-foreground')}>{renderHighlightedText(sessionTitle, normalizedSessionSearchQuery)}</div>
                    {pendingPermissionCount > 0 ? (
                      <span className="inline-flex items-center gap-1 rounded bg-destructive/10 px-1 py-0.5 text-[0.7rem] text-destructive flex-shrink-0" title="Permission required" aria-label="Permission required">
                        <RiShieldLine className="h-3 w-3" />
                        <span className="leading-none">{pendingPermissionCount}</span>
                      </span>
                    ) : null}
                  </div>

                  {!isMinimalMode ? (
                    <div className="flex items-center justify-between gap-3 text-muted-foreground/60 min-w-0 overflow-hidden leading-tight" style={{ fontSize: 'calc(var(--text-ui-label) * 0.85)' }}>
                      <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                        {runtimeMetaLogo}
                        <span className="flex-shrink-0">{sessionUpdatedLabel}</span>
                        {(hasSecondaryProjectLabel || hasSecondaryBranchLabel) ? <span className="flex-shrink-0 text-muted-foreground/45">•</span> : null}
                        {hasSecondaryProjectLabel ? <span className="truncate">{secondaryMeta?.projectLabel}</span> : null}
                        {hasSecondaryProjectLabel && hasSecondaryBranchLabel ? <span className="flex-shrink-0 text-muted-foreground/45">•</span> : null}
                        {hasSecondaryBranchLabel ? <span className="inline-flex min-w-0 items-center gap-0.5"><RiGitBranchLine className="h-3 w-3 flex-shrink-0 text-muted-foreground/70" /><span className="truncate">{secondaryMeta?.branchLabel}</span></span> : null}
                        {sessionDiffStats ? <span className="flex flex-shrink-0 items-center gap-0 text-[0.92em]"><span className="text-status-success/80">+{sessionDiffStats.additions}</span><span className="text-muted-foreground/60">/</span><span className="text-status-error/65">-{sessionDiffStats.deletions}</span></span> : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              </button>
            )}
          </div>

          {streamingIndicator && !mobileVariant ? (
            <div className={cn('absolute top-1/2 -translate-y-1/2 z-10', isMinimalMode ? 'right-0' : 'right-[30px]')}>
              {streamingIndicator}
            </div>
          ) : null}

          {!isMinimalMode || mobileVariant ? (
            <div className={cn(
              'absolute right-0 top-1/2 z-10 -translate-y-1/2',
              cn(
                'transition-opacity',
                isMenuOpen
                  ? 'opacity-100 pointer-events-auto'
                  : (mobileVariant && !isVSCode)
                    ? 'opacity-100 pointer-events-auto'
                    : cn('opacity-0 pointer-events-none', revealOnHoverClass),
              ),
            )}>
              <DropdownMenu open={isMenuOpen} onOpenChange={handleMenuOpenChange}>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      'inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 transition-opacity',
                      isMinimalMode && !mobileVariant
                        ? (isMenuOpen
                            ? 'h-4 w-4 opacity-100 pointer-events-auto'
                            : cn('h-4 w-4 opacity-0 pointer-events-none', revealOnHoverClass))
                        : 'h-6 w-6 opacity-100',
                    )}
                    aria-label="Session menu"
                    onClick={handleMenuTriggerClick}
                    onKeyDown={(event) => event.stopPropagation()}
                    >
                      <RiMore2Line className={cn(isMinimalMode && !mobileVariant ? 'h-2.5 w-2.5' : 'h-3.5 w-3.5')} />
                  </button>
                </DropdownMenuTrigger>
                {sessionMenuContent}
                </DropdownMenu>
              </div>
            ) : null}
        </div>
      </DraggableSessionRow>
      {hasChildren && isExpanded
        ? node.children.map((child) => renderSessionNode(child, depth + 1, sessionDirectory ?? groupDirectory, projectId, archivedBucket, undefined, renderContext))
        : null}
    </React.Fragment>
  );
}

export const SessionNodeItem = React.memo(SessionNodeItemComponent, areEqual);
