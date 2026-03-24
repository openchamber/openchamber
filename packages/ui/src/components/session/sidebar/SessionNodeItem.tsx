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
import { DraggableSessionRow } from './sessionFolderDnd';
import type { SessionNode, SessionSummaryMeta } from './types';
import { formatSessionCompactDateLabel, formatSessionDateLabel, normalizePath, renderHighlightedText, resolveSessionDiffStats } from './utils';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';

// Pre-defined palette with maximally distinct colors across hue + saturation + lightness.
// Ordered so adjacent entries are perceptually far apart.
const PROJECT_TAG_PALETTE: Array<[number, number, number]> = [
  // [hue, saturation%, lightness%]
  [  4,  80, 60],  // red
  [210,  80, 62],  // blue
  [ 38,  88, 56],  // orange
  [155,  55, 50],  // teal-green
  [270,  65, 66],  // purple
  [ 55,  80, 52],  // gold/yellow
  [330,  70, 64],  // pink
  [185,  62, 48],  // cyan
  [ 90,  55, 52],  // lime-green
  [240,  55, 68],  // periwinkle
  [ 20,  75, 62],  // amber
  [300,  55, 62],  // magenta
  [168,  48, 55],  // seafoam
  [ 68,  65, 50],  // olive
  [348,  65, 58],  // rose
  [195,  70, 52],  // sky
  [120,  45, 52],  // sage
  [258,  70, 58],  // indigo
];

function getProjectTagColor(projectId: string | null | undefined): { text: string; bg: string } {
  if (!projectId) {
    const [h, s, l] = PROJECT_TAG_PALETTE[0]!;
    return { text: `hsl(${h} ${s}% ${l}%)`, bg: `hsl(${h} ${s}% ${l}% / 0.13)` };
  }
  // djb2 hash → stable slot per projectId
  let hash = 5381;
  for (let i = 0; i < projectId.length; i++) {
    hash = ((hash << 5) + hash) ^ projectId.charCodeAt(i);
    hash |= 0;
  }
  const [h, s, l] = PROJECT_TAG_PALETTE[Math.abs(hash) % PROJECT_TAG_PALETTE.length]!;
  return {
    text: `hsl(${h} ${s}% ${l}%)`,
    bg:   `hsl(${h} ${s}% ${l}% / 0.13)`,
  };
}

const ATTENTION_DIAMOND_INDICES = new Set([1, 3, 4, 5, 7]);

const getAttentionDiamondDelay = (index: number): string => {
  return index === 4 ? '0ms' : '130ms';
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
  sessionMemoryState: Map<string, { isZombie?: boolean }>;
  currentSessionId: string | null;
  pinnedSessionIds: Set<string>;
  expandedParents: Set<string>;
  hasSessionSearchQuery: boolean;
  normalizedSessionSearchQuery: string;
  sessionAttentionStates: Map<string, { needsAttention?: boolean }>;
  notifyOnSubtasks: boolean;
  sessionStatus?: Map<string, { type?: string }>;
  permissions: Map<string, unknown[]>;
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
  renderSessionNode: (node: SessionNode, depth?: number, groupDirectory?: string | null, projectId?: string | null, archivedBucket?: boolean, secondaryMeta?: SecondaryMeta | null, renderContext?: 'project' | 'recent', projectColor?: string | null) => React.ReactNode;
  secondaryMeta?: SecondaryMeta | null;
  renderContext?: 'project' | 'recent';
  projectColor?: string | null;
};

export function SessionNodeItem(props: Props): React.ReactNode {
  const {
    node,
    depth = 0,
    groupDirectory,
    projectId,
    archivedBucket = false,
    directoryStatus,
    sessionMemoryState,
    currentSessionId,
    pinnedSessionIds,
    expandedParents,
    hasSessionSearchQuery,
    normalizedSessionSearchQuery,
    sessionAttentionStates,
    notifyOnSubtasks,
    sessionStatus,
    permissions,
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
    projectColor,
  } = props;
  const hasSecondaryProjectLabel = Boolean(secondaryMeta?.projectLabel);
  const hasSecondaryBranchLabel = Boolean(secondaryMeta?.branchLabel);

  const displayMode = useSessionDisplayStore((state) => state.displayMode);
  const isMinimalMode = displayMode === 'minimal';
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const suppressNextSelectRef = React.useRef(false);

  const session = node.session;
  const menuInstanceKey = `${renderContext}:${archivedBucket ? 'archived' : 'active'}:${session.id}`;
  const sessionDirectory =
    normalizePath((session as Session & { directory?: string | null }).directory ?? null)
    ?? normalizePath(groupDirectory ?? null);
  const directoryState = sessionDirectory ? directoryStatus.get(sessionDirectory) : null;
  const isMissingDirectory = directoryState === 'missing';
  const memoryState = sessionMemoryState.get(session.id);
  const isActive = currentSessionId === session.id;
  const sessionTitle = session.title || 'Untitled Session';
  const hasChildren = node.children.length > 0;
  const isPinnedSession = pinnedSessionIds.has(session.id);
  const isExpanded = hasSessionSearchQuery ? true : expandedParents.has(session.id);
  const isSubtaskSession = Boolean((session as Session & { parentID?: string | null }).parentID);
  const rawNeedsAttention = sessionAttentionStates.get(session.id)?.needsAttention === true;
  const needsAttention = rawNeedsAttention && (!isSubtaskSession || notifyOnSubtasks);
  const sessionSummary = session.summary as SessionSummaryMeta | undefined;
  const sessionDiffStats = resolveSessionDiffStats(sessionSummary);
  const sessionTimestamp = session.time?.updated || session.time?.created || Date.now();
  const sessionUpdatedLabel = formatSessionDateLabel(sessionTimestamp);
  const sessionCompactUpdatedLabel = formatSessionCompactDateLabel(sessionTimestamp);
  const isMenuOpen = openSidebarMenuKey === menuInstanceKey;

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
                {hasChildren ? <span className="inline-flex items-center justify-center flex-shrink-0">{isExpanded ? <RiArrowDownSLine className="h-3 w-3" /> : <RiArrowRightSLine className="h-3 w-3" />}</span> : null}
                <span className="flex-shrink-0">{sessionUpdatedLabel}</span>
                {sessionDiffStats ? <span className="flex flex-shrink-0 items-center gap-0 text-[0.92em]"><span className="text-status-success/80">+{sessionDiffStats.additions}</span><span className="text-status-error/65">/-{sessionDiffStats.deletions}</span></span> : null}
                {hasSecondaryProjectLabel ? <span className="truncate">{secondaryMeta?.projectLabel}</span> : null}
                {hasSecondaryBranchLabel ? <span className="inline-flex min-w-0 items-center gap-0.5"><RiGitBranchLine className="h-3 w-3 flex-shrink-0 text-muted-foreground/70" /><span className="truncate">{secondaryMeta?.branchLabel}</span></span> : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  const statusType = sessionStatus?.get(session.id)?.type ?? 'idle';
  const isStreaming = statusType === 'busy' || statusType === 'retry';
  const pendingPermissionCount = permissions.get(session.id)?.length ?? 0;
  const showUnreadStatus = !isStreaming && needsAttention && !isActive;
  const showStatusMarker = isStreaming || showUnreadStatus;
  const statusMarkerContent = isStreaming
    ? <GridLoader size="xs" className="text-primary" />
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
  const inlineStatusMarker = !isMinimalMode && showStatusMarker ? (
    <span className="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
      {statusMarkerContent}
    </span>
  ) : null;
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

  const streamingIndicator = memoryState?.isZombie
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
      {!session.share ? (
        <DropdownMenuItem onClick={() => handleShareSession(session)} className="[&>svg]:mr-1">
          <RiShare2Line className="mr-1 h-4 w-4" />
          Share
        </DropdownMenuItem>
      ) : (
        <>
          <DropdownMenuItem onClick={() => { if (session.share?.url) handleCopyShareUrl(session.share.url, session.id); }} className="[&>svg]:mr-1">
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
                      mobileVariant ? 'pr-7' : '',
                    )}
                  >
                    <div className={cn('flex w-full items-center min-w-0 flex-1 overflow-hidden', isMinimalMode ? 'gap-1' : 'gap-1')}>
                      {isPinnedSession ? <RiPushpinLine className="h-3 w-3 flex-shrink-0 text-primary" aria-label="Pinned session" /> : null}
                      <div className={cn('block min-w-0 flex-1 truncate typography-ui-label font-normal', isActive ? 'text-primary' : 'text-foreground')}>{renderHighlightedText(sessionTitle, normalizedSessionSearchQuery)}</div>
                      {mobileVariant ? <span className="ml-2 flex-shrink-0 text-[0.72rem] text-muted-foreground/75">{sessionCompactUpdatedLabel}</span> : null}
                      {!mobileVariant ? (
                        <div className="relative ml-1 flex h-4 min-w-4 flex-shrink-0 items-center justify-end">
                          <span className={cn(
                            'whitespace-nowrap text-right text-[0.72rem] text-muted-foreground/75 transition-opacity duration-150',
                            isMenuOpen
                              ? 'opacity-0'
                              : 'group-hover:opacity-0 group-focus-within:opacity-0',
                          )}>
                            {sessionCompactUpdatedLabel}
                          </span>
                          <DropdownMenu open={isMenuOpen} onOpenChange={handleMenuOpenChange}>
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                className={cn(
                                  'absolute inset-y-0 right-0 inline-flex h-4 w-4 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 transition-opacity',
                                  isMenuOpen
                                    ? 'opacity-100 pointer-events-auto'
                                    : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto',
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
                className={cn('flex min-w-0 flex-1 cursor-pointer flex-col gap-0 overflow-hidden rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 text-foreground select-none disabled:cursor-not-allowed transition-[padding]', mobileVariant ? 'pr-7' : 'group-hover:pr-5 group-focus-within:pr-5')}
              >
                <div className={cn('flex w-full items-center min-w-0 flex-1 overflow-hidden', isMinimalMode ? 'gap-1' : 'gap-1')}>
                    {inlineStatusMarker}
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
                      <span className="flex-shrink-0">{sessionUpdatedLabel}</span>
                      {renderContext === 'recent' && secondaryMeta?.projectLabel ? (
                        (() => {
                          const tagColor = getProjectTagColor(projectId);
                          return (
                            <span
                              className="inline-flex items-center rounded px-1 py-0.5 text-[0.7rem] font-medium flex-shrink-0 leading-none"
                              style={{ color: tagColor.text, backgroundColor: tagColor.bg }}
                            >
                              <span className="truncate max-w-[80px]">{secondaryMeta.projectLabel}</span>
                            </span>
                          );
                        })()
                      ) : hasSecondaryProjectLabel ? (
                        <span className="truncate">{secondaryMeta?.projectLabel}</span>
                      ) : null}
                      {hasSecondaryBranchLabel ? <span className="inline-flex min-w-0 items-center gap-0.5"><RiGitBranchLine className="h-3 w-3 flex-shrink-0 text-muted-foreground/70" /><span className="truncate">{secondaryMeta?.branchLabel}</span></span> : null}
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

          {!isMinimalMode || mobileVariant ? (
            <div className={cn(
              'absolute right-0 top-1/2 z-10 -translate-y-1/2',
              cn(
                'transition-opacity',
                isMenuOpen
                  ? 'opacity-100 pointer-events-auto'
                  : mobileVariant
                    ? 'opacity-100 pointer-events-auto'
                    : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto',
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
                            : 'h-4 w-4 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto')
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
        ? node.children.map((child) => renderSessionNode(child, depth + 1, sessionDirectory ?? groupDirectory, projectId, archivedBucket, undefined, renderContext, projectColor))
        : null}
    </React.Fragment>
  );
}
