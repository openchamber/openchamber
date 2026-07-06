import React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Session } from '@opencode-ai/sdk/v2';

// Archived buckets routinely grow into the hundreds/thousands; virtualize
// when we cross this row count so the DOM stays bounded.
const ARCHIVED_VIRTUALIZE_THRESHOLD = 50;
// Active/worktree groups can also grow large (a single worktree with 80+
// sessions), and unlike the archive they're interactive from the start.
// Virtualize eagerly for non-archived groups to keep the rendered row
// count bounded. With overscan ~8 the visible behavior is identical.
const ACTIVE_VIRTUALIZE_THRESHOLD = 30;
// Compact rows in the archived bucket without nested subagents render
// around 24-32px; virtua measures mounted rows and uses this as the initial hint.
const ARCHIVED_ROW_ESTIMATE_PX = 28;
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { sessionEvents } from '@/lib/sessionEvents';
import type { MainTab } from '@/stores/useUIStore';
import { SessionFolderItem } from '../SessionFolderItem';
import { DroppableFolderWrapper, SessionFolderDndScope } from './sessionFolderDnd';
import type { SortableDragHandleProps } from './sortableItems';
import type { GroupSearchData, SessionGroup, SessionNode } from './types';
import { compareSessionsByPinnedAndTime, isBranchDifferentFromLabel, normalizePath, renderHighlightedText } from './utils';
import {
  collectSubtreeContainingId,
  computeNodeStructureKey,
  nodeContainsSessionId,
  resolveMenuOpenSessionId,
} from './sessionNodeItemUtils';
import type { SessionNodeRenderExtras } from './sessionNodeItemUtils';
import type { SessionFolder } from '@/stores/useSessionFoldersStore';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { openExternalUrl } from '@/lib/url';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';

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
  visibleSessionCount?: number;
  collapsedGroups: Set<string>;
  hideDirectoryControls: boolean;
  collapsedFolderIds: Set<string>;
  toggleFolderCollapse: (folderId: string) => void;
  renameFolder: (scopeKey: string, folderId: string, name: string) => void;
  deleteFolder: (scopeKey: string, folderId: string) => void;
  showDeletionDialog: boolean;
  setDeleteFolderConfirm: React.Dispatch<React.SetStateAction<DeleteFolderConfirm>>;
  renderSessionNode: (
    node: SessionNode,
    depth?: number,
    groupDirectory?: string | null,
    projectId?: string | null,
    archivedBucket?: boolean,
    secondaryMeta?: { projectLabel?: string | null; branchLabel?: string | null } | null,
    renderContext?: 'project' | 'recent',
    renderExtras?: SessionNodeRenderExtras,
  ) => React.ReactNode;
  projectRepoStatus: Map<string, boolean | null>;
  lastRepoStatus: boolean;
  showMoreGroupSessions: (groupKey: string, currentVisibleCount: number) => void;
  resetGroupSessionLimit: (groupKey: string) => void;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
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
  expandedParents: Set<string>;
  sessionOrderIndex: Map<string, number>;
  currentSessionId: string | null;
  editingId: string | null;
  editTitle: string;
  openSidebarMenuKey: string | null;
  liveSessionById: Map<string, Session>;
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
  /**
   * Optional scroll container ref threaded from the outer ScrollableOverlay.
   * When provided, the virtualization effect can resolve the scrolling
   * ancestor synchronously and skip the getComputedStyle walk on every
   * render of an expanded archived bucket.
   */
  scrollContainerRef?: React.RefObject<HTMLElement | null>;
};

const groupContainsSessionId = (group: SessionGroup, sessionId: string | null): boolean => {
  if (!sessionId) return false;
  return group.sessions.some((node) => nodeContainsSessionId(node, sessionId));
};

const groupHasPinnedMembershipChange = (
  group: SessionGroup,
  prevPinnedSessionIds: Set<string>,
  nextPinnedSessionIds: Set<string>,
): boolean => {
  const visit = (node: SessionNode): boolean => {
    const sessionId = node.session.id;
    if (prevPinnedSessionIds.has(sessionId) !== nextPinnedSessionIds.has(sessionId)) return true;
    return node.children.some(visit);
  };
  return group.sessions.some(visit);
};

const groupHasSessionOrderChange = (
  group: SessionGroup,
  prevSessionOrderIndex: Map<string, number>,
  nextSessionOrderIndex: Map<string, number>,
): boolean => {
  const visit = (node: SessionNode): boolean => {
    const sessionId = node.session.id;
    if (prevSessionOrderIndex.get(sessionId) !== nextSessionOrderIndex.get(sessionId)) return true;
    return node.children.some(visit);
  };
  return group.sessions.some(visit);
};

const groupHasExpansionMembershipChange = (
  group: SessionGroup,
  prevExpandedParents: Set<string>,
  nextExpandedParents: Set<string>,
): boolean => {
  const bucketTag = group.isArchivedBucket ? 'archived' : 'active';
  const visit = (node: SessionNode): boolean => {
    const key = `project:${bucketTag}:${node.session.id}`;
    if (prevExpandedParents.has(key) !== nextExpandedParents.has(key)) return true;
    return node.children.some(visit);
  };
  return group.sessions.some(visit);
};

const groupHasResolvedSessionChange = (
  group: SessionGroup,
  prevLiveSessionById: Map<string, Session>,
  nextLiveSessionById: Map<string, Session>,
): boolean => {
  const visit = (node: SessionNode): boolean => {
    const sessionId = node.session.id;
    if ((prevLiveSessionById.get(sessionId) ?? node.session) !== (nextLiveSessionById.get(sessionId) ?? node.session)) {
      return true;
    }
    return node.children.some(visit);
  };
  return group.sessions.some(visit);
};

const getProjectRepoStatusValue = (props: Props): boolean | null | undefined => {
  if (!props.projectId) return undefined;
  return props.projectRepoStatus.has(props.projectId)
    ? props.projectRepoStatus.get(props.projectId)
    : undefined;
};

const areGroupPropsEqual = (prev: Props, next: Props): boolean => {
  // Bail on Object.is for the props that drive the most work: the group
  // itself, its key, and the group-level chrome. These change rarely and
  // any change should force a re-render of this group.
  if (prev.group !== next.group) return false;
  if (prev.groupKey !== next.groupKey) return false;
  if (prev.projectId !== next.projectId) return false;
  if (prev.hideGroupLabel !== next.hideGroupLabel) return false;
  if (prev.compactBodyPadding !== next.compactBodyPadding) return false;
  if (prev.groupSearchDataByGroup !== next.groupSearchDataByGroup) return false;
  if (prev.visibleSessionCount !== next.visibleSessionCount) return false;

  if (prev.collapsedGroups !== next.collapsedGroups
    && prev.collapsedGroups.has(prev.groupKey) !== next.collapsedGroups.has(next.groupKey)) {
    return false;
  }

  if (prev.projectRepoStatus !== next.projectRepoStatus
    && getProjectRepoStatusValue(prev) !== getProjectRepoStatusValue(next)) {
    return false;
  }

  if (prev.pinnedSessionIds !== next.pinnedSessionIds
    && groupHasPinnedMembershipChange(next.group, prev.pinnedSessionIds, next.pinnedSessionIds)) {
    return false;
  }

  if (prev.expandedParents !== next.expandedParents
    && groupHasExpansionMembershipChange(next.group, prev.expandedParents, next.expandedParents)) {
    return false;
  }

  if (prev.sessionOrderIndex !== next.sessionOrderIndex
    && groupHasSessionOrderChange(next.group, prev.sessionOrderIndex, next.sessionOrderIndex)) {
    return false;
  }

  if (prev.currentSessionId !== next.currentSessionId
    && (groupContainsSessionId(prev.group, prev.currentSessionId) || groupContainsSessionId(next.group, next.currentSessionId))) {
    return false;
  }

  if (prev.editingId !== next.editingId
    && (groupContainsSessionId(prev.group, prev.editingId) || groupContainsSessionId(next.group, next.editingId))) {
    return false;
  }

  if (prev.editTitle !== next.editTitle
    && (groupContainsSessionId(prev.group, prev.editingId) || groupContainsSessionId(next.group, next.editingId))) {
    return false;
  }

  if (prev.openSidebarMenuKey !== next.openSidebarMenuKey) {
    const prevMenuSessionId = resolveMenuOpenSessionId(prev.group.sessions, prev.openSidebarMenuKey, 'project', Boolean(prev.group.isArchivedBucket));
    const nextMenuSessionId = resolveMenuOpenSessionId(next.group.sessions, next.openSidebarMenuKey, 'project', Boolean(next.group.isArchivedBucket));
    if (prevMenuSessionId || nextMenuSessionId) return false;
  }

  if (prev.liveSessionById !== next.liveSessionById
    && groupHasResolvedSessionChange(next.group, prev.liveSessionById, next.liveSessionById)) {
    return false;
  }

  // Per-row / per-state props. The PR-visual-state map flips frequently
  // during bootstrap but a single group's value is usually stable, so we
  // compare only the value this group actually consumes instead of the
  // whole map reference.
  if (prev.prVisualStateByDirectoryBranch !== next.prVisualStateByDirectoryBranch) {
    const prevVal = prev.group?.directory && prev.group?.branch
      ? prev.prVisualStateByDirectoryBranch.get(`${prev.group.directory}::${prev.group.branch.trim()}`)
      : undefined;
    const nextVal = next.group?.directory && next.group?.branch
      ? next.prVisualStateByDirectoryBranch.get(`${next.group.directory}::${next.group.branch.trim()}`)
      : undefined;
    if (!Object.is(prevVal, nextVal)) return false;
  }

  // Other props are typically stable references from the parent. Default
  // to reference equality (the cheap path) and only re-render when the
  // parent actually swapped something.
  return (
    prev.hasSessionSearchQuery === next.hasSessionSearchQuery
    && prev.normalizedSessionSearchQuery === next.normalizedSessionSearchQuery
    && prev.hideDirectoryControls === next.hideDirectoryControls
    && prev.collapsedFolderIds === next.collapsedFolderIds
    && prev.toggleFolderCollapse === next.toggleFolderCollapse
    && prev.renameFolder === next.renameFolder
    && prev.deleteFolder === next.deleteFolder
    && prev.showDeletionDialog === next.showDeletionDialog
    && prev.setDeleteFolderConfirm === next.setDeleteFolderConfirm
    && prev.renderSessionNode === next.renderSessionNode
    && prev.lastRepoStatus === next.lastRepoStatus
    && prev.showMoreGroupSessions === next.showMoreGroupSessions
    && prev.resetGroupSessionLimit === next.resetGroupSessionLimit
    && prev.mobileVariant === next.mobileVariant
    && prev.alwaysShowActions === next.alwaysShowActions
    && prev.activeProjectId === next.activeProjectId
    && prev.setActiveProjectIdOnly === next.setActiveProjectIdOnly
    && prev.setActiveMainTab === next.setActiveMainTab
    && prev.setSessionSwitcherOpen === next.setSessionSwitcherOpen
    && prev.openNewSessionDraft === next.openNewSessionDraft
    && prev.addSessionToFolder === next.addSessionToFolder
    && prev.createFolderAndStartRename === next.createFolderAndStartRename
    && prev.renamingFolderId === next.renamingFolderId
    && prev.renameFolderDraft === next.renameFolderDraft
    && prev.setRenameFolderDraft === next.setRenameFolderDraft
    && prev.setRenamingFolderId === next.setRenamingFolderId
    && prev.onToggleCollapsedGroup === next.onToggleCollapsedGroup
    && prev.dragHandleProps === next.dragHandleProps
    && prev.scrollContainerRef === next.scrollContainerRef
  );
};

function SessionGroupSectionBase(props: Props): React.ReactNode {
  const { t } = useI18n();
  const {
    group,
    groupKey,
    projectId,
    hideGroupLabel,
    hasSessionSearchQuery,
    normalizedSessionSearchQuery,
    groupSearchDataByGroup,
    visibleSessionCount,
    collapsedGroups,
    hideDirectoryControls,
    collapsedFolderIds,
    toggleFolderCollapse,
    renameFolder,
    deleteFolder,
    showDeletionDialog,
    setDeleteFolderConfirm,
    renderSessionNode,
    projectRepoStatus,
    lastRepoStatus,
    showMoreGroupSessions,
    resetGroupSessionLimit,
    mobileVariant,
    alwaysShowActions,
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
    expandedParents,
    sessionOrderIndex,
    currentSessionId,
    editingId,
    openSidebarMenuKey,
    prVisualStateByDirectoryBranch,
    onToggleCollapsedGroup,
    dragHandleProps,
    compactBodyPadding = false,
    scrollContainerRef,
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
  const foldersMap = useSessionFoldersStore((state) => state.foldersMap);
  // VS Code always uses the expanded layout (see SessionNodeItem).
  const isMinimalMode = displayMode === 'minimal' && !isVSCodeRuntime();
  const isCollapsed = hasSessionSearchQuery ? false : collapsedGroups.has(groupKey);
  const maxVisible = hideDirectoryControls ? 10 : 5;
  const nonArchivedVisibleCount = Math.max(maxVisible, visibleSessionCount ?? maxVisible);
  const groupMatchesSearch = hasSessionSearchQuery ? searchData?.groupMatches === true : false;
  const shouldFilterGroupContents = hasSessionSearchQuery;
  const sourceGroupNodes = React.useMemo(
    () => [...(shouldFilterGroupContents ? (searchData?.filteredNodes ?? []) : group.sessions)]
      .sort(compareSessionNodes),
    [compareSessionNodes, group.sessions, searchData?.filteredNodes, shouldFilterGroupContents],
  );
  const folderScopeKey = group.folderScopeKey ?? normalizePath(group.directory ?? null);
  const scopeFolders = React.useMemo(
    () => folderScopeKey ? (foldersMap[folderScopeKey] ?? []) : [],
    [folderScopeKey, foldersMap]
  );

  const nodeBySessionId = React.useMemo(() => {
    const map = new Map<string, SessionNode>();
    const collectNodeLookup = (nodes: SessionNode[]) => {
      nodes.forEach((node) => {
        map.set(node.session.id, node);
        if (node.children.length > 0) {
          collectNodeLookup(node.children);
        }
      });
    };
    collectNodeLookup(sourceGroupNodes);
    return map;
  }, [sourceGroupNodes]);

  const allFoldersForGroupBase = React.useMemo(() => scopeFolders.map((folder) => {
    const nodes = folder.sessionIds
      .map((sid) => nodeBySessionId.get(sid))
      .filter((n): n is SessionNode => Boolean(n))
      .sort(compareSessionNodes);
    return { folder, nodes };
  }), [scopeFolders, nodeBySessionId, compareSessionNodes]);

  const allFoldersForGroup = React.useMemo(() => {
    const folderMapById = new Map(allFoldersForGroupBase.map((entry) => [entry.folder.id, entry]));
    const childFolderIdsByParentId = new Map<string, string[]>();
    for (const { folder } of allFoldersForGroupBase) {
      if (!folder.parentId) continue;
      const existing = childFolderIdsByParentId.get(folder.parentId);
      if (existing) {
        existing.push(folder.id);
      } else {
        childFolderIdsByParentId.set(folder.parentId, [folder.id]);
      }
    }

    const keepByFolderId = new Map<string, boolean>();
    const shouldKeepFolder = (folderId: string): boolean => {
      const cached = keepByFolderId.get(folderId);
      if (cached !== undefined) return cached;

      const entry = folderMapById.get(folderId);
      if (!entry) {
        keepByFolderId.set(folderId, false);
        return false;
      }

      const childFolderIds = childFolderIdsByParentId.get(folderId) ?? [];

      // For archived buckets, hide folders with no sessions unless descendants have content.
      if (group.isArchivedBucket && entry.nodes.length === 0) {
        const hasContentInChildren = childFolderIds.some((childId) => shouldKeepFolder(childId));
        keepByFolderId.set(folderId, hasContentInChildren);
        return hasContentInChildren;
      }

      if (!hasSessionSearchQuery) {
        keepByFolderId.set(folderId, true);
        return true;
      }

      const folderMatches = entry.folder.name.toLowerCase().includes(normalizedSessionSearchQuery);
      if (folderMatches || entry.nodes.length > 0) {
        keepByFolderId.set(folderId, true);
        return true;
      }

      const hasMatchingChildren = childFolderIds.some((childId) => shouldKeepFolder(childId));
      keepByFolderId.set(folderId, hasMatchingChildren);
      return hasMatchingChildren;
    };

    return allFoldersForGroupBase.filter(({ folder }) => shouldKeepFolder(folder.id));
  }, [allFoldersForGroupBase, group.isArchivedBucket, hasSessionSearchQuery, normalizedSessionSearchQuery]);

  const sessionIdsInFolders = React.useMemo(() => new Set(allFoldersForGroup.flatMap((f) => f.folder.sessionIds)), [allFoldersForGroup]);
  const ungroupedSessions = React.useMemo(() => sourceGroupNodes.filter((node) => !sessionIdsInFolders.has(node.session.id)), [sourceGroupNodes, sessionIdsInFolders]);
  const rootFolders = React.useMemo(() => allFoldersForGroup.filter(({ folder }) => !folder.parentId), [allFoldersForGroup]);

  // Precompute per-row "subtree contains active session" and "subtree contains
  // editing session" lookups once per render. The previous design walked the
  // node tree inside SessionNodeItem.areEqual for every row, which is O(M^2)
  // across the whole sidebar. These sets let areEqual answer with a single
  // Set.has lookup, so the cost is O(M) once per SessionGroupSection render.
  const renderContextForGroup = 'project' as const;
  const subtreeContainsActive = React.useMemo(() => {
    const set = new Set<string>();
    collectSubtreeContainingId(sourceGroupNodes, currentSessionId, set);
    allFoldersForGroup.forEach(({ nodes }) => {
      collectSubtreeContainingId(nodes, currentSessionId, set);
    });
    return set;
  }, [sourceGroupNodes, allFoldersForGroup, currentSessionId]);

  const subtreeContainsEditing = React.useMemo(() => {
    const set = new Set<string>();
    collectSubtreeContainingId(sourceGroupNodes, editingId, set);
    allFoldersForGroup.forEach(({ nodes }) => {
      collectSubtreeContainingId(nodes, editingId, set);
    });
    return set;
  }, [sourceGroupNodes, allFoldersForGroup, editingId]);

  const menuOpenSessionId = React.useMemo(() => {
    if (!openSidebarMenuKey) return null;
    const fromSource = resolveMenuOpenSessionId(sourceGroupNodes, openSidebarMenuKey, renderContextForGroup, Boolean(group.isArchivedBucket));
    if (fromSource) return fromSource;
    for (const { nodes } of allFoldersForGroup) {
      const id = resolveMenuOpenSessionId(nodes, openSidebarMenuKey, renderContextForGroup, Boolean(group.isArchivedBucket));
      if (id) return id;
    }
    return null;
  }, [openSidebarMenuKey, sourceGroupNodes, allFoldersForGroup, group.isArchivedBucket]);

  const buildNodeStructureKeyByNode = React.useCallback((nodes: SessionNode[]): WeakMap<SessionNode, string> => {
    const map = new WeakMap<SessionNode, string>();
    const visit = (node: SessionNode): void => {
      map.set(node, computeNodeStructureKey(node));
      for (const child of node.children) {
        visit(child);
      }
    };
    nodes.forEach(visit);
    return map;
  }, []);

  const nodeStructureKeyBySourceNode = React.useMemo(
    () => buildNodeStructureKeyByNode(sourceGroupNodes),
    [buildNodeStructureKeyByNode, sourceGroupNodes],
  );
  const nodeStructureKeyByFolderNode = React.useMemo(
    () => {
      const map = new WeakMap<SessionNode, string>();
      allFoldersForGroup.forEach(({ nodes }) => {
        nodes.forEach((node) => map.set(node, computeNodeStructureKey(node)));
      });
      return map;
    },
    [allFoldersForGroup],
  );

  const resolveNodeStructureKey = React.useCallback((node: SessionNode): string => {
    return nodeStructureKeyBySourceNode.get(node) ?? nodeStructureKeyByFolderNode.get(node) ?? '';
  }, [nodeStructureKeyBySourceNode, nodeStructureKeyByFolderNode]);

  const childRenderExtrasFor = React.useCallback((child: SessionNode) => ({
    subtreeContainsActive,
    subtreeContainsEditing,
    menuOpenSessionId,
    nodeStructureKey: resolveNodeStructureKey(child),
  }), [subtreeContainsActive, subtreeContainsEditing, menuOpenSessionId, resolveNodeStructureKey]);

  const totalSessions = ungroupedSessions.length;
  const visibleSessions = group.isArchivedBucket
    ? ungroupedSessions
    : hasSessionSearchQuery
      ? ungroupedSessions
      : ungroupedSessions.slice(0, nonArchivedVisibleCount);
  const remainingCount = totalSessions - visibleSessions.length;
  const canShowLess = !group.isArchivedBucket && !hasSessionSearchQuery && totalSessions > maxVisible && remainingCount === 0;

  // Virtualize large groups. Archived buckets grow into the hundreds or
  // thousands of rows; active/worktree groups can also hit 80+ sessions
  // when a single worktree accumulates over time. Both paths share the
  // same virtua Virtualizer; the threshold just controls when we mount
  // it. The visible behavior is identical because virtua uses overscan
  // (8) for the buffer zone. All hooks below MUST stay above the
  // search-empty early-return so they fire in the same order every
  // render — rules-of-hooks.
  const shouldVirtualizeArchived = group.isArchivedBucket === true
    && !hasSessionSearchQuery
    && visibleSessions.length >= ARCHIVED_VIRTUALIZE_THRESHOLD;
  const shouldVirtualizeActive = group.isArchivedBucket !== true
    && !hasSessionSearchQuery
    && visibleSessions.length >= ACTIVE_VIRTUALIZE_THRESHOLD;
  const shouldVirtualize = shouldVirtualizeArchived || shouldVirtualizeActive;

  // Check if any parent node is expanded - expanded parents render their
  // children inline, making them much taller than the fixed estimate.
  // When expanded parents exist, increase bufferSize to cover the extra height.
  const bucketTag = group.isArchivedBucket ? 'archived' : 'active';
  const hasExpandedParent = shouldVirtualize && visibleSessions.some((node) => {
    if (node.children.length === 0) return false;
    const expansionKey = `project:${bucketTag}:${node.session.id}`;
    return expandedParents.has(expansionKey);
  });

  const archivedVirtualContainerRef = React.useRef<HTMLDivElement | null>(null);
  const [archivedScrollEl, setArchivedScrollEl] = React.useState<HTMLElement | null>(null);
  // Offset of the virtual container from the scroll element's content origin.
  // virtua reads startMargin from Virtualizer options and uses it
  // to translate scrollTop into container-relative coordinates. Without this,
  // when the scroll element is an ancestor (the sidebar's ScrollableOverlay),
  // the virtualizer assumes the container starts at the top of the scroll
  // element and renders rows in the wrong subset / position.
  const [archivedScrollMargin, setArchivedScrollMargin] = React.useState(0);

  // Resolve the scrolling ancestor. When the parent has threaded a
  // `scrollContainerRef` (Layer 1.4), use it directly to skip the
  // `getComputedStyle` walk on every render of an expanded archived
  // bucket — the walk is one of the more expensive operations in the
  // hot path because it forces a style recalc on every parent up the
  // tree. Fall back to the legacy walk only when the ref is missing.
  //
  // We also still re-run when the archive flips between expanded/collapsed,
  // and on a ResizeObserver-driven layout change of the container, so a
  // dep-gated effect that only fires when shouldVirtualizeArchived flips
  // would miss the eventual mount and leave the scroll element null.
  const [, setLayoutVersion] = React.useState(0);
  React.useEffect(() => {
    if (!shouldVirtualize) return;
    const container = archivedVirtualContainerRef.current;
    if (!container) return;
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setLayoutVersion((v) => v + 1));
    ro.observe(container);
    return () => ro.disconnect();
  }, [shouldVirtualize]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  React.useLayoutEffect(() => {
    if (!shouldVirtualize) {
      if (archivedScrollEl !== null) setArchivedScrollEl(null);
      if (archivedScrollMargin !== 0) setArchivedScrollMargin(0);
      return;
    }
    const container = archivedVirtualContainerRef.current;
    if (!container) {
      // Bucket still collapsed — body not mounted. We'll re-run on the
      // render that mounts it.
      return;
    }
    let scrollEl: HTMLElement | null = archivedScrollEl;
    const providedScrollEl = scrollContainerRef?.current ?? null;
    if (providedScrollEl && providedScrollEl.contains(container)) {
      scrollEl = providedScrollEl;
      if (scrollEl !== archivedScrollEl) {
        setArchivedScrollEl(scrollEl);
        return;
      }
    } else if (!scrollEl || !scrollEl.contains(container)) {
      // Walk up to find the nearest scrolling ancestor. Only happens on
      // first mount or if the DOM tree restructured.
      let el: HTMLElement | null = container.parentElement;
      while (el) {
        const style = window.getComputedStyle(el);
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
          scrollEl = el;
          break;
        }
        el = el.parentElement;
      }
      if (scrollEl !== archivedScrollEl) {
        setArchivedScrollEl(scrollEl);
        return;
      }
    }
    if (!scrollEl) return;
    const offset = container.getBoundingClientRect().top
      - scrollEl.getBoundingClientRect().top
      + scrollEl.scrollTop;
    setArchivedScrollMargin((prev) => (Math.abs(prev - offset) < 1 ? prev : offset));
  });

  // The scroll element is an ANCESTOR of this section (the sidebar's
  // ScrollableOverlay), so scrollMargin translates its scrollTop into
  // container-relative coordinates — the tanstack equivalent of virtua's
  // startMargin this replaces.
  // Enable ONLY once the ancestor scroll element is resolved. While the
  // virtualizer is disabled the core resets its cached scroll offset, so the
  // first enabled read takes initialOffset() from the LIVE scrollTop below —
  // making the core's attach-time scrollTo target the current position (a
  // visual no-op) instead of a stale 0 that reset the sidebar to the top.
  // The core only learns the offset from scroll events after that, so this
  // initial seeding is what makes the first render window correct too.
  const virtualizerReady = shouldVirtualize && archivedScrollEl !== null;
  const sessionVirtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: visibleSessions.length,
    enabled: virtualizerReady,
    getScrollElement: () => archivedScrollEl,
    initialOffset: () => archivedScrollEl?.scrollTop ?? 0,
    estimateSize: () => ARCHIVED_ROW_ESTIMATE_PX,
    // Expanded parents render children inline and dwarf the row estimate;
    // widen the window so their extra height stays covered.
    overscan: hasExpandedParent ? 20 : 8,
    scrollMargin: archivedScrollMargin,
    getItemKey: (index) => visibleSessions[index]?.session.id ?? index,
  });

  // Hooks below MUST stay above the search-empty early-return so they
  // fire in the same order every render — rules-of-hooks.
  const collectGroupSessions = React.useCallback((nodes: SessionNode[]): Session[] => {
    const collected: Session[] = [];
    const visit = (list: SessionNode[]) => {
      list.forEach((node) => {
        collected.push(node.session);
        if (node.children.length > 0) visit(node.children);
      });
    };
    visit(nodes);
    return collected;
  }, []);

  // Flat list of all sessions in this group (including nested children).
  // Used by both the "delete all archived" button and the "delete worktree"
  // button. Memoize so the recursive flatten only runs when the underlying
  // source group nodes change, not on every render.
  const allGroupSessions = React.useMemo(
    () => collectGroupSessions(sourceGroupNodes),
    [collectGroupSessions, sourceGroupNodes],
  );

  // Precompute the per-folder "delete all sessions in folder" list once
  // per render. The previous design ran a recursive `collectFolderSessions`
  // walk inside each folder's render, which is O(F × (S + F)) per group
  // render. With F=50 folders and S=200 archived sessions this is
  // significant; the precompute makes it O(F + S) once.
  const folderSessionsForDeleteById = React.useMemo(() => {
    if (!group.isArchivedBucket) return new Map<string, Session[]>();
    const result = new Map<string, Session[]>();
    const childIdsByParentId = new Map<string, string[]>();
    for (const { folder } of allFoldersForGroup) {
      if (!folder.parentId) continue;
      const existing = childIdsByParentId.get(folder.parentId) ?? [];
      existing.push(folder.id);
      childIdsByParentId.set(folder.parentId, existing);
    }
    const visit = (targetFolderId: string, seen: Set<string>): Session[] => {
      if (seen.has(targetFolderId)) return [];
      seen.add(targetFolderId);
      const directEntry = allFoldersForGroup.find(({ folder: candidate }) => candidate.id === targetFolderId);
      const collected: Session[] = directEntry ? collectGroupSessions(directEntry.nodes) : [];
      const childIds = childIdsByParentId.get(targetFolderId) ?? [];
      for (const childId of childIds) {
        collected.push(...visit(childId, seen));
      }
      return collected;
    };
    for (const { folder } of allFoldersForGroup) {
      result.set(folder.id, visit(folder.id, new Set()));
    }
    return result;
  }, [allFoldersForGroup, collectGroupSessions, group.isArchivedBucket]);

  if (hasSessionSearchQuery && !groupMatchesSearch && rootFolders.length === 0 && ungroupedSessions.length === 0) {
    return null;
  }

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
    ? t('sessions.sidebar.group.pr.checksPassed', {
      success: prIndicator.checks.success,
      total: prIndicator.checks.total,
    })
    : null;
  const checksTail = prIndicator && prIndicator.state === 'open' && prIndicator.checks
    ? [
      prIndicator.checks.failure > 0
        ? t('sessions.sidebar.group.pr.failingCount', { count: prIndicator.checks.failure })
        : null,
      prIndicator.checks.pending > 0
        ? t('sessions.sidebar.group.pr.pendingCount', { count: prIndicator.checks.pending })
        : null,
    ].filter((item): item is string => Boolean(item)).join(', ')
    : null;
  const mergeabilityLabel = prIndicator && prIndicator.state === 'open'
    ? (prIndicator.mergeableState === 'blocked' || prIndicator.mergeableState === 'dirty'
        ? t('sessions.sidebar.group.pr.conflictsOrBlocked')
        : (prIndicator.mergeableState === 'clean' || prIndicator.canMerge === true ? t('sessions.sidebar.group.pr.mergeable') : null))
    : null;
  const mergeStateLabel = prIndicator && prIndicator.state === 'open' && prIndicator.mergeableState
    ? t('sessions.sidebar.group.pr.mergeState', { state: prIndicator.mergeableState })
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
        return { label: t('sessions.sidebar.group.pr.status.merged'), color: 'var(--pr-merged)' };
      case 'open':
        return (prIndicator.canMerge === true || prIndicator.mergeableState === 'clean' || prIndicator.checks?.state === 'success')
          ? { label: t('sessions.sidebar.group.pr.status.readyToMerge'), color: 'var(--pr-open)' }
          : { label: t('sessions.sidebar.group.pr.status.open'), color: 'var(--pr-open)' };
      case 'blocked':
        return {
          label: prIndicator.mergeableState === 'dirty'
            ? t('sessions.sidebar.group.pr.status.mergeConflicts')
            : t('sessions.sidebar.group.pr.status.mergeBlocked'),
          color: 'var(--pr-blocked)',
        };
      case 'draft':
        return { label: t('sessions.sidebar.group.pr.status.draft'), color: 'var(--pr-draft)' };
      case 'closed':
        return { label: t('sessions.sidebar.group.pr.status.closed'), color: 'var(--pr-closed)' };
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
    const folderSessionsForDelete = folderSessionsForDeleteById.get(folder.id) ?? [];

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
                // Delete sessions in the folder
                // Empty folders are auto-hidden by useArchivedAutoFolders
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
            getRenderExtras={resolveNodeStructureKey
              ? (node) => ({
                subtreeContainsActive,
                subtreeContainsEditing,
                menuOpenSessionId,
                nodeStructureKey: resolveNodeStructureKey(node),
                childRenderExtrasFor,
              })
              : undefined}
            groupDirectory={group.directory}
            projectId={projectId}
            mobileVariant={mobileVariant}
            alwaysShowActions={alwaysShowActions}
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
  const groupHeaderRightPadding = alwaysShowActions
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
      {shouldVirtualize ? (
        <div ref={archivedVirtualContainerRef}>
          {!virtualizerReady ? (
            // At most one pre-paint frame: this wrapper must exist for the
            // layout effect to resolve the ancestor scroll element, which
            // re-renders synchronously before paint. Rendering the plain rows
            // meanwhile keeps the container's height real so the scroller
            // never collapses/clamps during the flip.
            visibleSessions.map((node) => renderSessionNode(node, 0, group.directory, projectId, group.isArchivedBucket === true, undefined, 'project', {
              subtreeContainsActive,
              subtreeContainsEditing,
              menuOpenSessionId,
              nodeStructureKey: resolveNodeStructureKey(node),
              childRenderExtrasFor,
            }))
          ) : (
          <div style={{ height: sessionVirtualizer.getTotalSize(), position: 'relative' }}>
            {/* Absolutely positioned rows (canonical tanstack layout): with
                variable-height rows, flow-stacking can drift from the computed
                total height until measurements settle and overlap the content
                below the group. Per-item offsets cannot drift. item.start
                includes scrollMargin (ancestor-scroll offset), so subtract it. */}
            {sessionVirtualizer.getVirtualItems().map((item) => {
              const node = visibleSessions[item.index];
              if (!node) return null;
              return (
                <div
                  key={node.session.id}
                  data-index={item.index}
                  ref={sessionVirtualizer.measureElement}
                  // Rows carry my-0.5 (2px), which COLLAPSES to 2px between
                  // neighbors in normal flow but cannot collapse across
                  // isolated virtualized wrappers — spacing doubles to 4px the
                  // moment virtualization kicks in. Replace the row margin
                  // with 1px per side (no collapse, 1+1 = the same visual 2px
                  // gap). The [data-session-row] selector reaches the row
                  // through the dnd/context-menu wrappers at any depth and
                  // keeps nested child rows consistent too.
                  className="[&_[data-session-row]]:my-px"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${item.start - archivedScrollMargin}px)`,
                  }}
                >
                  {renderSessionNode(node, 0, group.directory, projectId, group.isArchivedBucket === true, undefined, 'project', {
                    subtreeContainsActive,
                    subtreeContainsEditing,
                    menuOpenSessionId,
                    nodeStructureKey: resolveNodeStructureKey(node),
                    childRenderExtrasFor,
                  })}
                </div>
              );
            })}
          </div>
          )}
        </div>
      ) : (
        visibleSessions.map((node) => renderSessionNode(node, 0, group.directory, projectId, group.isArchivedBucket === true, undefined, 'project', {
          subtreeContainsActive,
          subtreeContainsEditing,
          menuOpenSessionId,
          nodeStructureKey: resolveNodeStructureKey(node),
          childRenderExtrasFor,
        }))
      )}
      {totalSessions === 0 && allFoldersForGroup.length === 0 ? (
        <div className="py-1 text-left typography-micro text-muted-foreground">
          {group.isArchivedBucket
            ? t('sessions.sidebar.group.empty.noArchivedSessions')
            : t('sessions.sidebar.group.empty.noSessionsInWorkspace')}
        </div>
      ) : null}
      {remainingCount > 0 ? (
        <button
          type="button"
          onClick={() => showMoreGroupSessions(groupKey, visibleSessions.length)}
          className="mt-0.5 flex items-center justify-start rounded-md px-1.5 py-0.5 text-left text-xs text-muted-foreground/70 leading-tight hover:text-foreground hover:underline"
        >
          {t('sessions.sidebar.group.showMore')}
        </button>
      ) : null}
      {canShowLess ? (
        <button
          type="button"
          onClick={() => resetGroupSessionLimit(groupKey)}
          className="mt-0.5 flex items-center justify-start rounded-md px-1.5 py-0.5 text-left text-xs text-muted-foreground/70 leading-tight hover:text-foreground hover:underline"
        >
          {t('sessions.sidebar.group.showFewer')}
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
        aria-label={isCollapsed
          ? t('sessions.sidebar.group.expandAria', { label: group.label })
          : t('sessions.sidebar.group.collapseAria', { label: group.label })}
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
                          <Icon name="git-branch"
                            className={cn('h-3.5 w-3.5 shrink-0', alwaysShowActions ? 'hidden' : 'group-hover/gh:hidden')}
                            style={branchIconColor ? { color: branchIconColor } : undefined}
                          />
                          <span className={cn(
                            'text-muted-foreground h-3.5 w-3.5 items-center justify-center',
                            alwaysShowActions ? 'inline-flex' : 'hidden group-hover/gh:inline-flex',
                          )}>
                            {isCollapsed ? <Icon name="arrow-right-s" className="h-3.5 w-3.5" /> : <Icon name="arrow-down-s" className="h-3.5 w-3.5" />}
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
                                <Icon name="arrow-left-long" className="mx-0.5 inline h-3 w-3 align-[-2px]" />
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
                    <Icon name="archive" className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground', alwaysShowActions ? 'hidden' : 'group-hover/gh:hidden')} />
                    <span className={cn(
                      'text-muted-foreground h-3.5 w-3.5 items-center justify-center',
                      alwaysShowActions ? 'inline-flex' : 'hidden group-hover/gh:inline-flex',
                    )}>
                      {isCollapsed ? <Icon name="arrow-right-s" className="h-3.5 w-3.5" /> : <Icon name="arrow-down-s" className="h-3.5 w-3.5" />}
                    </span>
                  </span>
                  <span className="min-w-0 flex-1 truncate">{renderHighlightedText(group.label, normalizedSessionSearchQuery)}</span>
                </span>
              ) : (!group.isMain || group.worktree) ? (
                <span className="inline-flex min-w-0 max-w-full items-center gap-1">
                  <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    <Icon name="git-branch"
                      className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground', alwaysShowActions ? 'hidden' : 'group-hover/gh:hidden')}
                      style={branchIconColor ? { color: branchIconColor } : undefined}
                    />
                    <span className={cn(
                      'text-muted-foreground h-3.5 w-3.5 items-center justify-center',
                      alwaysShowActions ? 'inline-flex' : 'hidden group-hover/gh:inline-flex',
                    )}>
                      {isCollapsed ? <Icon name="arrow-right-s" className="h-3.5 w-3.5" /> : <Icon name="arrow-down-s" className="h-3.5 w-3.5" />}
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
                  <Icon name="archive" className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                ) : (!group.isMain || isGitProject) ? (
                  showInlinePrTitle && prIndicator ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
                          <Icon name="git-branch" className="h-3.5 w-3.5 text-muted-foreground"
                            style={branchIconColor ? { color: branchIconColor } : undefined}/>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top" sideOffset={6} align="start" className="max-w-sm">
                        <div className="space-y-1 text-xs">
                          {(baseBranchLabel || headBranchLabel) ? (
                            <div className="text-muted-foreground truncate">
                              {baseBranchLabel && headBranchLabel ? (
                                <>
                                  <span>{baseBranchLabel}</span>
                                  <Icon name="arrow-left-long" className="mx-0.5 inline h-3 w-3 align-[-2px]" />
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
                    <Icon name="git-branch" className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground"
                      style={branchIconColor ? { color: branchIconColor } : undefined}/>
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
          <div className={cn('absolute right-0.5 top-1/2 -translate-y-1/2 z-10 transition-opacity', alwaysShowActions ? 'opacity-100' : 'opacity-0 group-hover/gh:opacity-100 group-focus-within/gh:opacity-100')}>
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
                  aria-label={t('sessions.sidebar.group.actions.deleteArchivedInGroupAria', { label: group.label })}
                >
                  <Icon name="delete-bin" className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.group.actions.deleteArchivedSessions')}</p></TooltipContent>
            </Tooltip>
          </div>
        ) : null}
        {group.directory && !group.isMain && group.worktree ? (
          <div className={cn('absolute right-7 top-1/2 -translate-y-1/2 z-10 transition-opacity', alwaysShowActions ? 'opacity-100' : 'opacity-0 group-hover/gh:opacity-100 group-focus-within/gh:opacity-100')}>
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
                  aria-label={t('sessions.sidebar.group.actions.deleteGroupAria', { label: group.label })}
                >
                  <Icon name="delete-bin" className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.group.actions.deleteWorktree')}</p></TooltipContent>
            </Tooltip>
          </div>
        ) : null}
        {group.directory ? (
          <div className={cn('absolute right-0.5 top-1/2 -translate-y-1/2 z-10 transition-opacity', alwaysShowActions ? 'opacity-100' : 'opacity-0 group-hover/gh:opacity-100 group-focus-within/gh:opacity-100')}>
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
                  aria-label={t('sessions.sidebar.group.actions.newDraftInGroupAria', { label: group.label })}
                 >
                   <Icon name="add" className="h-4 w-4" />
                 </button>
               </TooltipTrigger>
               <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.project.actions.newDraftSession')}</p></TooltipContent>
             </Tooltip>
           </div>
         ) : null}
      </div>
      {!isCollapsed ? <div className={cn('oc-group-body', groupBodyPaddingClass)}>{body}</div> : null}
    </div>
  );
}

export const SessionGroupSection = React.memo(SessionGroupSectionBase, areGroupPropsEqual);
