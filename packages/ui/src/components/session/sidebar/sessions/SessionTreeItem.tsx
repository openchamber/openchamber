import React from 'react';
import { SessionNodeItem } from './SessionNodeItem';
import type { SessionNodeItemProps } from './SessionNodeItem';
import type { SessionNode } from '../types';
import type { SessionNodeRenderExtras } from './sessionNodeItemUtils';
import { useSessionActions, type DeleteSessionConfirmState } from './useSessionActions';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useUIStore } from '@/stores/useUIStore';
import { SessionDeleteConfirmDialog } from '../shell/ConfirmDialogs';

type Context = {
  groupDirectory?: string | null;
  projectId?: string | null;
  archivedBucket?: boolean;
  secondaryMeta?: { projectLabel?: string | null; branchLabel?: string | null } | null;
  renderContext?: 'project' | 'recent';
};

type SessionTreeItemRenderProps = Context & Pick<SessionNodeItemProps,
  | 'expandedParents'
  | 'hasSessionSearchQuery'
  | 'normalizedSessionSearchQuery'
  | 'notifyOnSubtasks'
  | 'editingId'
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
  | 'setEditTitle'
  | 'toggleParent'
  | 'setOpenSidebarMenuKey'
  | 'startSessionWorktreeMenuLoad'
> & {
  allowReselect: boolean;
  onSessionSelected?: (sessionId: string) => void;
  isSessionSearchOpen: boolean;
  sessionSearchQuery: string;
  setSessionSearchQuery: (value: string) => void;
  setIsSessionSearchOpen: (open: boolean) => void;
  deleteSessionConfirm: DeleteSessionConfirmState;
  setDeleteSessionConfirm: (value: DeleteSessionConfirmState) => void;
  startFolderRename: (scopeKey: string, folder: { id: string; name: string }) => void;
  setCopiedSessionId: (sessionId: string | null) => void;
};

const EMPTY_SUBTREE_CONTAINS_EDITING: Set<string> = new Set();

// This is the recursive ownership boundary. Structural parents pass identity
// and stable UI actions; the row itself remains the leaf subscriber for live UI state.
export function SessionTreeItem({
  node,
  depth = 0,
  groupDirectory,
  projectId,
  archivedBucket = false,
  secondaryMeta,
  renderContext = 'project',
  renderExtras,
  pinnedSessionIds,
  expandedParents,
  hasSessionSearchQuery,
  normalizedSessionSearchQuery,
  notifyOnSubtasks,
  editingId,
  setEditingId,
  editTitle,
  setEditTitle,
  toggleParent,
  openSidebarMenuKey,
  setOpenSidebarMenuKey,
  allowReselect,
  onSessionSelected,
  isSessionSearchOpen,
  sessionSearchQuery,
  setSessionSearchQuery,
  setIsSessionSearchOpen,
  deleteSessionConfirm,
  setDeleteSessionConfirm,
  startFolderRename,
  copiedSessionId,
  setCopiedSessionId,
  startSessionWorktreeMenuLoad,
  mobileVariant,
  alwaysShowActions,
}: SessionTreeItemProps): React.ReactNode {
  const createFolder = useSessionFoldersStore((state) => state.createFolder);
  const toggleFolderCollapse = useSessionFoldersStore((state) => state.toggleFolderCollapse);
  const showDeletionDialog = useUIStore((state) => state.showDeletionDialog);
  const setShowDeletionDialog = useUIStore((state) => state.setShowDeletionDialog);
  const descendantIds = React.useMemo(() => {
    const ids: string[] = [];
    const visit = (current: SessionNode) => current.children.forEach((child) => {
      ids.push(child.session.id);
      visit(child);
    });
    visit(node);
    return ids;
  }, [node]);
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
    isSessionSearchOpen,
    sessionSearchQuery,
    setSessionSearchQuery,
    setIsSessionSearchOpen,
    descendantIds,
    showDeletionDialog,
    setDeleteSessionConfirm,
    deleteSessionConfirm,
    editingId,
    setEditingId,
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
      setEditingId={setEditingId}
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
       mobileVariant={mobileVariant}
       alwaysShowActions={alwaysShowActions}
        pinnedSessionIds={pinnedSessionIds}
      node={node}
      depth={depth}
      groupDirectory={groupDirectory}
      projectId={projectId}
      archivedBucket={archivedBucket}
      secondaryMeta={secondaryMeta}
      renderContext={renderContext}
      subtreeContainsEditing={renderExtras?.subtreeContainsEditing ?? EMPTY_SUBTREE_CONTAINS_EDITING}
      menuOpenSessionId={renderExtras?.menuOpenSessionId ?? null}
      nodeStructureKey={renderExtras?.nodeStructureKey ?? ''}
      relativeTimeTick={renderExtras?.relativeTimeTick}
    >
      {node.children.map((child) => (
        <SessionTreeItem
          key={child.session.id}
           node={child}
           pinnedSessionIds={pinnedSessionIds}
          expandedParents={expandedParents}
          hasSessionSearchQuery={hasSessionSearchQuery}
          normalizedSessionSearchQuery={normalizedSessionSearchQuery}
          notifyOnSubtasks={notifyOnSubtasks}
          editingId={editingId}
          setEditingId={setEditingId}
           editTitle={editTitle}
           copiedSessionId={copiedSessionId}
          setEditTitle={setEditTitle}
           toggleParent={toggleParent}
           openSidebarMenuKey={openSidebarMenuKey}
           setOpenSidebarMenuKey={setOpenSidebarMenuKey}
           allowReselect={allowReselect}
           onSessionSelected={onSessionSelected}
           isSessionSearchOpen={isSessionSearchOpen}
           sessionSearchQuery={sessionSearchQuery}
           setSessionSearchQuery={setSessionSearchQuery}
           setIsSessionSearchOpen={setIsSessionSearchOpen}
           deleteSessionConfirm={deleteSessionConfirm}
           setDeleteSessionConfirm={setDeleteSessionConfirm}
            startFolderRename={startFolderRename}
            setCopiedSessionId={setCopiedSessionId}
            startSessionWorktreeMenuLoad={startSessionWorktreeMenuLoad}
           mobileVariant={mobileVariant}
           alwaysShowActions={alwaysShowActions}
           depth={depth + 1}
          {...childContext}
          renderExtras={childRenderExtrasFor?.(child)}
        />
      ))}
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
