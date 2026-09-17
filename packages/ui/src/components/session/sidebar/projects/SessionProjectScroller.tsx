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
import { formatDirectoryName, formatPathForDisplay } from '@/lib/utils';
import type { SessionGroup } from '../types';
import { SortableGroupItem, SortableProjectItem } from './sortableItems';
import { SessionGroupSection, type SessionGroupSectionProps } from './SessionGroupSection';
import { buildGroupRenderDescriptors, resolveSearchResultPlacement, selectRenderedProjectSections, type ProjectSection } from './sessionProjectRender';
import { formatProjectLabel } from '../utils';
import { useI18n } from '@/lib/i18n';
import type { ProjectSortOrder } from '@/stores/useSessionDisplayStore';
import { streamPerfCount } from '@/stores/utils/streamDebug';
import { CrossfadeZoneHeaders } from './CrossfadeZoneHeaders';

type SessionProjectScrollerState = Pick<SessionGroupSectionProps,
  | 'editingId'
  | 'openSidebarMenuKey'
  | 'setOpenSidebarMenuKey'
> & {
  visibleSessionCountByGroup: Map<string, number>;
};

type SessionProjectScrollerGroupProps = Pick<SessionGroupSectionProps,
  | 'hasSessionSearchQuery'
  | 'normalizedSessionSearchQuery'
  | 'groupSearchDataByGroup'
  | 'collapsedGroups'
  | 'hideDirectoryControls'
  | 'mobileVariant'
  | 'alwaysShowActions'
  | 'activeProjectId'
  | 'notifyOnSubtasks'
  | 'expandedParents'
  | 'editTitle'
  | 'copiedSessionId'
  | 'folderRename'
  | 'setFolderRenameDraft'
  | 'clearFolderRename'
  | 'setEditingId'
  | 'setEditTitle'
  | 'toggleParent'
  | 'allowReselect'
  | 'onSessionSelected'
  | 'isSessionSearchOpen'
  | 'sessionSearchQuery'
  | 'setSessionSearchQuery'
  | 'setIsSessionSearchOpen'
  | 'deleteSessionConfirm'
  | 'setDeleteSessionConfirm'
  | 'startFolderRename'
  | 'setCopiedSessionId'
  | 'startSessionWorktreeMenuLoad'
> & {
  pinnedSessionIds: Set<string>;
  sessionOrderIndex: Map<string, number>;
};

type SessionProjectScrollerGroupActions = Pick<SessionGroupSectionProps,
  | 'showMoreGroupSessions'
  | 'resetGroupSessionLimit'
  | 'setActiveProjectIdOnly'
  | 'setSessionSwitcherOpen'
  | 'openNewSessionDraft'
  | 'onToggleCollapsedGroup'
>;

type SessionProjectScrollerModel = {
  topContent?: React.ReactNode;
  /**
   * Whether the top content itself holds search results. The managed chats
   * render only there, so without this the "no project section matched" branch
   * below would drop a matching chat and claim there is nothing to show.
   */
  topContentHasSearchMatches?: boolean;
  sectionsForRender: ProjectSection[];
  projectSections: ProjectSection[];
  activeProjectId: string | null;
  singleProjectMode: boolean;
  singleProjectId: string | null;
  emptyState: React.ReactNode;
  searchEmptyState: React.ReactNode;
  projectRepoStatus: Map<string, boolean | null>;
  state: SessionProjectScrollerState;
  groupProps: SessionProjectScrollerGroupProps;
};

type SessionProjectScrollerView = {
  homeDirectory: string | null;
  collapsedProjects: Set<string>;
  showOnlyMainWorkspace: boolean;
  hasSessionSearchQuery: boolean;
  normalizedSessionSearchQuery: string;
  hideDirectoryControls: boolean;
  stickyZoneHeaders: boolean;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  projectSortOrder: ProjectSortOrder;
};

type SessionProjectScrollerActions = {
  group: SessionProjectScrollerGroupActions;
  toggleProject: (id: string) => void;
  setActiveProjectIdOnly: (id: string) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
  openNewSessionDraft: (options?: { selectedProjectId?: string | null; directoryOverride?: string | null }) => void;
  openNewWorktreeDialog: () => void;
  openWorktreesPage: (id: string) => void;
  openProjectEditDialog: (id: string) => void;
  removeProject: (id: string) => void;
  reorderProjects: (fromIndex: number, toIndex: number) => void;
  setGroupOrderByProject: React.Dispatch<React.SetStateAction<Map<string, string[]>>>;
  renderProjectStatusIndicator?: (projectId: string, groups: SessionGroup[]) => React.ReactNode;
  setSingleProjectId: (id: string) => void;
};

type Props = {
  model: SessionProjectScrollerModel;
  view: SessionProjectScrollerView;
  actions: SessionProjectScrollerActions;
};

const getProjectLabel = (project: ProjectSection['project'], homeDirectory: string | null): string => (
  formatProjectLabel(
    project.label?.trim()
    || formatDirectoryName(project.normalizedPath, homeDirectory)
    || project.normalizedPath,
  )
);

function SessionProjectScrollerComponent(props: Props): React.ReactNode {
  streamPerfCount('ui.sidebar_projects_list.render');
  const { t } = useI18n();
  const { model, view, actions } = props;
  const isInlineEditing = model.state.editingId !== null;
  const [isProjectDragging, setIsProjectDragging] = React.useState(false);
  const projectSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const groupSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  // Threaded into SessionGroupSection so the archived-bucket virtualizer
  // can resolve the scrolling ancestor synchronously (no getComputedStyle
  // walk) and skip the cost of a style recalc on every render.
  const scrollContainerRef = React.useRef<HTMLElement | null>(null);
  const renderedSections = selectRenderedProjectSections(
    model.sectionsForRender,
    model.singleProjectMode,
    model.singleProjectId,
  );
  const projectPickerOptions = React.useMemo(() => model.projectSections.map((section) => ({
    id: section.project.id,
    projectLabel: getProjectLabel(section.project, view.homeDirectory),
    projectDescription: formatPathForDisplay(section.project.normalizedPath, view.homeDirectory),
    projectIcon: section.project.icon,
    projectColor: section.project.color,
    projectIconImage: section.project.iconImage,
    projectIconBackground: section.project.iconBackground,
  })), [model.projectSections, view.homeDirectory]);

  return (
    // [overflow-anchor:none] — the browser's native scroll anchoring otherwise
    // latches onto content BELOW a growing session group (e.g. the "Show more"
    // button) and holds it in place, which makes newly revealed sessions look
    // like they insert upward. With anchoring off, scrollTop stays put and new
    // rows appear below naturally.
    <div className="relative flex min-h-0 flex-1">
      <CrossfadeZoneHeaders
        enabled={view.stickyZoneHeaders}
        suspended={isProjectDragging}
        layoutKey={renderedSections.map((section) => section.project.id).join(':')}
        scrollRef={scrollContainerRef}
      >
      <ScrollableOverlay
        ref={scrollContainerRef}
        useScrollShadow
        hideTopScrollShadow
        scrollShadowSize={96}
        outerClassName="flex-1 min-h-0"
        className="oc-sidebar-scroller space-y-1.5 pb-1 pl-2.5 pr-2 [overflow-anchor:none]"
      >
      {model.projectSections.length === 0 ? <>{model.topContent}{model.emptyState}</> : model.sectionsForRender.length === 0 ? (
        resolveSearchResultPlacement(model.topContentHasSearchMatches === true) === 'top-content'
          ? model.topContent
          : model.searchEmptyState
      ) : <>
      {model.topContent}
      {view.showOnlyMainWorkspace ? (
        <div className="space-y-[0.6rem] py-1">
          {(() => {
            const activeSection = renderedSections.find((section) => section.project.id === model.activeProjectId) ?? renderedSections[0];
            if (!activeSection) {
              return view.hasSessionSearchQuery ? model.searchEmptyState : model.emptyState;
            }
            const descriptors = buildGroupRenderDescriptors(activeSection, { mainWorkspaceOnly: true });
            if (!descriptors.length) {
              return <div className="py-1 text-left typography-micro text-muted-foreground">{t('sessions.sidebar.empty.noSessions.title')}</div>;
            }
            return descriptors.map(({ group, groupKey, projectId, hideGroupLabel }) => {
              return (
                <React.Fragment key={groupKey}>
                  <SessionGroupSection {...model.groupProps} {...actions.group} editingId={model.state.editingId} openSidebarMenuKey={model.state.openSidebarMenuKey} setOpenSidebarMenuKey={model.state.setOpenSidebarMenuKey} group={group} groupKey={groupKey} projectId={projectId} hideGroupLabel={hideGroupLabel} visibleSessionCount={model.state.visibleSessionCountByGroup.get(groupKey)} compactBodyPadding scrollContainerRef={scrollContainerRef} />
                </React.Fragment>
              );
            });
          })()}
        </div>
      ) : (
        <DndContext
          sensors={projectSensors}
          collisionDetection={closestCenter}
          onDragStart={() => setIsProjectDragging(true)}
          onDragCancel={() => setIsProjectDragging(false)}
          onDragEnd={(event) => {
             setIsProjectDragging(false);
             if (isInlineEditing) return;
            // Drag only allowed in manual sort mode - indices from visual order don't match store order in other modes
            if (view.projectSortOrder !== 'manual') return;
            const { active, over } = event;
            if (!over || active.id === over.id) return;
            const oldIndex = model.sectionsForRender.findIndex((section) => section.project.id === active.id);
            const newIndex = model.sectionsForRender.findIndex((section) => section.project.id === over.id);
            if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
            actions.reorderProjects(oldIndex, newIndex);
          }}
        >
            <SortableContext items={renderedSections.map((section) => section.project.id)} strategy={verticalListSortingStrategy}>
            {renderedSections.map((section) => {
              const project = section.project;
              const projectKey = project.id;
              const projectLabel = getProjectLabel(project, view.homeDirectory);
              const projectDescription = formatPathForDisplay(project.normalizedPath, view.homeDirectory);
              const isCollapsed = model.singleProjectMode ? false : view.collapsedProjects.has(projectKey);
              const isRepo = model.projectRepoStatus.get(projectKey);

              return (
                <SortableProjectItem
                  key={projectKey}
                  id={projectKey}
                  disabled={model.singleProjectMode || view.projectSortOrder !== 'manual'}
                  projectLabel={projectLabel}
                  projectDescription={projectDescription}
                  projectDirectory={project.normalizedPath}
                  projectIcon={project.icon}
                  projectColor={project.color}
                  projectIconImage={project.iconImage}
                  projectIconBackground={project.iconBackground}
                  isCollapsed={isCollapsed}
                  isRepo={Boolean(isRepo)}
                  hideDirectoryControls={view.hideDirectoryControls}
                  mobileVariant={view.mobileVariant}
                  alwaysShowActions={view.alwaysShowActions}
                   statusIndicator={isCollapsed ? actions.renderProjectStatusIndicator?.(projectKey, section.groups) : null}
                    openSidebarMenuKey={model.state.openSidebarMenuKey}
                  setOpenSidebarMenuKey={model.state.setOpenSidebarMenuKey}
                  projectPickerOptions={model.singleProjectMode ? projectPickerOptions : undefined}
                  onProjectSelect={model.singleProjectMode ? actions.setSingleProjectId : undefined}
                  onToggle={() => { if (!model.singleProjectMode) actions.toggleProject(projectKey); }}
                  onNewSession={() => {
                    if (projectKey !== model.activeProjectId) actions.setActiveProjectIdOnly(projectKey);
                    if (view.mobileVariant) actions.setSessionSwitcherOpen(false);
                    actions.openNewSessionDraft({
                      selectedProjectId: projectKey,
                      directoryOverride: project.normalizedPath,
                    });
                  }}
                  onNewWorktreeSession={() => {
                    if (projectKey !== model.activeProjectId) actions.setActiveProjectIdOnly(projectKey);
                    actions.openNewWorktreeDialog();
                  }}
                  onManageWorktrees={() => actions.openWorktreesPage(projectKey)}
                  onRenameStart={() => actions.openProjectEditDialog(projectKey)}
                  onClose={() => actions.removeProject(projectKey)}
                  showCreateButtons
                 >
                  {!isCollapsed ? (
                    <div className="space-y-0 pt-0.5 pb-0.5">
                      {(() => {
                         const orderedGroups = section.groups;
                        const rootGroup = orderedGroups.find((group) => group.isMain) ?? null;
                        const nestedGroups = rootGroup
                          ? orderedGroups.filter((group) => group.id !== rootGroup.id)
                          : orderedGroups;
                        return (
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
                                 actions.setGroupOrderByProject((prev) => {
                                const map = new Map(prev);
                                map.set(projectKey, next);
                                return map;
                              });
                            }}
                          >
                            {/* Root/flat sessions render directly under the
                                project zone header; worktree and archived
                                groups keep their own slim sortable sub-header. */}
                              {rootGroup ? <SessionGroupSection {...model.groupProps} {...actions.group} editingId={model.state.editingId} openSidebarMenuKey={model.state.openSidebarMenuKey} setOpenSidebarMenuKey={model.state.setOpenSidebarMenuKey} group={rootGroup} groupKey={`${projectKey}:${rootGroup.id}`} projectId={projectKey} hideGroupLabel visibleSessionCount={model.state.visibleSessionCountByGroup.get(`${projectKey}:${rootGroup.id}`)} scrollContainerRef={scrollContainerRef} /> : null}
                            <SortableContext items={nestedGroups.map((group) => group.id)} strategy={verticalListSortingStrategy}>
                              {nestedGroups.map((group) => {
                                const groupKey = `${projectKey}:${group.id}`;
                                return (
                                   <SortableGroupItem key={group.id} id={group.id} disabled={isInlineEditing}>
                                      {(dragHandleProps) => <SessionGroupSection {...model.groupProps} {...actions.group} editingId={model.state.editingId} openSidebarMenuKey={model.state.openSidebarMenuKey} setOpenSidebarMenuKey={model.state.setOpenSidebarMenuKey} group={group} groupKey={groupKey} projectId={projectKey} visibleSessionCount={model.state.visibleSessionCountByGroup.get(groupKey)} dragHandleProps={dragHandleProps} scrollContainerRef={scrollContainerRef} />}
                                  </SortableGroupItem>
                                );
                              })}
                            </SortableContext>
                            <DragOverlay dropAnimation={null} />
                          </DndContext>
                        );
                      })()}
                    </div>
                  ) : null}
                </SortableProjectItem>
              );
            })}
          </SortableContext>
          <DragOverlay dropAnimation={null} />
        </DndContext>
      )}
      </>}
      </ScrollableOverlay>
      </CrossfadeZoneHeaders>
    </div>
  );
}

export const SessionProjectScroller = React.memo(SessionProjectScrollerComponent);
