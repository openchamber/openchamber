import React from 'react';
import { RiArrowDownSLine, RiArrowRightSLine, RiFolderLine, RiFolderAddLine, RiMore2Line } from '@remixicon/react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { formatDirectoryName, formatPathForDisplay, cn } from '@/lib/utils';
import type { SessionGroup } from './types';
import type { SortableDragHandleProps } from './sortableItems';
import { SortableGroupItem, SortableProjectItem } from './sortableItems';
import { formatProjectLabel } from './utils';
import { useProjectFoldersStore, type ProjectFolder } from '@/stores/useProjectFoldersStore';

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
};

export function SidebarProjectsList(props: Props): React.ReactNode {
  const [projectsCollapsed, setProjectsCollapsed] = React.useState(false);
  
  // Project folders store
  const folders = useProjectFoldersStore((s) => s.folders);
  const collapsedFolderIds = useProjectFoldersStore((s) => s.collapsedFolderIds);
  const toggleFolder = useProjectFoldersStore((s) => s.toggleFolderCollapse);
  const createFolder = useProjectFoldersStore((s) => s.createFolder);
  const renameFolder = useProjectFoldersStore((s) => s.renameFolder);
  
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
  
  // Handle create new folder
  const handleCreateFolder = () => {
    const name = prompt('Folder name:');
    if (name?.trim()) {
      createFolder(name.trim());
    }
  };

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

  // Helper to render a single project inside a folder
  const renderProjectItem = (projectId: string, indent: string = '') => {
    const section = projectSectionsMap.get(projectId);
    if (!section) return null;
    const project = section.project;
    const projectKey = project.id;
    const projectLabel = formatProjectLabel(
      project.label?.trim()
      || formatDirectoryName(project.normalizedPath, props.homeDirectory)
      || project.normalizedPath,
    );
    const projectDescription = formatPathForDisplay(project.normalizedPath, props.homeDirectory);
    const isCollapsed = props.collapsedProjects.has(projectKey);
    const isActiveProject = projectKey === props.activeProjectId;
    const isHovered = props.hoveredProjectId === projectKey;
    const isRepo = props.projectRepoStatus.get(projectKey);
    const orderedGroups = props.getOrderedGroups(projectKey, section.groups);
    const rootGroup = orderedGroups.find((group) => group.isMain) ?? null;
    const nestedGroups = rootGroup
      ? orderedGroups.filter((group) => group.id !== rootGroup.id)
      : orderedGroups;

    return (
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
        isDesktopShell={props.isDesktopShellRuntime}
        isStuck={props.stuckProjectHeaders.has(projectKey)}
        hideDirectoryControls={props.hideDirectoryControls}
        mobileVariant={props.mobileVariant}
        onToggle={() => props.toggleProject(projectKey)}
        onHoverChange={(hovered) => props.setHoveredProjectId(hovered ? projectKey : null)}
        onNewSession={() => {
          if (projectKey !== props.activeProjectId) props.setActiveProjectIdOnly(projectKey);
          props.setActiveMainTab('chat');
          if (props.mobileVariant) props.setSessionSwitcherOpen(false);
          props.openNewSessionDraft({ directoryOverride: project.normalizedPath });
        }}
        onNewWorktreeSession={() => {
          if (projectKey !== props.activeProjectId) props.setActiveProjectIdOnly(projectKey);
          props.setActiveMainTab('chat');
          if (props.mobileVariant) props.setSessionSwitcherOpen(false);
          props.openNewWorktreeDialog();
        }}
        onOpenMultiRunLauncher={() => {
          if (projectKey !== props.activeProjectId) props.setActiveProjectIdOnly(projectKey);
          props.openMultiRunLauncher();
        }}
        onRenameStart={() => props.openProjectEditDialog(projectKey)}
        onClose={() => props.removeProject(projectKey)}
        sentinelRef={(el) => { props.projectHeaderSentinelRefs.current.set(projectKey, el); }}
        showCreateButtons
        openSidebarMenuKey={props.openSidebarMenuKey}
        setOpenSidebarMenuKey={props.setOpenSidebarMenuKey}
      >
        {!isCollapsed ? (
          <div className={cn('space-y-0 pt-0 pb-0.5', indent)}>
            {section.groups.length > 0 ? (
              <DndContext
                sensors={groupSensors}
                collisionDetection={closestCenter}
                onDragEnd={(event) => {
                  if (props.isInlineEditing) return;
                  const { active, over } = event;
                  if (!over || active.id === over.id) return;
                  const oldIndex = nestedGroups.findIndex((item) => item.id === active.id);
                  const newIndex = nestedGroups.findIndex((item) => item.id === over.id);
                  if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
                  const nextNested = arrayMove(nestedGroups, oldIndex, newIndex).map((item) => item.id);
                  const next = rootGroup ? [rootGroup.id, ...nextNested] : nextNested;
                  props.setGroupOrderByProject((prev) => {
                    const map = new Map(prev);
                    map.set(projectKey, next);
                    return map;
                  });
                }}
              >
                {rootGroup ? props.renderGroupSessions(rootGroup, `${projectKey}:${rootGroup.id}`, projectKey, true) : null}
                <SortableContext items={nestedGroups.map((group) => group.id)} strategy={verticalListSortingStrategy}>
                  {nestedGroups.map((group) => {
                    const groupKey = `${projectKey}:${group.id}`;
                    return (
                      <SortableGroupItem key={group.id} id={group.id} disabled={props.isInlineEditing}>
                        {(dragHandleProps) => props.renderGroupSessions(group, groupKey, projectKey, false, dragHandleProps)}
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
    );
  };

  // Helper to render a folder with its projects
  const renderFolder = (folder: ProjectFolder, depth: number = 0) => {
    const isCollapsed = collapsedFolderIds.has(folder.id);
    const indent = depth > 0 ? 'pl-3' : '';

    return (
      <div key={folder.id}>
        {/* Folder header */}
        <div className={cn('flex items-center gap-1 rounded-md px-0.5 py-0.5 group', indent)}>
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
            onClick={() => {
              const newName = prompt('Rename folder:', folder.name);
              if (newName?.trim() && newName.trim() !== folder.name) {
                renameFolder(folder.id, newName.trim());
              }
            }}
            className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-interactive-hover"
          >
            <RiMore2Line className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </div>
        
        {/* Folder projects */}
        {!isCollapsed && (
          <div className="pl-3 space-y-0.5">
            {folder.projectIds.map((projectId) => renderProjectItem(projectId, 'pl-3'))}
          </div>
        )}
      </div>
    );
  };

  return (
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
          {folders.map((folder) => renderFolder(folder))}
          
          {/* Unfiled projects section */}
          {unfiledProjectIds.length > 0 && (
            <div>
              <div className="flex items-center gap-1 rounded-md px-0.5 py-0.5 opacity-60">
                <RiFolderLine className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-[12px] font-normal text-muted-foreground">Unfiled</span>
                <span className="text-[11px] text-muted-foreground/60">({unfiledProjectIds.length})</span>
              </div>
              <div className="space-y-0.5">
                {unfiledProjectIds.map((projectId) => renderProjectItem(projectId))}
              </div>
            </div>
          )}
          
          {/* Create folder button */}
          <button
            type="button"
            onClick={handleCreateFolder}
            className="flex w-full items-center gap-1 rounded-md px-1 py-0.5 text-left text-[13px] text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
          >
            <RiFolderAddLine className="h-3.5 w-3.5" />
            <span>Create folder</span>
          </button>
        </div>
      ) : null}
    </ScrollableOverlay>
  );
}
