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
  RiFileEditLine,
  RiFolderLine,
  RiLinkUnlinkM,
  RiMore2Line,
  RiPencilAiLine,
  RiPushpinLine,
  RiRobot2Line,
  RiShare2Line,
  RiShieldLine,
  RiUnpinLine,
} from '@remixicon/react';
import { cn } from '@/lib/utils';
import { DraggableSessionRow } from './sessionFolderDnd';
import type { SessionNode, SessionSummaryMeta } from './types';
import { formatSessionDateLabel, normalizePath, renderHighlightedText, resolveSessionDiffStats } from './utils';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useLanguage } from '@/hooks/useLanguage';

const ATTENTION_DIAMOND_INDICES = new Set([1, 3, 4, 5, 7]);

const getAttentionDiamondDelay = (index: number): string => {
  return index === 4 ? '0ms' : '130ms';
};

type Folder = { id: string; name: string; sessionIds: string[] };

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
  openMenuSessionId: string | null;
  setOpenMenuSessionId: (id: string | null) => void;
  renamingFolderId: string | null;
  getFoldersForScope: (scopeKey: string) => Folder[];
  getSessionFolderId: (scopeKey: string, sessionId: string) => string | null;
  removeSessionFromFolder: (scopeKey: string, sessionId: string) => void;
  addSessionToFolder: (scopeKey: string, folderId: string, sessionId: string) => void;
  createFolderAndStartRename: (scopeKey: string, parentId?: string | null) => { id: string } | null;
  openContextPanelTab: (directory: string, options: { mode: 'chat'; dedupeKey: string; label: string }) => void;
  handleDeleteSession: (session: Session, source?: { archivedBucket?: boolean }) => void;
  mobileVariant: boolean;
  renderSessionNode: (node: SessionNode, depth?: number, groupDirectory?: string | null, projectId?: string | null, archivedBucket?: boolean) => React.ReactNode;
};

export function SessionNodeItem(props: Props): React.ReactNode {
  const { t } = useLanguage();
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
    openMenuSessionId,
    setOpenMenuSessionId,
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
  } = props;

  const displayMode = useSessionDisplayStore((state) => state.displayMode);
  const isMinimalMode = displayMode === 'minimal';

  const session = node.session;
  const sessionDirectory =
    normalizePath((session as Session & { directory?: string | null }).directory ?? null)
    ?? normalizePath(groupDirectory ?? null);
  const directoryState = sessionDirectory ? directoryStatus.get(sessionDirectory) : null;
  const isMissingDirectory = directoryState === 'missing';
  const memoryState = sessionMemoryState.get(session.id);
  const isActive = currentSessionId === session.id;
  const sessionTitle = session.title || t('sessionDialogs.untitledSession');
  const hasChildren = node.children.length > 0;
  const isPinnedSession = pinnedSessionIds.has(session.id);
  const isExpanded = hasSessionSearchQuery ? true : expandedParents.has(session.id);
  const isSubtaskSession = Boolean((session as Session & { parentID?: string | null }).parentID);
  const rawNeedsAttention = sessionAttentionStates.get(session.id)?.needsAttention === true;
  const needsAttention = rawNeedsAttention && (!isSubtaskSession || notifyOnSubtasks);
  const sessionSummary = session.summary as SessionSummaryMeta | undefined;
  const sessionDiffStats = resolveSessionDiffStats(sessionSummary);

  if (editingId === session.id) {
    return (
      <div
        key={session.id}
        className={cn('group relative flex items-center rounded-md px-1.5 py-1', 'bg-interactive-selection', depth > 0 && 'pl-[20px]')}
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
              placeholder={t('sessionSidebar.renameSession')}
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
            <div className="flex items-center gap-2 text-muted-foreground/60 min-w-0 overflow-hidden leading-tight" style={{ fontSize: 'calc(var(--text-ui-label) * 0.85)' }}>
              {hasChildren ? <span className="inline-flex items-center justify-center flex-shrink-0">{isExpanded ? <RiArrowDownSLine className="h-3 w-3" /> : <RiArrowRightSLine className="h-3 w-3" />}</span> : null}
              <span className="flex-shrink-0">{formatSessionDateLabel(session.time?.updated || session.time?.created || Date.now())}</span>
              {sessionDiffStats ? <span className="flex-shrink-0"><span className="text-status-success/80">+{sessionDiffStats.additions}</span><span className="text-muted-foreground/60">/</span><span className="text-status-error/80">-{sessionDiffStats.deletions}</span></span> : null}
              {session.share ? <RiShare2Line className="h-3 w-3 text-[color:var(--status-info)] flex-shrink-0" /> : null}
              {(sessionSummary?.files ?? 0) > 0 || hasChildren ? (
                <span className="flex items-center gap-2 flex-shrink-0">
                  {(sessionSummary?.files ?? 0) > 0 ? <Tooltip><TooltipTrigger asChild><span className="inline-flex items-center gap-0.5"><RiFileEditLine className="h-3 w-3 text-muted-foreground/70" /><span>{sessionSummary!.files}</span></span></TooltipTrigger><TooltipContent side="bottom" sideOffset={4}><p>{sessionSummary!.files} changed {sessionSummary!.files === 1 ? 'file' : 'files'}</p></TooltipContent></Tooltip> : null}
                  {hasChildren ? <Tooltip><TooltipTrigger asChild><span className="inline-flex items-center gap-0.5"><RiRobot2Line className="h-3 w-3 text-muted-foreground/70" /><span>{node.children.length}</span></span></TooltipTrigger><TooltipContent side="bottom" sideOffset={4}><p>{node.children.length} {node.children.length === 1 ? 'sub-session' : 'sub-sessions'}</p></TooltipContent></Tooltip> : null}
                </span>
              ) : null}
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

  const streamingIndicator = memoryState?.isZombie
    ? <RiErrorWarningLine className="h-4 w-4 text-status-warning" />
    : null;

  return (
    <React.Fragment key={session.id}>
      <DraggableSessionRow sessionId={session.id} sessionDirectory={sessionDirectory ?? null} sessionTitle={sessionTitle}>
        <div
          className={cn('group relative flex items-center rounded-md px-1.5 py-1', isActive ? 'bg-interactive-selection' : 'hover:bg-interactive-hover', isMissingDirectory ? 'opacity-75' : '', depth > 0 && 'pl-[20px]')}
          onContextMenu={(e) => {
            e.preventDefault();
            setOpenMenuSessionId(session.id);
          }}
        >
          <div className="flex min-w-0 flex-1 items-center">
            {isMinimalMode ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    disabled={isMissingDirectory}
                    onClick={() => handleSessionSelect(session.id, sessionDirectory, isMissingDirectory, projectId)}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      handleSessionDoubleClick();
                    }}
                    className={cn('flex min-w-0 flex-1 cursor-pointer flex-col gap-0 overflow-hidden rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 text-foreground select-none disabled:cursor-not-allowed transition-[padding]', mobileVariant ? 'pr-7' : 'group-hover:pr-5 group-focus-within:pr-5')}
                  >
                    <div className={cn('flex w-full items-center min-w-0 flex-1 overflow-hidden', isMinimalMode ? 'gap-1' : 'gap-2')}>
                      {isMinimalMode && hasChildren ? (
                        <span role="button" tabIndex={0} onClick={(event) => { event.stopPropagation(); toggleParent(session.id); }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); toggleParent(session.id); } }} className="inline-flex items-center justify-center text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 flex-shrink-0 rounded-sm" aria-label={isExpanded ? t('sessionSidebar.collapseSubsessions') : t('sessionSidebar.expandSubsessions')}>
                          {isExpanded ? <RiArrowDownSLine className="h-3 w-3" /> : <RiArrowRightSLine className="h-3 w-3" />}
                        </span>
                      ) : null}
                      {showStatusMarker ? (
                        <span className="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
                          {isStreaming ? (
                            <GridLoader size="xs" className="text-primary" />
                          ) : (
                            <span className="grid grid-cols-3 gap-[1px] text-[var(--status-info)]" aria-label={t('sessionSidebar.unreadUpdates')} title={t('sessionSidebar.unreadUpdates')}>
                              {Array.from({ length: 9 }, (_, i) => (
                                ATTENTION_DIAMOND_INDICES.has(i) ? (
                                  <span key={i} className="h-[3px] w-[3px] rounded-full bg-current animate-attention-diamond-pulse" style={{ animationDelay: getAttentionDiamondDelay(i) }} />
                                ) : (
                                  <span key={i} className="h-[3px] w-[3px]" />
                                )
                              ))}
                            </span>
                          )}
                        </span>
                      ) : null}
                      {isPinnedSession ? <RiPushpinLine className="h-3 w-3 flex-shrink-0 text-primary" aria-label={t('sessionSidebar.pinnedSession')} /> : null}
                      <div className="block min-w-0 flex-1 truncate typography-ui-label font-normal text-foreground">{renderHighlightedText(sessionTitle, normalizedSessionSearchQuery)}</div>
                      {pendingPermissionCount > 0 ? (
                        <span className="inline-flex items-center gap-1 rounded bg-destructive/10 px-1 py-0.5 text-[0.7rem] text-destructive flex-shrink-0" title={t('sessionSidebar.permissionRequired')} aria-label={t('sessionSidebar.permissionRequired')}>
                          <RiShieldLine className="h-3 w-3" />
                          <span className="leading-none">{pendingPermissionCount}</span>
                        </span>
                      ) : null}
                    </div>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8} className="max-w-xs">
                  <div className="flex flex-col gap-1 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">{formatSessionDateLabel(session.time?.updated || session.time?.created || Date.now())}</span>
                      {sessionDiffStats ? (
                        <span className="flex items-center gap-1">
                          <span className="text-status-success">+{sessionDiffStats.additions}</span>
                          <span className="text-muted-foreground">/</span>
                          <span className="text-status-error">-{sessionDiffStats.deletions}</span>
                        </span>
                      ) : null}
                    </div>
                    {session.share ? (
                      <div className="flex items-center gap-1 text-[color:var(--status-info)]">
                        <RiShare2Line className="h-3 w-3" />
                        <span>{t('sessionSidebar.sessionShared')}</span>
                      </div>
                    ) : null}
                    {(sessionSummary?.files ?? 0) > 0 ? (
                      <div className="flex items-center gap-1">
                        <RiFileEditLine className="h-3 w-3 text-muted-foreground" />
                        <span className="text-muted-foreground">{sessionSummary!.files} changed {sessionSummary!.files === 1 ? 'file' : 'files'}</span>
                      </div>
                    ) : null}
                    {hasChildren ? (
                      <div className="flex items-center gap-1">
                        <RiRobot2Line className="h-3 w-3 text-muted-foreground" />
                        <span className="text-muted-foreground">{node.children.length} {node.children.length === 1 ? 'sub-session' : 'sub-sessions'}</span>
                      </div>
                    ) : null}
                    {isMissingDirectory ? (
                      <div className="flex items-center gap-1 text-status-warning">
                        <RiErrorWarningLine className="h-3 w-3" />
                        <span>{t('sessionSidebar.directoryMissing')}</span>
                      </div>
                    ) : null}
                  </div>
                </TooltipContent>
              </Tooltip>
            ) : (
              <button
                type="button"
                disabled={isMissingDirectory}
                onClick={() => handleSessionSelect(session.id, sessionDirectory, isMissingDirectory, projectId)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  handleSessionDoubleClick();
                }}
                className={cn('flex min-w-0 flex-1 cursor-pointer flex-col gap-0 overflow-hidden rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 text-foreground select-none disabled:cursor-not-allowed transition-[padding]', mobileVariant ? 'pr-7' : 'group-hover:pr-5 group-focus-within:pr-5')}
              >
                <div className={cn('flex w-full items-center min-w-0 flex-1 overflow-hidden', isMinimalMode ? 'gap-1' : 'gap-2')}>
                  {showStatusMarker ? (
                    <span className="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
                      {isStreaming ? (
                        <GridLoader size="xs" className="text-primary" />
                      ) : (
                        <span className="grid grid-cols-3 gap-[1px] text-[var(--status-info)]" aria-label={t('sessionSidebar.unreadUpdates')} title={t('sessionSidebar.unreadUpdates')}>
                          {Array.from({ length: 9 }, (_, i) => (
                            ATTENTION_DIAMOND_INDICES.has(i) ? (
                              <span key={i} className="h-[3px] w-[3px] rounded-full bg-current animate-attention-diamond-pulse" style={{ animationDelay: getAttentionDiamondDelay(i) }} />
                            ) : (
                              <span key={i} className="h-[3px] w-[3px]" />
                            )
                          ))}
                        </span>
                      )}
                    </span>
                  ) : null}
                  {isPinnedSession ? <RiPushpinLine className="h-3 w-3 flex-shrink-0 text-primary" aria-label={t('sessionSidebar.pinnedSession')} /> : null}
                  <div className="block min-w-0 flex-1 truncate typography-ui-label font-normal text-foreground">{renderHighlightedText(sessionTitle, normalizedSessionSearchQuery)}</div>
                  {pendingPermissionCount > 0 ? (
                    <span className="inline-flex items-center gap-1 rounded bg-destructive/10 px-1 py-0.5 text-[0.7rem] text-destructive flex-shrink-0" title={t('sessionSidebar.permissionRequired')} aria-label={t('sessionSidebar.permissionRequired')}>
                      <RiShieldLine className="h-3 w-3" />
                      <span className="leading-none">{pendingPermissionCount}</span>
                    </span>
                  ) : null}
                </div>

              {!isMinimalMode ? (
                <div className="flex items-center gap-2 text-muted-foreground/60 min-w-0 overflow-hidden leading-tight" style={{ fontSize: 'calc(var(--text-ui-label) * 0.85)' }}>
                  {hasChildren ? (
                    <span role="button" tabIndex={0} onClick={(event) => { event.stopPropagation(); toggleParent(session.id); }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); toggleParent(session.id); } }} className="inline-flex items-center justify-center text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 flex-shrink-0 rounded-sm" aria-label={isExpanded ? t('sessionSidebar.collapseSubsessions') : t('sessionSidebar.expandSubsessions')}>
                      {isExpanded ? <RiArrowDownSLine className="h-3 w-3" /> : <RiArrowRightSLine className="h-3 w-3" />}
                    </span>
                  ) : null}
                  <span className="flex-shrink-0">{formatSessionDateLabel(session.time?.updated || session.time?.created || Date.now())}</span>
                  {sessionDiffStats ? <span className="flex-shrink-0"><span className="text-status-success/80">+{sessionDiffStats.additions}</span><span className="text-muted-foreground/60">/</span><span className="text-status-error/80">-{sessionDiffStats.deletions}</span></span> : null}
                  {session.share ? <RiShare2Line className="h-3 w-3 text-[color:var(--status-info)] flex-shrink-0" /> : null}
                  {(sessionSummary?.files ?? 0) > 0 || hasChildren ? (
                    <span className="flex items-center gap-2 flex-shrink-0">
                      {(sessionSummary?.files ?? 0) > 0 ? <Tooltip><TooltipTrigger asChild><span className="inline-flex items-center gap-0.5"><RiFileEditLine className="h-3 w-3 text-muted-foreground/70" /><span>{sessionSummary!.files}</span></span></TooltipTrigger><TooltipContent side="bottom" sideOffset={4}><p>{sessionSummary!.files} changed {sessionSummary!.files === 1 ? 'file' : 'files'}</p></TooltipContent></Tooltip> : null}
                      {hasChildren ? <Tooltip><TooltipTrigger asChild><span className="inline-flex items-center gap-0.5"><RiRobot2Line className="h-3 w-3 text-muted-foreground/70" /><span>{node.children.length}</span></span></TooltipTrigger><TooltipContent side="bottom" sideOffset={4}><p>{node.children.length} {node.children.length === 1 ? 'sub-session' : 'sub-sessions'}</p></TooltipContent></Tooltip> : null}
                    </span>
                  ) : null}
                  {isMissingDirectory ? <span className="inline-flex items-center gap-0.5 text-status-warning flex-shrink-0"><RiErrorWarningLine className="h-3 w-3" />{t('sessionSidebar.missing')}</span> : null}
                </div>
              ) : null}
              </button>
            )}
          </div>

          {streamingIndicator && !mobileVariant ? (
            <div className={cn('absolute top-1/2 -translate-y-1/2 z-10', isMinimalMode ? 'right-7' : 'right-[30px]')}>
              {streamingIndicator}
            </div>
          ) : null}

          <div className={cn('absolute right-0.5 top-1/2 -translate-y-1/2 z-10 transition-opacity', mobileVariant ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100')}>
            <DropdownMenu open={openMenuSessionId === session.id} onOpenChange={(open) => setOpenMenuSessionId(open ? session.id : null)}>
              <DropdownMenuTrigger asChild>
                <button type="button" className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50" aria-label={t('sessionSidebar.sessionMenu')} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                  <RiMore2Line className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[180px]" onCloseAutoFocus={(event) => { if (renamingFolderId) event.preventDefault(); }}>
                  <DropdownMenuItem
                    onClick={() => {
                      setEditingId(session.id);
                      setEditTitle(sessionTitle);
                    }}
                    className="[&>svg]:mr-1"
                  >
                    <RiPencilAiLine className="mr-1 h-4 w-4" />
                    {t('sessionSidebar.rename')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => togglePinnedSession(session.id)} className="[&>svg]:mr-1">
                    {isPinnedSession ? <RiUnpinLine className="mr-1 h-4 w-4" /> : <RiPushpinLine className="mr-1 h-4 w-4" />}
                    {isPinnedSession ? t('sessionSidebar.unpinSession') : t('sessionSidebar.pinSession')}
                  </DropdownMenuItem>
                  {!session.share ? (
                    <DropdownMenuItem onClick={() => handleShareSession(session)} className="[&>svg]:mr-1">
                      <RiShare2Line className="mr-1 h-4 w-4" />
                      {t('sessionSidebar.share')}
                    </DropdownMenuItem>
                  ) : (
                    <>
                      <DropdownMenuItem onClick={() => { if (session.share?.url) handleCopyShareUrl(session.share.url, session.id); }} className="[&>svg]:mr-1">
                        {copiedSessionId === session.id ? <><RiCheckLine className="mr-1 h-4 w-4" style={{ color: 'var(--status-success)' }} />{t('sessionSidebar.copied')}</> : <><RiFileCopyLine className="mr-1 h-4 w-4" />{t('sessionSidebar.copyLink')}</>}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => handleUnshareSession(session.id)} className="[&>svg]:mr-1">
                        <RiLinkUnlinkM className="mr-1 h-4 w-4" />
                        {t('sessionSidebar.unshare')}
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
                          <DropdownMenuSubTrigger className="[&>svg]:mr-1"><RiFolderLine className="h-4 w-4" />{t('sessionSidebar.moveToFolder')}</DropdownMenuSubTrigger>
                          <DropdownMenuSubContent className="min-w-[180px]">
                            {scopeFolders.length === 0 ? (
                              <DropdownMenuItem disabled className="text-muted-foreground">{t('sessionSidebar.noFoldersYet')}</DropdownMenuItem>
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
                    <span className="truncate">{t('sessionSidebar.openInSidePanel')}</span>
                    <span className="shrink-0 typography-micro px-1 rounded leading-none pb-px text-[var(--status-warning)] bg-[var(--status-warning)]/10">{t('settings.beta')}</span>
                  </DropdownMenuItem>

                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive focus:text-destructive [&>svg]:mr-1" onClick={() => handleDeleteSession(session, { archivedBucket })}>
                    <RiDeleteBinLine className="mr-1 h-4 w-4" />
                    {archivedBucket ? t('common.delete') : t('common.archive')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
        </div>
      </DraggableSessionRow>
      {hasChildren && isExpanded
        ? node.children.map((child) => renderSessionNode(child, depth + 1, sessionDirectory ?? groupDirectory, projectId, archivedBucket))
        : null}
    </React.Fragment>
  );
}
