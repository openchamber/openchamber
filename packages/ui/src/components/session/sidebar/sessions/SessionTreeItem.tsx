import React from 'react';
import { SessionNodeItem } from './SessionNodeItem';
import type { SessionNodeItemProps } from './SessionNodeItem';
import type { SessionNode } from '../types';
import type { SessionSidebarRenderContext } from '../sessionSidebarRowModel';
import type { SessionNodeRenderExtras } from './sessionNodeItemUtils';
import { useSessionActions, type DeleteSessionConfirmState } from './useSessionActions';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useUIStore } from '@/stores/useUIStore';
import { SessionDeleteConfirmDialog } from '../shell/ConfirmDialogs';
import { streamPerfCount } from '@/stores/utils/streamDebug';
import { sameMultiRunIdentity } from '@/lib/multirun/identity';
import { normalizePath } from '../utils';

type Context = {
  groupDirectory?: string | null;
  projectId?: string | null;
  folderOwnerKey?: string | null;
  selectionScopeKey?: string | null;
  archivedBucket?: boolean;
  secondaryMeta?: { projectLabel?: string | null; branchLabel?: string | null } | null;
  renderContext?: SessionSidebarRenderContext;
  rowKey?: string;
  dragKey?: string;
};

type SessionTreeItemRenderProps = Context & Pick<SessionNodeItemProps,
  | 'expandedParents'
  | 'hasSessionSearchQuery'
  | 'normalizedSessionSearchQuery'
  | 'notifyOnSubtasks'
  | 'editingId'
  | 'editingRowKey'
  | 'editTitle'
  | 'copiedSessionId'
  | 'openSidebarMenuKey'
  | 'mobileVariant'
  | 'alwaysShowActions'
> & {
  node: SessionNode;
  pinnedSessionIds: Set<string>;
  depth?: number;
  renderExtras?: SessionNodeRenderExtras;
};

export type SessionTreeItemProps = SessionTreeItemRenderProps & Pick<SessionNodeItemProps,
  | 'setEditingId'
  | 'setEditingRowKey'
  | 'setEditTitle'
  | 'toggleParent'
  | 'setOpenSidebarMenuKey'
  | 'startSessionWorktreeMenuLoad'
  | 'onEditProject'
> & {
  allowReselect: boolean;
  onSessionSelected?: (sessionId: string) => void;
  resetSessionSearch: () => void;
  deleteSessionConfirm: DeleteSessionConfirmState;
  setDeleteSessionConfirm: (value: DeleteSessionConfirmState) => void;
  startFolderRename: (scopeKey: string, folder: { id: string; name: string }) => void;
  setCopiedSessionId: (sessionId: string | null) => void;
  renderChildren?: boolean;
};

const EMPTY_SUBTREE_CONTAINS_EDITING: Set<string> = new Set();

// This is the recursive ownership boundary. Structural parents pass identity
// and stable UI actions; the row itself remains the leaf subscriber for live UI state.
function SessionTreeItemComponent({
  node,
  depth = 0,
  groupDirectory,
  projectId,
  folderOwnerKey,
  selectionScopeKey,
  archivedBucket = false,
  secondaryMeta,
  renderContext = 'project',
  rowKey,
  dragKey,
  renderExtras,
  pinnedSessionIds,
  expandedParents,
  hasSessionSearchQuery,
  normalizedSessionSearchQuery,
  notifyOnSubtasks,
  editingId,
  editingRowKey,
  setEditingId,
  setEditingRowKey,
  editTitle,
  setEditTitle,
  toggleParent,
  openSidebarMenuKey,
  setOpenSidebarMenuKey,
  allowReselect,
  onSessionSelected,
  resetSessionSearch,
  deleteSessionConfirm,
  setDeleteSessionConfirm,
  startFolderRename,
  copiedSessionId,
  setCopiedSessionId,
  startSessionWorktreeMenuLoad,
  onEditProject,
  mobileVariant,
  alwaysShowActions,
  renderChildren = true,
}: SessionTreeItemProps): React.ReactNode {
  streamPerfCount('ui.sidebar_tree_item.render');
  const effectiveRowKey = rowKey ?? `${renderContext}:${archivedBucket ? 'archived' : 'active'}:${node.session.id}`;
  const createFolder = useSessionFoldersStore((state) => state.createFolder);
  const toggleFolderCollapse = useSessionFoldersStore((state) => state.toggleFolderCollapse);
  const showDeletionDialog = useUIStore((state) => state.showDeletionDialog);
  const setShowDeletionDialog = useUIStore((state) => state.setShowDeletionDialog);
  // Keyed by the descendant ids themselves, not by node identity: the sidebar
  // rebuilds a project's node tree whenever one of its session records
  // changes, and a fresh array here would give every row in that project a
  // new delete handler and force it to re-render.
  const descendantIdsKey = React.useMemo(() => {
    const ids: string[] = [];
    const visit = (current: SessionNode) => current.children.forEach((child) => {
      ids.push(child.session.id);
      visit(child);
    });
    visit(node);
    return ids.join('\n');
  }, [node]);
  const descendantIds = React.useMemo(
    () => (descendantIdsKey ? descendantIdsKey.split('\n') : []),
    [descendantIdsKey],
  );
  const createFolderAndStartRename = React.useCallback((scopeKey: string, parentId?: string | null) => {
    if (!scopeKey) return null;
    if (parentId && useSessionFoldersStore.getState().collapsedFolderIds.has(parentId)) toggleFolderCollapse(parentId);
    const folder = createFolder(scopeKey, 'New folder', parentId);
    startFolderRename(scopeKey, folder);
    return folder;
  }, [createFolder, startFolderRename, toggleFolderCollapse]);
  const sessionActions = useSessionActions({
    mobileVariant,
    allowReselect,
    onSessionSelected,
    resetSessionSearch,
    descendantIds,
    showDeletionDialog,
    setDeleteSessionConfirm,
    deleteSessionConfirm,
    editingId,
    setEditingId,
    setEditingRowKey,
    editingSessionId: node.session.id,
    editingOccurrenceKey: effectiveRowKey,
    editTitle,
    setEditTitle,
    copiedSessionId,
    setCopiedSessionId,
  });
  const childRenderExtrasFor = renderExtras?.childRenderExtrasFor;
  const childContext: Context = {
    groupDirectory: node.session.directory ?? groupDirectory,
    projectId,
    archivedBucket,
    renderContext,
  };
  return <>
    <SessionNodeItem
      expandedParents={expandedParents}
      hasSessionSearchQuery={hasSessionSearchQuery}
      normalizedSessionSearchQuery={normalizedSessionSearchQuery}
      notifyOnSubtasks={notifyOnSubtasks}
      editingId={editingId}
      editingRowKey={editingRowKey}
      setEditingId={setEditingId}
      setEditingRowKey={setEditingRowKey}
      editTitle={editTitle}
      setEditTitle={setEditTitle}
       handleSaveEdit={sessionActions.handleSaveEdit}
       handleCancelEdit={sessionActions.handleCancelEdit}
      toggleParent={toggleParent}
       handleSessionSelect={sessionActions.handleSessionSelect}
       handleSessionDoubleClick={sessionActions.handleSessionDoubleClick}
       handleShareSession={sessionActions.handleShareSession}
       copiedSessionId={copiedSessionId}
       handleCopyShareUrl={sessionActions.handleCopyShareUrl}
       handleCopySessionId={sessionActions.handleCopySessionId}
       handleUnshareSession={sessionActions.handleUnshareSession}
      openSidebarMenuKey={openSidebarMenuKey}
      setOpenSidebarMenuKey={setOpenSidebarMenuKey}
      createFolderAndStartRename={createFolderAndStartRename}
        handleDeleteSession={sessionActions.handleDeleteSession}
        handleRestoreSession={sessionActions.handleRestoreSession}
       startSessionWorktreeMenuLoad={startSessionWorktreeMenuLoad}
       onEditProject={onEditProject}
       mobileVariant={mobileVariant}
       alwaysShowActions={alwaysShowActions}
        pinnedSessionIds={pinnedSessionIds}
      node={node}
      depth={depth}
      groupDirectory={groupDirectory}
      projectId={projectId}
      folderOwnerKey={folderOwnerKey}
      selectionScopeKey={selectionScopeKey}
      archivedBucket={archivedBucket}
      secondaryMeta={secondaryMeta}
      renderContext={renderContext}
      rowKey={effectiveRowKey}
      dragKey={dragKey ?? rowKey ?? node.session.id}
      subtreeContainsEditing={renderExtras?.subtreeContainsEditing ?? EMPTY_SUBTREE_CONTAINS_EDITING}
      menuOpenSessionId={renderExtras?.menuOpenSessionId ?? null}
      nodeStructureKey={renderExtras?.nodeStructureKey ?? ''}
      relativeTimeTick={renderExtras?.relativeTimeTick}
    >
      {renderChildren ? node.children.map((child) => (
        <SessionTreeItem
          key={child.session.id}
           node={child}
           pinnedSessionIds={pinnedSessionIds}
          expandedParents={expandedParents}
          hasSessionSearchQuery={hasSessionSearchQuery}
          normalizedSessionSearchQuery={normalizedSessionSearchQuery}
          notifyOnSubtasks={notifyOnSubtasks}
          editingId={editingId}
          editingRowKey={editingRowKey}
          setEditingId={setEditingId}
          setEditingRowKey={setEditingRowKey}
           editTitle={editTitle}
           copiedSessionId={copiedSessionId}
          setEditTitle={setEditTitle}
           toggleParent={toggleParent}
           openSidebarMenuKey={openSidebarMenuKey}
           setOpenSidebarMenuKey={setOpenSidebarMenuKey}
           allowReselect={allowReselect}
           onSessionSelected={onSessionSelected}
           resetSessionSearch={resetSessionSearch}
           deleteSessionConfirm={deleteSessionConfirm}
           setDeleteSessionConfirm={setDeleteSessionConfirm}
            startFolderRename={startFolderRename}
            setCopiedSessionId={setCopiedSessionId}
            startSessionWorktreeMenuLoad={startSessionWorktreeMenuLoad}
           mobileVariant={mobileVariant}
           alwaysShowActions={alwaysShowActions}
           depth={depth + 1}
           folderOwnerKey={folderOwnerKey}
           selectionScopeKey={selectionScopeKey}
          {...childContext}
          renderExtras={childRenderExtrasFor?.(child)}
        />
      )) : null}
    </SessionNodeItem>
    {deleteSessionConfirm?.session.id === node.session.id ? <SessionDeleteConfirmDialog
      value={deleteSessionConfirm}
      setValue={setDeleteSessionConfirm}
      showDeletionDialog={showDeletionDialog}
      setShowDeletionDialog={setShowDeletionDialog}
      onConfirm={sessionActions.confirmDeleteSession}
    /> : null}
  </>;
}

const isSameSessionForRow = (prev: SessionNode, next: SessionNode): boolean => (
  prev.session.id === next.session.id
  && prev.session.title === next.session.title
  && prev.session.directory === next.session.directory
  && prev.session.parentID === next.session.parentID
  && prev.session.share?.url === next.session.share?.url
  && prev.session.time?.created === next.session.time?.created
  && prev.session.time?.updated === next.session.time?.updated
  && prev.session.time?.archived === next.session.time?.archived
  && sameMultiRunIdentity(prev.session, next.session)
  && normalizePath(prev.worktree?.path ?? null) === normalizePath(next.worktree?.path ?? null)
  && prev.worktree?.branch === next.worktree?.branch
  && prev.children.length === next.children.length
);

// The row list re-renders on every virtualizer frame while scrolling and on
// every model rebuild. The scroller spreads a shared props bag onto each row
// and builds a fresh `renderExtras` object per call, so a plain shallow
// comparison would never match. Compare only what this wrapper and its row
// actually read, by value where the model recreates objects.
const areSessionTreeItemPropsEqual = (prev: SessionTreeItemProps, next: SessionTreeItemProps): boolean => {
  if (prev.node !== next.node && !isSameSessionForRow(prev.node, next.node)) return false;
  if ((prev.renderExtras?.nodeStructureKey ?? '') !== (next.renderExtras?.nodeStructureKey ?? '')) return false;
  if ((prev.renderExtras?.menuOpenSessionId ?? null) !== (next.renderExtras?.menuOpenSessionId ?? null)) return false;
  if (prev.renderExtras?.relativeTimeTick !== next.renderExtras?.relativeTimeTick) return false;
  const id = next.node.session.id;
  if ((prev.renderExtras?.subtreeContainsEditing?.has(id) ?? false) !== (next.renderExtras?.subtreeContainsEditing?.has(id) ?? false)) return false;
  if ((prev.secondaryMeta?.projectLabel ?? null) !== (next.secondaryMeta?.projectLabel ?? null)) return false;
  if ((prev.secondaryMeta?.branchLabel ?? null) !== (next.secondaryMeta?.branchLabel ?? null)) return false;
  const scalarKeys = [
    'depth', 'groupDirectory', 'projectId', 'folderOwnerKey', 'selectionScopeKey', 'archivedBucket',
    'renderContext', 'rowKey', 'dragKey', 'renderChildren',
    'hasSessionSearchQuery', 'normalizedSessionSearchQuery', 'notifyOnSubtasks',
    'editingId', 'editingRowKey', 'editTitle', 'copiedSessionId', 'openSidebarMenuKey',
    'mobileVariant', 'alwaysShowActions', 'allowReselect',
    'pinnedSessionIds', 'expandedParents', 'deleteSessionConfirm',
    'setEditingId', 'setEditingRowKey', 'setEditTitle', 'toggleParent', 'setOpenSidebarMenuKey',
    'startSessionWorktreeMenuLoad', 'onEditProject', 'onSessionSelected', 'resetSessionSearch',
    'setDeleteSessionConfirm', 'startFolderRename', 'setCopiedSessionId',
  ] as const;
  for (const key of scalarKeys) {
    if (prev[key] !== next[key]) return false;
  }
  return true;
};

export const SessionTreeItem = React.memo(SessionTreeItemComponent, areSessionTreeItemPropsEqual);
