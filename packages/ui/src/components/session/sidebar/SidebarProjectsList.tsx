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
import { formatProjectLabel, SIDEBAR_MUTED_HINT_CLASS, getSidebarRowPaddingLeft } from './utils';
import { useI18n } from '@/lib/i18n';
import type { MainTab } from '@/stores/useUIStore';
import { SidebarSectionHeader } from './SidebarSectionHeader';

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
  sharedSessionsOnly?: boolean;
  hasSharedSessions?: boolean;
  sectionsForRender: ProjectSection[];
  projectSections: ProjectSection[];
  activeProjectId: string | null;
  showOnlyMainWorkspace: boolean;
  hasSessionSearchQuery: boolean;
  emptyState: React.ReactNode;
  searchEmptyState: React.ReactNode;
  renderGroupSessions: (
    group: SessionGroup,
    groupKey: string,
    projectId?: string | null,
    hideGroupLabel?: boolean,
    dragHandleProps?: SortableDragHandleProps | null,
    compactBodyPadding?: boolean,
    scrollContainerRef?: React.RefObject<HTMLElement | null>,
  ) => React.ReactNode;
  homeDirectory: string | null;
  collapsedProjects: Set<string>;
  hideDirectoryControls: boolean;
  projectRepoStatus: Map<string, boolean | null>;
  isDesktopShellRuntime: boolean;
  stuckProjectHeaders: Set<string>;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  toggleProject: (id: string) => void;
  setActiveProjectIdOnly: (id: string) => void;
  setActiveMainTab: (tab: MainTab) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
  openNewSessionDraft: (options?: { directoryOverride?: string | null }) => void;
  openNewWorktreeDialog: () => void;
  openProjectEditDialog: (id: string) => void;
  removeProject: (id: string) => void;
  projectHeaderSentinelRefs: React.MutableRefObject<Map<string, HTMLDivElement | null>>;
  projectReorderEnabled?: boolean;
  reorderProjects: (fromIndex: number, toIndex: number) => void;
  getOrderedGroups: (projectId: string, groups: SessionGroup[]) => SessionGroup[];
  setGroupOrderByProject: React.Dispatch<React.SetStateAction<Map<string, string[]>>>;
  openSidebarMenuKey: string | null;
  setOpenSidebarMenuKey: (key: string | null) => void;
  isInlineEditing: boolean;
  /** Project ids whose session directories are currently fetching. */
  loadingProjectIds: Set<string>;
  /** True while any project session refresh is in flight (focus reconcile gate). */
  isProjectSessionsSyncing: boolean;
};

export function SidebarProjectsList(props: Props): React.ReactNode {
  const { t } = useI18n();
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

  // Memoize the result of getOrderedGroups. The callback is stable
  // (deps: [groupOrderByProject]) and `section.groups` is a stable
  // reference from useSessionSidebarSections, but the caller discards
  // the result on every render and the callback allocates a new array
  // each time. With many projects and many sidebar re-renders this
  // builds O(P) arrays per render. The cache returns the same array
  // reference when the inputs haven't changed, so the downstream
  // orderedGroups.filter/find work and any consumer-memoization see a
  // stable reference.
  const orderedGroupsCacheRef = React.useRef<Map<string, { groups: SessionGroup[]; ordered: SessionGroup[] }>>(new Map());
  const orderedGroupsCacheGetOrderedGroupsRef = React.useRef<typeof props.getOrderedGroups>(props.getOrderedGroups);
  if (orderedGroupsCacheGetOrderedGroupsRef.current !== props.getOrderedGroups) {
    orderedGroupsCacheGetOrderedGroupsRef.current = props.getOrderedGroups;
    orderedGroupsCacheRef.current.clear();
  }
  const cachedGetOrderedGroups = (projectId: string, groups: SessionGroup[]): SessionGroup[] => {
    const cache = orderedGroupsCacheRef.current;
    const hit = cache.get(projectId);
    if (hit && hit.groups === groups) {
      return hit.ordered;
    }
    const ordered = props.getOrderedGroups(projectId, groups);
    cache.set(projectId, { groups, ordered });
    // Bound the cache so re-ordering projects (which replaces the
    // projects list and invalidates every projectId) doesn't grow
    // unboundedly.
    if (cache.size > 256) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
    return ordered;
  };

  if (props.sharedSessionsOnly) {
    return (
      <ScrollableOverlay useScrollShadow scrollShadowSize={96} outerClassName="flex-1 min-h-0" className={cn('space-y-1 px-3 pb-1', props.mobileVariant ? '' : '')}>
        {props.topContent}
        {!props.hasSharedSessions ? (props.hasSessionSearchQuery ? props.searchEmptyState : props.emptyState) : null}
      </ScrollableOverlay>
    );
  }

  if (props.projectSections.length === 0) {
    return <ScrollableOverlay useScrollShadow scrollShadowSize={96} outerClassName="flex-1 min-h-0" className={cn('space-y-1 px-3 pb-1', props.mobileVariant ? '' : '')}>{props.topContent}{props.emptyState}</ScrollableOverlay>;
  }

  if (props.sectionsForRender.length === 0) {
    return <ScrollableOverlay useScrollShadow scrollShadowSize={96} outerClassName="flex-1 min-h-0" className={cn('space-y-1 px-3 pb-1', props.mobileVariant ? '' : '')}>{props.searchEmptyState}</ScrollableOverlay>;
  }

  return (
    // [overflow-anchor:none] — the browser's native scroll anchoring otherwise
    // latches onto content BELOW a growing session group (e.g. the "Show more"
    // button) and holds it in place, which makes newly revealed sessions look
    // like they insert upward. With anchoring off, scrollTop stays put and new
    // rows appear below naturally.
    <ScrollableOverlay ref={scrollContainerRef} useScrollShadow scrollShadowSize={96} outerClassName="flex-1 min-h-0" className={cn('space-y-1 px-3 pb-1 [overflow-anchor:none]', props.mobileVariant ? '' : '')}>
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
              return <div className={SIDEBAR_MUTED_HINT_CLASS}>{t('sessions.sidebar.empty.noSessions.title')}</div>;
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
                  {props.renderGroupSessions(group, groupKey, activeSection.project.id, hideGroupLabel, null, true, scrollContainerRef)}
                </React.Fragment>
              );
            });
          })()}
        </div>
      ) : (
        <>
          {/* Codex-style section label above the project tree.
              Per-project loading lives on the folder icon + body placeholder;
              do not reintroduce a global "syncing sessions" accessory here. */}
          {!props.hasSessionSearchQuery ? (
            <SidebarSectionHeader
              title={t('sessions.sidebar.projectsTitle')}
              isFirst={!props.topContent}
            />
          ) : null}
          <DndContext
            sensors={projectSensors}
            collisionDetection={closestCenter}
            onDragEnd={(event) => {
              if (!props.projectReorderEnabled || props.isInlineEditing) return;
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
                const isSessionsLoading = props.loadingProjectIds.has(projectKey);
                const isRepo = props.projectRepoStatus.get(projectKey);
                const orderedGroups = cachedGetOrderedGroups(projectKey, section.groups);
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
                    isSessionsLoading={isSessionsLoading}
                    isRepo={Boolean(isRepo)}
                    isDesktopShell={props.isDesktopShellRuntime}
                    isStuck={props.stuckProjectHeaders.has(projectKey)}
                    hideDirectoryControls={props.hideDirectoryControls}
                    mobileVariant={props.mobileVariant}
                    alwaysShowActions={props.alwaysShowActions}
                    onToggle={() => props.toggleProject(projectKey)}
                    onNewSession={() => {
                      if (projectKey !== props.activeProjectId) props.setActiveProjectIdOnly(projectKey);
                      props.setActiveMainTab('chat');
                      if (props.mobileVariant) props.setSessionSwitcherOpen(false);
                      props.openNewSessionDraft({ directoryOverride: project.normalizedPath });
                    }}
                    onNewWorktreeSession={() => {
                      if (projectKey !== props.activeProjectId) props.setActiveProjectIdOnly(projectKey);
                      props.setActiveMainTab('chat');
                      props.openNewWorktreeDialog();
                    }}
                    onRenameStart={() => props.openProjectEditDialog(projectKey)}
                    onClose={() => props.removeProject(projectKey)}
                    sentinelRef={(el) => { props.projectHeaderSentinelRefs.current.set(projectKey, el); }}
                    showCreateButtons
                    openSidebarMenuKey={props.openSidebarMenuKey}
                    setOpenSidebarMenuKey={props.setOpenSidebarMenuKey}
                    reorderEnabled={props.projectReorderEnabled ?? false}
                  >
                    {!isCollapsed ? (
                      <div className="space-y-0 pt-0 pb-0.5">
                        {isSessionsLoading ? (
                          <div
                            className="box-border w-full py-1.5 text-left typography-ui-label font-normal text-muted-foreground/80 animate-pulse select-none"
                            style={{ paddingLeft: getSidebarRowPaddingLeft(1) }}
                            role="status"
                            aria-live="polite"
                          >
                            {t('sessions.sidebar.project.loadingSessions')}
                          </div>
                        ) : section.groups.length > 0 ? (
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
                            {rootGroup ? props.renderGroupSessions(rootGroup, `${projectKey}:${rootGroup.id}`, projectKey, true, null, undefined, scrollContainerRef) : null}
                            <SortableContext items={nestedGroups.map((group) => group.id)} strategy={verticalListSortingStrategy}>
                              {nestedGroups.map((group) => {
                                const groupKey = `${projectKey}:${group.id}`;
                                return (
                                  <SortableGroupItem key={group.id} id={group.id} disabled={props.isInlineEditing}>
                                    {(dragHandleProps) => props.renderGroupSessions(group, groupKey, projectKey, false, dragHandleProps, undefined, scrollContainerRef)}
                                  </SortableGroupItem>
                                );
                              })}
                            </SortableContext>
                            <DragOverlay dropAnimation={null} />
                          </DndContext>
                        ) : (
                          <div className={SIDEBAR_MUTED_HINT_CLASS}>{t('sessions.sidebar.empty.noSessions.title')}</div>
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
