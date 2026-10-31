import React from 'react';
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  type Active,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable';
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
import { DroppableFolderWrapper, SessionFolderOwnersProvider } from '../folders/sessionFolderDnd';
import { sessionFolderCollision } from '../folders/sessionFolderCollision';
import { applySessionFolderDrop, resolveCurrentSessionFolderDropSource, resolveCurrentSessionFolderDropTarget } from '../folders/sessionFolderDrop';
import { FolderDeleteConfirmDialog, type DeleteFolderConfirmState } from '../shell/ConfirmDialogs';
import type { SessionGroup } from '../types';
import { SessionSidebarRows, type SessionSidebarHeldRow } from '../SessionSidebarRows';
import { copyDragSource, keepRowInList, ROW_DRAG_AUTO_SCROLL, useRowDragSensors } from '../rowDrag';
import { RowDragPreview } from '../RowDragPreview';
import { setSidebarBlockDrag, useSidebarBlockDragStore } from '../list/blockDrag';
import { saveSidebarSections, useSidebarSectionsUiStore } from '../sections/sectionActions';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { SortableSidebarSection } from './SortableSidebarSection';
import { sectionDragId, sectionIdOfRow } from './sectionDrag';
import { sessionTreeTextInset } from '../sessions/sessionTreeGeometry';
import { SessionSidebarActivityHeader, SessionSidebarCaption } from '../sessionSidebarHeaderPresentation';
import { resolveSessionSidebarStickyHeader, type SessionSidebarRow, type SessionSidebarRowModel } from '../sessionSidebarRowModel';
import { SortableProjectItem } from './sortableItems';
import { WorktreeWorkRow } from '../works/WorktreeWorkRow';
import { SessionDraftRow } from '../works/SessionDraftRow';
import { isGroupWork } from '../works/sidebarWorks';
import { SessionGroupSection, type SessionGroupSectionProps } from './SessionGroupSection';
import type { ProjectSection } from './sessionProjectRender';
import { CrossfadeZoneHeader, CrossfadeZoneHeaders } from './CrossfadeZoneHeaders';
import { getPinnedZoneHeaderHeight } from './pinnedZoneHeader';
import { prepareSessionProjectAction } from './sessionProjectActionContext';
import { applyShowControl, getProjectLabel, grantGroupAccess, retryGroupStatus, toggleActivityZone, toggleProjectsCaption } from './sessionProjectListActions';
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

/** The sort group of the projects under the Projects caption, or under none. */
const PROJECTS_SORT_GROUP = 'projects';
const ROW_DRAG_MODIFIERS = [keepRowInList];
const ROW_DRAG_MEASURING = { droppable: { strategy: MeasuringStrategy.Always } };

type SidebarDragData = {
  type?: 'session' | 'project' | 'section';
  sessionId?: string;
  rowKey?: string;
  sortGroup?: string;
  sectionId?: string;
};

// SAFETY: every drag payload in the sidebar comes from its own rows:
// DraggableSessionRow, SortableProjectItem and SortableSidebarSection.
const readDragData = (active: Active): SidebarDragData => (active.data.current ?? {}) as SidebarDragData;


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
  // Project headers and section captions sort; a worktree is a work among
  // the project's works, ordered by activity like the rest, and session rows
  // drag into folders. While a header is held the list folds to the headers of
  // its kind (`blockDrag`), and its copy follows the pointer.
  const blockDrag = useSidebarBlockDragStore((state) => state.kind);
  const [dragSource, setDragCopy] = React.useState<Element | null>(null);
  // The held header stays where it is on screen as the list folds, and where
  // it was dropped as the list opens again.
  const heldRowRef = React.useRef<SessionSidebarHeldRow | null>(null);
  const foldFrameRef = React.useRef<number | null>(null);
  // A list that goes away mid-drag leaves the sidebar unfolded.
  React.useEffect(() => () => {
    if (foldFrameRef.current !== null) cancelAnimationFrame(foldFrameRef.current);
    setSidebarBlockDrag(null);
  }, []);
  const scrollContainerRef = React.useRef<HTMLElement | null>(null);
  const sensors = useRowDragSensors({ keyboard: true });
  const savedSections = useSessionDisplayStore((state) => state.sections);
  const editingSection = useSidebarSectionsUiStore((state) => state.draft !== null);
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

  // A project sorts among the projects under its caption: Projects, or the
  // group of projects it belongs to, whose own order a drag changes.
  const projectSortGroupById = React.useMemo(() => {
    const groups = new Map<string, string>();
    let caption = PROJECTS_SORT_GROUP;
    for (const row of model.rowModel.rows) {
      if (row.kind === 'caption') caption = row.caption;
      else if (row.kind === 'project-header') groups.set(row.section.project.id, caption);
    }
    return groups;
  }, [model.rowModel.rows]);
  const savedSectionIds = React.useMemo(() => new Set(savedSections.map((entry) => entry.id)), [savedSections]);
  // Sections sort outside a search and outside the editor, whose section being
  // made is not in the list yet.
  const sectionsSortable = !view.hasSessionSearchQuery && !editingSection && model.state.editingId === null && !model.singleProjectMode;
  const sortableSection = React.useCallback((row: SessionSidebarRow, header: React.ReactNode): React.ReactNode => {
    const sectionId = sectionIdOfRow(row);
    if (sectionId === null || !savedSectionIds.has(sectionId)) return header;
    return <SortableSidebarSection sectionId={sectionId} rowKey={row.key} disabled={!sectionsSortable}>{header}</SortableSidebarSection>;
  }, [savedSectionIds, sectionsSortable]);

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
      return sortableSection(row, <CrossfadeZoneHeader
        className="sticky top-0 z-20 bg-sidebar"
        data-sidebar-sticky-header="true"
      >
        <SessionSidebarActivityHeader
          activityKey={row.activityKey}
          label={row.label}
          preview={row.preview === true}
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
      </CrossfadeZoneHeader>);
    }
    if (row.kind === 'project-header') {
      const project = row.section.project;
      const label = getProjectLabel(project, view.homeDirectory);
      const sortGroup = projectSortGroupById.get(project.id) ?? PROJECTS_SORT_GROUP;
      return <SortableProjectItem
        id={project.id}
        sortGroup={sortGroup}
        // A group of projects keeps the order the user gives it, whatever the
        // projects' sort; Projects sorts by hand only when sorted manually.
        disabled={model.singleProjectMode || row.forceExpanded || model.state.editingId !== null
          || (sortGroup === PROJECTS_SORT_GROUP && view.projectSortOrder !== 'manual')}
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
      // A worktree or a space is a work of its own and reads like a session
      // row; the archive keeps its group header.
      return isGroupWork(row.group)
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
          node={row.node} depth={row.depth} ownsWork={row.ownsWork} groupDirectory={row.groupDirectory} projectId={row.projectId}
          ownerProjectId={row.ownerProjectId}
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
      // Small and short, so it reads as a control under the list, not a row of it.
      const control = (kind: 'more' | 'fewer') => (
        <button type="button" className="rounded-md py-0.5 typography-micro text-muted-foreground leading-tight hover:text-foreground hover:underline" onClick={() => applyShowControl(row, kind, { model, actions })}>
          {t(kind === 'more' ? 'sessions.sidebar.group.showMore' : 'sessions.sidebar.group.showFewer')}
        </button>
      );
      return (
        <div className="mt-0.5 flex items-center gap-1.5 pe-1.5" style={{ paddingInlineStart: rowTextInset }}>
          {row.more ? control('more') : null}
          {row.more && row.fewer ? <span aria-hidden="true" className="typography-micro text-muted-foreground/50">·</span> : null}
          {row.fewer ? control('fewer') : null}
        </div>
      );
    }
    if (row.kind === 'status') return renderStatus(row);
    if (row.kind === 'caption') {
      return sortableSection(row, <SessionSidebarCaption
        label={row.label}
        preview={row.preview === true}
        collapsed={row.collapsed}
        forceExpanded={row.forceExpanded}
        alwaysShowActions={view.alwaysShowActions}
        onToggle={() => toggleProjectsCaption(row, { model })}
      />);
    }
    if (row.emptyKind === 'sidebar') return model.emptyState;
    if (row.emptyKind === 'search') return model.searchEmptyState;
    return <div className="py-1 text-start typography-micro text-muted-foreground" style={{ paddingInlineStart: rowTextInset }}>
      {row.emptyKind === 'section' ? t('sessions.sidebar.sections.empty') : t('sessions.sidebar.group.empty.noArchivedSessions')}
    </div>;
  }, [actions, deleteFolder, files, model, openProjectFolder, openProjectOnBoard, projectPickerOptions, projectSortGroupById, renameFolder, renderStatus, requestArchiveAll, showDeletionDialog, sortableSection, spacesPageAvailable, t, toggleFolderCollapse, view]);

  // Every sortable header while nothing is held; while one is, only those of
  // its kind, so the others stay put.
  const sortableIds = React.useMemo(() => {
    const projects: string[] = [];
    const sections: string[] = [];
    for (const row of model.rowModel.rows) {
      if (row.kind === 'project-header') projects.push(row.section.project.id);
      const sectionId = sectionIdOfRow(row);
      if (sectionId !== null && savedSectionIds.has(sectionId)) sections.push(sectionDragId(sectionId));
    }
    return blockDrag === 'project' ? projects : blockDrag === 'section' ? sections : [...sections, ...projects];
  }, [blockDrag, model.rowModel.rows, savedSectionIds]);
  const folderDropOwnerKeys = React.useMemo(() => model.rowModel.folderDropTargets
    .flatMap((target) => (target.enabled ? [target.ownerKey] : [])), [model.rowModel.folderDropTargets]);
  const zoneLayoutKey = React.useMemo(() => model.rowModel.stickyHeaders
    .map(({ kind, id, rowIndex }) => `${kind}:${id}:${rowIndex}`)
    .join('\u0001'), [model.rowModel.stickyHeaders]);

  // How far below the top of the list a header's top is, to hold it there:
  // where the drag put it, or else where the row is drawn (a drag that just
  // started has not measured its row yet).
  const holdRow = (rowKey: string, top: number | undefined): void => {
    const scroller = scrollContainerRef.current;
    const rowTop = top ?? scroller?.querySelector(`[data-sidebar-row-key="${CSS.escape(rowKey)}"]`)?.getBoundingClientRect().top;
    heldRowRef.current = scroller && rowTop !== undefined ? { key: rowKey, offset: rowTop - scroller.getBoundingClientRect().top } : null;
  };
  const handleDragStart = ({ active }: { active: Active }): void => {
    setDragCopy(copyDragSource(active.data.current));
    const data = readDragData(active);
    if ((data.type !== 'project' && data.type !== 'section') || !data.rowKey) return;
    // A header stuck to the top is drawn there while its place in the list has
    // scrolled above: bring its place under it first, so the drag starts from
    // where the user sees the header.
    const scroller = scrollContainerRef.current;
    const placeTop = scroller?.querySelector(`[data-sidebar-row-key="${CSS.escape(data.rowKey)}"]`)?.getBoundingClientRect().top;
    if (scroller && placeTop !== undefined) {
      const listTop = scroller.getBoundingClientRect().top;
      if (placeTop < listTop) scroller.scrollTop -= listTop - placeTop;
    }
    holdRow(data.rowKey, undefined);
    // Only once the drag has measured where the header was picked up: the
    // lifted copy follows the pointer from there, and a list folded before
    // that would move its starting point.
    const kind = data.type;
    const fold = (): void => {
      foldFrameRef.current = requestAnimationFrame(() => {
        if (!active.rect.current.initial) {
          fold();
          return;
        }
        foldFrameRef.current = null;
        setSidebarBlockDrag(kind);
      });
    };
    fold();
  };
  // The list opens again with the header where it was let go.
  const endBlockDrag = (active: Active, top: number | undefined): void => {
    setDragCopy(null);
    const data = readDragData(active);
    if ((data.type !== 'project' && data.type !== 'section') || !data.rowKey) return;
    if (foldFrameRef.current !== null) {
      // Let go before the list folded: nothing moved, nothing to hold.
      cancelAnimationFrame(foldFrameRef.current);
      foldFrameRef.current = null;
      heldRowRef.current = null;
      return;
    }
    holdRow(data.rowKey, top);
    setSidebarBlockDrag(null);
  };
  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    // Moved, the header stays where it was let go; let go in its own place,
    // the list returns to where it was.
    const moved = over !== null && over.id !== active.id;
    endBlockDrag(active, moved ? active.rect.current.translated?.top : active.rect.current.initial?.top);
    if (!over) return;
    const activeData = readDragData(active);
    // SAFETY: folder payloads are created by the sidebar's droppable folder rows.
    const overData = over.data.current as { type?: string; folderId?: string; scopeKey?: string; sectionId?: string } | undefined;
    if (activeData.type === 'session' && activeData.sessionId && overData?.type === 'folder' && overData.folderId && overData.scopeKey) {
      const source = resolveCurrentSessionFolderDropSource(model.rowModel.rows, String(active.id), activeData.sessionId);
      if (!source) return;
      const dropTarget = resolveCurrentSessionFolderDropTarget(model.rowModel.folderDropTargets, String(over.id), overData.scopeKey, overData.folderId);
      const authority = model.rowModel.folderAuthorityByOwner.get(source.ownerKey);
      const store = useSessionFoldersStore.getState();
      applySessionFolderDrop({
        sessionId: source.sessionId,
        sessionOwnerKey: source.ownerKey,
        target: dropTarget,
        authority,
        removeSessionFromFolder: store.removeSessionFromFolder,
        addSessionToFolder,
      });
      return;
    }
    if (view.hasSessionSearchQuery || model.state.editingId !== null || active.id === over.id) return;
    if (activeData.type === 'section' && activeData.sectionId && overData?.sectionId) {
      const sections = useSessionDisplayStore.getState().sections;
      const from = sections.findIndex((entry) => entry.id === activeData.sectionId);
      const to = sections.findIndex((entry) => entry.id === overData.sectionId);
      if (from >= 0 && to >= 0) saveSidebarSections(arrayMove(sections, from, to));
      return;
    }
    if (activeData.type !== 'project') return;
    const activeId = String(active.id);
    const overId = String(over.id);
    if (activeData.sortGroup && activeData.sortGroup !== PROJECTS_SORT_GROUP) {
      // A group of projects: its own order, kept in the section.
      const groupId = activeData.sortGroup.slice('section:'.length);
      const sections = useSessionDisplayStore.getState().sections;
      saveSidebarSections(sections.map((entry) => {
        if (entry.kind !== 'custom' || entry.id !== groupId) return entry;
        const ids = entry.filter.projectIds;
        const from = ids.indexOf(activeId);
        const to = ids.indexOf(overId);
        return from >= 0 && to >= 0 ? { ...entry, filter: { ...entry.filter, projectIds: arrayMove([...ids], from, to) } } : entry;
      }));
      return;
    }
    const projectIds = model.sectionsForRender.map((section) => section.project.id);
    const projectFrom = projectIds.indexOf(activeId);
    const projectTo = projectIds.indexOf(overId);
    if (projectFrom >= 0 && projectTo >= 0 && view.projectSortOrder === 'manual') actions.reorderProjects(projectFrom, projectTo);
  };

  return <div className="relative flex min-h-0 flex-1">
    <CrossfadeZoneHeaders
      suspended={blockDrag !== null}
      layoutKey={zoneLayoutKey}
      scrollRef={scrollContainerRef}
    >
      <ScrollableOverlay
        // Sticky zone headers replace the top shadow.
        ref={setScrollContainer} useScrollShadow hideTopScrollShadow scrollShadowSize={40}
        outerClassName="flex-1 min-h-0" className="oc-sidebar-scroller pb-1 ps-2.5 pe-2 [overflow-anchor:none]"
      >
        <SessionFolderOwnersProvider ownerKeys={folderDropOwnerKeys}>
        <DndContext
          sensors={sensors}
          collisionDetection={sessionFolderCollision}
          modifiers={ROW_DRAG_MODIFIERS}
          autoScroll={ROW_DRAG_AUTO_SCROLL}
          // The list folds as a header lifts, so where the headers are is
          // measured again on every move rather than once at the start.
          measuring={ROW_DRAG_MEASURING}
          onDragStart={handleDragStart}
          onDragCancel={({ active }) => endBlockDrag(active, active.rect.current.initial?.top)}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
            <SessionSidebarRows model={model.rowModel} scrollElement={scrollElement} pinnedRowIndexes={pinnedRowIndexes} renderRow={renderRow} onFirstVisibleIndexChange={handleFirstVisibleIndexChange} getStickyHeaderHeight={getPinnedZoneHeaderHeight} heldRowRef={heldRowRef} />
          </SortableContext>
          {/* Dropped, the header is where it lands at once: no flight back. */}
          <DragOverlay dropAnimation={null}>{dragSource ? <RowDragPreview copy={dragSource} /> : null}</DragOverlay>
        </DndContext>
        </SessionFolderOwnersProvider>
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
