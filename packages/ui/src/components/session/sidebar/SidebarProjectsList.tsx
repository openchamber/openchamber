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
import { SortableGroupItem, SortableProjectItem } from './sortableItems';
import { formatProjectLabel } from './utils';
import { useLanguage } from '@/hooks/useLanguage';

type ProjectSection = {
  project: {
    id: string;
    label?: string;
    normalizedPath: string;
  };
  groups: SessionGroup[];
};

type Props = {
  sectionsForRender: ProjectSection[];
  projectSections: ProjectSection[];
  activeProjectId: string | null;
  showOnlyMainWorkspace: boolean;
  hasSessionSearchQuery: boolean;
  emptyState: React.ReactNode;
  searchEmptyState: React.ReactNode;
  renderGroupSessions: (group: SessionGroup, groupKey: string, projectId?: string | null, hideGroupLabel?: boolean) => React.ReactNode;
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
  createWorktreeSession: () => void;
  openMultiRunLauncher: () => void;
  setEditingProjectId: (id: string | null) => void;
  setEditProjectTitle: (title: string) => void;
  editingProjectId: string | null;
  editProjectTitle: string;
  handleSaveProjectEdit: () => void;
  handleCancelProjectEdit: () => void;
  removeProject: (id: string) => void;
  projectHeaderSentinelRefs: React.MutableRefObject<Map<string, HTMLDivElement | null>>;
  settingsAutoCreateWorktree: boolean;
  getOrderedGroups: (projectId: string, groups: SessionGroup[]) => SessionGroup[];
  setGroupOrderByProject: React.Dispatch<React.SetStateAction<Map<string, string[]>>>;
  isInlineEditing: boolean;
};

export function SidebarProjectsList(props: Props): React.ReactNode {
  const { t } = useLanguage();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (props.projectSections.length === 0) {
    return <ScrollableOverlay outerClassName="flex-1 min-h-0" className={cn('space-y-1 pb-1 pl-2.5 pr-1', props.mobileVariant ? '' : '')}>{props.emptyState}</ScrollableOverlay>;
  }

  if (props.sectionsForRender.length === 0) {
    return <ScrollableOverlay outerClassName="flex-1 min-h-0" className={cn('space-y-1 pb-1 pl-2.5 pr-1', props.mobileVariant ? '' : '')}>{props.searchEmptyState}</ScrollableOverlay>;
  }

  return (
    <ScrollableOverlay outerClassName="flex-1 min-h-0" className={cn('space-y-1 pb-1 pl-2.5 pr-1', props.mobileVariant ? '' : '')}>
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
              return <div className="py-1 text-left typography-micro text-muted-foreground">{t('sessionSidebar.noSessionsYetDot')}</div>;
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
          {props.sectionsForRender.map((section) => {
            const project = section.project;
            const projectKey = project.id;
            const projectLabel = formatProjectLabel(
              project.label?.trim()
              || formatDirectoryName(project.normalizedPath, props.homeDirectory)
              || project.normalizedPath,
            );
            const projectDescription = formatPathForDisplay(project.normalizedPath, props.homeDirectory);
            const isCollapsed = props.collapsedProjects.has(projectKey) && props.hideDirectoryControls;
            const isActiveProject = projectKey === props.activeProjectId;
            const isRepo = props.projectRepoStatus.get(projectKey);
            const isHovered = props.hoveredProjectId === projectKey;
            const orderedGroups = props.getOrderedGroups(projectKey, section.groups);
            const sortableEntries = orderedGroups.map((group) => ({
              sortableId: `${projectKey}:${group.id}`,
              groupId: group.id,
            }));
            const sortableGroupIds = sortableEntries.map((entry) => entry.sortableId);
            const sortableIdToGroupId = new Map(sortableEntries.map((entry) => [entry.sortableId, entry.groupId]));

            return (
              <SortableProjectItem
                key={projectKey}
                id={projectKey}
                projectLabel={projectLabel}
                projectDescription={projectDescription}
                isCollapsed={isCollapsed}
                isActiveProject={isActiveProject}
                isRepo={Boolean(isRepo)}
                isHovered={isHovered}
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
                  props.createWorktreeSession();
                }}
                onOpenMultiRunLauncher={() => {
                  if (projectKey !== props.activeProjectId) props.setActiveProjectIdOnly(projectKey);
                  props.openMultiRunLauncher();
                }}
                onRenameStart={() => {
                  props.setEditingProjectId(projectKey);
                  props.setEditProjectTitle(project.label?.trim() || formatDirectoryName(project.normalizedPath, props.homeDirectory) || project.normalizedPath);
                }}
                onRenameSave={props.handleSaveProjectEdit}
                onRenameCancel={props.handleCancelProjectEdit}
                onRenameValueChange={props.setEditProjectTitle}
                renameValue={props.editingProjectId === projectKey ? props.editProjectTitle : ''}
                isRenaming={props.editingProjectId === projectKey}
                onClose={() => props.removeProject(projectKey)}
                sentinelRef={(el) => { props.projectHeaderSentinelRefs.current.set(projectKey, el); }}
                settingsAutoCreateWorktree={props.settingsAutoCreateWorktree}
                showCreateButtons={false}
                hideHeader
              >
                {!isCollapsed ? (
                  <div className="space-y-[0.6rem] py-1">
                    {section.groups.length > 0 ? (
                      <DndContext
                        sensors={sensors}
                        collisionDetection={closestCenter}
                        onDragEnd={(event) => {
                          const { active, over } = event;
                          if (!over || active.id === over.id) return;
                          const activeId = typeof active.id === 'string' ? sortableIdToGroupId.get(active.id) : null;
                          const overId = typeof over.id === 'string' ? sortableIdToGroupId.get(over.id) : null;
                          if (!activeId || !overId) return;
                          const oldIndex = orderedGroups.findIndex((item) => item.id === activeId);
                          const newIndex = orderedGroups.findIndex((item) => item.id === overId);
                          if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
                          const next = arrayMove(orderedGroups, oldIndex, newIndex).map((item) => item.id);
                          props.setGroupOrderByProject((prev) => {
                            const map = new Map(prev);
                            map.set(projectKey, next);
                            return map;
                          });
                        }}
                      >
                        <SortableContext items={sortableGroupIds} strategy={verticalListSortingStrategy}>
                          {orderedGroups.map((group) => {
                            const groupKey = `${projectKey}:${group.id}`;
                            return (
                              <SortableGroupItem key={groupKey} id={groupKey} disabled={props.isInlineEditing}>
                                {props.renderGroupSessions(group, groupKey, projectKey)}
                              </SortableGroupItem>
                            );
                          })}
                        </SortableContext>
                        <DragOverlay dropAnimation={null} />
                      </DndContext>
                    ) : (
                      <div className="py-1 text-left typography-micro text-muted-foreground">{t('sessionSidebar.noSessionsYetDot')}</div>
                    )}
                  </div>
                ) : null}
              </SortableProjectItem>
            );
          })}
        </>
      )}
    </ScrollableOverlay>
  );
}
