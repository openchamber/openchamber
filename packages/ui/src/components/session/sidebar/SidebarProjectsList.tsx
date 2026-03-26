import React from 'react';
import { RiArrowDownSLine, RiArrowRightSLine, RiFolderLine, RiFolderAddLine, RiMore2Line } from '@remixicon/react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { formatDirectoryName, formatPathForDisplay, cn } from '@/lib/utils';
import type { SessionGroup } from './types';
import type { SortableDragHandleProps } from './sortableItems';
import { SortableGroupItem, SortableProjectItem } from './sortableItems';
import { formatProjectLabel } from './utils';
import { useProjectFoldersStore, type ProjectFolder } from '@/stores/useProjectFoldersStore';

// --- DraggableProjectItem: wraps project with drag capabilities for folder reordering ---
function DraggableProjectItem(props: {
  projectId: string;
  indent: string;
  projectSectionsMap: Map<string, ProjectSection>;
  projectKey: string;
  projectLabel: string;
  projectDescription: string;
  project: ProjectSection['project'];
  isCollapsed: boolean;
  isActiveProject: boolean;
  isHovered: boolean;
  isRepo: boolean;
  isDesktopShellRuntime: boolean;
  hideDirectoryControls: boolean;
  mobileVariant: boolean;
  stuckProjectHeaders: Set<string>;
  collapsedProjects: Set<string>;
  hoveredProjectId: string | null;
  projectRepoStatus: Map<string, boolean | null>;
  activeProjectId: string | null;
  homeDirectory: string | null;
  isInlineEditing: boolean;
  openSidebarMenuKey: string | null;
  toggleProject: (id: string) => void;
  setHoveredProjectId: (id: string | null) => void;
  setActiveProjectIdOnly: (id: string) => void;
  setActiveMainTab: (tab: 'chat' | 'plan' | 'git' | 'diff' | 'terminal' | 'files') => void;
  setSessionSwitcherOpen: (open: boolean) => void;
  openNewSessionDraft: (options?: { directoryOverride?: string | null }) => void;
  openNewWorktreeDialog: () => void;
  openMultiRunLauncher: () => void;
  openProjectEditDialog: (id: string) => void;
  removeProject: (id: string) => void;
  projectHeaderSentinelRefs: React.MutableRefObject<Map<string, HTMLDivElement | null>>;
  getOrderedGroups: (projectId: string, groups: SessionGroup[]) => SessionGroup[];
  setGroupOrderByProject: React.Dispatch<React.SetStateAction<Map<string, string[]>>>;
  setOpenSidebarMenuKey: (key: string | null) => void;
  groupSensors: ReturnType<typeof useSensors>;
  renderGroupSessions: (group: SessionGroup, groupKey: string, projectId?: string | null, hideGroupLabel?: boolean, dragHandleProps?: SortableDragHandleProps | null) => React.ReactNode;
  isDragging: boolean;
}): React.ReactNode {
  const {
    projectId,
    indent,
    projectSectionsMap,
    projectKey,
    projectLabel,
    projectDescription,
    project,
    isCollapsed,
    isActiveProject,
    isHovered,
    isRepo,
    isDesktopShellRuntime,
    hideDirectoryControls,
    mobileVariant,
    stuckProjectHeaders,
    activeProjectId,
    isInlineEditing,
    openSidebarMenuKey,
    toggleProject,
    setHoveredProjectId,
    setActiveProjectIdOnly,
    setActiveMainTab,
    setSessionSwitcherOpen,
    openNewSessionDraft,
    openNewWorktreeDialog,
    openMultiRunLauncher,
    openProjectEditDialog,
    removeProject,
    projectHeaderSentinelRefs,
    getOrderedGroups,
    setGroupOrderByProject,
    setOpenSidebarMenuKey,
    groupSensors,
    renderGroupSessions,
    isDragging,
  } = props;

  // Always call useDraggable before any conditional returns (hooks rules)
  const { setNodeRef, transform } = useDraggable({
    id: projectId,
    data: { type: 'project', projectId },
  });

  const section = projectSectionsMap.get(projectId);
  if (!section) {
    return (
      <div ref={setNodeRef} className={cn(indent, isDragging && 'opacity-50')} />
    );
  }

  const orderedGroups = getOrderedGroups(projectKey, section.groups);
  const rootGroup = orderedGroups.find((group) => group.isMain) ?? null;
  const nestedGroups = rootGroup
    ? orderedGroups.filter((group) => group.id !== rootGroup.id)
    : orderedGroups;

  const style = transform
    ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
        opacity: isDragging ? 0.5 : 1,
      }
    : undefined;

  return (
    <div ref={setNodeRef} style={style} className={cn(indent, isDragging && 'opacity-50')}>
      <SortableProjectItem
        key={projectKey}
        id={projectKey}
        projectLabel={projectLabel}
        projectDescription={projectDescription}
        projectIcon={project.icon}
        projectColor={project.color}
        projectIconImage={project.iconImage}
        projectIconBackground={project.iconBackground}
        isCollapsed={isCollapsed}
        isActiveProject={isActiveProject}
        isHovered={isHovered}
        isRepo={Boolean(isRepo)}
        isDesktopShell={isDesktopShellRuntime}
        isStuck={stuckProjectHeaders.has(projectKey)}
        hideDirectoryControls={hideDirectoryControls}
        mobileVariant={mobileVariant}
        onToggle={() => toggleProject(projectKey)}
        onHoverChange={(hovered) => setHoveredProjectId(hovered ? projectKey : null)}
        onNewSession={() => {
          if (projectKey !== activeProjectId) setActiveProjectIdOnly(projectKey);
          setActiveMainTab('chat');
          if (mobileVariant) setSessionSwitcherOpen(false);
          openNewSessionDraft({ directoryOverride: project.normalizedPath });
        }}
        onNewWorktreeSession={() => {
          if (projectKey !== activeProjectId) setActiveProjectIdOnly(projectKey);
          setActiveMainTab('chat');
          if (mobileVariant) setSessionSwitcherOpen(false);
          openNewWorktreeDialog();
        }}
        onOpenMultiRunLauncher={() => {
          if (projectKey !== activeProjectId) setActiveProjectIdOnly(projectKey);
          openMultiRunLauncher();
        }}
        onRenameStart={() => openProjectEditDialog(projectKey)}
        onClose={() => removeProject(projectKey)}
        sentinelRef={(el) => { projectHeaderSentinelRefs.current.set(projectKey, el); }}
        showCreateButtons
        openSidebarMenuKey={openSidebarMenuKey}
        setOpenSidebarMenuKey={setOpenSidebarMenuKey}
      >
        {!isCollapsed ? (
          <div className="space-y-0 pt-0 pb-0.5">
            {section.groups.length > 0 ? (
              <DndContext
                sensors={groupSensors}
                collisionDetection={closestCenter}
                onDragEnd={(event) => {
                  if (isInlineEditing) return;
                  const { active, over } = event;
                  if (!over || active.id === over.id) return;
                  const oldIndex = nestedGroups.findIndex((item) => item.id === active.id);
                  const newIndex = nestedGroups.findIndex((item) => item.id === over.id);
                  if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
                  const nextNested = arrayMove(nestedGroups, oldIndex, newIndex).map((item) => item.id);
                  const next = rootGroup ? [rootGroup.id, ...nextNested] : nextNested;
                  setGroupOrderByProject((prev) => {
                    const map = new Map(prev);
                    map.set(projectKey, next);
                    return map;
                  });
                }}
              >
                {rootGroup ? renderGroupSessions(rootGroup, `${projectKey}:${rootGroup.id}`, projectKey, true) : null}
                <SortableContext items={nestedGroups.map((group) => group.id)} strategy={verticalListSortingStrategy}>
                  {nestedGroups.map((group) => {
                    const groupKey = `${projectKey}:${group.id}`;
                    return (
                      <SortableGroupItem key={group.id} id={group.id} disabled={isInlineEditing}>
                        {(dragHandleProps) => renderGroupSessions(group, groupKey, projectKey, false, dragHandleProps)}
                      </SortableGroupItem>
                    );
                  })}
                </SortableContext>
                <DragOverlay dropAnimation={null} />
              </DndContext>
            ) : (
              <div className="py-1 text-left typography-micro text-muted-foreground">No sessions yet.</div>
            )}
          </div>
        ) : null}
      </SortableProjectItem>
    </div>
  );
}

// --- DroppableFolder: folder area that can receive dropped projects ---
function DroppableFolderArea(props: {
  folderId: string;
  children: React.ReactNode;
  isOver: boolean;
}): React.ReactNode {
  const { setNodeRef } = useDroppable({
    id: `folder-${props.folderId}`,
    data: { type: 'folder', folderId: props.folderId },
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'pl-3 space-y-0.5 rounded-md transition-colors',
        props.isOver && 'bg-primary/10 border border-primary/30'
      )}
    >
      {props.children}
    </div>
  );
}

// --- DroppableUnfiled: unfiled area that can receive dropped projects ---
function DroppableUnfiledArea(props: {
  children: React.ReactNode;
  isOver: boolean;
}): React.ReactNode {
  const { setNodeRef } = useDroppable({
    id: 'unfiled',
    data: { type: 'unfiled' },
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'space-y-0.5 pl-3 rounded-md transition-colors',
        props.isOver && 'bg-primary/10 border border-primary/30'
      )}
    >
      {props.children}
    </div>
  );
}

type ProjectSection = {
  project: {
    id: string;
    label?: string;
    normalizedPath: string;
    icon?: string;
    color?: string;
    iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' };
    iconBackground?: string;
  };
  groups: SessionGroup[];
};

type Props = {
  topContent?: React.ReactNode;
  sectionsForRender: ProjectSection[];
  projectSections: ProjectSection[];
  activeProjectId: string | null;
  showOnlyMainWorkspace: boolean;
  hasSessionSearchQuery: boolean;
  emptyState: React.ReactNode;
  searchEmptyState: React.ReactNode;
  renderGroupSessions: (group: SessionGroup, groupKey: string, projectId?: string | null, hideGroupLabel?: boolean, dragHandleProps?: SortableDragHandleProps | null) => React.ReactNode;
  homeDirectory: string | null;
  collapsedProjects: Set<string>;
  hideDirectoryControls: boolean;
  projectRepoStatus: Map<string, boolean | null>;
  hoveredProjectId: string | null;
  setHoveredProjectId: (id: string | null) => void;
  isDesktopShellRuntime: boolean;
  stuckProjectHeaders: Set<string>;
  mobileVariant: boolean;
  toggleProject: (id: string) => void;
  setActiveProjectIdOnly: (id: string) => void;
  setActiveMainTab: (tab: 'chat' | 'plan' | 'git' | 'diff' | 'terminal' | 'files') => void;
  setSessionSwitcherOpen: (open: boolean) => void;
  openNewSessionDraft: (options?: { directoryOverride?: string | null }) => void;
  openNewWorktreeDialog: () => void;
  openMultiRunLauncher: () => void;
  openProjectEditDialog: (id: string) => void;
  removeProject: (id: string) => void;
  projectHeaderSentinelRefs: React.MutableRefObject<Map<string, HTMLDivElement | null>>;
  reorderProjects: (fromIndex: number, toIndex: number) => void;
  getOrderedGroups: (projectId: string, groups: SessionGroup[]) => SessionGroup[];
  setGroupOrderByProject: React.Dispatch<React.SetStateAction<Map<string, string[]>>>;
  openSidebarMenuKey: string | null;
  setOpenSidebarMenuKey: (key: string | null) => void;
  isInlineEditing: boolean;
  onCreateFolder: () => void;
  onRenameFolder: (folderId: string, currentName: string) => void;
  onMoveProjectToFolder: (projectId: string, targetFolderId: string | null) => void;
};

export function SidebarProjectsList(props: Props): React.ReactNode {
  const [projectsCollapsed, setProjectsCollapsed] = React.useState(false);
  const [activeDragProjectId, setActiveDragProjectId] = React.useState<string | null>(null);
  const [overFolderId, setOverFolderId] = React.useState<string | 'unfiled' | null>(null);
  
  // Sensors for folder drag-drop
  const folderDragSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );
  
  // Project folders store
  const folders = useProjectFoldersStore((s) => s.folders);
  const collapsedFolderIds = useProjectFoldersStore((s) => s.collapsedFolderIds);
  const toggleFolder = useProjectFoldersStore((s) => s.toggleFolderCollapse);
  
  // Get all project IDs and find unfiled ones
  const allProjectIds = React.useMemo(() => 
    props.sectionsForRender.map((s) => s.project.id),
    [props.sectionsForRender]
  );
  const unfiledProjectIds = React.useMemo(() => {
    const assignedIds = new Set(folders.flatMap((f) => f.projectIds));
    return allProjectIds.filter((id) => !assignedIds.has(id));
  }, [allProjectIds, folders]);
  
  // Create project section lookup
  const projectSectionsMap = React.useMemo(() => {
    const map = new Map<string, ProjectSection>();
    props.sectionsForRender.forEach((s) => map.set(s.project.id, s));
    return map;
  }, [props.sectionsForRender]);
  
  // Keep folders ref up to date to avoid stale closure in drag handlers
  const foldersRef = React.useRef(folders);
  foldersRef.current = folders;

  // Sensors for session reordering (defined before conditional returns so hooks are always called same number of times)
  const groupSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  if (props.projectSections.length === 0) {
    return <ScrollableOverlay useScrollShadow scrollShadowSize={96} outerClassName="flex-1 min-h-0" className={cn('space-y-1 pb-1 pl-2.5 pr-2', props.mobileVariant ? '' : '')}>{props.topContent}{props.emptyState}</ScrollableOverlay>;
  }

  if (props.sectionsForRender.length === 0) {
    return <ScrollableOverlay useScrollShadow scrollShadowSize={96} outerClassName="flex-1 min-h-0" className={cn('space-y-1 pb-1 pl-2.5 pr-2', props.mobileVariant ? '' : '')}>{props.searchEmptyState}</ScrollableOverlay>;
  }

  // Handle drag end for folder reordering
  const handleFolderDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDragProjectId(null);
    setOverFolderId(null);
    
    if (!over) return;
    
    const activeProjectId = active.id as string;
    const overData = over.data.current;
    
    // Determine target folder based on drop data
    let targetFolderId: string | null = null;
    
    if (overData?.type === 'folder') {
      // Dropped directly on folder area
      targetFolderId = overData.folderId;
    } else if (overData?.type === 'unfiled') {
      // Dropped on unfiled area
      targetFolderId = null;
    } else if (overData?.type === 'project') {
      // Dropped on another project - find which folder that project is in
      const targetProjectId = overData.projectId as string;
      const targetProjectFolder = foldersRef.current.find((f) => f.projectIds.includes(targetProjectId));
      if (targetProjectFolder) {
        targetFolderId = targetProjectFolder.id;
      }
    } else {
      // Fallback: check by id string pattern
      const overId = over.id as string;
      if (overId.startsWith('folder-')) {
        targetFolderId = overId.replace('folder-', '');
      } else if (overId === 'unfiled') {
        targetFolderId = null;
      } else {
        // Try finding by project id in any folder
        const fallbackFolder = foldersRef.current.find((f) => f.projectIds.includes(overId));
        if (fallbackFolder) {
          targetFolderId = fallbackFolder.id;
        }
      }
    }
    
    // Only move if target is different from current location
    if (targetFolderId !== undefined) {
      const currentFolder = foldersRef.current.find((f) => f.projectIds.includes(activeProjectId));
      const currentFolderId = currentFolder?.id ?? null;
      
      // Don't move if already in target folder
      if (targetFolderId !== currentFolderId) {
        props.onMoveProjectToFolder(activeProjectId, targetFolderId);
      }
    }
  };

  // Render folder with drag-drop support
  const renderFolderWithDrag = (folder: ProjectFolder, depth: number = 0) => {
    const isCollapsed = collapsedFolderIds.has(folder.id);
    const indent = depth > 0 ? 'pl-3' : '';
    const isOver = overFolderId === folder.id;

    return (
      <div key={folder.id}>
        {/* Folder header */}
        <div className={cn('flex items-center gap-1 rounded-md px-0.5 py-0.5 group', indent, isOver && 'bg-primary/5')}>
          <button
            type="button"
            onClick={() => toggleFolder(folder.id)}
            className="flex items-center gap-1 flex-1 text-left"
          >
            <span className="inline-flex h-4 w-4 items-center justify-center text-muted-foreground">
              {isCollapsed ? <RiArrowRightSLine className="h-3.5 w-3.5" /> : <RiArrowDownSLine className="h-3.5 w-3.5" />}
            </span>
            <RiFolderLine className="h-3.5 w-3.5 text-primary" />
            <span className="text-[13px] font-medium text-foreground/90">{folder.name}</span>
            <span className="text-[11px] text-muted-foreground/60">({folder.projectIds.length})</span>
          </button>
          <button
            type="button"
            onClick={() => props.onRenameFolder(folder.id, folder.name)}
            className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-interactive-hover"
          >
            <RiMore2Line className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </div>
        
        {/* Folder projects - droppable area */}
        {!isCollapsed && (
          <DroppableFolderArea folderId={folder.id} isOver={isOver}>
            {folder.projectIds.map((projectId) => {
              const section = projectSectionsMap.get(projectId);
              if (!section) return null;
              const proj = section.project;
              return (
                <DraggableProjectItem
                  key={projectId}
                  projectId={projectId}
                  indent="pl-3"
                  projectSectionsMap={projectSectionsMap}
                  projectKey={proj.id}
                  projectLabel={formatProjectLabel(
                    proj.label?.trim()
                    || formatDirectoryName(proj.normalizedPath, props.homeDirectory)
                    || proj.normalizedPath,
                  )}
                  projectDescription={formatPathForDisplay(proj.normalizedPath, props.homeDirectory)}
                  project={proj}
                  isCollapsed={props.collapsedProjects.has(proj.id)}
                  isActiveProject={proj.id === props.activeProjectId}
                  isHovered={props.hoveredProjectId === proj.id}
                  isRepo={Boolean(props.projectRepoStatus.get(proj.id))}
                  isDesktopShellRuntime={props.isDesktopShellRuntime}
                  hideDirectoryControls={props.hideDirectoryControls}
                  mobileVariant={props.mobileVariant}
                  stuckProjectHeaders={props.stuckProjectHeaders}
                  collapsedProjects={props.collapsedProjects}
                  hoveredProjectId={props.hoveredProjectId}
                  projectRepoStatus={props.projectRepoStatus}
                  activeProjectId={props.activeProjectId}
                  homeDirectory={props.homeDirectory}
                  isInlineEditing={props.isInlineEditing}
                  openSidebarMenuKey={props.openSidebarMenuKey}
                  toggleProject={props.toggleProject}
                  setHoveredProjectId={props.setHoveredProjectId}
                  setActiveProjectIdOnly={props.setActiveProjectIdOnly}
                  setActiveMainTab={props.setActiveMainTab}
                  setSessionSwitcherOpen={props.setSessionSwitcherOpen}
                  openNewSessionDraft={props.openNewSessionDraft}
                  openNewWorktreeDialog={props.openNewWorktreeDialog}
                  openMultiRunLauncher={props.openMultiRunLauncher}
                  openProjectEditDialog={props.openProjectEditDialog}
                  removeProject={props.removeProject}
                  projectHeaderSentinelRefs={props.projectHeaderSentinelRefs}
                  getOrderedGroups={props.getOrderedGroups}
                  setGroupOrderByProject={props.setGroupOrderByProject}
                  setOpenSidebarMenuKey={props.setOpenSidebarMenuKey}
                  groupSensors={groupSensors}
                  renderGroupSessions={props.renderGroupSessions}
                  isDragging={activeDragProjectId === projectId}
                />
              );
            })}
          </DroppableFolderArea>
        )}
      </div>
    );
  };

  return (
    <DndContext
      sensors={folderDragSensors}
      onDragStart={(event) => {
        setActiveDragProjectId(event.active.id as string);
      }}
      onDragOver={(event) => {
        const overData = event.over?.data.current;
        if (overData?.type === 'folder') {
          setOverFolderId(overData.folderId);
        } else if (overData?.type === 'unfiled') {
          setOverFolderId('unfiled');
    } else if (overData?.type === 'project') {
      // Find folder containing this project
      const projectId = overData.projectId as string;
      const folder = foldersRef.current.find((f) => f.projectIds.includes(projectId));
      setOverFolderId(folder?.id ?? null);
    } else {
      setOverFolderId(null);
    }
      }}
      onDragEnd={handleFolderDragEnd}
      onDragCancel={() => {
        setActiveDragProjectId(null);
        setOverFolderId(null);
      }}
    >
      <ScrollableOverlay useScrollShadow scrollShadowSize={96} outerClassName="flex-1 min-h-0" className={cn('space-y-1 pb-1 pl-2.5 pr-2', props.mobileVariant ? '' : '')}>
        {props.topContent}
        
        {/* Projects Section Header - Collapsible */}
        {!props.showOnlyMainWorkspace && (
          <button
            type="button"
            onClick={() => setProjectsCollapsed(!projectsCollapsed)}
            className="group flex w-full items-center gap-1 rounded-md px-0.5 py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          >
            <span className="inline-flex h-4 w-4 items-center justify-center text-muted-foreground">
              {projectsCollapsed ? <RiArrowRightSLine className="h-3.5 w-3.5" /> : <RiArrowDownSLine className="h-3.5 w-3.5" />}
            </span>
            <RiFolderLine className="h-3.5 w-3.5 text-primary mr-1" />
            <span className="text-[14px] font-normal text-foreground/95 uppercase tracking-wide">Projects</span>
          </button>
        )}
        
        {props.showOnlyMainWorkspace ? (
          <div className="space-y-[0.6rem] py-1">
            {(() => {
              const activeSection = props.sectionsForRender.find((section) => section.project.id === props.activeProjectId) ?? props.sectionsForRender[0];
              if (!activeSection) {
                return props.hasSessionSearchQuery ? props.searchEmptyState : props.emptyState;
              }
              const primaryGroup =
                activeSection.groups.find((candidate) => candidate.isMain && candidate.sessions.length > 0)
                ?? activeSection.groups.find((candidate) => candidate.sessions.length > 0)
                ?? activeSection.groups.find((candidate) => candidate.isMain)
                ?? activeSection.groups[0];
              if (!primaryGroup) {
                return <div className="py-1 text-left typography-micro text-muted-foreground">No sessions yet.</div>;
              }
              const archivedGroup = activeSection.groups.find((candidate) => candidate.isArchivedBucket);
              const groupsToRender = [
                primaryGroup,
                ...(archivedGroup && archivedGroup.id !== primaryGroup.id ? [archivedGroup] : []),
              ];

              return groupsToRender.map((group) => {
                const groupKey = `${activeSection.project.id}:${group.id}`;
                const hideGroupLabel = group.id === primaryGroup.id;
                return (
                  <React.Fragment key={groupKey}>
                    {props.renderGroupSessions(group, groupKey, activeSection.project.id, hideGroupLabel)}
                  </React.Fragment>
                );
              });
            })()}
          </div>
        ) : !projectsCollapsed ? (
          <div className="space-y-1">
            {/* Render folders with their projects */}
            {folders.map((folder) => renderFolderWithDrag(folder))}
            
            {/* Unfiled projects section */}
            {unfiledProjectIds.length > 0 && (
              <div>
                <div className="flex items-center gap-1 rounded-md px-0.5 py-0.5 opacity-60">
                  <RiFolderLine className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-[12px] font-normal text-muted-foreground">Unfiled</span>
                  <span className="text-[11px] text-muted-foreground/60">({unfiledProjectIds.length})</span>
                </div>
                <DroppableUnfiledArea isOver={overFolderId === 'unfiled'}>
                  {unfiledProjectIds.map((projectId) => {
                    const section = projectSectionsMap.get(projectId);
                    if (!section) return null;
                    const proj = section.project;
                    return (
                      <DraggableProjectItem
                        key={projectId}
                        projectId={projectId}
                        indent="pl-3"
                        projectSectionsMap={projectSectionsMap}
                        projectKey={proj.id}
                        projectLabel={formatProjectLabel(
                          proj.label?.trim()
                          || formatDirectoryName(proj.normalizedPath, props.homeDirectory)
                          || proj.normalizedPath,
                        )}
                        projectDescription={formatPathForDisplay(proj.normalizedPath, props.homeDirectory)}
                        project={proj}
                        isCollapsed={props.collapsedProjects.has(proj.id)}
                        isActiveProject={proj.id === props.activeProjectId}
                        isHovered={props.hoveredProjectId === proj.id}
                        isRepo={Boolean(props.projectRepoStatus.get(proj.id))}
                        isDesktopShellRuntime={props.isDesktopShellRuntime}
                        hideDirectoryControls={props.hideDirectoryControls}
                        mobileVariant={props.mobileVariant}
                        stuckProjectHeaders={props.stuckProjectHeaders}
                        collapsedProjects={props.collapsedProjects}
                        hoveredProjectId={props.hoveredProjectId}
                        projectRepoStatus={props.projectRepoStatus}
                        activeProjectId={props.activeProjectId}
                        homeDirectory={props.homeDirectory}
                        isInlineEditing={props.isInlineEditing}
                        openSidebarMenuKey={props.openSidebarMenuKey}
                        toggleProject={props.toggleProject}
                        setHoveredProjectId={props.setHoveredProjectId}
                        setActiveProjectIdOnly={props.setActiveProjectIdOnly}
                        setActiveMainTab={props.setActiveMainTab}
                        setSessionSwitcherOpen={props.setSessionSwitcherOpen}
                        openNewSessionDraft={props.openNewSessionDraft}
                        openNewWorktreeDialog={props.openNewWorktreeDialog}
                        openMultiRunLauncher={props.openMultiRunLauncher}
                        openProjectEditDialog={props.openProjectEditDialog}
                        removeProject={props.removeProject}
                        projectHeaderSentinelRefs={props.projectHeaderSentinelRefs}
                        getOrderedGroups={props.getOrderedGroups}
                        setGroupOrderByProject={props.setGroupOrderByProject}
                        setOpenSidebarMenuKey={props.setOpenSidebarMenuKey}
                        groupSensors={groupSensors}
                        renderGroupSessions={props.renderGroupSessions}
                        isDragging={activeDragProjectId === projectId}
                      />
                    );
                  })}
                </DroppableUnfiledArea>
              </div>
            )}
            
            {/* Create folder button - inside projects section */}
            <button
              type="button"
              onClick={props.onCreateFolder}
              className="flex w-full items-center gap-1 rounded-md px-1 py-0.5 text-left text-[13px] text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
            >
              <RiFolderAddLine className="h-3.5 w-3.5" />
              <span>Create folder</span>
            </button>
          </div>
        ) : null}
      </ScrollableOverlay>
      <DragOverlay>
        {activeDragProjectId && (() => {
          const section = projectSectionsMap.get(activeDragProjectId);
          if (!section) return null;
          const proj = section.project;
          return (
            <div className="rounded-md border border-primary/30 bg-background px-2 py-1.5 shadow-lg opacity-90">
              <span className="text-[13px] font-medium">{formatProjectLabel(
                proj.label?.trim()
                || formatDirectoryName(proj.normalizedPath, props.homeDirectory)
                || proj.normalizedPath,
              )}</span>
            </div>
          );
        })()}
      </DragOverlay>
    </DndContext>
  );
}
