import React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { SessionTreeItem, type SessionTreeItemProps } from '../sessions/SessionTreeItem';
import { SessionFolderItem } from '../../SessionFolderItem';
import { DroppableFolderWrapper, SessionFolderDndScope, type SessionFolderDropTarget } from '../folders/sessionFolderDnd';
import { FolderDeleteConfirmDialog, type DeleteFolderConfirmState } from '../shell/ConfirmDialogs';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useUIStore } from '@/stores/useUIStore';
import { sessionEvents } from '@/lib/sessionEvents';
import { formatDirectoryName, formatPathForDisplay } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { isArchivedFolderScope } from '@/lib/sessionFolderIdentity';
import { SortableProjectItem } from './sortableItems';
import { SidebarActivityHeaderPresentation, SidebarGroupHeaderPresentation } from './groupHeaderPresentation';
import type {
  SessionSearchActivityHeaderRow,
  SessionSearchEmptyRow,
  SessionSearchFolderRow,
  SessionSearchGroupHeaderRow,
  SessionSearchProjectHeaderRow,
  SessionSearchRow,
  SessionSearchRowModel,
  SessionSearchSessionRow,
} from './sessionSearchRowModel';
import type { SessionGroup, SessionNode } from '../types';
import { formatProjectLabel } from '../utils';
import {
  collectSubtreeContainingId,
  computeNodeStructureKey,
  resolveMenuOpenSessionId,
} from '../sessions/sessionNodeItemUtils';
import type { SessionNodeRenderExtras } from '../sessions/sessionNodeItemUtils';
import { useRegisterSessionRowOrder } from '../sessions/sessionRowOrder';

const ROW_ESTIMATE_PX = 32;
const EMPTY_SESSION_RENDER_EXTRAS: SessionNodeRenderExtras = {
  subtreeContainsEditing: new Set<string>(),
  menuOpenSessionId: null,
  nodeStructureKey: '',
};

const findSearchScrollElement = (content: HTMLElement | null): HTMLElement | null => {
  let ancestor = content?.parentElement ?? null;
  while (ancestor) {
    if (ancestor.classList.contains('overlay-scrollbar-container')) return ancestor;
    ancestor = ancestor.parentElement;
  }
  return null;
};

type SearchSessionProps = Pick<SessionGroupSectionPropsForSearch,
  | 'hasSessionSearchQuery'
  | 'normalizedSessionSearchQuery'
  | 'mobileVariant'
  | 'alwaysShowActions'
  | 'activeProjectId'
  | 'notifyOnSubtasks'
  | 'pinnedSessionIds'
  | 'expandedParents'
  | 'editingId'
  | 'editTitle'
  | 'copiedSessionId'
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
   | 'folderRename'
   | 'setFolderRenameDraft'
   | 'clearFolderRename'
   | 'onToggleCollapsedGroup'
 >;

// Keep this local projection type tied to the existing group props without
// making the scroller's orchestration types part of the search-row module's
// public contract.
type SessionGroupSectionPropsForSearch = {
  hasSessionSearchQuery: boolean;
  normalizedSessionSearchQuery: string;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  activeProjectId: string | null;
  notifyOnSubtasks: boolean;
  pinnedSessionIds: Set<string>;
  expandedParents: Set<string>;
  editingId: string | null;
  editTitle: string;
  copiedSessionId: string | null;
  setEditingId: SessionTreeItemProps['setEditingId'];
  setEditTitle: SessionTreeItemProps['setEditTitle'];
  toggleParent: SessionTreeItemProps['toggleParent'];
  setOpenSidebarMenuKey: SessionTreeItemProps['setOpenSidebarMenuKey'];
  allowReselect: SessionTreeItemProps['allowReselect'];
  onSessionSelected?: SessionTreeItemProps['onSessionSelected'];
  resetSessionSearch: SessionTreeItemProps['resetSessionSearch'];
  deleteSessionConfirm: SessionTreeItemProps['deleteSessionConfirm'];
  setDeleteSessionConfirm: SessionTreeItemProps['setDeleteSessionConfirm'];
  startFolderRename: SessionTreeItemProps['startFolderRename'];
  setCopiedSessionId: SessionTreeItemProps['setCopiedSessionId'];
  startSessionWorktreeMenuLoad: SessionTreeItemProps['startSessionWorktreeMenuLoad'];
  folderRename: { scopeKey: string; folderId: string; draft: string } | null;
  setFolderRenameDraft: (draft: string) => void;
  clearFolderRename: () => void;
  onToggleCollapsedGroup: (groupKey: string) => void;
};

export type SessionSearchRowsProps = {
  model: SessionSearchRowModel;
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  homeDirectory: string | null;
  hideDirectoryControls: boolean;
  isDesktopShellRuntime: boolean;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  singleProjectMode: boolean;
  projectPickerOptions: Array<{
    id: string;
    projectLabel: string;
    projectDescription: string;
    projectIcon?: string;
    projectColor?: string;
    projectIconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' };
    projectIconBackground?: string;
  }>;
  activeProjectId: string | null;
  projectRepoStatus: Map<string, boolean | null>;
  openSidebarMenuKey: string | null;
  setOpenSidebarMenuKey: (key: string | null) => void;
  sessionProps: SearchSessionProps;
  toggleProject: (id: string) => void;
  setActiveProjectIdOnly: (id: string) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
  openNewSessionDraft: (options?: { selectedProjectId?: string | null; directoryOverride?: string | null; targetFolderId?: string; target?: 'chat' | 'project' }) => void;
  openNewWorktreeDialog: () => void;
  openWorktreesPage: (id: string) => void;
  openProjectEditDialog: (id: string) => void;
  removeProject: (id: string) => void;
  setSingleProjectId: (id: string) => void;
  onNewChat: () => void;
  toggleActivitySection: (key: 'chats' | 'active-now') => void;
  stickyZoneHeaders: boolean;
  onRowsMounted?: () => void;
  renderProjectStatusIndicator?: (projectId: string, groups: SessionGroup[]) => React.ReactNode;
  projectHeaderSentinelRefs: React.MutableRefObject<Map<string, HTMLDivElement | null>>;
};

const getProjectLabel = (
  project: SessionSearchProjectHeaderRow['project'],
  homeDirectory: string | null,
): string => formatProjectLabel(project.label?.trim() || formatDirectoryName(project.normalizedPath, homeDirectory) || project.normalizedPath);

const SearchActivityHeader: React.FC<{
  row: SessionSearchActivityHeaderRow;
  collapsed: boolean;
  onToggle: () => void;
  onNewChat: () => void;
  alwaysShowActions: boolean;
  stickyZoneHeaders: boolean;
}> = ({ row, collapsed, onToggle, onNewChat, alwaysShowActions, stickyZoneHeaders }) => {
  const { t } = useI18n();
  const isChats = row.activityKey === 'chats';
  return (
    <SidebarActivityHeaderPresentation
      title={isChats ? t('sessions.sidebar.activity.chatsTitle') : t('sessions.sidebar.activity.recentTitle')}
      icon={isChats ? 'chat-4' : 'history'}
      isCollapsed={collapsed}
      onToggle={onToggle}
      showNewChat={row.showNewChat}
      onNewChat={onNewChat}
      alwaysShowActions={alwaysShowActions}
      isSticky={stickyZoneHeaders}
      className="-mx-2.5"
      activityStartKey={row.activityKey}
      isChats={isChats}
      toggleAriaLabel={t(isChats ? 'sessions.sidebar.activity.chatsTitle' : 'sessions.sidebar.activity.recentTitle')}
    />
  );
};

const SearchProjectHeader: React.FC<{
  row: SessionSearchProjectHeaderRow;
  props: SessionSearchRowsProps;
  statusIndicator: React.ReactNode;
}> = ({ row, props, statusIndicator }) => {
  const project = row.project;
  const isRepo = Boolean(props.projectRepoStatus.get(project.id));
  const projectLabel = getProjectLabel(project, props.homeDirectory);
  return (
    <SortableProjectItem
      id={project.id}
      disabled
      projectLabel={projectLabel}
      projectDescription={formatPathForDisplay(project.normalizedPath, props.homeDirectory)}
      projectDirectory={project.normalizedPath}
      projectIcon={project.icon}
      projectColor={project.color}
      projectIconImage={project.iconImage}
      projectIconBackground={project.iconBackground}
      isCollapsed={row.isCollapsed}
      isRepo={isRepo}
      isDesktopShell={props.isDesktopShellRuntime}
      hideDirectoryControls={props.hideDirectoryControls}
      mobileVariant={props.mobileVariant}
      alwaysShowActions={props.alwaysShowActions}
      openSidebarMenuKey={props.openSidebarMenuKey}
      setOpenSidebarMenuKey={props.setOpenSidebarMenuKey}
      statusIndicator={row.isCollapsed ? statusIndicator : null}
      projectPickerOptions={props.singleProjectMode ? props.projectPickerOptions : undefined}
      onProjectSelect={props.singleProjectMode ? props.setSingleProjectId : undefined}
      onToggle={() => props.toggleProject(project.id)}
      onNewSession={() => {
        if (project.id !== props.activeProjectId) props.setActiveProjectIdOnly(project.id);
        if (props.mobileVariant) props.setSessionSwitcherOpen(false);
        props.openNewSessionDraft({ selectedProjectId: project.id, directoryOverride: project.normalizedPath });
      }}
      onNewWorktreeSession={() => {
        if (project.id !== props.activeProjectId) props.setActiveProjectIdOnly(project.id);
        props.openNewWorktreeDialog();
      }}
      onManageWorktrees={() => props.openWorktreesPage(project.id)}
      onRenameStart={() => props.openProjectEditDialog(project.id)}
      onClose={() => props.removeProject(project.id)}
      sentinelRef={(element) => { props.projectHeaderSentinelRefs.current.set(project.id, element); }}
      showCreateButtons
    >
      {null}
    </SortableProjectItem>
  );
};

const SearchGroupHeader: React.FC<{
  row: SessionSearchGroupHeaderRow;
  props: SessionSearchRowsProps;
}> = ({ row, props }) => (
  <SidebarGroupHeaderPresentation
    group={row.group}
    labelQuery={props.sessionProps.normalizedSessionSearchQuery}
    isCollapsed={row.isCollapsed}
    onToggle={() => props.sessionProps.onToggleCollapsedGroup(row.groupKey)}
    alwaysShowActions={props.alwaysShowActions}
    collapsedActivityNodes={row.group.sessions}
    notifyOnSubtasks={props.sessionProps.notifyOnSubtasks}
    allGroupSessions={row.allGroupSessions}
    projectId={row.projectId}
    activeProjectId={props.activeProjectId}
    mobileVariant={props.mobileVariant}
    setActiveProjectIdOnly={props.setActiveProjectIdOnly}
    setSessionSwitcherOpen={props.setSessionSwitcherOpen}
    openNewSessionDraft={props.openNewSessionDraft}
  />
);

const SearchFolderRow: React.FC<{
  row: SessionSearchFolderRow;
  props: SessionSearchRowsProps;
}> = ({ row, props }) => {
  const toggleFolderCollapse = useSessionFoldersStore((state) => state.toggleFolderCollapse);
  const renameFolder = useSessionFoldersStore((state) => state.renameFolder);
  const deleteFolder = useSessionFoldersStore((state) => state.deleteFolder);
  const showDeletionDialog = useUIStore((state) => state.showDeletionDialog);
  const [deleteConfirm, setDeleteConfirm] = React.useState<DeleteFolderConfirmState>(null);
  const isRenaming = props.sessionProps.folderRename?.folderId === row.folder.id
    && props.sessionProps.folderRename.scopeKey === row.scopeKey;
  const ownerScopeAuthority = row.folderOwnerKey
    ? props.model.activeFolderScopesByOwner.get(row.folderOwnerKey)
    : undefined;
  const folderDropEnabled = !row.archivedBucket
    && !isArchivedFolderScope(row.scopeKey)
    && ownerScopeAuthority?.complete === true
    && ownerScopeAuthority.scopeKeys.includes(row.scopeKey);
  const handleDelete = React.useCallback(() => {
    if (row.archivedBucket) {
      sessionEvents.requestDelete({ sessions: [...row.deleteSessions], mode: 'session' });
      return;
    }
    if (!showDeletionDialog) {
      deleteFolder(row.scopeKey, row.folder.id);
      return;
    }
    setDeleteConfirm({
      scopeKey: row.scopeKey,
      folderId: row.folder.id,
      folderName: row.folder.name,
      subFolderCount: row.subFolderCount,
      sessionCount: row.nodes.length,
    });
  }, [deleteFolder, row, showDeletionDialog]);
  return (
    <>
      <DroppableFolderWrapper
        folderId={row.folder.id}
        scopeKey={row.scopeKey}
        ownerKey={row.folderOwnerKey}
        disabled={!folderDropEnabled}
      >
        {(droppableRef, isDropTarget) => (
          <SessionFolderItem
            folder={row.folder}
            displayName={row.displayName}
            sessions={row.nodes}
            isCollapsed={row.isCollapsed}
            renderBody={false}
            onToggle={() => toggleFolderCollapse(row.scopeKey, row.folder.id)}
            onRename={(name) => renameFolder(row.scopeKey, row.folder.id, name)}
            onDelete={handleDelete}
            groupDirectory={row.groupDirectory}
            projectId={row.projectId}
            mobileVariant={props.mobileVariant}
            alwaysShowActions={props.alwaysShowActions}
            isRenaming={isRenaming}
            renameDraft={isRenaming ? props.sessionProps.folderRename?.draft : undefined}
            onRenameDraftChange={props.sessionProps.setFolderRenameDraft}
            onRenameSave={() => {
              const trimmed = props.sessionProps.folderRename?.draft.trim() ?? '';
              if (trimmed) renameFolder(row.scopeKey, row.folder.id, trimmed);
              props.sessionProps.clearFolderRename();
            }}
            onRenameCancel={props.sessionProps.clearFolderRename}
            droppableRef={droppableRef}
            isDropTarget={isDropTarget}
            onNewSession={() => {
              if (row.projectId && row.projectId !== props.activeProjectId) props.setActiveProjectIdOnly(row.projectId);
              if (props.mobileVariant) props.setSessionSwitcherOpen(false);
              props.openNewSessionDraft({
                selectedProjectId: row.projectId,
                directoryOverride: row.groupDirectory,
                targetFolderId: row.folder.id,
                target: row.group.draftTarget,
              });
            }}
            hideActions={false}
            archivedBucket={row.archivedBucket}
          />
        )}
      </DroppableFolderWrapper>
      <FolderDeleteConfirmDialog
        value={deleteConfirm}
        setValue={setDeleteConfirm}
        onConfirm={() => {
          if (!deleteConfirm) return;
          deleteFolder(deleteConfirm.scopeKey, deleteConfirm.folderId);
          setDeleteConfirm(null);
        }}
      />
    </>
  );
};

const SearchSessionRow: React.FC<{
  row: SessionSearchSessionRow;
  props: SessionSearchRowsProps;
  renderExtras: SessionNodeRenderExtras;
  relativeTimeTick: number;
}> = ({ row, props, renderExtras, relativeTimeTick }) => (
  <SessionTreeItem
    node={row.node}
    depth={row.depth}
    pinnedSessionIds={props.sessionProps.pinnedSessionIds}
    expandedParents={props.sessionProps.expandedParents}
    hasSessionSearchQuery={props.sessionProps.hasSessionSearchQuery}
    normalizedSessionSearchQuery={props.sessionProps.normalizedSessionSearchQuery}
    notifyOnSubtasks={props.sessionProps.notifyOnSubtasks}
    editingId={props.sessionProps.editingId}
    editTitle={props.sessionProps.editTitle}
    copiedSessionId={props.sessionProps.copiedSessionId}
    openSidebarMenuKey={props.openSidebarMenuKey}
    mobileVariant={props.mobileVariant}
    alwaysShowActions={props.alwaysShowActions}
     groupDirectory={row.groupDirectory}
     projectId={row.projectId}
     folderOwnerKey={row.folderOwnerKey}
     selectionScopeKey={row.selectionScopeKey}
     archivedBucket={row.archivedBucket}
    secondaryMeta={row.secondaryMeta}
    renderContext={row.renderContext}
    rowKey={row.key}
    dragKey={row.key}
    renderChildren={false}
    renderExtras={row.renderContext === 'recent' ? { ...renderExtras, relativeTimeTick } : renderExtras}
    setEditingId={props.sessionProps.setEditingId}
    setEditTitle={props.sessionProps.setEditTitle}
    toggleParent={props.sessionProps.toggleParent}
    setOpenSidebarMenuKey={props.setOpenSidebarMenuKey}
    allowReselect={props.sessionProps.allowReselect}
    onSessionSelected={props.sessionProps.onSessionSelected}
    resetSessionSearch={props.sessionProps.resetSessionSearch}
    deleteSessionConfirm={props.sessionProps.deleteSessionConfirm}
    setDeleteSessionConfirm={props.sessionProps.setDeleteSessionConfirm}
    startFolderRename={props.sessionProps.startFolderRename}
    setCopiedSessionId={props.sessionProps.setCopiedSessionId}
    startSessionWorktreeMenuLoad={props.sessionProps.startSessionWorktreeMenuLoad}
  />
);

const SearchEmptyRow: React.FC<{ row: SessionSearchEmptyRow }> = ({ row }) => {
  const { t } = useI18n();
  return (
    <div className="py-1 pl-[26px] text-left typography-micro text-muted-foreground">
      {row.archivedBucket ? t('sessions.sidebar.group.empty.noArchivedSessions') : row.group.emptyMessage ?? t('sessions.sidebar.group.empty.noSessionsInWorkspace')}
    </div>
  );
};

const buildSearchRenderExtras = (
  rows: readonly SessionSearchRow[],
  editingId: string | null,
  openSidebarMenuKey: string | null,
): WeakMap<SessionNode, SessionNodeRenderExtras> => {
  const nodes: SessionNode[] = [];
  const seenNodes = new WeakSet<SessionNode>();
  rows.forEach((row) => {
    if (row.kind !== 'session' || seenNodes.has(row.node)) return;
    seenNodes.add(row.node);
    nodes.push(row.node);
  });
  const childIds = new Set<string>();
  const structureKeys = new WeakMap<SessionNode, string>();
  const visitStructure = (node: SessionNode): void => {
    if (structureKeys.has(node)) return;
    structureKeys.set(node, computeNodeStructureKey(node));
    node.children.forEach((child) => {
      childIds.add(child.session.id);
      visitStructure(child);
    });
  };
  nodes.forEach(visitStructure);
  const roots = nodes.filter((node) => !childIds.has(node.session.id));
  const subtreeContainsEditing = new Set<string>();
  collectSubtreeContainingId(roots, editingId, subtreeContainsEditing);
  let menuOpenSessionId: string | null = null;
  for (const row of rows) {
    if (row.kind !== 'session') continue;
    const candidate = resolveMenuOpenSessionId([row.node], openSidebarMenuKey, row.renderContext, row.archivedBucket);
    if (candidate) {
      menuOpenSessionId = candidate;
      break;
    }
  }
  const extrasByNode = new WeakMap<SessionNode, SessionNodeRenderExtras>();
  nodes.forEach((node) => {
    extrasByNode.set(node, {
      subtreeContainsEditing,
      menuOpenSessionId,
      nodeStructureKey: structureKeys.get(node) ?? '',
    });
  });
  return extrasByNode;
};

export const SessionSearchRows: React.FC<SessionSearchRowsProps> = (props) => {
  const { model, onRowsMounted, scrollContainerRef } = props;
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const [scrollElement, setScrollElement] = React.useState<HTMLElement | null>(null);
  const [relativeTimeTick, setRelativeTimeTick] = React.useState(0);
  const hasRecentRows = model.hasRecentRows;
  React.useLayoutEffect(() => {
    const content = contentRef.current;
    const threadedScrollElement = scrollContainerRef.current;
    const nextScrollElement = threadedScrollElement && (!content || threadedScrollElement.contains(content))
      ? threadedScrollElement
      : findSearchScrollElement(content);
    setScrollElement((current) => current === nextScrollElement ? current : nextScrollElement);
  }, [scrollContainerRef, scrollElement]);
  React.useLayoutEffect(() => {
    if (scrollElement) onRowsMounted?.();
  }, [onRowsMounted, scrollElement]);
  React.useEffect(() => {
    if (!hasRecentRows) return;
    const timer = window.setInterval(() => setRelativeTimeTick((value) => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, [hasRecentRows]);
  const renderExtras = React.useMemo(
    () => buildSearchRenderExtras(model.rows, props.sessionProps.editingId, props.openSidebarMenuKey),
    [model.rows, props.openSidebarMenuKey, props.sessionProps.editingId],
  );
  useRegisterSessionRowOrder(0, model.entries);
  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: model.rows.length,
    enabled: scrollElement !== null,
    getScrollElement: () => scrollElement,
    initialOffset: () => scrollElement?.scrollTop ?? 0,
    estimateSize: () => ROW_ESTIMATE_PX,
    overscan: 8,
    getItemKey: (index) => model.rows[index]?.key ?? index,
  });
  const visibleRows = virtualizer.getVirtualItems();
  const rowsToRender = scrollElement ? visibleRows : [];
  const folderRows = model.folderRows;

  const handleSessionDroppedOnFolder = React.useCallback((sessionId: string, target: SessionFolderDropTarget, sourceOwnerKey: string) => {
    if (sourceOwnerKey !== target.ownerKey) return;
    if (isArchivedFolderScope(target.scopeKey)) return;
    const ownerScopeAuthority = model.activeFolderScopesByOwner.get(sourceOwnerKey);
    if (ownerScopeAuthority?.complete !== true || !ownerScopeAuthority.scopeKeys.includes(target.scopeKey)) return;
    const targetRows = folderRows.filter((row) => (
      row.scopeKey === target.scopeKey
      && row.folder.id === target.folderId
      && row.folderOwnerKey === target.ownerKey
    ));
    if (targetRows.length !== 1) return;
    const targetRow = targetRows[0];
    if (!targetRow || targetRow.archivedBucket) return;
    const foldersStore = useSessionFoldersStore.getState();
    const currentTargetFolders = foldersStore.foldersMap[targetRow.scopeKey] ?? [];
    if (currentTargetFolders.filter((folder) => folder.id === targetRow.folder.id).length !== 1) return;
    for (const scopeKey of ownerScopeAuthority.scopeKeys) {
      if (scopeKey === target.scopeKey) continue;
      foldersStore.removeSessionFromFolder(scopeKey, sessionId);
    }
    foldersStore.addSessionToFolder(targetRow.scopeKey, targetRow.folder.id, sessionId);
  }, [folderRows, model.activeFolderScopesByOwner]);

  const renderRow = React.useCallback((row: SessionSearchRow): React.ReactNode => {
    switch (row.kind) {
      case 'activity-header':
        return (
          <SearchActivityHeader
            row={row}
            collapsed={row.isCollapsed}
            onToggle={() => props.toggleActivitySection(row.activityKey)}
            onNewChat={props.onNewChat}
            alwaysShowActions={props.alwaysShowActions}
            stickyZoneHeaders={props.stickyZoneHeaders}
          />
        );
      case 'project-header': {
        const section = model.projectSections.find((candidate) => candidate.project.id === row.project.id);
        return <SearchProjectHeader row={row} props={props} statusIndicator={section ? props.renderProjectStatusIndicator?.(row.project.id, section.groups) : null} />;
      }
      case 'group-header':
        return <SearchGroupHeader row={row} props={props} />;
      case 'folder':
        return <SearchFolderRow row={row} props={props} />;
      case 'session':
        return <SearchSessionRow row={row} props={props} renderExtras={renderExtras.get(row.node) ?? EMPTY_SESSION_RENDER_EXTRAS} relativeTimeTick={relativeTimeTick} />;
      case 'empty-group':
        return <SearchEmptyRow row={row} />;
    }
  }, [model.projectSections, props, relativeTimeTick, renderExtras]);

  const totalSize = scrollElement ? virtualizer.getTotalSize() : model.rows.length * ROW_ESTIMATE_PX;
  const content = (
    <div ref={contentRef} data-session-search-virtual-content style={{ height: totalSize, position: 'relative' }}>
      {rowsToRender.map((item) => {
        const row = model.rows[item.index];
        if (!row) return null;
        return (
          <div
            key={item.key}
            data-index={item.index}
            ref={scrollElement ? virtualizer.measureElement : undefined}
            className="[&_[data-session-row]]:my-px"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${item.start}px)`,
            }}
          >
            {renderRow(row)}
          </div>
        );
      })}
    </div>
  );

  return (
    <SessionFolderDndScope
      scopeKey="search"
      hasFolders={folderRows.length > 0}
      onSessionDroppedOnFolder={handleSessionDroppedOnFolder}
    >
      {content}
    </SessionFolderDndScope>
  );
};
