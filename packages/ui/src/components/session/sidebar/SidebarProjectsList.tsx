import React from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { formatDirectoryName, formatPathForDisplay, cn } from '@/lib/utils';
import type { SessionGroup } from './types';
import type { SortableDragHandleProps } from './sortableItems';
import { SortableGroupItem, SortableProjectItem } from './sortableItems';
import { formatProjectLabel } from './utils';

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
  const projectSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const groupSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  if (props.projectSections.length === 0) {
    return <ScrollableOverlay useScrollShadow scrollShadowSize={96} outerClassName="flex-1 min-h-0" className={cn('space-y-1 pb-1 pl-2.5 pr-2', props.mobileVariant ? '' : '')}>{props.topContent}{props.emptyState}</ScrollableOverlay>;
  }

  if (props.sectionsForRender.length === 0) {
    return <ScrollableOverlay useScrollShadow scrollShadowSize={96} outerClassName="flex-1 min-h-0" className={cn('space-y-1 pb-1 pl-2.5 pr-2', props.mobileVariant ? '' : '')}>{props.searchEmptyState}</ScrollableOverlay>;
  }

  return (
    <ScrollableOverlay useScrollShadow scrollShadowSize={96} outerClassName="flex-1 min-h-0" className={cn('space-y-1 pb-1 pl-2.5 pr-2', props.mobileVariant ? '' : '')}>
      {props.topContent}
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
      ) : (
        <>
          <DndContext
            sensors={projectSensors}
            collisionDetection={closestCenter}
            onDragEnd={(event) => {
              if (props.isInlineEditing) return;
              const { active, over } = event;
              if (!over || active.id === over.id) return;
              const oldIndex = props.sectionsForRender.findIndex((section) => section.project.id === active.id);
              const newIndex = props.sectionsForRender.findIndex((section) => section.project.id === over.id);
              if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
              props.reorderProjects(oldIndex, newIndex);
            }}
          >
            <SortableContext items={props.sectionsForRender.map((section) => section.project.id)} strategy={verticalListSortingStrategy}>
              {props.sectionsForRender.map((section) => {
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
                      <div className="space-y-0 pt-0 pb-0.5 pl-3">
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
              })}
            </SortableContext>
            <DragOverlay dropAnimation={null} />
          </DndContext>
        </>
      )}
    </ScrollableOverlay>
  );
}
