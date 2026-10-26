import React from 'react';
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Button } from '@/components/ui/button';
import { formatPathForDisplay } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { isVSCodeRuntime } from '@/lib/desktop';
import { sessionEvents } from '@/lib/sessionEvents';
import { CHAT_DRAFT_PROJECT_ID } from '@/lib/chatDirectories';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useUIStore } from '@/stores/useUIStore';
import { useChildStoreManager } from '@/sync/sync-context';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { ProjectSortOrder } from '@/stores/useSessionDisplayStore';
import { streamPerfCount } from '@/stores/utils/streamDebug';
import { Spinner } from '@/components/ui/spinner';
import { SessionSidebarFolderItem } from '../folders/SessionSidebarFolderItem';
import { SessionTreeItem } from '../sessions/SessionTreeItem';
import { RunSidebarRow } from '../sessions/RunSidebarRow';
import { computeNodeStructureKey, nodeContainsSessionId } from '../sessions/sessionNodeItemUtils';
import { DroppableFolderWrapper } from '../folders/sessionFolderDnd';
import { FolderDeleteConfirmDialog, type DeleteFolderConfirmState } from '../shell/ConfirmDialogs';
import type { SessionGroup } from '../types';
import { SessionSidebarRows } from '../SessionSidebarRows';
import { sessionTreeTextInset } from '../sessions/sessionTreeGeometry';
import { SessionSidebarActivityHeader } from '../sessionSidebarHeaderPresentation';
import { resolveSessionSidebarStickyHeader, type SessionSidebarRow, type SessionSidebarRowModel } from '../sessionSidebarRowModel';
import { SortableProjectItem } from './sortableItems';
import { WorktreeWorkRow } from '../works/WorktreeWorkRow';
import { SessionDraftRow } from '../works/SessionDraftRow';
import { isWorktreeWorkGroup } from '../works/sidebarWorks';
import { SessionGroupSection, type SessionGroupSectionProps } from './SessionGroupSection';
import type { ProjectSection } from './sessionProjectRender';
import { CrossfadeZoneHeader, CrossfadeZoneHeaders } from './CrossfadeZoneHeaders';
import { prepareSessionProjectAction } from './sessionProjectActionContext';
import { applyShowControl, getProjectLabel, grantGroupAccess, retryGroupStatus, toggleActivityZone } from './sessionProjectListActions';
import { countArchiveAllOutcome, selectArchiveAllSessionIds, withArchiveAllSubtrees } from './archiveAllSessions';
import { collectSessionSubtreeIds } from '../sessions/sessionSubtreeActions';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/components/ui';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { isSessionPinned } from '@/lib/sessionPins';
import { isSessionBusyNow } from '@/sync/session-actions';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { isSessionInWork } from '@/lib/sessionWorkMetadata';
import { useOpenProjectOnBoard } from '@/components/sourceBoard/openTrackerItem';
import { useProjectsInSidebarOrder } from '../list/useProjectsInSidebarOrder';

type SessionProjectScrollerState = Pick<SessionGroupSectionProps,
  | 'editingId'
  | 'openSidebarMenuKey'
  | 'setOpenSidebarMenuKey'
> & {
  visibleSessionCountByGroup: Map<string, number>;
  collapsedActivityKeys: Set<string>;
  setCollapsedActivityKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  visibleActivityCountByKey: Map<string, number>;
  setVisibleActivityCountByKey: React.Dispatch<React.SetStateAction<Map<string, number>>>;
};

type GroupProps = Pick<SessionGroupSectionProps,
  | 'hasSessionSearchQuery' | 'normalizedSessionSearchQuery' | 'groupSearchDataByGroup'
  | 'collapsedGroups' | 'hideDirectoryControls' | 'mobileVariant' | 'alwaysShowActions'
  | 'activeProjectId' | 'expandedParents' | 'editTitle'
  | 'editingRowKey'
  | 'folderRename' | 'setFolderRenameDraft' | 'clearFolderRename'
  | 'setEditingId' | 'setEditingRowKey' | 'setEditTitle' | 'toggleParent' | 'allowReselect'
  | 'onSessionSelected' | 'resetSessionSearch' | 'deleteSessionConfirm'
  | 'setDeleteSessionConfirm' | 'startFolderRename'
  | 'startSessionWorktreeMenuLoad'
> & { pinnedSessionIds: Set<string>; sessionOrderIndex: Map<string, number> };

type GroupActions = Pick<SessionGroupSectionProps,
  | 'showMoreGroupSessions' | 'resetGroupSessionLimit' | 'setActiveProjectIdOnly'
  | 'setSessionSwitcherOpen' | 'openNewSessionDraft' | 'onToggleCollapsedGroup'
>;

export type SessionProjectScrollerModel = {
  rowModel: SessionSidebarRowModel;
  sectionsForRender: ProjectSection[];
  projectSections: ProjectSection[];
  singleProjectMode: boolean;
  emptyState: React.ReactNode;
  searchEmptyState: React.ReactNode;
  projectRepoStatus: Map<string, boolean | null>;
  state: SessionProjectScrollerState;
  groupProps: GroupProps;
};

export type SessionProjectScrollerView = {
  homeDirectory: string | null;
  hasSessionSearchQuery: boolean;
  hideDirectoryControls: boolean;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  projectSortOrder: ProjectSortOrder;
};

export type SessionProjectScrollerActions = {
  group: GroupActions;
  toggleProject: (id: string) => void;
  setActiveProjectIdOnly: (id: string) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
  openNewSessionDraft: (options?: { selectedProjectId?: string | null; directoryOverride?: string | null; preserveDirectoryOverride?: boolean; targetFolderId?: string; target?: 'chat' | 'project' }) => void;
  openNewWorktreeDialog: () => void;
  openWorktreesPage: (id: string) => void;
  openProjectEditDialog: (id: string) => void;
  removeProject: (id: string) => void;
  reorderProjects: (fromIndex: number, toIndex: number) => void;
  renderProjectStatusIndicator?: (projectId: string, groups: SessionGroup[]) => React.ReactNode;
  setSingleProjectId: (id: string) => void;
};

/** What draws the list: the desktop's scroller, or the phone's own rows over the same model. */
export type SessionProjectListProps = { model: SessionProjectScrollerModel; view: SessionProjectScrollerView; actions: SessionProjectScrollerActions };

const FLAT_TEXT_INSET_PX = 10;

function SessionProjectScrollerComponent({ model, view, actions }: SessionProjectListProps): React.ReactNode {
  streamPerfCount('ui.sidebar_projects_list.render');
  const { t } = useI18n();
  const childStores = useChildStoreManager();
  const { files } = useRuntimeAPIs();
  const toggleFolderCollapse = useSessionFoldersStore((state) => state.toggleFolderCollapse);
  const renameFolder = useSessionFoldersStore((state) => state.renameFolder);
  const deleteFolder = useSessionFoldersStore((state) => state.deleteFolder);
  const addSessionToFolder = useSessionFoldersStore((state) => state.addSessionToFolder);
  const showDeletionDialog = useUIStore((state) => state.showDeletionDialog);
  // A project's isolated spaces page: while the feature's switch is on, and never in VS Code (decision 16).
  const spacesPageAvailable = useUIStore((state) => state.isolatedSpacesEnabled) && !isVSCodeRuntime();
  const openProjectOnBoard = useOpenProjectOnBoard();
  const [folderDeleteConfirm, setFolderDeleteConfirm] = React.useState<DeleteFolderConfirmState>(null);
  const [stickyIdentity, setStickyIdentity] = React.useState<string | null>(null);
  const [focusedRowKey, setFocusedRowKey] = React.useState<string | null>(null);
  const [scrollElement, setScrollElement] = React.useState<HTMLElement | null>(null);
  // Only project headers sort; a worktree is a work among the project's
  // works, ordered by activity like the rest.
  const [isProjectDragging, setProjectDragging] = React.useState(false);
  const scrollContainerRef = React.useRef<HTMLElement | null>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const setScrollContainer = React.useCallback((element: HTMLElement | null) => {
    scrollContainerRef.current = element;
    setScrollElement(element);
  }, []);

  const projectPickerProjects = React.useMemo(() => model.projectSections.map((section) => section.project), [model.projectSections]);
  const orderedPickerProjects = useProjectsInSidebarOrder(projectPickerProjects, model.singleProjectMode);
  const projectPickerOptions = React.useMemo(() => orderedPickerProjects.map((project) => ({
    id: project.id,
    projectLabel: getProjectLabel(project, view.homeDirectory),
    projectDescription: formatPathForDisplay(project.normalizedPath, view.homeDirectory),
    projectIcon: project.icon,
    projectColor: project.color,
    projectIconImage: project.iconImage,
    projectIconBackground: project.iconBackground,
  })), [orderedPickerProjects, view.homeDirectory]);

  const archiveAllConfirm = useConfirmDialog();
  const { confirm: confirmArchiveAll } = archiveAllConfirm;
  const requestArchiveAll = React.useCallback(async (projectLabel: string, groups: SessionGroup[]) => {
    const pinnedIds = useSessionPinnedStore.getState().ids;
    const targets = withArchiveAllSubtrees(
      selectArchiveAllSessionIds(groups, (session) =>
        isSessionPinned(pinnedIds, session.directory, session.id)
        || isSessionBusyNow(session.id)
        || isSessionInWork(session)),
      (id) => collectSessionSubtreeIds(id, [], false),
      isSessionBusyNow,
    );
    if (targets.length === 0) {
      toast.info(t('sessions.sidebar.project.archiveAll.nothing'));
      return;
    }
    const confirmed = await confirmArchiveAll({
      title: t('sessions.sidebar.project.archiveAll.title', { project: projectLabel }),
      message: targets.length === 1
        ? t('sessions.sidebar.project.archiveAll.descriptionSingle', { count: targets.length })
        : t('sessions.sidebar.project.archiveAll.descriptionPlural', { count: targets.length }),
      action: t('sessions.sidebar.bulkActions.archive'),
    });
    if (!confirmed) return;
    const { failedIds } = await useSessionUIStore.getState().archiveSessions(
      targets.flatMap(({ id, descendantIds }) => [id, ...descendantIds]),
    );
    const outcome = countArchiveAllOutcome(targets, failedIds);
    if (outcome.archived > 0) {
      toast.success(outcome.archived === 1
        ? t('sessions.sidebar.bulkActions.archivedSingle', { count: outcome.archived })
        : t('sessions.sidebar.bulkActions.archivedPlural', { count: outcome.archived }));
    }
    if (outcome.failed > 0) {
      toast.error(outcome.failed === 1
        ? t('sessions.sidebar.bulkActions.failedArchiveSingle', { count: outcome.failed })
        : t('sessions.sidebar.bulkActions.failedArchivePlural', { count: outcome.failed }));
    }
  }, [confirmArchiveAll, t]);

  const openProjectFolder = React.useCallback((projectPath: string) => {
    if (!files.revealPath) return;
    void files.revealPath(projectPath).catch(() => {
      toast.error(t('sidebarFilesTree.toast.revealFailed'));
    });
  }, [files, t]);

  const stickyDescriptorIndex = React.useMemo(() => model.rowModel.stickyHeaders.findIndex(
    (descriptor) => `${descriptor.kind}:${descriptor.id}` === stickyIdentity,
  ), [model.rowModel.stickyHeaders, stickyIdentity]);

  const pinnedRowIndexes = React.useMemo(() => {
    const indexes = new Set<number>();
    if (focusedRowKey) {
      const focusedIndex = model.rowModel.rowIndexByKey.get(focusedRowKey);
      if (focusedIndex !== undefined) indexes.add(focusedIndex);
    }
    for (let index = 0; index < model.rowModel.rows.length; index += 1) {
      const row = model.rowModel.rows[index];
      if (row?.kind !== 'session') continue;
      if (model.groupProps.editingRowKey === row.key
        || model.state.openSidebarMenuKey === `session-menu:${row.key}`
        || model.state.openSidebarMenuKey === `session-context:${row.key}`) indexes.add(index);
    }
    if (stickyDescriptorIndex >= 0) {
      const first = Math.max(0, stickyDescriptorIndex - 1);
      const last = Math.min(model.rowModel.stickyHeaders.length - 1, stickyDescriptorIndex + 1);
      for (let index = first; index <= last; index += 1) {
        const descriptor = model.rowModel.stickyHeaders[index];
        if (descriptor) indexes.add(descriptor.rowIndex);
      }
    }
    return indexes;
  }, [focusedRowKey, model.groupProps.editingRowKey, model.rowModel.rowIndexByKey, model.rowModel.rows, model.rowModel.stickyHeaders, model.state.openSidebarMenuKey, stickyDescriptorIndex]);

  const handleFirstVisibleIndexChange = React.useCallback((index: number) => {
    const descriptor = resolveSessionSidebarStickyHeader(model.rowModel.stickyHeaders, index);
    const nextIdentity = descriptor ? `${descriptor.kind}:${descriptor.id}` : null;
    setStickyIdentity((current) => current === nextIdentity ? current : nextIdentity);
  }, [model.rowModel.stickyHeaders]);

  const renderStatus = React.useCallback((row: Extract<SessionSidebarRow, { kind: 'status' }>) => {
    const retry = () => retryGroupStatus(row, childStores);
    const grant = () => grantGroupAccess(row, childStores);
    let label: string;
    switch (row.status.state) {
      case 'permission-denied':
        label = t('sessions.sidebar.group.empty.permissionDenied');
        break;
      case 'load-failed':
        label = t('sessions.sidebar.group.empty.loadFailed');
        break;
      case 'initialization-failed':
        label = t('sessions.sidebar.group.empty.initializationFailed');
        break;
      default:
        label = t('sessions.sidebar.group.empty.loadingSessions');
    }
    return <div className="relative py-1 text-start typography-micro text-muted-foreground" style={{ paddingInlineStart: row.flat ? FLAT_TEXT_INSET_PX : sessionTreeTextInset(row.depth ?? 0) }}>
      <span className="inline-flex flex-wrap items-center gap-1.5">
        {row.status.state === 'loading' ? <Spinner className="size-3" /> : null}
        {label}
        {row.status.canGrantAccess ? <Button variant="link" size="xs" className="h-auto p-0 typography-micro" onClick={() => void grant()}>{t('sessions.sidebar.group.empty.grantAccess')}</Button> : null}
        {row.status.state !== 'loading' ? <Button variant="link" size="xs" className="h-auto p-0 typography-micro" onClick={retry}>{t('sessions.sidebar.group.empty.retry')}</Button> : null}
      </span>
    </div>;
  }, [childStores, t]);

  const renderRow = React.useCallback((row: SessionSidebarRow): React.ReactNode => {
    if (row.kind === 'activity-header') {
      return <CrossfadeZoneHeader
        className="sticky top-0 z-20 bg-sidebar"
        data-sidebar-sticky-header="true"
      >
        <SessionSidebarActivityHeader
          activityKey={row.activityKey}
          collapsed={row.collapsed}
          forceExpanded={row.forceExpanded}
          alwaysShowActions={view.alwaysShowActions}
          onToggle={() => toggleActivityZone(row, { model, actions })}
          onNewChat={() => {
            useUIStore.getState().closeMainSurfaces();
            if (view.mobileVariant) actions.setSessionSwitcherOpen(false);
            actions.openNewSessionDraft({ selectedProjectId: CHAT_DRAFT_PROJECT_ID, directoryOverride: null });
          }}
        />
      </CrossfadeZoneHeader>;
    }
    if (row.kind === 'project-header') {
      const project = row.section.project;
      const label = getProjectLabel(project, view.homeDirectory);
      return <SortableProjectItem
        id={project.id}
        disabled={model.singleProjectMode || row.forceExpanded || model.state.editingId !== null || view.projectSortOrder !== 'manual'}
        projectLabel={label}
        projectDescription={formatPathForDisplay(project.normalizedPath, view.homeDirectory)}
        projectDirectory={project.normalizedPath}
        projectIcon={project.icon} projectColor={project.color} projectIconImage={project.iconImage} projectIconBackground={project.iconBackground}
        isCollapsed={row.collapsed} isRepo={Boolean(model.projectRepoStatus.get(project.id))}
        hideDirectoryControls={view.hideDirectoryControls}
        mobileVariant={view.mobileVariant} alwaysShowActions={view.alwaysShowActions}
        statusIndicator={row.collapsed ? actions.renderProjectStatusIndicator?.(project.id, row.section.groups) : null}
        openSidebarMenuKey={model.state.openSidebarMenuKey} setOpenSidebarMenuKey={model.state.setOpenSidebarMenuKey}
        projectPickerOptions={model.singleProjectMode ? projectPickerOptions : undefined}
        onProjectSelect={model.singleProjectMode ? actions.setSingleProjectId : undefined}
        onToggle={() => { if (!row.forceExpanded && !model.singleProjectMode) actions.toggleProject(project.id); }}
        onNewSession={() => {
          prepareSessionProjectAction({
            projectId: project.id,
            mobileVariant: view.mobileVariant,
            closeMobileSwitcher: true,
            setActiveProjectIdOnly: actions.setActiveProjectIdOnly,
            setSessionSwitcherOpen: actions.setSessionSwitcherOpen,
          });
          actions.openNewSessionDraft({ selectedProjectId: project.id, directoryOverride: project.normalizedPath });
        }}
        onNewWorktreeSession={() => {
          prepareSessionProjectAction({
            projectId: project.id,
            mobileVariant: view.mobileVariant,
            closeMobileSwitcher: false,
            setActiveProjectIdOnly: actions.setActiveProjectIdOnly,
            setSessionSwitcherOpen: actions.setSessionSwitcherOpen,
          });
          actions.openNewWorktreeDialog();
        }}
        onManageWorktrees={() => actions.openWorktreesPage(project.id)}
        onManageSpaces={spacesPageAvailable ? () => useUIStore.getState().setSpacesPageProjectId(project.id) : undefined}
        onOpenSourceBoard={openProjectOnBoard ? () => openProjectOnBoard(project.id) : undefined}
        onOpenFolder={project.normalizedPath && files.revealPath ? () => openProjectFolder(project.normalizedPath) : undefined}
        onRenameStart={() => actions.openProjectEditDialog(project.id)}
        onArchiveAll={() => void requestArchiveAll(label, row.section.groups)}
        onClose={() => actions.removeProject(project.id)}
        showCreateButtons
      />;
    }
    if (row.kind === 'group-header') {
      // A worktree is a work of its own and reads like a session row; spaces
      // and the archive keep their group header.
      return isWorktreeWorkGroup(row.group)
        ? <WorktreeWorkRow
          group={row.group} groupKey={row.groupKey} projectId={row.projectId} depth={row.depth} detailed={row.detailed} mixed={row.mixed}
          collapsed={row.collapsed} forceExpanded={row.forceExpanded} empty={row.empty}
          normalizedSessionSearchQuery={model.groupProps.normalizedSessionSearchQuery}
          alwaysShowActions={view.alwaysShowActions} mobileVariant={view.mobileVariant}
          onToggle={actions.group.onToggleCollapsedGroup}
          setSessionSwitcherOpen={actions.setSessionSwitcherOpen}
        />
        : <SessionGroupSection
          {...model.groupProps} {...actions.group}
          group={row.group} groupKey={row.groupKey} projectId={row.projectId} isEmpty={row.empty}
          visibleSessionCount={model.state.visibleSessionCountByGroup.get(row.groupKey)}
          editingId={model.state.editingId} openSidebarMenuKey={model.state.openSidebarMenuKey}
          setOpenSidebarMenuKey={model.state.setOpenSidebarMenuKey}
          renderBody={false}
        />;
    }
    if (row.kind === 'folder-header') {
      const renaming = model.groupProps.folderRename?.folderId === row.folder.id && model.groupProps.folderRename.scopeKey === row.scopeKey;
      return <DroppableFolderWrapper folderId={row.folder.id} scopeKey={row.scopeKey} ownerKey={row.ownerKey} disabled={!row.dropEnabled}>
        {(droppableRef, isDropTarget) => <SessionSidebarFolderItem
          activityNodes={row.activityNodes}
          folder={row.folder} displayName={row.displayName} sessions={row.nodes} depth={row.depth} canExpand={!row.empty}
          isCollapsed={row.collapsed} onToggle={row.forceExpanded ? () => undefined : () => toggleFolderCollapse(row.folder.id)}
          onRename={(name) => renameFolder(row.scopeKey, row.folder.id, name)}
          onDelete={() => {
            if (row.archived) {
              sessionEvents.requestDelete({ sessions: [...row.deleteSessions], mode: 'session' });
            } else if (!showDeletionDialog) {
              deleteFolder(row.scopeKey, row.folder.id);
            } else {
              setFolderDeleteConfirm({ scopeKey: row.scopeKey, folderId: row.folder.id, folderName: row.folder.name, subFolderCount: row.subFolderCount, sessionCount: row.nodes.length });
            }
          }}
          renderBody={false} groupDirectory={row.scopeDirectory ?? row.group.directory} projectId={row.projectId}
          mobileVariant={view.mobileVariant} alwaysShowActions={view.alwaysShowActions}
          isRenaming={renaming} renameDraft={renaming ? model.groupProps.folderRename?.draft : undefined}
          onRenameDraftChange={model.groupProps.setFolderRenameDraft}
          onRenameSave={() => { const draft = model.groupProps.folderRename?.draft.trim(); if (draft) renameFolder(row.scopeKey, row.folder.id, draft); model.groupProps.clearFolderRename(); }}
          onRenameCancel={model.groupProps.clearFolderRename} droppableRef={droppableRef} isDropTarget={isDropTarget}
          onNewSession={() => {
            prepareSessionProjectAction({
              projectId: row.projectId,
              mobileVariant: view.mobileVariant,
              closeMobileSwitcher: true,
              setActiveProjectIdOnly: actions.setActiveProjectIdOnly,
              setSessionSwitcherOpen: actions.setSessionSwitcherOpen,
            });
            actions.openNewSessionDraft({ selectedProjectId: row.projectId, directoryOverride: row.scopeDirectory ?? row.group.directory, targetFolderId: row.folder.id, target: row.group.draftTarget });
          }}
          archivedBucket={row.archived}
        />}
      </DroppableFolderWrapper>;
    }
    if (row.kind === 'session') {
      const subtreeContainsEditing = new Set<string>();
      if (nodeContainsSessionId(row.node, model.state.editingId)) subtreeContainsEditing.add(row.node.session.id);
      return <div onFocusCapture={() => setFocusedRowKey(row.key)} onBlurCapture={() => setFocusedRowKey((current) => current === row.key ? null : current)}>
        <SessionTreeItem
          {...model.groupProps}
          node={row.node} depth={row.depth} groupDirectory={row.groupDirectory} projectId={row.projectId}
          folderOwnerKey={row.ownerKey} selectionScopeKey={row.selectionScopeKey}
          archivedBucket={row.archived} renderContext={row.renderContext} detailed={row.detailed} rowKey={row.key} dragKey={row.key}
          secondaryMeta={row.secondaryMeta} renderChildren={false}
          editingId={model.state.editingId} openSidebarMenuKey={model.state.openSidebarMenuKey}
          setOpenSidebarMenuKey={model.state.setOpenSidebarMenuKey}
          renderExtras={{
            subtreeContainsEditing,
            menuOpenSessionId: model.state.openSidebarMenuKey === `session-menu:${row.key}` || model.state.openSidebarMenuKey === `session-context:${row.key}` ? row.node.session.id : null,
            nodeStructureKey: row.blockingBadgeSessionScopes
              ? `${computeNodeStructureKey(row.node)}:${JSON.stringify(row.blockingBadgeSessionScopes)}`
              : computeNodeStructureKey(row.node),
            blockingBadgeSessionScopes: row.blockingBadgeSessionScopes,
          }}
        />
      </div>;
    }
    if (row.kind === 'draft') {
      return <SessionDraftRow
        draft={row.draft} depth={row.depth} detailed={row.detailed} mixed={row.mixed}
        alwaysShowActions={view.alwaysShowActions} mobileVariant={view.mobileVariant}
        setSessionSwitcherOpen={actions.setSessionSwitcherOpen}
      />;
    }
    if (row.kind === 'run') {
      return <RunSidebarRow
        run={row.run} depth={row.depth} laneNodes={row.laneNodes} blockingSessionIds={row.blockingSessionIds}
        detailed={row.detailed} mixed={row.renderContext === 'timeline-mixed' || row.renderContext === 'mixed-compact'}
        projectId={row.projectId} projectLabel={row.projectLabel}
        expansionKey={row.expansionKey} expanded={row.expanded} forceExpanded={row.forceExpanded}
        alwaysShowActions={view.alwaysShowActions}
        toggleParent={model.groupProps.toggleParent}
      />;
    }
    // Show more and the archive's empty line align with the text of the rows
    // they close: 10px in under gutterless timeline-style rows; past the tree
    // level's chevron slot on tree rows.
    const rowTextInset = row.kind === 'show-control' && row.flat === true
      ? FLAT_TEXT_INSET_PX
      : sessionTreeTextInset(row.kind === 'show-control' || row.kind === 'empty' ? row.depth ?? 0 : 0);
    if (row.kind === 'show-control') {
      return <div><button type="button" className="mt-0.5 flex items-center justify-start rounded-md pe-1.5 py-0.5 text-start text-xs text-muted-foreground/70 leading-tight hover:text-foreground hover:underline" style={{ paddingInlineStart: rowTextInset }} onClick={() => applyShowControl(row, { model, actions })}>{t(row.control === 'more' ? 'sessions.sidebar.group.showMore' : 'sessions.sidebar.group.showFewer')}</button></div>;
    }
    if (row.kind === 'status') return renderStatus(row);
    if (row.emptyKind === 'sidebar') return model.emptyState;
    if (row.emptyKind === 'search') return model.searchEmptyState;
    return <div className="py-1 text-start typography-micro text-muted-foreground" style={{ paddingInlineStart: rowTextInset }}>
      {t('sessions.sidebar.group.empty.noArchivedSessions')}
    </div>;
  }, [actions, deleteFolder, files, model, openProjectFolder, openProjectOnBoard, projectPickerOptions, renameFolder, renderStatus, requestArchiveAll, showDeletionDialog, spacesPageAvailable, t, toggleFolderCollapse, view]);

  const structuralIds = React.useMemo(() => model.rowModel.rows.flatMap((row) => (
    row.kind === 'project-header' ? [row.section.project.id] : []
  )), [model.rowModel.rows]);
  const projectDragIds = React.useMemo(() => new Set(model.sectionsForRender.map((section) => section.project.id)), [model.sectionsForRender]);
  const zoneLayoutKey = React.useMemo(() => model.rowModel.stickyHeaders
    .map(({ kind, id, rowIndex }) => `${kind}:${id}:${rowIndex}`)
    .join('\u0001'), [model.rowModel.stickyHeaders]);

  return <div className="relative flex min-h-0 flex-1">
    <CrossfadeZoneHeaders
      suspended={isProjectDragging}
      layoutKey={zoneLayoutKey}
      scrollRef={scrollContainerRef}
    >
      <ScrollableOverlay
        // Sticky zone headers replace the top shadow.
        ref={setScrollContainer} useScrollShadow hideTopScrollShadow scrollShadowSize={40}
        outerClassName="flex-1 min-h-0" className="oc-sidebar-scroller pb-1 ps-2.5 pe-2 [overflow-anchor:none]"
      >
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={(event) => {
          // Session rows drag into folders and take no part in the header sort.
          setProjectDragging(projectDragIds.has(String(event.active.id)));
        }} onDragCancel={() => setProjectDragging(false)} onDragEnd={(event) => {
          setProjectDragging(false);
          if (!event.over) return;
          // SAFETY: session and folder payloads are created by the sidebar's draggable and droppable row components.
          const activeData = event.active.data.current as { type?: string; sessionId?: string; ownerKey?: string | null; archivedBucket?: boolean } | undefined;
          // SAFETY: session and folder payloads are created by the sidebar's draggable and droppable row components.
          const overData = event.over.data.current as { type?: string; folderId?: string; scopeKey?: string; ownerKey?: string | null } | undefined;
          if (activeData?.type === 'session' && activeData.sessionId && activeData.ownerKey && activeData.archivedBucket !== true && overData?.type === 'folder' && overData.folderId && overData.scopeKey && overData.ownerKey === activeData.ownerKey) {
            const dropTarget = model.rowModel.folderDropTargets.find((entry) => entry.folderId === overData.folderId && entry.scopeKey === overData.scopeKey && entry.ownerKey === activeData.ownerKey);
            const authority = model.rowModel.folderAuthorityByOwner.get(activeData.ownerKey);
            if (!dropTarget?.enabled || authority?.complete !== true) return;
            const store = useSessionFoldersStore.getState();
            for (const scopeKey of authority.scopeKeys) {
              if (scopeKey !== overData.scopeKey) store.removeSessionFromFolder(scopeKey, activeData.sessionId);
            }
            addSessionToFolder(overData.scopeKey, overData.folderId, activeData.sessionId);
            return;
          }
          if (view.hasSessionSearchQuery || model.state.editingId !== null || event.active.id === event.over.id) return;
          const activeId = String(event.active.id);
          const overId = String(event.over.id);
          const projectIds = model.sectionsForRender.map((section) => section.project.id);
          const projectFrom = projectIds.indexOf(activeId);
          const projectTo = projectIds.indexOf(overId);
          if (projectFrom >= 0 && projectTo >= 0 && view.projectSortOrder === 'manual') {
            actions.reorderProjects(projectFrom, projectTo);
          }
        }}>
          <SortableContext items={structuralIds} strategy={verticalListSortingStrategy}>
            <SessionSidebarRows model={model.rowModel} scrollElement={scrollElement} pinnedRowIndexes={pinnedRowIndexes} renderRow={renderRow} onFirstVisibleIndexChange={handleFirstVisibleIndexChange} />
          </SortableContext>
        </DndContext>
      </ScrollableOverlay>
    </CrossfadeZoneHeaders>
    <FolderDeleteConfirmDialog value={folderDeleteConfirm} setValue={setFolderDeleteConfirm} onConfirm={() => {
      if (!folderDeleteConfirm) return;
      deleteFolder(folderDeleteConfirm.scopeKey, folderDeleteConfirm.folderId);
      setFolderDeleteConfirm(null);
    }} />
    {archiveAllConfirm.dialog}
  </div>;
}

export const SessionProjectScroller = React.memo(SessionProjectScrollerComponent);
