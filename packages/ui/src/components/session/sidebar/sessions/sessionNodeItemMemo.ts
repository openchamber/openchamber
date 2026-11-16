import type { Session } from '@/lib/opencode/model';
import { sameMultiRunIdentity } from '@/lib/multirun/identity';
import { streamPerfCount } from '@/stores/utils/streamDebug';
import type { SessionNode } from '../types';
import { normalizePath } from '../utils';
import { nodeContainsSessionId, nodeHasPinnedMembershipChange } from './sessionNodeItemUtils';
import type { SecondaryMeta, SessionNodeItemProps } from './sessionNodeItemProps';

const areNodeWorktreeRenderSemanticsEqual = (prev: SessionNode, next: SessionNode): boolean => (
  normalizePath(prev.worktree?.path ?? null) === normalizePath(next.worktree?.path ?? null)
  && prev.worktree?.branch === next.worktree?.branch
);

const getNodeSessionDirectory = (node: SessionNode): string | null => {
  return normalizePath(node.session.directory ?? null);
};

const isSecondaryMetaEqual = (prev?: SecondaryMeta | null, next?: SecondaryMeta | null): boolean => {
  return (prev?.projectLabel ?? null) === (next?.projectLabel ?? null)
    && (prev?.branchLabel ?? null) === (next?.branchLabel ?? null)
    && (prev?.inSpace ?? false) === (next?.inSpace ?? false);
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
  if (prev.ownsWork !== next.ownsWork) return 'ownsWork';
  if (prev.groupDirectory !== next.groupDirectory) return 'groupDirectory';
  if (prev.projectId !== next.projectId) return 'projectId';
  if (prev.ownerProjectId !== next.ownerProjectId) return 'ownerProjectId';
  if (prev.folderOwnerKey !== next.folderOwnerKey) return 'folderOwnerKey';
  if (prev.selectionScopeKey !== next.selectionScopeKey) return 'selectionScopeKey';
  if (prev.archivedBucket !== next.archivedBucket) return 'archivedBucket';
  if ((prev.renderContext ?? 'project') !== (next.renderContext ?? 'project')) return 'renderContext';
  if ((prev.detailed ?? false) !== (next.detailed ?? false)) return 'detailed';
  if ((prev.repeat ?? false) !== (next.repeat ?? false)) return 'repeat';
  if (prev.mobileVariant !== next.mobileVariant) return 'mobileVariant';
  if (prev.alwaysShowActions !== next.alwaysShowActions) return 'alwaysShowActions';
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
    && prev.setOpenSidebarMenuKey === next.setOpenSidebarMenuKey
    && prev.createFolderAndStartRename === next.createFolderAndStartRename
    && prev.handleDeleteSession === next.handleDeleteSession
    && prev.handleRestoreSession === next.handleRestoreSession
    && prev.startSessionWorktreeMenuLoad === next.startSessionWorktreeMenuLoad
    && prev.children === next.children;
  if (!callbacksEqual) return 'callbacks';
  return null;
};

export const areSessionNodeItemPropsEqual = (prev: SessionNodeItemProps, next: SessionNodeItemProps): boolean => {
  const changed = sessionNodeItemPropsChange(prev, next);
  if (changed === null) return true;
  streamPerfCount(`ui.sidebar_session_node.props_changed.${changed}`);
  return false;
};
