import React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useShallow } from 'zustand/react/shallow';
import type { Session } from '@opencode-ai/sdk/v2';

// Compact rows without nested subagents render around 24-32px; the
// virtualizer measures mounted rows and uses this as the initial hint.
const ROW_ESTIMATE_PX = 28;
const EMPTY_FOLDERS: readonly never[] = [];
import { Button } from '@/components/ui/button';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { sessionEvents } from '@/lib/sessionEvents';
import { useUIStore } from '@/stores/useUIStore';
import { SessionFolderItem } from '../../SessionFolderItem';
import type { SortableDragHandleProps } from './sortableItems';
import { DroppableFolderWrapper, SessionFolderDndScope } from '../folders/sessionFolderDnd';
import type { GroupSearchData, SessionGroup, SessionNode } from '../types';
import { normalizePath } from '../utils';
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
  selectSessionGroupScrollElement,
  selectSessionGroupVirtualizationMode,
} from '../sessions/sessionNodeItemUtils';
import {
  getSessionFolderIdentityKey,
  getSessionFolderOwnerKey,
  getSessionFolderScopes,
} from '../sessions/sessionFolderIdentity';
import { isArchivedFolderScope } from '@/lib/sessionFolderIdentity';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';

import { useI18n } from '@/lib/i18n';
import { useChildStoreManager } from '@/sync/sync-context';
import { canRequestNativeDirectoryAccess, requestDirectoryAccess } from '@/lib/desktop';
import { useCollapsedSessionActivityState } from '../sessions/collapsedActivityState';
import { SessionTreeItem, type SessionTreeItemProps } from '../sessions/SessionTreeItem';
import { FolderDeleteConfirmDialog } from '../shell/ConfirmDialogs';
import { SidebarGroupHeaderPresentation } from './groupHeaderPresentation';
import { useRegisterSessionRowOrder } from '../sessions/sessionRowOrder';
import {
  buildSessionGroupRowOrderEntries,
  buildSessionGroupRenderRowModel,
  getSessionNodeRowKeys,
  getSessionFolderRowContainerKey,
  type SessionGroupRenderRow,
} from '../sessions/sessionRowOrderUtils';

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
  /**
   * Base of this group's segment in the sidebar's logical row order. Callers
   * assign disjoint ranges in document order (Recent/Chats < project
   * sections) so selection can flatten every rendered list deterministically.
   */
  rowOrderBase: number;
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
   * render of a virtualized group.
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
  | 'resetSessionSearch'
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
    prev.rowOrderBase === next.rowOrderBase
    && prev.hasSessionSearchQuery === next.hasSessionSearchQuery
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
    && prev.resetSessionSearch === next.resetSessionSearch
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
    rowOrderBase,
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
        `${directory}\u0000${childStores.getBootstrapState(directory) ?? ''}\u0000${childStores.getBootstrapFailure(directory) ?? ''}\u0000${childStores.getInitializationState(directory) ?? ''}\u0000${childStores.getInitializationFailure(directory) ?? ''}`
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
    (directory) => childStores.getBootstrapState(directory) === 'failed' || childStores.getInitializationState(directory) === 'failed',
  ) ?? null;
  const sessionListFailed = failedBootstrapDirectory !== null && childStores.getBootstrapState(failedBootstrapDirectory) === 'failed';
  const bootstrapFailure = failedBootstrapDirectory
    ? sessionListFailed
      ? childStores.getBootstrapFailure(failedBootstrapDirectory)
      : childStores.getInitializationFailure(failedBootstrapDirectory)
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
  const folderScopes = React.useMemo(
    () => getSessionFolderScopes(group),
    [group],
  );
  const folderOwnerKey = getSessionFolderOwnerKey(projectId, group.directory);
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
    (state) => new Set(folderScopes.flatMap(({ scopeKey }, index) => {
      const folders = folderProjection[index] ?? EMPTY_FOLDERS;
      return folders
        .filter((folder) => state.collapsedFolderIds.has(getSessionFolderIdentityKey(scopeKey, folder.id)))
        .map((folder) => getSessionFolderIdentityKey(scopeKey, folder.id));
    })),
    [folderProjection, folderScopes],
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
    const visibleFolderKeys = selectFolderIdsForProjection(
      allFoldersForGroupBase.map(({ folder, scopeKey, nodes }) => ({
        id: folder.id,
        scopeKey,
        name: folder.name,
        parentId: folder.parentId,
        nodeCount: nodes.length,
      })),
      {
        archivedBucket: group.isArchivedBucket === true,
        searchQuery: hasSessionSearchQuery ? normalizedSessionSearchQuery : '',
      },
    );
    return allFoldersForGroupBase.filter(({ folder, scopeKey }) => (
      visibleFolderKeys.has(getSessionFolderIdentityKey(scopeKey, folder.id))
    ));
  }, [allFoldersForGroupBase, group.isArchivedBucket, hasSessionSearchQuery, normalizedSessionSearchQuery]);
  const folderEntryByKey = React.useMemo(() => new Map(allFoldersForGroup.map((entry) => [
    getSessionFolderIdentityKey(entry.scopeKey, entry.folder.id),
    entry,
  ] as const)), [allFoldersForGroup]);

  const effectiveEditingId = editingId;
  const effectiveOpenMenuKey = openSidebarMenuKey;
  const effectiveExpandedParents = expandedParents;

  const sessionIdsInFolders = React.useMemo(() => new Set(allFoldersForGroup.flatMap((f) => f.folder.sessionIds)), [allFoldersForGroup]);
  const ungroupedSessions = React.useMemo(() => sourceGroupNodes.filter((node) => !sessionIdsInFolders.has(node.session.id)), [sourceGroupNodes, sessionIdsInFolders]);
  const rootFolders = React.useMemo(() => {
    const entryByKey = new Map(allFoldersForGroup.map((entry) => [
      getSessionFolderIdentityKey(entry.scopeKey, entry.folder.id),
      entry,
    ]));
    return normalizeFolderRoots(allFoldersForGroup.map((entry) => ({ ...entry.folder, scopeKey: entry.scopeKey })))
      .map((folder) => entryByKey.get(getSessionFolderIdentityKey(folder.scopeKey ?? '', folder.id)))
      .filter((entry): entry is (typeof allFoldersForGroup)[number] => Boolean(entry));
  }, [allFoldersForGroup]);
  const childFoldersByParentId = React.useMemo(() => {
    const map = new Map<string, typeof allFoldersForGroup>();
    allFoldersForGroup.forEach((entry) => {
      if (!entry.folder.parentId) return;
      const parentKey = getSessionFolderIdentityKey(entry.scopeKey, entry.folder.parentId);
      const children = map.get(parentKey) ?? [];
      children.push(entry);
      map.set(parentKey, children);
    });
    return map;
  }, [allFoldersForGroup]);
  const activityNodesByFolderId = React.useMemo(() => {
    const foldersByKey = new Map(allFoldersForGroup.map((entry) => [
      getSessionFolderIdentityKey(entry.scopeKey, entry.folder.id),
      entry,
    ] as const));
    const result = new Map<string, SessionNode[]>();
    const visit = (folderKey: string, seen: Set<string>): SessionNode[] => {
      const cached = result.get(folderKey);
      if (cached !== undefined) return cached;
      if (seen.has(folderKey)) return [];
      seen.add(folderKey);
      const entry = foldersByKey.get(folderKey);
      const nodes = entry ? [...entry.nodes] : [];
      for (const child of childFoldersByParentId.get(folderKey) ?? []) {
        nodes.push(...visit(getSessionFolderIdentityKey(child.scopeKey, child.folder.id), seen));
      }
      result.set(folderKey, nodes);
      return nodes;
    };
    allFoldersForGroup.forEach((entry) => visit(getSessionFolderIdentityKey(entry.scopeKey, entry.folder.id), new Set()));
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
  // Stable identity matters for the row-order segment: the registration
  // effect re-runs on reference changes, and an unsliced new array on every
  // group render would rebuild the whole segment for no content change.
  const visibleSessions = React.useMemo(
    () => (group.isArchivedBucket || hasSessionSearchQuery
      ? ungroupedSessions
      : ungroupedSessions.slice(0, nonArchivedVisibleCount)),
    [group.isArchivedBucket, hasSessionSearchQuery, nonArchivedVisibleCount, ungroupedSessions],
  );
  const remainingCount = totalSessions - visibleSessions.length;
  const canShowLess = !group.isArchivedBucket && !hasSessionSearchQuery && totalSessions > maxVisible && remainingCount === 0;

  const archivedGroupRenderRowModel = React.useMemo(() => {
    if (!group.isArchivedBucket || hasSessionSearchQuery) {
      return { rows: [], entries: [] };
    }
    return buildSessionGroupRenderRowModel({
      groupKey,
      isCollapsed,
      hasSessionSearchQuery,
      collapsedFolderIds,
      expandedParents: effectiveExpandedParents,
      archivedBucket: true,
      projectId,
      groupDirectory: group.directory,
      selectionScopeKey: folderOwnerKey,
      rootFolders,
      childFoldersByParentId,
      visibleSessions,
    });
  }, [
    childFoldersByParentId,
    collapsedFolderIds,
    effectiveExpandedParents,
    folderOwnerKey,
    group.directory,
    group.isArchivedBucket,
    groupKey,
    hasSessionSearchQuery,
    isCollapsed,
    projectId,
    rootFolders,
    visibleSessions,
  ]);

  // Hooks below MUST stay above the search-empty early-return so they fire in
  // the same order every render — rules-of-hooks.
  // Large unsearched archived buckets virtualize one flat render-row stream
  // containing folder headers, folder bodies, nested folders, and ungrouped
  // sessions. Small lists and the non-search active Show more flow stay in
  // normal document order. Search results use the single global virtualizer in
  // SessionSearchRows rather than one virtualizer per group.
  const virtualizationMode = selectSessionGroupVirtualizationMode({
    isArchivedBucket: group.isArchivedBucket === true,
    // The existing mode helper's count slot now receives the complete body
    // model, including folder headers, folder sessions, and ungrouped rows.
    rootCount: archivedGroupRenderRowModel.rows.length,
  });
  const shouldVirtualize = !hasSessionSearchQuery && virtualizationMode === 'roots';

  const rowOrderEntries = React.useMemo(() => {
    // The archived virtual model is also the mounted row model, so retain its
    // established keys. Normal-flow rows use the canonical scoped folder key.
    if (group.isArchivedBucket && !hasSessionSearchQuery && shouldVirtualize) {
      return archivedGroupRenderRowModel.entries;
    }
    return buildSessionGroupRowOrderEntries({
      groupKey,
      isCollapsed,
      hasSessionSearchQuery,
      collapsedFolderIds,
      expandedParents: effectiveExpandedParents,
      archivedBucket: group.isArchivedBucket === true,
      projectId,
      groupDirectory: group.directory,
      selectionScopeKey: folderOwnerKey,
      rootFolders,
      childFoldersByParentId,
      visibleSessions,
    });
  }, [
    archivedGroupRenderRowModel.entries,
    childFoldersByParentId,
    collapsedFolderIds,
    effectiveExpandedParents,
    groupKey,
    group.directory,
    group.isArchivedBucket,
    hasSessionSearchQuery,
    isCollapsed,
    projectId,
    folderOwnerKey,
    rootFolders,
    shouldVirtualize,
    visibleSessions,
  ]);
  useRegisterSessionRowOrder(rowOrderBase, rowOrderEntries);

  const visibleSessionRowKeys = React.useMemo(
    () => getSessionNodeRowKeys(groupKey, visibleSessions),
    [groupKey, visibleSessions],
  );

  // Keep a wider window when an expanded parent is present. The group model
  // now gives each descendant its own virtual row, but this preserves the
  // existing expansion transition cushion for unusually tall row content.
  const bucketTag = group.isArchivedBucket ? 'archived' : 'active';
  const hasExpandedParent = virtualizationMode === 'roots' && archivedGroupRenderRowModel.rows.some((row) => {
    if (row.kind !== 'session' || row.node.children.length === 0) return false;
    const expansionKey = `project:${bucketTag}:${row.node.session.id}`;
    return effectiveExpandedParents.has(expansionKey);
  });

  const virtualContainerRef = React.useRef<HTMLDivElement | null>(null);
  const [virtualScrollEl, setVirtualScrollEl] = React.useState<HTMLElement | null>(null);
  // Offset of the virtual container from the scroll element's content origin.
  // virtua reads startMargin from Virtualizer options and uses it
  // to translate scrollTop into container-relative coordinates. Without this,
  // when the scroll element is an ancestor (the sidebar's ScrollableOverlay),
  // the virtualizer assumes the container starts at the top of the scroll
  // element and renders rows in the wrong subset / position.
  const [virtualScrollMargin, setVirtualScrollMargin] = React.useState(0);

  // Resolve the scrolling ancestor. When the parent has threaded a
  // `scrollContainerRef` (Layer 1.4), use it directly to skip the
  // `getComputedStyle` walk on every render of a virtualized group — the walk
  // is one of the more expensive operations in the hot path because it forces
  // a style recalc on every parent up the tree. Fall back to the legacy walk
  // only when the ref is missing.
  //
  // We also still re-run when the group flips between virtualized and
  // normal-flow rendering, and on a ResizeObserver-driven layout change of
  // the container, so a dep-gated effect that only fires when
  // `shouldVirtualize` flips would miss the eventual mount and leave the
  // scroll element null.
  const [, setLayoutVersion] = React.useState(0);
  React.useEffect(() => {
    if (!shouldVirtualize) return;
    const container = virtualContainerRef.current;
    if (!container) return;
    if (!globalThis.ResizeObserver) return;
    const ro = new ResizeObserver(() => setLayoutVersion((v) => v + 1));
    ro.observe(container);
    return () => ro.disconnect();
  }, [shouldVirtualize]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  React.useLayoutEffect(() => {
    if (!shouldVirtualize) {
      if (virtualScrollEl !== null) setVirtualScrollEl(null);
      if (virtualScrollMargin !== 0) setVirtualScrollMargin(0);
      return;
    }
    const container = virtualContainerRef.current;
    if (!container) {
      // Group body not mounted yet — we'll re-run on the render that mounts
      // it.
      return;
    }
    let scrollEl: HTMLElement | null = virtualScrollEl;
    const providedScrollEl = scrollContainerRef?.current ?? null;
    if (providedScrollEl && providedScrollEl.contains(container)) {
      scrollEl = providedScrollEl;
      if (scrollEl !== virtualScrollEl) {
        setVirtualScrollEl(scrollEl);
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
      if (scrollEl !== virtualScrollEl) {
        setVirtualScrollEl(scrollEl);
        return;
      }
    }
    if (!scrollEl) return;
    const offset = container.getBoundingClientRect().top
      - scrollEl.getBoundingClientRect().top
      + scrollEl.scrollTop;
    setVirtualScrollMargin((prev) => (Math.abs(prev - offset) < 1 ? prev : offset));
  });

  // The scroll element is an ANCESTOR of this section (the sidebar's
  // ScrollableOverlay), so scrollMargin translates its scrollTop into
  // container-relative coordinates — the tanstack equivalent of virtua's
  // startMargin this replaces.
  // Enable ONLY once a scroll element is known. The parent-threaded ref is
  // already populated after the first mount, so readiness is true on the same
  // commit that turns virtualization on; the locally resolved element from
  // the layout effect remains the fallback source (and wins once set). While
  // the virtualizer is disabled the core resets its cached scroll offset, so
  // the first enabled read takes initialOffset() from the LIVE scrollTop
  // below — making the core's attach-time scrollTo target the current position
  // (a visual no-op) instead of a stale 0 that reset the sidebar to the top.
  // The core only learns the offset from scroll events after that, so this
  // initial seeding is what makes the first render window correct too.
  const providedScrollElement = scrollContainerRef?.current ?? null;
  const effectiveScrollElement = selectSessionGroupScrollElement({
    providedScrollElement,
    resolvedScrollElement: virtualScrollEl,
  });
  const virtualizerReady = shouldVirtualize && effectiveScrollElement !== null;
  const sessionVirtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: archivedGroupRenderRowModel.rows.length,
    enabled: virtualizerReady,
    getScrollElement: () => effectiveScrollElement,
    initialOffset: () => effectiveScrollElement?.scrollTop ?? 0,
    estimateSize: () => ROW_ESTIMATE_PX,
    // Expanded parent subtrees add rows to the flat model; widen the window
    // when one is present because its rows can have unusually tall content.
    overscan: hasExpandedParent ? 20 : 8,
    scrollMargin: virtualScrollMargin,
    getItemKey: (index) => archivedGroupRenderRowModel.rows[index]?.key ?? index,
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
  // button. Memoize so the recursive walk only runs when the underlying source
  // group nodes change, not on every render.
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
    for (const { folder, scopeKey } of allFoldersForGroup) {
      if (!folder.parentId) continue;
      const parentKey = getSessionFolderIdentityKey(scopeKey, folder.parentId);
      const existing = childIdsByParentId.get(parentKey) ?? [];
      existing.push(getSessionFolderIdentityKey(scopeKey, folder.id));
      childIdsByParentId.set(parentKey, existing);
    }
    const visit = (targetFolderKey: string, seen: Set<string>): Session[] => {
      if (seen.has(targetFolderKey)) return [];
      seen.add(targetFolderKey);
      const directEntry = allFoldersForGroup.find(({ folder: candidate, scopeKey }) => (
        getSessionFolderIdentityKey(scopeKey, candidate.id) === targetFolderKey
      ));
      const collected: Session[] = directEntry ? collectGroupSessions(directEntry.nodes) : [];
      const childIds = childIdsByParentId.get(targetFolderKey) ?? [];
      for (const childId of childIds) {
        collected.push(...visit(childId, seen));
      }
      return collected;
    };
    for (const { folder, scopeKey } of allFoldersForGroup) {
      const folderKey = getSessionFolderIdentityKey(scopeKey, folder.id);
      result.set(folderKey, visit(folderKey, new Set()));
    }
    return result;
  }, [allFoldersForGroup, collectGroupSessions, group.isArchivedBucket]);

  if (hasSessionSearchQuery && !groupMatchesSearch && rootFolders.length === 0 && ungroupedSessions.length === 0) {
    return null;
  }

  type FolderEntry = (typeof allFoldersForGroup)[number];

  const renderFolderItem = (
    entry: FolderEntry,
    displayName: string,
    renderBody: boolean,
  ): React.ReactNode => {
    const { folder, scopeKey, scopeDirectory, nodes } = entry;
    const folderKey = getSessionFolderIdentityKey(scopeKey, folder.id);
    const rowKeys = renderBody
      ? getSessionNodeRowKeys(getSessionFolderRowContainerKey(groupKey, scopeKey, folder.id), nodes)
      : [];
    const folderSessionsForDelete = folderSessionsForDeleteById.get(folderKey) ?? [];
    const isRenamingFolder = folderRename?.folderId === folder.id && folderRename?.scopeKey === scopeKey;

    const isFolderCollapsed = hasSessionSearchQuery ? false : collapsedFolderIds.has(folderKey);
    const item = (collapsedActivityState: ReturnType<typeof useCollapsedSessionActivityState>) => (
      <DroppableFolderWrapper
        key={folderKey}
        folderId={folder.id}
        scopeKey={scopeKey}
        ownerKey={folderOwnerKey}
        disabled={group.isArchivedBucket === true}
      >
        {(droppableRef, isDropTarget) => (
          <SessionFolderItem
             folder={folder}
             displayName={displayName}
             sessions={nodes}
             isCollapsed={isFolderCollapsed}
             renderBody={renderBody}
             collapsedActivityState={collapsedActivityState}
             onToggle={() => toggleFolderCollapse(scopeKey, folder.id)}
            onRename={(name) => {
              renameFolder(scopeKey, folder.id, name);
            }}
            onDelete={() => {
              if (group.isArchivedBucket) {
                // Delete sessions in the folder
                // Archived membership is reconciled from authoritative session
                // ownership; this action only deletes the sessions in the folder.
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
               const subFolderCount = allFoldersForGroup.filter(({ folder: f, scopeKey: childScopeKey }) => (
                 childScopeKey === scopeKey && f.parentId === folder.id
               )).length;
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
              {renderBody ? nodes.map((node, index) => {
                const nodeRowKey = rowKeys[index] ?? node.session.id;
                return <SessionTreeItem
                key={nodeRowKey}
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
                folderOwnerKey={folderOwnerKey}
                selectionScopeKey={folderOwnerKey}
                archivedBucket={group.isArchivedBucket === true}
                rowKey={nodeRowKey}
                dragKey={nodeRowKey}
                renderExtras={{ subtreeContainsEditing, menuOpenSessionId, nodeStructureKey: resolveNodeStructureKey(node), childRenderExtrasFor }}
               setEditingId={props.setEditingId}
               setEditTitle={props.setEditTitle}
                toggleParent={props.toggleParent}
                setOpenSidebarMenuKey={props.setOpenSidebarMenuKey}
                allowReselect={props.allowReselect}
                onSessionSelected={props.onSessionSelected}
                resetSessionSearch={props.resetSessionSearch}
                deleteSessionConfirm={props.deleteSessionConfirm}
               setDeleteSessionConfirm={props.setDeleteSessionConfirm}
               startFolderRename={props.startFolderRename}
               setCopiedSessionId={props.setCopiedSessionId}
               startSessionWorktreeMenuLoad={props.startSessionWorktreeMenuLoad}
               />;
              }) : null}
           </SessionFolderItem>
         )}
       </DroppableFolderWrapper>
    );
    if (!isFolderCollapsed) return item(null);
    return <CollapsedFolderActivity
      key={folderKey}
      nodes={activityNodesByFolderId.get(folderKey) ?? nodes}
      includeUnreadSubtasks={notifyOnSubtasks}
      >{item}</CollapsedFolderActivity>;
  };

  const renderOneFolderItem = (entry: FolderEntry, displayName: string): React.ReactNode => (
    renderFolderItem(entry, displayName, true)
  );
  const renderFolderHeader = (entry: FolderEntry, displayName: string): React.ReactNode => (
    renderFolderItem(entry, displayName, false)
  );

  // Folders render flat: nested folders keep their data-model parent link but
  // display at the same level with a "Parent / Child" path label, so sessions
  // never gain extra indentation. Collapsing a folder hides its whole subtree.
  const renderFolderItems = () => {
    const childEntriesByParentId = new Map<string, FolderEntry[]>();
    for (const entry of allFoldersForGroup) {
      const parentId = entry.folder.parentId;
      if (!parentId) continue;
      const parentKey = getSessionFolderIdentityKey(entry.scopeKey, parentId);
      const existing = childEntriesByParentId.get(parentKey);
      if (existing) existing.push(entry);
      else childEntriesByParentId.set(parentKey, [entry]);
    }
    const out: React.ReactNode[] = [];
    const visited = new Set<string>();
    const visit = (entry: FolderEntry, parentPath: string) => {
      const folderKey = getSessionFolderIdentityKey(entry.scopeKey, entry.folder.id);
      if (visited.has(folderKey)) return;
      visited.add(folderKey);
      const displayName = parentPath ? `${parentPath} / ${entry.folder.name}` : entry.folder.name;
      out.push(renderOneFolderItem(entry, displayName));
      const isFolderCollapsed = !hasSessionSearchQuery
        && collapsedFolderIds.has(getSessionFolderIdentityKey(entry.scopeKey, entry.folder.id));
      if (isFolderCollapsed) return;
      (childEntriesByParentId.get(folderKey) ?? []).forEach((child) => visit(child, displayName));
    };
    rootFolders.forEach((entry) => visit(entry, ''));
    return out;
  };

  const bootstrapFailureNotice = failedBootstrapDirectory ? (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {bootstrapFailure === 'os-permission'
        ? t('sessions.sidebar.group.empty.permissionDenied')
        : sessionListFailed
          ? t('sessions.sidebar.group.empty.loadFailed')
          : t('sessions.sidebar.group.empty.initializationFailed')}
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

  type SessionRowRenderOptions = {
    depth?: number;
    groupDirectory?: string | null;
    dragKey?: string;
    renderChildren?: boolean;
  };

  const renderSessionRow = (
    node: SessionNode,
    rowKey: string,
    options: SessionRowRenderOptions = {},
  ): React.ReactNode => {
    const rowGroupDirectory = options.groupDirectory === undefined ? group.directory : options.groupDirectory;
    return <SessionTreeItem
      key={rowKey}
      node={node}
      depth={options.depth}
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
      groupDirectory={rowGroupDirectory}
      projectId={projectId}
      folderOwnerKey={folderOwnerKey}
      selectionScopeKey={folderOwnerKey}
      archivedBucket={group.isArchivedBucket === true}
      rowKey={rowKey}
       dragKey={options.dragKey ?? rowKey}
      renderChildren={options.renderChildren}
      renderExtras={{ subtreeContainsEditing, menuOpenSessionId, nodeStructureKey: resolveNodeStructureKey(node), childRenderExtrasFor }}
      setEditingId={props.setEditingId}
      setEditTitle={props.setEditTitle}
       toggleParent={props.toggleParent}
       setOpenSidebarMenuKey={props.setOpenSidebarMenuKey}
       allowReselect={props.allowReselect}
       onSessionSelected={props.onSessionSelected}
       resetSessionSearch={props.resetSessionSearch}
       deleteSessionConfirm={props.deleteSessionConfirm}
       setDeleteSessionConfirm={props.setDeleteSessionConfirm}
       startFolderRename={props.startFolderRename}
       setCopiedSessionId={props.setCopiedSessionId}
       startSessionWorktreeMenuLoad={props.startSessionWorktreeMenuLoad}
     />;
  };

  const renderSessionNode = (node: SessionNode, index: number): React.ReactNode => renderSessionRow(
    node,
    visibleSessionRowKeys[index] ?? node.session.id,
  );

  const renderVirtualGroupRow = (row: SessionGroupRenderRow): React.ReactNode => {
    if (row.kind === 'folder-header') {
      const entry = folderEntryByKey.get(getSessionFolderIdentityKey(row.entry.scopeKey, row.entry.folder.id));
      return entry ? renderFolderHeader(entry, row.displayName) : null;
    }
    if (row.kind === 'folder-empty') {
      return (
        <div className="pb-1">
          <div className="py-1 pl-1.5 text-left typography-micro text-muted-foreground/70">
            {t('sessions.sidebar.folderItem.emptyFolder')}
          </div>
        </div>
      );
    }
    return renderSessionRow(row.node, row.key, {
      depth: row.depth,
      groupDirectory: row.groupDirectory,
      dragKey: row.key,
      renderChildren: false,
    });
  };

  const body = (
    <SessionFolderDndScope
      scopeKey={folderScopes[0]?.scopeKey ?? folderScopeKey}
      ownerKey={folderOwnerKey}
      hasFolders={allFoldersForGroup.length > 0}
      onSessionDroppedOnFolder={(sessionId, target, sourceOwnerKey) => {
    if (group.isArchivedBucket || isArchivedFolderScope(target.scopeKey)) return;
        if (!folderOwnerKey || sourceOwnerKey !== folderOwnerKey || target.ownerKey !== folderOwnerKey) return;
        const targetEntries = allFoldersForGroup.filter(({ folder, scopeKey }) => (
          scopeKey === target.scopeKey && folder.id === target.folderId
        ));
        if (targetEntries.length !== 1) return;
         const targetEntry = targetEntries[0];
         if (!targetEntry) return;
         // Clear membership in other scopes first — the store only dedupes
         // within one scope, and a session must live in a single folder.
         const foldersStore = useSessionFoldersStore.getState();
         const currentTargetFolders = foldersStore.foldersMap[targetEntry.scopeKey] ?? EMPTY_FOLDERS;
         if (currentTargetFolders.filter((folder) => folder.id === targetEntry.folder.id).length !== 1) return;
         for (const { scopeKey } of folderScopes) {
          if (scopeKey === targetEntry.scopeKey) continue;
          if (foldersStore.getSessionFolderId(scopeKey, sessionId)) {
            foldersStore.removeSessionFromFolder(scopeKey, sessionId);
          }
        }
        addSessionToFolder(targetEntry.scopeKey, targetEntry.folder.id, sessionId);
      }}
    >
      {shouldVirtualize ? (
        <div ref={virtualContainerRef}>
          {!virtualizerReady ? (
            // No scroll element yet: keep the full model height while the
            // ancestor walk resolves the parent scroller, without mounting
            // folder bodies before the virtual window is available.
            <div style={{ height: archivedGroupRenderRowModel.rows.length * ROW_ESTIMATE_PX }} aria-hidden="true" />
          ) : (
            <div style={{ height: sessionVirtualizer.getTotalSize(), position: 'relative' }}>
              {/* Absolutely positioned rows (canonical tanstack layout): with
                  variable-height rows, flow-stacking can drift from the computed
                  total height until measurements settle and overlap the content
                  below the group. Per-item offsets cannot drift. item.start
                  includes scrollMargin (ancestor-scroll offset), so subtract it. */}
              {sessionVirtualizer.getVirtualItems().map((item) => {
                const row = archivedGroupRenderRowModel.rows[item.index];
                if (!row) return null;
                return (
                  <div
                    key={item.key}
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
                      transform: `translateY(${item.start - virtualScrollMargin}px)`,
                    }}
                  >
                    {renderVirtualGroupRow(row)}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <>
          {renderFolderItems()}
          {visibleSessions.map(renderSessionNode)}
        </>
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
      <SidebarGroupHeaderPresentation
        group={group}
        labelQuery={normalizedSessionSearchQuery}
        isCollapsed={isCollapsed}
        onToggle={() => onToggleCollapsedGroup(groupKey)}
        alwaysShowActions={alwaysShowActions}
        collapsedActivityNodes={sourceGroupNodes}
        notifyOnSubtasks={notifyOnSubtasks}
        allGroupSessions={allGroupSessions}
        projectId={projectId}
        activeProjectId={activeProjectId}
        mobileVariant={mobileVariant}
        setActiveProjectIdOnly={setActiveProjectIdOnly}
        setSessionSwitcherOpen={setSessionSwitcherOpen}
        openNewSessionDraft={openNewSessionDraft}
        dragHandleProps={dragHandleProps}
      />
      {!isCollapsed ? <div className={cn('oc-group-body', groupBodyPaddingClass)}>{body}</div> : null}
    </div>{folderDeleteDialog}</>
  );
}

export const SessionGroupSection = React.memo(SessionGroupSectionBase, areGroupPropsEqual);
