import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import {
  RiAddLine,
  RiArchiveLine,
  RiArrowDownSLine,
  RiArrowLeftLongLine,
  RiArrowRightSLine,
  RiDeleteBinLine,
  RiGitBranchLine,
} from '@remixicon/react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { sessionEvents } from '@/lib/sessionEvents';
import type { MainTab } from '@/stores/useUIStore';
import { SessionFolderItem } from '../SessionFolderItem';
import { DroppableFolderWrapper, SessionFolderDndScope } from './sessionFolderDnd';
import type { SortableDragHandleProps } from './sortableItems';
import type { GroupSearchData, SessionGroup, SessionNode } from './types';
import { compareSessionsByPinnedAndTime, isBranchDifferentFromLabel, normalizePath, renderHighlightedText } from './utils';
import type { SessionFolder } from '@/stores/useSessionFoldersStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { openExternalUrl } from '@/lib/url';

type DeleteFolderConfirm = {
  scopeKey: string;
  folderId: string;
  folderName: string;
  subFolderCount: number;
  sessionCount: number;
} | null;

type Props = {
  group: SessionGroup;
  groupKey: string;
  projectId?: string | null;
  hideGroupLabel?: boolean;
  hasSessionSearchQuery: boolean;
  normalizedSessionSearchQuery: string;
  groupSearchDataByGroup: WeakMap<SessionGroup, GroupSearchData>;
  expandedSessionGroups: Set<string>;
  collapsedGroups: Set<string>;
  hideDirectoryControls: boolean;
  getFoldersForScope: (scopeKey: string) => SessionFolder[];
  collapsedFolderIds: Set<string>;
  toggleFolderCollapse: (folderId: string) => void;
  renameFolder: (scopeKey: string, folderId: string, name: string) => void;
  deleteFolder: (scopeKey: string, folderId: string) => void;
  showDeletionDialog: boolean;
  setDeleteFolderConfirm: React.Dispatch<React.SetStateAction<DeleteFolderConfirm>>;
  renderSessionNode: (node: SessionNode, depth?: number, groupDirectory?: string | null, projectId?: string | null, archivedBucket?: boolean, secondaryMeta?: { projectLabel?: string | null; branchLabel?: string | null } | null) => React.ReactNode;
  currentSessionDirectory: string | null;
  projectRepoStatus: Map<string, boolean | null>;
  lastRepoStatus: boolean;
  toggleGroupSessionLimit: (groupKey: string) => void;
  mobileVariant: boolean;
  activeProjectId: string | null;
  setActiveProjectIdOnly: (id: string) => void;
  setActiveMainTab: (tab: MainTab) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
  openNewSessionDraft: (options?: { directoryOverride?: string | null; targetFolderId?: string }) => void;
  addSessionToFolder: (scopeKey: string, folderId: string, sessionId: string) => void;
  createFolderAndStartRename: (scopeKey: string, parentId?: string | null) => { id: string } | null;
  renamingFolderId: string | null;
  renameFolderDraft: string;
  setRenameFolderDraft: React.Dispatch<React.SetStateAction<string>>;
  setRenamingFolderId: React.Dispatch<React.SetStateAction<string | null>>;
  pinnedSessionIds: Set<string>;
  sessionOrderIndex: Map<string, number>;
  prVisualStateByDirectoryBranch: Map<string, {
    visualState: 'draft' | 'open' | 'blocked' | 'merged' | 'closed';
    number: number;
    url: string | null;
    state: 'open' | 'closed' | 'merged';
    draft: boolean;
    title: string | null;
    base: string | null;
    head: string | null;
    checks: {
      state: 'success' | 'failure' | 'pending' | 'unknown';
      total: number;
      success: number;
      failure: number;
      pending: number;
    } | null;
    canMerge: boolean | null;
    mergeableState: string | null;
    repo: {
      owner: string;
      repo: string;
    } | null;
  }>;
  onToggleCollapsedGroup: (groupKey: string) => void;
  dragHandleProps?: SortableDragHandleProps | null;
  compactBodyPadding?: boolean;
};

export function SessionGroupSection(props: Props): React.ReactNode {
  const {
    group,
    groupKey,
    projectId,
    hideGroupLabel,
    hasSessionSearchQuery,
    normalizedSessionSearchQuery,
    groupSearchDataByGroup,
    expandedSessionGroups,
    collapsedGroups,
    hideDirectoryControls,
    getFoldersForScope,
    collapsedFolderIds,
    toggleFolderCollapse,
    renameFolder,
    deleteFolder,
    showDeletionDialog,
    setDeleteFolderConfirm,
    renderSessionNode,
    projectRepoStatus,
    lastRepoStatus,
    toggleGroupSessionLimit,
    mobileVariant,
    activeProjectId,
    setActiveProjectIdOnly,
    setActiveMainTab,
    setSessionSwitcherOpen,
    openNewSessionDraft,
    addSessionToFolder,
    createFolderAndStartRename,
    renamingFolderId,
    renameFolderDraft,
    setRenameFolderDraft,
    setRenamingFolderId,
    pinnedSessionIds,
    sessionOrderIndex,
    prVisualStateByDirectoryBranch,
    onToggleCollapsedGroup,
    dragHandleProps,
    compactBodyPadding = false,
  } = props;

  const compareSessionNodes = React.useCallback((a: SessionNode, b: SessionNode) => {
    const aIndex = sessionOrderIndex.get(a.session.id);
    const bIndex = sessionOrderIndex.get(b.session.id);
    if (aIndex !== undefined || bIndex !== undefined) {
      if (aIndex === undefined) return 1;
      if (bIndex === undefined) return -1;
      if (aIndex !== bIndex) return aIndex - bIndex;
    }
    return compareSessionsByPinnedAndTime(a.session, b.session, pinnedSessionIds);
  }, [pinnedSessionIds, sessionOrderIndex]);

  const searchData = hasSessionSearchQuery ? groupSearchDataByGroup.get(group) : null;
  const displayMode = useSessionDisplayStore((state) => state.displayMode);
  const isMinimalMode = displayMode === 'minimal';
  const isExpanded = expandedSessionGroups.has(groupKey);
  const isCollapsed = hasSessionSearchQuery ? false : collapsedGroups.has(groupKey);
  const maxVisible = hideDirectoryControls ? 10 : 5;
  const groupMatchesSearch = hasSessionSearchQuery ? searchData?.groupMatches === true : false;
  const shouldFilterGroupContents = hasSessionSearchQuery;
  const sourceGroupNodes = React.useMemo(
    () => [...(shouldFilterGroupContents ? (searchData?.filteredNodes ?? []) : group.sessions)]
      .sort(compareSessionNodes),
    [compareSessionNodes, group.sessions, searchData?.filteredNodes, shouldFilterGroupContents],
  );
  const folderScopeKey = group.folderScopeKey ?? normalizePath(group.directory ?? null);
  const scopeFolders = folderScopeKey ? getFoldersForScope(folderScopeKey) : [];

  const nodeBySessionId = new Map<string, SessionNode>();
  const collectNodeLookup = (nodes: SessionNode[]) => {
    nodes.forEach((node) => {
      nodeBySessionId.set(node.session.id, node);
      if (node.children.length > 0) {
        collectNodeLookup(node.children);
      }
    });
  };
  collectNodeLookup(sourceGroupNodes);

  const allFoldersForGroupBase = scopeFolders.map((folder) => {
    const nodes = folder.sessionIds
      .map((sid) => nodeBySessionId.get(sid))
      .filter((n): n is SessionNode => Boolean(n))
      .sort(compareSessionNodes);
    return { folder, nodes };
  });

  const folderMapById = new Map(allFoldersForGroupBase.map((entry) => [entry.folder.id, entry]));
  const shouldKeepFolder = (folderId: string): boolean => {
    const entry = folderMapById.get(folderId);
    if (!entry) return false;
    if (!hasSessionSearchQuery) return true;
    const folderMatches = entry.folder.name.toLowerCase().includes(normalizedSessionSearchQuery);
    if (folderMatches || entry.nodes.length > 0) return true;
    return allFoldersForGroupBase
      .filter(({ folder }) => folder.parentId === folderId)
      .some(({ folder }) => shouldKeepFolder(folder.id));
  };

  const allFoldersForGroup = hasSessionSearchQuery
    ? allFoldersForGroupBase.filter(({ folder }) => shouldKeepFolder(folder.id))
    : allFoldersForGroupBase;

  const sessionIdsInFolders = new Set(allFoldersForGroup.flatMap((f) => f.folder.sessionIds));
  const ungroupedSessions = sourceGroupNodes.filter((node) => !sessionIdsInFolders.has(node.session.id));
  const rootFolders = allFoldersForGroup.filter(({ folder }) => !folder.parentId);

  if (hasSessionSearchQuery && !groupMatchesSearch && rootFolders.length === 0 && ungroupedSessions.length === 0) {
    return null;
  }

  const totalSessions = ungroupedSessions.length;
  const visibleSessions = group.isArchivedBucket
    ? ungroupedSessions
    : hasSessionSearchQuery
      ? ungroupedSessions
      : (isExpanded ? ungroupedSessions : ungroupedSessions.slice(0, maxVisible));
  const remainingCount = totalSessions - visibleSessions.length;

  const collectGroupSessions = (nodes: SessionNode[]): Session[] => {
    const collected: Session[] = [];
    const visit = (list: SessionNode[]) => {
      list.forEach((node) => {
        collected.push(node.session);
        if (node.children.length > 0) visit(node.children);
      });
    };
    visit(nodes);
    return collected;
  };

  const allGroupSessions = collectGroupSessions(sourceGroupNodes);
  const isGitProject = projectId && projectRepoStatus.has(projectId)
    ? Boolean(projectRepoStatus.get(projectId))
    : lastRepoStatus;
  const groupDirectoryKey = normalizePath(group.directory ?? null);
  const groupBranchKey = group.branch?.trim() ?? null;
  const prIndicator = groupDirectoryKey && groupBranchKey
    ? (prVisualStateByDirectoryBranch.get(`${groupDirectoryKey}::${groupBranchKey}`) ?? null)
    : null;
  const showInlinePrTitle = Boolean(prIndicator && group.branch);
  const showBranchSubtitle = !prIndicator && !group.isMain && Boolean(group.branch);
  const prVisualState = prIndicator?.visualState ?? null;
  const checksSummary = prIndicator && prIndicator.state === 'open' && prIndicator.checks
    ? `${prIndicator.checks.success}/${prIndicator.checks.total} checks passed`
    : null;
  const checksTail = prIndicator && prIndicator.state === 'open' && prIndicator.checks
    ? [
      prIndicator.checks.failure > 0 ? `${prIndicator.checks.failure} failing` : null,
      prIndicator.checks.pending > 0 ? `${prIndicator.checks.pending} pending` : null,
    ].filter((item): item is string => Boolean(item)).join(', ')
    : null;
  const mergeabilityLabel = prIndicator && prIndicator.state === 'open'
    ? (prIndicator.mergeableState === 'blocked' || prIndicator.mergeableState === 'dirty'
        ? 'Conflicts or blocked'
        : (prIndicator.mergeableState === 'clean' || prIndicator.canMerge === true ? 'Mergeable' : null))
    : null;
  const mergeStateLabel = prIndicator && prIndicator.state === 'open' && prIndicator.mergeableState
    ? `Merge state: ${prIndicator.mergeableState}`
    : null;
  const baseBranchLabel = prIndicator?.base ?? null;
  const headBranchLabel = prIndicator?.head ?? null;
  const statusLine = (() => {
    if (!prIndicator) {
      return group.branch && isBranchDifferentFromLabel(group.branch, group.label)
        ? { label: group.branch, color: null as string | null }
        : null;
    }
    switch (prIndicator.visualState) {
      case 'merged':
        return { label: 'Merged', color: 'var(--pr-merged)' };
      case 'open':
        return (prIndicator.canMerge === true || prIndicator.mergeableState === 'clean' || prIndicator.checks?.state === 'success')
          ? { label: 'Ready to merge', color: 'var(--pr-open)' }
          : { label: 'PR open', color: 'var(--pr-open)' };
      case 'blocked':
        return {
          label: prIndicator.mergeableState === 'dirty' ? 'Merge conflicts' : 'Merge blocked',
          color: 'var(--pr-blocked)',
        };
      case 'draft':
        return { label: 'Draft PR', color: 'var(--pr-draft)' };
      case 'closed':
        return { label: 'Closed', color: 'var(--pr-closed)' };
      default:
        return null;
    }
  })();
  const branchIconColor = statusLine?.color ?? (prVisualState ? `var(--pr-${prVisualState})` : undefined);
  const handlePrLinkClick = (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const url = prIndicator?.url;
    if (!url) {
      return;
    }
    void openExternalUrl(url);
  };

  const renderOneFolderItem = (folder: SessionFolder, nodes: SessionNode[], depth: number): React.ReactNode => {
    const directSubFolders = allFoldersForGroup.filter(({ folder: f }) => f.parentId === folder.id);
    const subFolderItems = directSubFolders.length > 0
      ? <>{directSubFolders.map(({ folder: sf, nodes: sn }) => renderOneFolderItem(sf, sn, depth + 1))}</>
      : undefined;
    const collectFolderSessions = (targetFolderId: string): Session[] => {
      const directNodes = allFoldersForGroup.find(({ folder: candidate }) => candidate.id === targetFolderId)?.nodes ?? [];
      const childFolders = allFoldersForGroup.filter(({ folder: candidate }) => candidate.parentId === targetFolderId);
      return [
        ...collectGroupSessions(directNodes),
        ...childFolders.flatMap(({ folder: child }) => collectFolderSessions(child.id)),
      ];
    };
    const folderSessionsForDelete = group.isArchivedBucket ? collectFolderSessions(folder.id) : [];

    return (
      <DroppableFolderWrapper key={folder.id} folderId={folder.id}>
        {(droppableRef, isDropTarget) => (
          <SessionFolderItem
            folder={folder}
            sessions={nodes}
            subFolderItems={subFolderItems}
            isCollapsed={hasSessionSearchQuery ? false : collapsedFolderIds.has(folder.id)}
            onToggle={() => toggleFolderCollapse(folder.id)}
            onRename={(name) => {
              if (folderScopeKey) renameFolder(folderScopeKey, folder.id, name);
            }}
            onDelete={() => {
              if (group.isArchivedBucket) {
                sessionEvents.requestDelete({
                  sessions: folderSessionsForDelete,
                  mode: 'session',
                });
                return;
              }
              if (!folderScopeKey) return;
              if (!showDeletionDialog) {
                deleteFolder(folderScopeKey, folder.id);
                return;
              }
              const subFolderCount = allFoldersForGroup.filter(({ folder: f }) => f.parentId === folder.id).length;
              const sessionCount = nodes.length;
              setDeleteFolderConfirm({
                scopeKey: folderScopeKey,
                folderId: folder.id,
                folderName: folder.name,
                subFolderCount,
                sessionCount,
              });
            }}
            renderSessionNode={renderSessionNode}
            groupDirectory={group.directory}
            projectId={projectId}
            mobileVariant={mobileVariant}
            isRenaming={renamingFolderId === folder.id}
            renameDraft={renamingFolderId === folder.id ? renameFolderDraft : undefined}
            onRenameDraftChange={(value) => setRenameFolderDraft(value)}
            onRenameSave={() => {
              const trimmed = renameFolderDraft.trim();
              if (trimmed && folderScopeKey) {
                renameFolder(folderScopeKey, folder.id, trimmed);
              }
              setRenamingFolderId(null);
              setRenameFolderDraft('');
            }}
            onRenameCancel={() => {
              setRenamingFolderId(null);
              setRenameFolderDraft('');
            }}
            droppableRef={droppableRef}
            isDropTarget={isDropTarget}
            depth={depth}
            onNewSession={() => {
              if (projectId && projectId !== activeProjectId) setActiveProjectIdOnly(projectId);
              setActiveMainTab('chat');
              if (mobileVariant) setSessionSwitcherOpen(false);
              openNewSessionDraft({ directoryOverride: group.directory, targetFolderId: folder.id });
            }}
            onNewSubFolder={depth === 0 ? () => {
              if (!folderScopeKey) return;
              createFolderAndStartRename(folderScopeKey, folder.id);
            } : undefined}
            hideActions={false}
            archivedBucket={group.isArchivedBucket === true}
          />
        )}
      </DroppableFolderWrapper>
    );
  };

  const renderFolderItems = () => rootFolders.map(({ folder, nodes }) => renderOneFolderItem(folder, nodes, 0));
  const hasWorktreeDeleteAction = Boolean(!group.isMain && group.worktree);
  const groupHeaderRightPadding = mobileVariant
    ? (hasWorktreeDeleteAction ? 'pr-14' : 'pr-7')
    : isMinimalMode
      ? (hasWorktreeDeleteAction
          ? 'pr-2 group-hover/gh:pr-14 group-focus-within/gh:pr-14'
          : 'pr-2')
      : (hasWorktreeDeleteAction
          ? 'pr-5 group-hover/gh:pr-14 group-focus-within/gh:pr-14'
          : 'pr-5');

  const body = (
    <SessionFolderDndScope
      scopeKey={folderScopeKey}
      hasFolders={allFoldersForGroup.length > 0}
      onSessionDroppedOnFolder={(sessionId, folderId) => {
        if (folderScopeKey) addSessionToFolder(folderScopeKey, folderId, sessionId);
      }}
    >
      {renderFolderItems()}
      {visibleSessions.map((node) => renderSessionNode(node, 0, group.directory, projectId, group.isArchivedBucket === true))}
      {totalSessions === 0 && allFoldersForGroup.length === 0 ? (
        <div className="py-1 text-left typography-micro text-muted-foreground">
          {group.isArchivedBucket ? 'No archived sessions yet.' : 'No sessions in this workspace yet.'}
        </div>
      ) : null}
      {remainingCount > 0 && !isExpanded ? (
        <button
          type="button"
          onClick={() => toggleGroupSessionLimit(groupKey)}
          className="mt-0.5 flex items-center justify-start rounded-md px-1.5 py-0.5 text-left text-xs text-muted-foreground/70 leading-tight hover:text-foreground hover:underline"
        >
          Show {remainingCount} more {remainingCount === 1 ? 'session' : 'sessions'}
        </button>
      ) : null}
      {isExpanded && totalSessions > maxVisible ? (
        <button
          type="button"
          onClick={() => toggleGroupSessionLimit(groupKey)}
          className="mt-0.5 flex items-center justify-start rounded-md px-1.5 py-0.5 text-left text-xs text-muted-foreground/70 leading-tight hover:text-foreground hover:underline"
        >
          Show fewer sessions
        </button>
      ) : null}
    </SessionFolderDndScope>
  );

  const groupBodyPaddingClass = compactBodyPadding ? 'pb-2 pl-1' : 'pb-3 pl-4';

  if (hideGroupLabel) {
    return <div className="oc-group"><div className={cn('oc-group-body', groupBodyPaddingClass)}>{body}</div></div>;
  }

  return (
    <div className="oc-group">
      <div
        className={cn('group/gh relative flex items-start justify-between gap-1 py-1 min-w-0 rounded-md', 'cursor-pointer')}
        onClick={() => onToggleCollapsedGroup(groupKey)}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggleCollapsedGroup(groupKey);
          }
        }}
        aria-label={isCollapsed ? `Expand ${group.label}` : `Collapse ${group.label}`}
        aria-expanded={!isCollapsed}
      >
        <div
          ref={dragHandleProps?.setActivatorNodeRef}
          className={cn(
            'min-w-0 flex flex-1 items-start gap-1 overflow-hidden pl-0.5 transition-[padding] cursor-grab active:cursor-grabbing',
            groupHeaderRightPadding,
          )}
          {...(dragHandleProps?.listeners ?? {})}
        >
          <div className="min-w-0 flex flex-1 flex-col justify-center gap-0.5 overflow-hidden">
            <p className="text-[14px] font-normal truncate text-foreground/92">
              {showInlinePrTitle && prIndicator ? (
                <span className="inline-flex min-w-0 max-w-full items-center">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex shrink-0 items-center gap-1 leading-none align-middle">
                        <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                          <RiGitBranchLine
                            className="h-3.5 w-3.5 shrink-0 group-hover/gh:hidden"
                            style={branchIconColor ? { color: branchIconColor } : undefined}
                          />
                          <span className="hidden text-muted-foreground group-hover/gh:inline-flex h-3.5 w-3.5 items-center justify-center">
                            {isCollapsed ? <RiArrowRightSLine className="h-3.5 w-3.5" /> : <RiArrowDownSLine className="h-3.5 w-3.5" />}
                          </span>
                        </span>
                        {prIndicator.url ? (
                          <button
                            type="button"
                            className="inline-flex shrink-0 items-center leading-none"
                            onMouseDown={(event) => event.stopPropagation()}
                            onClick={handlePrLinkClick}
                          >
                            #{prIndicator.number}
                          </button>
                        ) : (
                          <span className="inline-flex shrink-0 items-center leading-none">#{prIndicator.number}</span>
                        )}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={6} align="start" className="max-w-sm">
                      <div className="space-y-1 text-xs">
                        {(baseBranchLabel || headBranchLabel) ? (
                          <div className="text-muted-foreground truncate">
                            {baseBranchLabel && headBranchLabel ? (
                              <>
                                <span>{baseBranchLabel}</span>
                                <RiArrowLeftLongLine className="mx-0.5 inline h-3 w-3 align-[-2px]" />
                                <span>{headBranchLabel}</span>
                              </>
                            ) : (
                              <span>{baseBranchLabel ?? headBranchLabel ?? ''}</span>
                            )}
                          </div>
                        ) : null}
                        {mergeStateLabel ? <div className="text-muted-foreground truncate">{mergeStateLabel}</div> : null}
                        {(mergeabilityLabel || checksSummary) ? (
                          <div className="text-muted-foreground truncate">
                            {mergeabilityLabel ?? ''}
                            {mergeabilityLabel && checksSummary ? ' • ' : ''}
                            {checksSummary ?? ''}
                            {checksTail ? ` (${checksTail})` : ''}
                          </div>
                        ) : null}
                      </div>
                    </TooltipContent>
                  </Tooltip>
                  <span className="ml-1 min-w-0 flex-1 truncate leading-none align-middle">{group.branch}</span>
                </span>
              ) : group.isArchivedBucket ? (
                <span className="inline-flex min-w-0 max-w-full items-center gap-1">
                  <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    <RiArchiveLine className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover/gh:hidden" />
                    <span className="hidden text-muted-foreground group-hover/gh:inline-flex h-3.5 w-3.5 items-center justify-center">
                      {isCollapsed ? <RiArrowRightSLine className="h-3.5 w-3.5" /> : <RiArrowDownSLine className="h-3.5 w-3.5" />}
                    </span>
                  </span>
                  <span className="min-w-0 flex-1 truncate">{renderHighlightedText(group.label, normalizedSessionSearchQuery)}</span>
                </span>
              ) : (!group.isMain || group.worktree) ? (
                <span className="inline-flex min-w-0 max-w-full items-center gap-1">
                  <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    <RiGitBranchLine
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover/gh:hidden"
                      style={branchIconColor ? { color: branchIconColor } : undefined}
                    />
                    <span className="hidden text-muted-foreground group-hover/gh:inline-flex h-3.5 w-3.5 items-center justify-center">
                      {isCollapsed ? <RiArrowRightSLine className="h-3.5 w-3.5" /> : <RiArrowDownSLine className="h-3.5 w-3.5" />}
                    </span>
                  </span>
                  <span className="min-w-0 flex-1 truncate">{renderHighlightedText(group.label, normalizedSessionSearchQuery)}</span>
                </span>
              ) : (
                renderHighlightedText(group.label, normalizedSessionSearchQuery)
              )}
            </p>
            {showBranchSubtitle && statusLine ? (
              <span className="inline-flex min-w-0 items-center gap-1.5 leading-tight">
                {group.isArchivedBucket ? (
                  <RiArchiveLine className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                ) : (!group.isMain || isGitProject) ? (
                  showInlinePrTitle && prIndicator ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
                          <RiGitBranchLine
                            className="h-3.5 w-3.5 text-muted-foreground"
                            style={branchIconColor ? { color: branchIconColor } : undefined}
                          />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top" sideOffset={6} align="start" className="max-w-sm">
                        <div className="space-y-1 text-xs">
                          {(baseBranchLabel || headBranchLabel) ? (
                            <div className="text-muted-foreground truncate">
                              {baseBranchLabel && headBranchLabel ? (
                                <>
                                  <span>{baseBranchLabel}</span>
                                  <RiArrowLeftLongLine className="mx-0.5 inline h-3 w-3 align-[-2px]" />
                                  <span>{headBranchLabel}</span>
                                </>
                              ) : (
                                <span>{baseBranchLabel ?? headBranchLabel ?? ''}</span>
                              )}
                            </div>
                          ) : null}
                          {mergeStateLabel ? <div className="text-muted-foreground truncate">{mergeStateLabel}</div> : null}
                          {(mergeabilityLabel || checksSummary) ? (
                            <div className="text-muted-foreground truncate">
                              {mergeabilityLabel ?? ''}
                              {mergeabilityLabel && checksSummary ? ' • ' : ''}
                              {checksSummary ?? ''}
                              {checksTail ? ` (${checksTail})` : ''}
                            </div>
                          ) : null}
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <RiGitBranchLine
                      className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground"
                      style={branchIconColor ? { color: branchIconColor } : undefined}
                    />
                  )
                ) : null}
                <span
                  className={cn('min-w-0 truncate text-[11px] font-medium', !statusLine.color && 'text-muted-foreground/80')}
                  style={statusLine.color ? { color: statusLine.color } : undefined}
                >
                  {statusLine.label}
                </span>
              </span>
            ) : null}
          </div>
        </div>
        {group.isArchivedBucket && allGroupSessions.length > 0 ? (
          <div className={cn('absolute right-0.5 top-1/2 -translate-y-1/2 z-10 transition-opacity', mobileVariant ? 'opacity-100' : 'opacity-0 group-hover/gh:opacity-100 group-focus-within/gh:opacity-100')}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    sessionEvents.requestDelete({
                      sessions: allGroupSessions,
                      mode: 'session',
                    });
                  }}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                  aria-label={`Delete archived sessions in ${group.label}`}
                >
                  <RiDeleteBinLine className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}><p>Delete archived sessions</p></TooltipContent>
            </Tooltip>
          </div>
        ) : null}
        {group.directory && !group.isMain && group.worktree ? (
          <div className={cn('absolute right-7 top-1/2 -translate-y-1/2 z-10 transition-opacity', mobileVariant ? 'opacity-100' : 'opacity-0 group-hover/gh:opacity-100 group-focus-within/gh:opacity-100')}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    sessionEvents.requestDelete({
                      sessions: allGroupSessions,
                      mode: 'worktree',
                      worktree: group.worktree,
                    });
                  }}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                  aria-label={`Delete ${group.label}`}
                >
                  <RiDeleteBinLine className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}><p>Delete worktree</p></TooltipContent>
            </Tooltip>
          </div>
        ) : null}
        {group.directory ? (
          <div className={cn('absolute right-0.5 top-1/2 -translate-y-1/2 z-10 transition-opacity', mobileVariant ? 'opacity-100' : 'opacity-0 group-hover/gh:opacity-100 group-focus-within/gh:opacity-100')}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (projectId && projectId !== activeProjectId) setActiveProjectIdOnly(projectId);
                    setActiveMainTab('chat');
                    if (mobileVariant) setSessionSwitcherOpen(false);
                    openNewSessionDraft({ directoryOverride: group.directory });
                  }}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                   aria-label={`New draft session in ${group.label}`}
                 >
                   <RiAddLine className="h-4 w-4" />
                 </button>
               </TooltipTrigger>
               <TooltipContent side="bottom" sideOffset={4}><p>New draft session</p></TooltipContent>
             </Tooltip>
           </div>
         ) : null}
      </div>
      {!isCollapsed ? <div className={cn('oc-group-body', groupBodyPaddingClass)}>{body}</div> : null}
    </div>
  );
}
