import React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useShallow } from 'zustand/react/shallow';
import type { Session } from '@opencode-ai/sdk/v2';

// Archived buckets routinely grow into the hundreds/thousands; virtualize
// when we cross this row count so the DOM stays bounded.
const ARCHIVED_VIRTUALIZE_THRESHOLD = 50;
// Compact rows in the archived bucket without nested subagents render
// around 24-32px; virtua measures mounted rows and uses this as the initial hint.
const ARCHIVED_ROW_ESTIMATE_PX = 28;
const EMPTY_FOLDERS: readonly never[] = [];
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { sessionEvents } from '@/lib/sessionEvents';
import { useUIStore } from '@/stores/useUIStore';
import { SessionFolderItem } from '../../SessionFolderItem';
import type { SortableDragHandleProps } from './sortableItems';
import { DroppableFolderWrapper, SessionFolderDndScope } from '../folders/sessionFolderDnd';
import type { GroupSearchData, SessionGroup, SessionNode } from '../types';
import { isBranchDifferentFromLabel, normalizePath, renderHighlightedText } from '../utils';
import { compareSessionsByLifecycleOrder, EMPTY_SESSION_ORDER_RANKS } from '@/sync/session-ordering';
import {
  collectSubtreeContainingId,
  computeNodeStructureKey,
  nodeHasPinnedMembershipChange,
  nodeContainsSessionId,
  normalizeFolderRoots,
  resolveMenuOpenSessionId,
  selectFolderIdsForProjection,
  selectFolderRootNodes,
} from '../sessions/sessionNodeItemUtils';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';

type FolderScope = { scopeKey: string; directory: string | null };
import { getGitHubPrStatusKey, usePrVisualSummary } from '@/stores/useGitHubPrStatusStore';
import { useI18n } from '@/lib/i18n';
import { useChildStoreManager } from '@/sync/sync-context';
import { canRequestNativeDirectoryAccess, requestDirectoryAccess } from '@/lib/desktop';
import { CollapsedSessionActivityIndicator } from '../sessions/collapsedActivityIndicator';
import { useCollapsedSessionActivityState } from '../sessions/collapsedActivityState';
import { SessionTreeItem, type SessionTreeItemProps } from '../sessions/SessionTreeItem';
import { FolderDeleteConfirmDialog } from '../shell/ConfirmDialogs';

type DeleteFolderConfirm = {
  scopeKey: string;
  folderId: string;
  folderName: string;
  subFolderCount: number;
  sessionCount: number;
} | null;

export type SessionGroupSectionProps = {
  group: SessionGroup;
  groupKey: string;
  projectId?: string | null;
  hideGroupLabel?: boolean;
  hasSessionSearchQuery: boolean;
  normalizedSessionSearchQuery: string;
  groupSearchDataByGroup: WeakMap<SessionGroup, GroupSearchData>;
  visibleSessionCount?: number;
  sessionBatchSize?: number;
  collapsedGroups: Set<string>;
  hideDirectoryControls: boolean;
  showMoreGroupSessions: (groupKey: string, currentVisibleCount: number, increment?: number) => void;
  resetGroupSessionLimit: (groupKey: string) => void;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  activeProjectId: string | null;
  setActiveProjectIdOnly: (id: string) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
  openNewSessionDraft: (options?: { selectedProjectId?: string | null; directoryOverride?: string | null; targetFolderId?: string; target?: 'chat' | 'project' }) => void;
  pinnedSessionIds: Set<string>;
  sessionOrderIndex: Map<string, number>;
  notifyOnSubtasks: boolean;
  expandedParents: Set<string>;
  editingId: string | null;
  editTitle: string;
  copiedSessionId: string | null;
  openSidebarMenuKey: string | null;
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
  folderRename: { scopeKey: string; folderId: string; draft: string } | null;
  setFolderRenameDraft: (draft: string) => void;
  clearFolderRename: () => void;
} & Pick<SessionTreeItemProps,
  | 'setEditingId'
  | 'setEditTitle'
  | 'toggleParent'
  | 'setOpenSidebarMenuKey'
  | 'allowReselect'
  | 'onSessionSelected'
  | 'isSessionSearchOpen'
  | 'sessionSearchQuery'
  | 'setSessionSearchQuery'
  | 'setIsSessionSearchOpen'
  | 'deleteSessionConfirm'
  | 'setDeleteSessionConfirm'
  | 'startFolderRename'
  | 'setCopiedSessionId'
  | 'startSessionWorktreeMenuLoad'
>;

const CollapsedFolderActivity: React.FC<{
  nodes: SessionNode[];
  includeUnreadSubtasks: boolean;
  children: (state: ReturnType<typeof useCollapsedSessionActivityState>) => React.ReactNode;
}> = ({ nodes, includeUnreadSubtasks, children }) => children(useCollapsedSessionActivityState({
  nodes,
  includeUnreadSubtasks,
}));

const groupContainsSessionId = (group: SessionGroup, sessionId: string | null): boolean => {
  if (!sessionId) return false;
  return group.sessions.some((node) => nodeContainsSessionId(node, sessionId));
};

const groupHasPinnedMembershipChange = (
  group: SessionGroup,
  prevPinnedSessionIds: Set<string>,
  nextPinnedSessionIds: Set<string>,
): boolean => {
  return group.sessions.some((node) => nodeHasPinnedMembershipChange(
    node,
    node,
    prevPinnedSessionIds,
    nextPinnedSessionIds,
    group.directory,
    group.directory,
  ));
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

const areGroupPropsEqual = (prev: SessionGroupSectionProps, next: SessionGroupSectionProps): boolean => {
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
  if (prev.sessionBatchSize !== next.sessionBatchSize) return false;

  if (prev.collapsedGroups !== next.collapsedGroups
    && prev.collapsedGroups.has(prev.groupKey) !== next.collapsedGroups.has(next.groupKey)) {
    return false;
  }

  if (prev.pinnedSessionIds !== next.pinnedSessionIds
    && groupHasPinnedMembershipChange(next.group, prev.pinnedSessionIds, next.pinnedSessionIds)) {
    return false;
  }

  if (prev.sessionOrderIndex !== next.sessionOrderIndex
    && groupHasSessionOrderChange(next.group, prev.sessionOrderIndex, next.sessionOrderIndex)) {
    return false;
  }

  if (prev.expandedParents !== next.expandedParents
    && groupHasExpansionMembershipChange(next.group, prev.expandedParents, next.expandedParents)) {
    return false;
  }
  if (prev.editingId !== next.editingId
    && (groupContainsSessionId(next.group, prev.editingId) || groupContainsSessionId(next.group, next.editingId))) {
    return false;
  }
  if (prev.editTitle !== next.editTitle && groupContainsSessionId(next.group, next.editingId)) return false;
  if (prev.copiedSessionId !== next.copiedSessionId
    && (groupContainsSessionId(next.group, prev.copiedSessionId) || groupContainsSessionId(next.group, next.copiedSessionId))) {
    return false;
  }
  if (prev.openSidebarMenuKey !== next.openSidebarMenuKey) {
    const archived = next.group.isArchivedBucket === true;
    const previousMenuSessionId = resolveMenuOpenSessionId(next.group.sessions, prev.openSidebarMenuKey, 'project', archived);
    const nextMenuSessionId = resolveMenuOpenSessionId(next.group.sessions, next.openSidebarMenuKey, 'project', archived);
    if (previousMenuSessionId || nextMenuSessionId) return false;
  }
  if (prev.folderRename !== next.folderRename) {
    const scopes = next.group.folderScopes?.map((scope) => scope.scopeKey)
      ?? [next.group.folderScopeKey ?? normalizePath(next.group.directory ?? null)];
    if (scopes.includes(prev.folderRename?.scopeKey ?? null) || scopes.includes(next.folderRename?.scopeKey ?? null)) {
      return false;
    }
  }

  // Other props are typically stable references from the parent. Default
  // to reference equality (the cheap path) and only re-render when the
  // parent actually swapped something.
  return (
    prev.hasSessionSearchQuery === next.hasSessionSearchQuery
    && prev.normalizedSessionSearchQuery === next.normalizedSessionSearchQuery
    && prev.hideDirectoryControls === next.hideDirectoryControls
    && prev.showMoreGroupSessions === next.showMoreGroupSessions
    && prev.resetGroupSessionLimit === next.resetGroupSessionLimit
    && prev.mobileVariant === next.mobileVariant
    && prev.alwaysShowActions === next.alwaysShowActions
    && prev.setActiveProjectIdOnly === next.setActiveProjectIdOnly
    && prev.setSessionSwitcherOpen === next.setSessionSwitcherOpen
    && prev.openNewSessionDraft === next.openNewSessionDraft
    && prev.onToggleCollapsedGroup === next.onToggleCollapsedGroup
    && prev.dragHandleProps === next.dragHandleProps
    && prev.scrollContainerRef === next.scrollContainerRef
    && prev.notifyOnSubtasks === next.notifyOnSubtasks
    && prev.setEditingId === next.setEditingId
    && prev.setEditTitle === next.setEditTitle
    && prev.toggleParent === next.toggleParent
    && prev.setOpenSidebarMenuKey === next.setOpenSidebarMenuKey
    && prev.allowReselect === next.allowReselect
    && prev.onSessionSelected === next.onSessionSelected
    && prev.isSessionSearchOpen === next.isSessionSearchOpen
    && prev.sessionSearchQuery === next.sessionSearchQuery
    && prev.setSessionSearchQuery === next.setSessionSearchQuery
    && prev.setIsSessionSearchOpen === next.setIsSessionSearchOpen
    && prev.deleteSessionConfirm === next.deleteSessionConfirm
    && prev.setDeleteSessionConfirm === next.setDeleteSessionConfirm
    && prev.startFolderRename === next.startFolderRename
    && prev.setCopiedSessionId === next.setCopiedSessionId
    && prev.startSessionWorktreeMenuLoad === next.startSessionWorktreeMenuLoad
    && prev.setFolderRenameDraft === next.setFolderRenameDraft
    && prev.clearFolderRename === next.clearFolderRename
  );
};

function SessionGroupSectionBase(props: SessionGroupSectionProps): React.ReactNode {
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
    sessionBatchSize,
    collapsedGroups,
    hideDirectoryControls,
    showMoreGroupSessions,
    resetGroupSessionLimit,
    mobileVariant,
    alwaysShowActions,
    activeProjectId,
    setActiveProjectIdOnly,
    setSessionSwitcherOpen,
    openNewSessionDraft,
    pinnedSessionIds,
    sessionOrderIndex,
    notifyOnSubtasks,
    onToggleCollapsedGroup,
    dragHandleProps,
    compactBodyPadding = false,
    scrollContainerRef,
    expandedParents,
    editingId,
    openSidebarMenuKey,
    editTitle,
    copiedSessionId,
    folderRename,
    setFolderRenameDraft,
    clearFolderRename,
  } = props;
  const toggleFolderCollapse = useSessionFoldersStore((state) => state.toggleFolderCollapse);
  const renameFolder = useSessionFoldersStore((state) => state.renameFolder);
  const deleteFolder = useSessionFoldersStore((state) => state.deleteFolder);
  const addSessionToFolder = useSessionFoldersStore((state) => state.addSessionToFolder);
  const showDeletionDialog = useUIStore((state) => state.showDeletionDialog);
  const [deleteFolderConfirm, setDeleteFolderConfirm] = React.useState<DeleteFolderConfirm>(null);
  const compareSessionNodes = React.useCallback((a: SessionNode, b: SessionNode) => {
    const aIndex = sessionOrderIndex.get(a.session.id);
    const bIndex = sessionOrderIndex.get(b.session.id);
    if (aIndex !== undefined || bIndex !== undefined) {
      if (aIndex === undefined) return 1;
      if (bIndex === undefined) return -1;
      if (aIndex !== bIndex) return aIndex - bIndex;
    }
    return compareSessionsByLifecycleOrder(a.session, b.session, pinnedSessionIds, EMPTY_SESSION_ORDER_RANKS);
  }, [pinnedSessionIds, sessionOrderIndex]);

  const searchData = hasSessionSearchQuery ? groupSearchDataByGroup.get(group) : null;
  const isCollapsed = hasSessionSearchQuery ? false : collapsedGroups.has(groupKey);
  // PR state for the worktree sub-header (grouped display mode).
  const groupPrKey = React.useMemo(() => {
    if (group.isMain || group.isArchivedBucket || hideGroupLabel) return null;
    const directory = normalizePath(group.directory ?? null);
    const branch = group.branch?.trim();
    return directory && branch ? getGitHubPrStatusKey(directory, branch) : null;
  }, [group.branch, group.directory, group.isArchivedBucket, group.isMain, hideGroupLabel]);
  const groupPrSummary = usePrVisualSummary(groupPrKey);
  const groupPrColor = groupPrSummary ? `var(--pr-${groupPrSummary.visualState})` : undefined;
  const childStores = useChildStoreManager();
  const bootstrapDirectories = React.useMemo(() => {
    const directories = group.folderScopes?.map((scope) => normalizePath(scope.directory))
      ?? [normalizePath(group.directory ?? null)];
    return [...new Set(directories.filter((directory): directory is string => Boolean(directory)))];
  }, [group.directory, group.folderScopes]);
  React.useSyncExternalStore(
    React.useCallback(
      (notify) => bootstrapDirectories.length > 0 ? childStores.subscribeBootstrap(notify) : () => undefined,
      [bootstrapDirectories.length, childStores],
    ),
    React.useCallback(
      () => bootstrapDirectories.map((directory) => (
        `${directory}\u0000${childStores.getBootstrapState(directory) ?? ''}\u0000${childStores.getBootstrapFailure(directory) ?? ''}`
      )).join('\u0001'),
      [bootstrapDirectories, childStores],
    ),
    React.useCallback(() => '', []),
  );
  const bootstrapLoading = bootstrapDirectories.some((directory) => {
    const state = childStores.getBootstrapState(directory);
    return state === 'queued' || state === 'running';
  });
  const failedBootstrapDirectory = bootstrapDirectories.find(
    (directory) => childStores.getBootstrapState(directory) === 'failed',
  ) ?? null;
  const bootstrapFailure = failedBootstrapDirectory
    ? childStores.getBootstrapFailure(failedBootstrapDirectory)
    : undefined;
  const canGrantBootstrapAccess = bootstrapFailure === 'os-permission' && canRequestNativeDirectoryAccess();
  const [isRequestingBootstrapAccess, setIsRequestingBootstrapAccess] = React.useState(false);

  const retryFailedBootstrap = React.useCallback(() => {
    if (!failedBootstrapDirectory) return;
    childStores.requestBootstrap({
      directory: failedBootstrapDirectory,
      priority: isCollapsed ? 'visible' : 'expanded',
      reason: group.isMain ? 'project-expanded' : 'worktree-expanded',
      force: true,
    });
  }, [childStores, failedBootstrapDirectory, group.isMain, isCollapsed]);

  const grantFailedBootstrapAccess = React.useCallback(async () => {
    if (!failedBootstrapDirectory || !canGrantBootstrapAccess || isRequestingBootstrapAccess) return;
    setIsRequestingBootstrapAccess(true);
    try {
      const result = await requestDirectoryAccess(failedBootstrapDirectory);
      if (result.success) retryFailedBootstrap();
    } finally {
      setIsRequestingBootstrapAccess(false);
    }
  }, [canGrantBootstrapAccess, failedBootstrapDirectory, isRequestingBootstrapAccess, retryFailedBootstrap]);
  const maxVisible = sessionBatchSize ?? (hideDirectoryControls ? 10 : 5);
  const nonArchivedVisibleCount = Math.max(maxVisible, visibleSessionCount ?? maxVisible);
  const groupMatchesSearch = hasSessionSearchQuery ? searchData?.groupMatches === true : false;
  const shouldFilterGroupContents = hasSessionSearchQuery;
  const sourceGroupNodes = React.useMemo(
    () => [...(shouldFilterGroupContents ? (searchData?.filteredNodes ?? []) : group.sessions)]
      .sort(compareSessionNodes),
    [compareSessionNodes, group.sessions, searchData?.filteredNodes, shouldFilterGroupContents],
  );
  const folderScopeKey = group.folderScopeKey ?? normalizePath(group.directory ?? null);
  // Merged flat groups list every contributing scope; single-scope groups
  // (archived buckets, VS Code workspaces) fall back to folderScopeKey.
  const folderScopes = React.useMemo<FolderScope[]>(() => {
    if (group.folderScopes && group.folderScopes.length > 0) return group.folderScopes;
    return folderScopeKey ? [{ scopeKey: folderScopeKey, directory: group.directory ?? null }] : [];
  }, [folderScopeKey, group.directory, group.folderScopes]);
  // A group only needs folders and collapse state from its own scopes. The
  // shallow projection retains its reference for mutations elsewhere.
  const folderProjection = useSessionFoldersStore(useShallow(React.useCallback(
    (state) => folderScopes.map(({ scopeKey }) => state.foldersMap[scopeKey] ?? EMPTY_FOLDERS),
    [folderScopes],
  )));
  const scopeFolders = React.useMemo(() => folderScopes.flatMap(({ scopeKey, directory }, index) => {
    const folders = folderProjection[index] ?? EMPTY_FOLDERS;
    return folders.map((folder) => ({ folder, scopeKey, scopeDirectory: directory }));
  }), [folderProjection, folderScopes]);
  const collapsedFolderIds = useSessionFoldersStore(useShallow(React.useCallback(
    (state) => new Set(folderProjection.flatMap((folders) => folders
      .filter((folder) => state.collapsedFolderIds.has(folder.id))
      .map((folder) => folder.id))),
    [folderProjection],
  )));

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

  const allFoldersForGroupBase = React.useMemo(() => scopeFolders.map(({ folder, scopeKey, scopeDirectory }) => {
    const nodes = selectFolderRootNodes(folder.sessionIds, nodeBySessionId).sort(compareSessionNodes);
    return { folder, scopeKey, scopeDirectory, nodes };
  }), [scopeFolders, nodeBySessionId, compareSessionNodes]);

  const allFoldersForGroup = React.useMemo(() => {
    const visibleFolderIds = selectFolderIdsForProjection(
      allFoldersForGroupBase.map(({ folder, nodes }) => ({
        id: folder.id,
        name: folder.name,
        parentId: folder.parentId,
        nodeCount: nodes.length,
      })),
      {
        archivedBucket: group.isArchivedBucket === true,
        searchQuery: hasSessionSearchQuery ? normalizedSessionSearchQuery : '',
      },
    );
    return allFoldersForGroupBase.filter(({ folder }) => visibleFolderIds.has(folder.id));
  }, [allFoldersForGroupBase, group.isArchivedBucket, hasSessionSearchQuery, normalizedSessionSearchQuery]);

  const effectiveEditingId = editingId;
  const effectiveOpenMenuKey = openSidebarMenuKey;
  const effectiveExpandedParents = expandedParents;

  const sessionIdsInFolders = React.useMemo(() => new Set(allFoldersForGroup.flatMap((f) => f.folder.sessionIds)), [allFoldersForGroup]);
  const ungroupedSessions = React.useMemo(() => sourceGroupNodes.filter((node) => !sessionIdsInFolders.has(node.session.id)), [sourceGroupNodes, sessionIdsInFolders]);
  const rootFolders = React.useMemo(() => {
    const entryById = new Map(allFoldersForGroup.map((entry) => [entry.folder.id, entry]));
    return normalizeFolderRoots(allFoldersForGroup.map((entry) => entry.folder))
      .map((folder) => entryById.get(folder.id))
      .filter((entry): entry is (typeof allFoldersForGroup)[number] => Boolean(entry));
  }, [allFoldersForGroup]);
  const childFoldersByParentId = React.useMemo(() => {
    const map = new Map<string, typeof allFoldersForGroup>();
    allFoldersForGroup.forEach((entry) => {
      if (!entry.folder.parentId) return;
      const children = map.get(entry.folder.parentId) ?? [];
      children.push(entry);
      map.set(entry.folder.parentId, children);
    });
    return map;
  }, [allFoldersForGroup]);
  const activityNodesByFolderId = React.useMemo(() => {
    const foldersById = new Map(allFoldersForGroup.map((entry) => [entry.folder.id, entry] as const));
    const result = new Map<string, SessionNode[]>();
    const visit = (folderId: string, seen: Set<string>): SessionNode[] => {
      const cached = result.get(folderId);
      if (cached !== undefined) return cached;
      if (seen.has(folderId)) return [];
      seen.add(folderId);
      const entry = foldersById.get(folderId);
      const nodes = entry ? [...entry.nodes] : [];
      for (const child of childFoldersByParentId.get(folderId) ?? []) {
        nodes.push(...visit(child.folder.id, seen));
      }
      result.set(folderId, nodes);
      return nodes;
    };
    allFoldersForGroup.forEach(({ folder }) => visit(folder.id, new Set()));
    return result;
  }, [allFoldersForGroup, childFoldersByParentId]);

  // Precompute the per-row "subtree contains editing session" lookup once per
  // render. The previous design walked the
  // node tree inside SessionNodeItem.areEqual for every row, which is O(M^2)
  // across the whole sidebar. These sets let areEqual answer with a single
  // Set.has lookup, so the cost is O(M) once per SessionGroupSection render.
  const renderContextForGroup = 'project' as const;
  const subtreeContainsEditing = React.useMemo(() => {
    const set = new Set<string>();
    collectSubtreeContainingId(sourceGroupNodes, effectiveEditingId, set);
    allFoldersForGroup.forEach(({ nodes }) => {
      collectSubtreeContainingId(nodes, effectiveEditingId, set);
    });
    return set;
  }, [sourceGroupNodes, allFoldersForGroup, effectiveEditingId]);

  const menuOpenSessionId = React.useMemo(() => {
    if (!effectiveOpenMenuKey) return null;
    const fromSource = resolveMenuOpenSessionId(sourceGroupNodes, effectiveOpenMenuKey, renderContextForGroup, Boolean(group.isArchivedBucket));
    if (fromSource) return fromSource;
    for (const { nodes } of allFoldersForGroup) {
      const id = resolveMenuOpenSessionId(nodes, effectiveOpenMenuKey, renderContextForGroup, Boolean(group.isArchivedBucket));
      if (id) return id;
    }
    return null;
  }, [effectiveOpenMenuKey, sourceGroupNodes, allFoldersForGroup, group.isArchivedBucket]);

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
    subtreeContainsEditing,
    menuOpenSessionId,
    nodeStructureKey: resolveNodeStructureKey(child),
  }), [subtreeContainsEditing, menuOpenSessionId, resolveNodeStructureKey]);

  const totalSessions = ungroupedSessions.length;
  const visibleSessions = group.isArchivedBucket
    ? ungroupedSessions
    : hasSessionSearchQuery
      ? ungroupedSessions
      : ungroupedSessions.slice(0, nonArchivedVisibleCount);
  const remainingCount = totalSessions - visibleSessions.length;
  const canShowLess = !group.isArchivedBucket && !hasSessionSearchQuery && totalSessions > maxVisible && remainingCount === 0;

  // Virtualize archived buckets, which can grow into the thousands. Active
  // groups retain normal flow because their incremental Show more control and
  // the shared ancestor scroller cannot expose an unmounted virtual tail.
  // Hooks below MUST stay above the search-empty early-return so they fire in
  // the same order every render — rules-of-hooks.
  const shouldVirtualize = group.isArchivedBucket === true
    && !hasSessionSearchQuery
    && visibleSessions.length >= ARCHIVED_VIRTUALIZE_THRESHOLD;

  // Check if any parent node is expanded - expanded parents render their
  // children inline, making them much taller than the fixed estimate.
  // When expanded parents exist, increase bufferSize to cover the extra height.
  const bucketTag = group.isArchivedBucket ? 'archived' : 'active';
  const hasExpandedParent = shouldVirtualize && visibleSessions.some((node) => {
    if (node.children.length === 0) return false;
    const expansionKey = `project:${bucketTag}:${node.session.id}`;
    return effectiveExpandedParents.has(expansionKey);
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
    if (!globalThis.ResizeObserver) return;
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

  const showBranchSubtitle = !group.isMain && Boolean(group.branch);
  // SAFETY: null is the intentional no-color branch for a status line.
  const statusLine = group.branch && isBranchDifferentFromLabel(group.branch, group.label)
    ? { label: group.branch, color: null as string | null }
    : null;
  const groupActivityIndicator = isCollapsed
    ? <CollapsedSessionActivityIndicator nodes={sourceGroupNodes} includeUnreadSubtasks={notifyOnSubtasks} />
    : null;

  type FolderEntry = (typeof allFoldersForGroup)[number];

  const renderOneFolderItem = (entry: FolderEntry, displayName: string): React.ReactNode => {
    const { folder, scopeKey, scopeDirectory, nodes } = entry;
    const folderSessionsForDelete = folderSessionsForDeleteById.get(folder.id) ?? [];
    const isRenamingFolder = folderRename?.folderId === folder.id && folderRename?.scopeKey === scopeKey;

    const isFolderCollapsed = hasSessionSearchQuery ? false : collapsedFolderIds.has(folder.id);
    const item = (collapsedActivityState: ReturnType<typeof useCollapsedSessionActivityState>) => (
      <DroppableFolderWrapper key={folder.id} folderId={folder.id}>
        {(droppableRef, isDropTarget) => (
          <SessionFolderItem
            folder={folder}
            displayName={displayName}
            sessions={nodes}
            isCollapsed={isFolderCollapsed}
            collapsedActivityState={collapsedActivityState}
            onToggle={() => toggleFolderCollapse(folder.id)}
            onRename={(name) => {
              renameFolder(scopeKey, folder.id, name);
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
              if (!showDeletionDialog) {
                deleteFolder(scopeKey, folder.id);
                return;
              }
              const subFolderCount = allFoldersForGroup.filter(({ folder: f }) => f.parentId === folder.id).length;
              const sessionCount = nodes.length;
              setDeleteFolderConfirm({
                scopeKey,
                folderId: folder.id,
                folderName: folder.name,
                subFolderCount,
                sessionCount,
              });
            }}
            groupDirectory={scopeDirectory ?? group.directory}
            projectId={projectId}
            mobileVariant={mobileVariant}
            alwaysShowActions={alwaysShowActions}
            isRenaming={isRenamingFolder}
            renameDraft={isRenamingFolder ? folderRename?.draft : undefined}
            onRenameDraftChange={setFolderRenameDraft}
            onRenameSave={() => {
              const trimmed = folderRename?.draft.trim() ?? '';
              if (trimmed) {
                renameFolder(scopeKey, folder.id, trimmed);
              }
              clearFolderRename();
            }}
            onRenameCancel={clearFolderRename}
            droppableRef={droppableRef}
            isDropTarget={isDropTarget}
            depth={0}
            onNewSession={() => {
              if (projectId && projectId !== activeProjectId) setActiveProjectIdOnly(projectId);
              if (mobileVariant) setSessionSwitcherOpen(false);
               openNewSessionDraft({
                 selectedProjectId: projectId,
                 directoryOverride: scopeDirectory ?? group.directory,
                 targetFolderId: folder.id,
                 target: group.draftTarget,
               });
            }}
            hideActions={false}
            archivedBucket={group.isArchivedBucket === true}
          >
            {nodes.map((node) => <SessionTreeItem
              key={node.session.id}
              node={node}
              pinnedSessionIds={pinnedSessionIds}
              expandedParents={expandedParents}
              hasSessionSearchQuery={hasSessionSearchQuery}
              normalizedSessionSearchQuery={normalizedSessionSearchQuery}
              notifyOnSubtasks={notifyOnSubtasks}
              editingId={editingId}
               editTitle={editTitle}
               copiedSessionId={copiedSessionId}
              openSidebarMenuKey={openSidebarMenuKey}
              mobileVariant={mobileVariant}
              alwaysShowActions={alwaysShowActions}
              groupDirectory={scopeDirectory ?? group.directory}
              projectId={projectId}
              archivedBucket={group.isArchivedBucket === true}
              renderExtras={{ subtreeContainsEditing, menuOpenSessionId, nodeStructureKey: resolveNodeStructureKey(node), childRenderExtrasFor }}
              setEditingId={props.setEditingId}
              setEditTitle={props.setEditTitle}
               toggleParent={props.toggleParent}
               setOpenSidebarMenuKey={props.setOpenSidebarMenuKey}
               allowReselect={props.allowReselect}
               onSessionSelected={props.onSessionSelected}
               isSessionSearchOpen={props.isSessionSearchOpen}
               sessionSearchQuery={props.sessionSearchQuery}
               setSessionSearchQuery={props.setSessionSearchQuery}
               setIsSessionSearchOpen={props.setIsSessionSearchOpen}
               deleteSessionConfirm={props.deleteSessionConfirm}
              setDeleteSessionConfirm={props.setDeleteSessionConfirm}
              startFolderRename={props.startFolderRename}
              setCopiedSessionId={props.setCopiedSessionId}
              startSessionWorktreeMenuLoad={props.startSessionWorktreeMenuLoad}
             />)}
          </SessionFolderItem>
        )}
      </DroppableFolderWrapper>
    );
    if (!isFolderCollapsed) return item(null);
    return <CollapsedFolderActivity
      key={folder.id}
      nodes={activityNodesByFolderId.get(folder.id) ?? nodes}
      includeUnreadSubtasks={notifyOnSubtasks}
    >{item}</CollapsedFolderActivity>;
  };

  // Folders render flat: nested folders keep their data-model parent link but
  // display at the same level with a "Parent / Child" path label, so sessions
  // never gain extra indentation. Collapsing a folder hides its whole subtree.
  const renderFolderItems = () => {
    const childEntriesByParentId = new Map<string, FolderEntry[]>();
    for (const entry of allFoldersForGroup) {
      const parentId = entry.folder.parentId;
      if (!parentId) continue;
      const existing = childEntriesByParentId.get(parentId);
      if (existing) existing.push(entry);
      else childEntriesByParentId.set(parentId, [entry]);
    }
    const out: React.ReactNode[] = [];
    const visited = new Set<string>();
    const visit = (entry: FolderEntry, parentPath: string) => {
      if (visited.has(entry.folder.id)) return;
      visited.add(entry.folder.id);
      const displayName = parentPath ? `${parentPath} / ${entry.folder.name}` : entry.folder.name;
      out.push(renderOneFolderItem(entry, displayName));
      const isFolderCollapsed = !hasSessionSearchQuery && collapsedFolderIds.has(entry.folder.id);
      if (isFolderCollapsed) return;
      (childEntriesByParentId.get(entry.folder.id) ?? []).forEach((child) => visit(child, displayName));
    };
    rootFolders.forEach((entry) => visit(entry, ''));
    return out;
  };
  // Reserve room for the hover-revealed header actions (new draft + delete
  // worktree) so they never overlap the label / PR badge.
  const hasWorktreeDeleteAction = Boolean(!group.isMain && group.worktree);
  const groupHeaderRightPadding = alwaysShowActions
    ? (hasWorktreeDeleteAction ? 'pr-14' : 'pr-7')
    : (hasWorktreeDeleteAction
        ? 'pr-2 group-hover/gh:pr-14 group-focus-within/gh:pr-14'
        : 'pr-2 group-hover/gh:pr-7 group-focus-within/gh:pr-7');

  const bootstrapFailureNotice = failedBootstrapDirectory ? (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {bootstrapFailure === 'os-permission'
        ? t('sessions.sidebar.group.empty.permissionDenied')
        : t('sessions.sidebar.group.empty.loadFailed')}
      {canGrantBootstrapAccess ? (
        <Button
          variant="link"
          size="xs"
          className="h-auto p-0 typography-micro"
          disabled={isRequestingBootstrapAccess}
          onClick={() => void grantFailedBootstrapAccess()}
        >
          {t('sessions.sidebar.group.empty.grantAccess')}
        </Button>
      ) : null}
      <Button
        variant="link"
        size="xs"
        className="h-auto p-0 typography-micro"
        onClick={retryFailedBootstrap}
      >
        {t('sessions.sidebar.group.empty.retry')}
      </Button>
    </span>
  ) : null;

  const renderSessionNode = (node: SessionNode): React.ReactNode => <SessionTreeItem
    key={node.session.id}
    node={node}
    pinnedSessionIds={pinnedSessionIds}
    expandedParents={expandedParents}
    hasSessionSearchQuery={hasSessionSearchQuery}
    normalizedSessionSearchQuery={normalizedSessionSearchQuery}
    notifyOnSubtasks={notifyOnSubtasks}
    editingId={editingId}
     editTitle={editTitle}
     copiedSessionId={copiedSessionId}
    openSidebarMenuKey={openSidebarMenuKey}
    mobileVariant={mobileVariant}
    alwaysShowActions={alwaysShowActions}
    groupDirectory={group.directory}
    projectId={projectId}
    archivedBucket={group.isArchivedBucket === true}
    renderExtras={{ subtreeContainsEditing, menuOpenSessionId, nodeStructureKey: resolveNodeStructureKey(node), childRenderExtrasFor }}
    setEditingId={props.setEditingId}
    setEditTitle={props.setEditTitle}
     toggleParent={props.toggleParent}
     setOpenSidebarMenuKey={props.setOpenSidebarMenuKey}
     allowReselect={props.allowReselect}
     onSessionSelected={props.onSessionSelected}
     isSessionSearchOpen={props.isSessionSearchOpen}
     sessionSearchQuery={props.sessionSearchQuery}
     setSessionSearchQuery={props.setSessionSearchQuery}
     setIsSessionSearchOpen={props.setIsSessionSearchOpen}
     deleteSessionConfirm={props.deleteSessionConfirm}
     setDeleteSessionConfirm={props.setDeleteSessionConfirm}
     startFolderRename={props.startFolderRename}
     setCopiedSessionId={props.setCopiedSessionId}
     startSessionWorktreeMenuLoad={props.startSessionWorktreeMenuLoad}
   />;

  const body = (
    <SessionFolderDndScope
      scopeKey={folderScopes[0]?.scopeKey ?? folderScopeKey}
      hasFolders={allFoldersForGroup.length > 0}
      onSessionDroppedOnFolder={(sessionId, folderId) => {
        const targetEntry = allFoldersForGroup.find(({ folder }) => folder.id === folderId);
        if (!targetEntry) return;
        // Clear membership in other scopes first — the store only dedupes
        // within one scope, and a session must live in a single folder.
        const foldersStore = useSessionFoldersStore.getState();
        for (const { scopeKey } of folderScopes) {
          if (scopeKey === targetEntry.scopeKey) continue;
          if (foldersStore.getSessionFolderId(scopeKey, sessionId)) {
            foldersStore.removeSessionFromFolder(scopeKey, sessionId);
          }
        }
        addSessionToFolder(targetEntry.scopeKey, folderId, sessionId);
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
            visibleSessions.map(renderSessionNode)
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
                  {renderSessionNode(node)}
                </div>
              );
            })}
          </div>
          )}
        </div>
      ) : (
        visibleSessions.map(renderSessionNode)
      )}
      {totalSessions === 0 && allFoldersForGroup.length === 0 ? (
        // pl-[26px] lines the text up with the worktree sub-header label
        // (gutter + icon + gap).
        <div className="py-1 pl-[26px] text-left typography-micro text-muted-foreground">
          {group.isArchivedBucket
            ? t('sessions.sidebar.group.empty.noArchivedSessions')
            : bootstrapLoading
              ? (
                <span className="inline-flex items-center gap-1.5">
                  <Icon name="loader-4" className="size-3 animate-spin" />
                  {t('sessions.sidebar.group.empty.loadingSessions')}
                </span>
              )
              : bootstrapFailureNotice
                ? bootstrapFailureNotice
            : group.emptyMessage ?? t('sessions.sidebar.group.empty.noSessionsInWorkspace')}
        </div>
      ) : null}
      {totalSessions > 0 && bootstrapFailureNotice ? (
        <div className="py-1 pl-[26px] text-left typography-micro text-status-error">
          {bootstrapFailureNotice}
        </div>
      ) : null}
      {remainingCount > 0 ? (
        <button
          type="button"
          onClick={() => showMoreGroupSessions(groupKey, visibleSessions.length, sessionBatchSize ?? 7)}
          className="mt-0.5 flex items-center justify-start rounded-md pl-[26px] pr-1.5 py-0.5 text-left text-xs text-muted-foreground/70 leading-tight hover:text-foreground hover:underline"
        >
          {t('sessions.sidebar.group.showMore')}
        </button>
      ) : null}
      {canShowLess ? (
        <button
          type="button"
          onClick={() => resetGroupSessionLimit(groupKey)}
          className="mt-0.5 flex items-center justify-start rounded-md pl-[26px] pr-1.5 py-0.5 text-left text-xs text-muted-foreground/70 leading-tight hover:text-foreground hover:underline"
        >
          {t('sessions.sidebar.group.showFewer')}
        </button>
      ) : null}
    </SessionFolderDndScope>
  );

  // Rows own their left gutter (aligned with the zone-header text), so the
  // group body adds no extra indentation.
  void compactBodyPadding;
  // Folder nesting is legacy-only: existing sub-folders keep working (path
  // labels), but the UI no longer offers creating new ones.
  const groupBodyPaddingClass = 'pb-2';
  const folderDeleteDialog = <FolderDeleteConfirmDialog
    value={deleteFolderConfirm}
    setValue={setDeleteFolderConfirm}
    onConfirm={() => {
      const value = deleteFolderConfirm;
      if (!value) return;
      deleteFolder(value.scopeKey, value.folderId);
      setDeleteFolderConfirm(null);
    }}
  />;

  if (hideGroupLabel) {
    return <><div className="oc-group"><div className={cn('oc-group-body', groupBodyPaddingClass)}>{body}</div></div>{folderDeleteDialog}</>;
  }

  return (
    <><div className="oc-group">
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
            // pl-1.5 lines the branch icon up with the project-zone header
            // icon (container pl-2.5 + 6px = band pl-4 past its -ml-2.5).
            'min-w-0 flex flex-1 items-start gap-1 overflow-hidden pl-1.5 transition-[padding]',
            groupHeaderRightPadding,
          )}
          {...(dragHandleProps?.listeners ?? {})}
        >
          <div className="min-w-0 flex flex-1 flex-col justify-center gap-0.5 overflow-hidden">
            <p className="text-[14px] font-normal truncate text-foreground/92">
              {group.isArchivedBucket ? (
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
                  {groupActivityIndicator}
                </span>
              ) : (!group.isMain || group.worktree) ? (
                // Worktree sub-header in the flat visual language: slim
                // folder-style row with a PR-tinted branch icon and PR badge.
                <span className="flex w-full min-w-0 items-center gap-1.5">
                  <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    <Icon name="git-branch"
                      className={cn('h-3.5 w-3.5 shrink-0', !groupPrColor && 'text-muted-foreground', alwaysShowActions ? 'hidden' : 'group-hover/gh:hidden')}
                      style={groupPrColor ? { color: groupPrColor } : undefined}
                    />
                    <span className={cn(
                      'text-muted-foreground h-3.5 w-3.5 items-center justify-center',
                      alwaysShowActions ? 'inline-flex' : 'hidden group-hover/gh:inline-flex',
                    )}>
                      {isCollapsed ? <Icon name="arrow-right-s" className="h-3.5 w-3.5" /> : <Icon name="arrow-down-s" className="h-3.5 w-3.5" />}
                    </span>
                  </span>
                  <span className="min-w-0 truncate typography-ui-label font-semibold text-muted-foreground">
                    {renderHighlightedText(group.label, normalizedSessionSearchQuery)}
                  </span>
                  {groupActivityIndicator}
                  {groupPrSummary ? (
                    <span
                      className="ml-auto flex-shrink-0 text-[0.72rem] font-medium leading-none"
                      style={groupPrColor ? { color: groupPrColor } : undefined}
                    >
                      #{groupPrSummary.number}
                    </span>
                  ) : null}
                </span>
              ) : (
                <span className="inline-flex min-w-0 max-w-full items-center gap-1">
                  <span className="min-w-0 truncate">{renderHighlightedText(group.label, normalizedSessionSearchQuery)}</span>
                  {groupActivityIndicator}
                </span>
              )}
            </p>
            {showBranchSubtitle && statusLine ? (
              <span className="inline-flex min-w-0 items-center gap-1.5 leading-tight">
                {group.isArchivedBucket ? (
                  <Icon name="archive" className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                ) : (
                  <Icon name="git-branch" className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 truncate text-[11px] font-medium text-muted-foreground/80">
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
                    if (mobileVariant) setSessionSwitcherOpen(false);
                    openNewSessionDraft({ selectedProjectId: projectId, directoryOverride: group.directory });
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
    </div>{folderDeleteDialog}</>
  );
}

export const SessionGroupSection = React.memo(SessionGroupSectionBase, areGroupPropsEqual);
