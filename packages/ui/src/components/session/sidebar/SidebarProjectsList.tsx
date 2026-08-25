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
import { ProjectHeaderIdentity, SortableGroupItem, SortableProjectItem } from './sortableItems';
import { formatProjectLabel } from './utils';
import { useI18n } from '@/lib/i18n';
import type { ProjectSortOrder } from '@/stores/useSessionDisplayStore';
import { streamPerfCount } from '@/stores/utils/streamDebug';
import { Icon } from '@/components/icon/Icon';

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

const TOP_FADE_MAX_SIZE = 48;
const TOP_FADE_MIN_SIZE = 32;
const TOP_FADE_CLEAR_MAX_SIZE = 24;
type ActivitySectionKey = 'chats' | 'active-now';

const readActivitySectionKey = (element: Element): ActivitySectionKey | null => {
  const key = element.getAttribute('data-sidebar-activity-sentinel');
  if (key === 'chats' || key === 'active-now') return key;
  return null;
};

const getProjectLabel = (project: ProjectSection['project'], homeDirectory: string | null): string => (
  formatProjectLabel(
    project.label?.trim()
    || formatDirectoryName(project.normalizedPath, homeDirectory)
    || project.normalizedPath,
  )
);

type Props = {
  topContent?: React.ReactNode;
  sharedSessionsOnly?: boolean;
  hasSharedSessions?: boolean;
  sectionsForRender: ProjectSection[];
  projectSections: ProjectSection[];
  projectPickerSections: ProjectSection[];
  activeProjectId: string | null;
  singleProjectMode: boolean;
  singleProjectId: string | null;
  setSingleProjectId: (id: string) => void;
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
  getOrderedGroups: (projectId: string, groups: SessionGroup[]) => SessionGroup[];
  setGroupOrderByProject: React.Dispatch<React.SetStateAction<Map<string, string[]>>>;
  renderProjectStatusIndicator?: (projectId: string, groups: SessionGroup[]) => React.ReactNode;
  homeDirectory: string | null;
  collapsedProjects: Set<string>;
  hideDirectoryControls: boolean;
  projectRepoStatus: Map<string, boolean | null>;
  isDesktopShellRuntime: boolean;
  stickyZoneHeaders: boolean;
  stuckProjectHeaders: Set<string>;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  toggleProject: (id: string) => void;
  setActiveProjectIdOnly: (id: string) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
  openNewSessionDraft: (options?: { selectedProjectId?: string | null; directoryOverride?: string | null }) => void;
  openNewWorktreeDialog: () => void;
  openWorktreesPage: (id: string) => void;
  openProjectEditDialog: (id: string) => void;
  removeProject: (id: string) => void;
  projectHeaderSentinelRefs: React.MutableRefObject<Map<string, HTMLDivElement | null>>;
  reorderProjects: (fromIndex: number, toIndex: number) => void;
  projectSortOrder: ProjectSortOrder;
  openSidebarMenuKey: string | null;
  setOpenSidebarMenuKey: (key: string | null) => void;
  isInlineEditing: boolean;
};

function SidebarProjectsListComponent(props: Props): React.ReactNode {
  streamPerfCount('ui.sidebar_projects_list.render');
  const { t } = useI18n();
  const enableStickyFade = props.isDesktopShellRuntime && props.stickyZoneHeaders && !props.singleProjectMode;
  const projectSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const groupSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );
  const selectedSingleProjectSection = props.singleProjectMode
    ? props.sectionsForRender.find((section) => section.project.id === props.singleProjectId)
    : null;
  const renderedProjectSections = props.singleProjectMode
    ? (selectedSingleProjectSection ? [selectedSingleProjectSection] : [])
    : props.sectionsForRender;
  const projectPickerOptions = React.useMemo(() => props.projectPickerSections.map((section) => ({
    id: section.project.id,
    projectLabel: getProjectLabel(section.project, props.homeDirectory),
    projectDescription: formatPathForDisplay(section.project.normalizedPath, props.homeDirectory),
    projectIcon: section.project.icon,
    projectColor: section.project.color,
    projectIconImage: section.project.iconImage,
    projectIconBackground: section.project.iconBackground,
  })), [props.homeDirectory, props.projectPickerSections]);

  // Memoize getOrderedGroups per project so downstream consumers see a stable
  // array reference while inputs are unchanged (avoids O(P) fresh arrays per
  // list render invalidating the memoized group subtrees).
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
    if (cache.size > 256) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
    return ordered;
  };

  // Threaded into SessionGroupSection so the archived-bucket virtualizer
  // can resolve the scrolling ancestor synchronously (no getComputedStyle
  // walk) and skip the cost of a style recalc on every render.
  const scrollContainerRef = React.useRef<HTMLElement | null>(null);
  const [leadingActivitySection, setLeadingActivitySection] = React.useState<ActivitySectionKey>('chats');
  // Keep per-scroll measurements out of React state so the interaction guard
  // can read the current fade boundary without rerendering the sidebar.
  const topFadeSizeRef = React.useRef(0);
  // Update the compositor-owned mask on every scroll, but cross the React
  // render boundary only when the sticky identity overlay appears or hides.
  const syncTopFade = React.useCallback((scroller: HTMLElement) => {
    const hasTopScroll = scroller.scrollTop > 1;
    const topFadeSize = hasTopScroll
      ? Math.min(TOP_FADE_MIN_SIZE + scroller.scrollTop, TOP_FADE_MAX_SIZE)
      : 0;
    topFadeSizeRef.current = topFadeSize;
    scroller.style.setProperty('--scroll-shadow-top-size', `${topFadeSize}px`);
    scroller.style.setProperty(
      '--scroll-shadow-top-clear-size',
      `${Math.min(Math.max(topFadeSize - 8, 0), TOP_FADE_CLEAR_MAX_SIZE)}px`,
    );
  }, []);
  const blockObscuredInteraction = React.useCallback((
    event: React.MouseEvent<HTMLDivElement> | React.PointerEvent<HTMLDivElement>,
  ) => {
    if ((event.target as Element).closest('[data-overlay-scrollbar-thumb], [data-sidebar-sticky-header]')) return;
    const eventY = event.clientY - event.currentTarget.getBoundingClientRect().top;
    if (eventY >= topFadeSizeRef.current) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);
  const hasProjectScroller = props.projectSections.length > 0 && renderedProjectSections.length > 0;
  React.useLayoutEffect(() => {
    if (enableStickyFade && hasProjectScroller && scrollContainerRef.current) {
      syncTopFade(scrollContainerRef.current);
    }
  }, [enableStickyFade, hasProjectScroller, syncTopFade]);
  React.useEffect(() => {
    const root = scrollContainerRef.current;
    if (!enableStickyFade || !root || !props.hasSharedSessions) return;

    const sentinels = Array.from(root.querySelectorAll<HTMLElement>('[data-sidebar-activity-sentinel]'));
    if (sentinels.length === 0) return;
    const stuckSections = new Set<ActivitySectionKey>();
    const syncLeadingSection = (): void => {
      let nextSection = sentinels[0] ? readActivitySectionKey(sentinels[0]) : null;
      for (const sentinel of sentinels) {
        const key = readActivitySectionKey(sentinel);
        if (key && stuckSections.has(key)) nextSection = key;
      }
      if (nextSection) setLeadingActivitySection((current) => current === nextSection ? current : nextSection);
    };
    const observer = new IntersectionObserver((entries) => {
      const rootTop = root.getBoundingClientRect().top;
      for (const entry of entries) {
        const key = readActivitySectionKey(entry.target);
        if (!key) continue;
        if (!entry.isIntersecting && entry.boundingClientRect.top < (entry.rootBounds?.top ?? rootTop)) {
          stuckSections.add(key);
        } else {
          stuckSections.delete(key);
        }
      }
      syncLeadingSection();
    }, { root, threshold: 0 });
    sentinels.forEach((sentinel) => observer.observe(sentinel));
    syncLeadingSection();
    return () => observer.disconnect();
  }, [enableStickyFade, props.hasSharedSessions, props.topContent]);
  let stuckProject: ProjectSection['project'] | null = null;
  for (const section of props.projectSections) {
    if (props.stuckProjectHeaders.has(section.project.id)) {
      stuckProject = section.project;
    }
  }
  // The IntersectionObserver reports the stuck header asynchronously, a frame or
  // two after the (synchronous) mask has already hidden the real header — which
  // otherwise leaves a one-frame gap where the title blinks out with no crisp
  // replacement. Seed the overlay with the topmost rendered project so it is
  // ready in the same frame; the observer then corrects it. When shared sessions
  // lead the list, the Recent fallback below owns the top instead of a project.
  const leadingProject =
    stuckProject ?? (props.hasSharedSessions ? null : renderedProjectSections[0]?.project ?? null);
  const leadingProjectLabel = leadingProject ? getProjectLabel(leadingProject, props.homeDirectory) : null;

  if (props.sharedSessionsOnly) {
    return (
      <ScrollableOverlay useScrollShadow scrollShadowSize={96} outerClassName="flex-1 min-h-0" className={cn('space-y-1 pb-1 pr-2', props.mobileVariant ? '' : '')}>
        {props.topContent}
        {!props.hasSharedSessions ? (props.hasSessionSearchQuery ? props.searchEmptyState : props.emptyState) : null}
      </ScrollableOverlay>
    );
  }

  if (props.projectSections.length === 0) {
    return <ScrollableOverlay useScrollShadow scrollShadowSize={96} outerClassName="flex-1 min-h-0" className={cn('space-y-1 pb-1 pl-2.5 pr-2', props.mobileVariant ? '' : '')}>{props.topContent}{props.emptyState}</ScrollableOverlay>;
  }

  if (props.sectionsForRender.length === 0) {
    return <ScrollableOverlay useScrollShadow scrollShadowSize={96} outerClassName="flex-1 min-h-0" className={cn('space-y-1 pb-1 pl-2.5 pr-2', props.mobileVariant ? '' : '')}>{props.searchEmptyState}</ScrollableOverlay>;
  }

  return (
    // [overflow-anchor:none] — the browser's native scroll anchoring otherwise
    // latches onto content BELOW a growing session group (e.g. the "Show more"
    // button) and holds it in place, which makes newly revealed sessions look
    // like they insert upward. With anchoring off, scrollTop stays put and new
    // rows appear below naturally.
    <div
      className="oc-sticky-fade-root relative flex min-h-0 flex-1"
      onPointerDownCapture={enableStickyFade ? blockObscuredInteraction : undefined}
      onClickCapture={enableStickyFade ? blockObscuredInteraction : undefined}
      onContextMenuCapture={enableStickyFade ? blockObscuredInteraction : undefined}
    >
    <ScrollableOverlay
      ref={scrollContainerRef}
      useScrollShadow
      hideTopScrollShadow={!enableStickyFade}
      scrollShadowSize={96}
      outerClassName="flex-1 min-h-0"
      className={cn('oc-sidebar-scroller oc-sticky-fade-scroller space-y-1.5 pb-1 pl-2.5 pr-2 [overflow-anchor:none]', props.mobileVariant ? '' : '')}
      style={enableStickyFade ? { '--scroll-shadow-top-size': '0px' } as React.CSSProperties : undefined}
      onScroll={enableStickyFade ? (event) => syncTopFade(event.currentTarget) : undefined}
    >
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
              return <div className="py-1 text-left typography-micro text-muted-foreground">{t('sessions.sidebar.empty.noSessions.title')}</div>;
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
        <DndContext
          sensors={projectSensors}
          collisionDetection={closestCenter}
          onDragEnd={(event) => {
            if (props.isInlineEditing) return;
            // Drag only allowed in manual sort mode - indices from visual order don't match store order in other modes
            if (props.projectSortOrder !== 'manual') return;
            const { active, over } = event;
            if (!over || active.id === over.id) return;
            const oldIndex = props.sectionsForRender.findIndex((section) => section.project.id === active.id);
            const newIndex = props.sectionsForRender.findIndex((section) => section.project.id === over.id);
            if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
            props.reorderProjects(oldIndex, newIndex);
          }}
        >
          <SortableContext items={renderedProjectSections.map((section) => section.project.id)} strategy={verticalListSortingStrategy}>
            {renderedProjectSections.map((section) => {
              const project = section.project;
              const projectKey = project.id;
              const projectLabel = getProjectLabel(project, props.homeDirectory);
              const projectDescription = formatPathForDisplay(project.normalizedPath, props.homeDirectory);
              const isCollapsed = props.singleProjectMode ? false : props.collapsedProjects.has(projectKey);
              const isRepo = props.projectRepoStatus.get(projectKey);

              return (
                <SortableProjectItem
                  key={projectKey}
                  id={projectKey}
                  disabled={props.singleProjectMode || props.projectSortOrder !== 'manual'}
                  projectLabel={projectLabel}
                  projectDescription={projectDescription}
                  projectIcon={project.icon}
                  projectColor={project.color}
                  projectIconImage={project.iconImage}
                  projectIconBackground={project.iconBackground}
                  isCollapsed={isCollapsed}
                  isRepo={Boolean(isRepo)}
                  isDesktopShell={props.isDesktopShellRuntime}
                  hideDirectoryControls={props.hideDirectoryControls}
                  mobileVariant={props.mobileVariant}
                  alwaysShowActions={props.alwaysShowActions}
                  statusIndicator={isCollapsed ? props.renderProjectStatusIndicator?.(projectKey, section.groups) : null}
                  onToggle={() => {
                    if (!props.singleProjectMode) props.toggleProject(projectKey);
                  }}
                  onNewSession={() => {
                    if (projectKey !== props.activeProjectId) props.setActiveProjectIdOnly(projectKey);
                    if (props.mobileVariant) props.setSessionSwitcherOpen(false);
                    props.openNewSessionDraft({
                      selectedProjectId: projectKey,
                      directoryOverride: project.normalizedPath,
                    });
                  }}
                  onNewWorktreeSession={() => {
                    if (projectKey !== props.activeProjectId) props.setActiveProjectIdOnly(projectKey);
                    props.openNewWorktreeDialog();
                  }}
                  onManageWorktrees={() => props.openWorktreesPage(projectKey)}
                  onRenameStart={() => props.openProjectEditDialog(projectKey)}
                  onClose={() => props.removeProject(projectKey)}
                  sentinelRef={(el) => { props.projectHeaderSentinelRefs.current.set(projectKey, el); }}
                  showCreateButtons
                  openSidebarMenuKey={props.openSidebarMenuKey}
                  setOpenSidebarMenuKey={props.setOpenSidebarMenuKey}
                  projectPickerOptions={props.singleProjectMode ? projectPickerOptions : undefined}
                  onProjectSelect={props.singleProjectMode ? props.setSingleProjectId : undefined}
                >
                  {!isCollapsed ? (
                    <div className="space-y-0 pt-0.5 pb-0.5">
                      {(() => {
                        const orderedGroups = cachedGetOrderedGroups(projectKey, section.groups);
                        const rootGroup = orderedGroups.find((group) => group.isMain) ?? null;
                        const nestedGroups = rootGroup
                          ? orderedGroups.filter((group) => group.id !== rootGroup.id)
                          : orderedGroups;
                        return (
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
                            {/* Root/flat sessions render directly under the
                                project zone header; worktree and archived
                                groups keep their own slim sortable sub-header. */}
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
    </ScrollableOverlay>
      {enableStickyFade && (leadingProject || props.hasSharedSessions) ? (
        <div
          className="oc-sticky-fade-overlay pointer-events-none absolute inset-x-0 top-0 z-30 flex items-center gap-1.5 py-1 pl-4 pr-5"
          aria-hidden="true"
        >
          {leadingProject && leadingProjectLabel ? (
            <ProjectHeaderIdentity
              id={leadingProject.id}
              projectLabel={leadingProjectLabel}
              projectIcon={leadingProject.icon}
              projectColor={leadingProject.color}
              projectIconImage={leadingProject.iconImage}
              projectIconBackground={leadingProject.iconBackground}
            />
          ) : (
            <>
              <Icon name={leadingActivitySection === 'chats' ? 'chat-4' : 'history'} className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/80" />
              <span className="truncate text-[14px] font-semibold lowercase text-foreground">
                {t(leadingActivitySection === 'chats'
                  ? 'sessions.sidebar.activity.chatsTitle'
                  : 'sessions.sidebar.activity.recentTitle')}
              </span>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

export const SidebarProjectsList = React.memo(SidebarProjectsListComponent);
