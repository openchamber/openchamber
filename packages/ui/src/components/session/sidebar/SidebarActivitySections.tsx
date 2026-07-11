import React from 'react';
import { cn } from '@/lib/utils';
import type { SessionNode } from './types';
import { useI18n } from '@/lib/i18n';
import {
  collectSubtreeContainingId,
  computeNodeStructureKey,
  resolveMenuOpenSessionId,
} from './sessionNodeItemUtils';
import type { SessionNodeRenderExtras } from './sessionNodeItemUtils';
import { SidebarSectionHeader } from './SidebarSectionHeader';
import { SIDEBAR_MUTED_HINT_CLASS } from './utils';
import { useSessionFocusStore } from '@/stores/useSessionFocusStore';
import {
  getRecentNavigationVisibleCount,
  getRecentSectionDisplayState,
  RECENT_SESSION_INITIAL_VISIBLE_COUNT,
} from './activitySections';

type ActivityItem = {
  node: SessionNode;
  projectId: string | null;
  groupDirectory: string | null;
  secondaryMeta: {
    projectLabel?: string | null;
    branchLabel?: string | null;
  } | null;
};

type ActivitySection = {
  key: 'active-now';
  title: string;
  items: ActivityItem[];
};

type Props = {
  sections: ActivitySection[];
  renderSessionNode: (
    node: SessionNode,
    depth?: number,
    groupDirectory?: string | null,
    projectId?: string | null,
    archivedBucket?: boolean,
    secondaryMeta?: { projectLabel?: string | null; branchLabel?: string | null } | null,
    renderContext?: 'project' | 'recent',
    renderExtras?: SessionNodeRenderExtras,
  ) => React.ReactNode;
  currentSessionId: string | null;
  editingId: string | null;
  openSidebarMenuKey: string | null;
  variant?: 'section' | 'flat';
  initialVisibleCount?: number;
  /** Right-side chrome on the section title row (e.g. display-mode equalizer). */
  headerAccessory?: React.ReactNode;
  /** Publishes the exact root-session rows currently revealed by collapse/Show more state. */
  onVisibleSessionIdsChange?: (sessionIds: readonly string[]) => void;
};

type RenderExtras = SessionNodeRenderExtras;

export function SidebarActivitySections({
  sections,
  renderSessionNode,
  currentSessionId,
  editingId,
  openSidebarMenuKey,
  variant = 'section',
  initialVisibleCount = RECENT_SESSION_INITIAL_VISIBLE_COUNT,
  headerAccessory,
  onVisibleSessionIdsChange,
}: Props): React.ReactNode {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const [expandedSections, setExpandedSections] = React.useState<Set<string>>(new Set());
  const recentFocusSessionId = useSessionFocusStore((state) => (
    state.focus?.scope === 'recent' ? state.focus.sessionId : null
  ));
  const flatVariant = variant === 'flat';

  const visibleSessionIds = React.useMemo(() => visibleSectionsForShortcutPublishing({
    sections,
    collapsed,
    expandedSections,
    initialVisibleCount,
    flatVariant,
  }), [collapsed, expandedSections, flatVariant, initialVisibleCount, sections]);

  React.useLayoutEffect(() => {
    onVisibleSessionIdsChange?.(visibleSessionIds);
  }, [onVisibleSessionIdsChange, visibleSessionIds]);

  React.useLayoutEffect(() => {
    if (!recentFocusSessionId) {
      return;
    }
    const section = sections.find((candidate) => (
      candidate.items.some((item) => item.node.session.id === recentFocusSessionId)
    ));
    if (!section) {
      return;
    }
    const targetIndex = section.items.findIndex((item) => item.node.session.id === recentFocusSessionId);
    if (targetIndex < 0) {
      return;
    }

    setCollapsed((prev) => {
      if (!prev.has(section.key)) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(section.key);
      return next;
    });

    // Keyboard navigation into a hidden Recent row behaves exactly like
    // pressing Show more: reveal the entire bounded Recent list at once.
    const requiredCount = getRecentNavigationVisibleCount(
      targetIndex,
      initialVisibleCount,
      section.items.length,
    );
    if (requiredCount <= initialVisibleCount) {
      return;
    }
    setExpandedSections((prev) => {
      if (prev.has(section.key)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(section.key);
      return next;
    });
  }, [initialVisibleCount, recentFocusSessionId, sections]);

  const resetSectionLimit = React.useCallback((key: string) => {
    setExpandedSections((prev) => {
      if (!prev.has(key)) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const toggleSection = React.useCallback((key: string) => {
    // Collapsing/expanding resets the bounded Recent list to its short form.
    resetSectionLimit(key);
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, [resetSectionLimit]);

  const showMoreSessions = React.useCallback((key: string) => {
    setExpandedSections((prev) => {
      if (prev.has(key)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, []);

  const buildRenderExtras = React.useCallback((nodes: SessionNode[]) => {
    const subtreeContainsActive = new Set<string>();
    collectSubtreeContainingId(nodes, currentSessionId, subtreeContainsActive);
    const subtreeContainsEditing = new Set<string>();
    collectSubtreeContainingId(nodes, editingId, subtreeContainsEditing);
    const menuOpenSessionId = resolveMenuOpenSessionId(nodes, openSidebarMenuKey, 'recent', false);
    const nodeStructureKeyByNode = new WeakMap<SessionNode, string>();
    const visit = (node: SessionNode): void => {
      nodeStructureKeyByNode.set(node, computeNodeStructureKey(node));
      node.children.forEach(visit);
    };
    nodes.forEach(visit);

    const childRenderExtrasFor = (child: SessionNode): RenderExtras => ({
      subtreeContainsActive,
      subtreeContainsEditing,
      menuOpenSessionId,
      nodeStructureKey: nodeStructureKeyByNode.get(child) ?? '',
      childRenderExtrasFor,
    });

    return (node: SessionNode): RenderExtras => ({
      subtreeContainsActive,
      subtreeContainsEditing,
      menuOpenSessionId,
      nodeStructureKey: nodeStructureKeyByNode.get(node) ?? '',
      childRenderExtrasFor,
    });
  }, [currentSessionId, editingId, openSidebarMenuKey]);

  // Keep the section header (and its accessory) even when Recent is empty so
  // display-mode controls stay reachable on the "最近" row.
  const visibleSections = sections.filter((section) => section.items.length > 0 || Boolean(headerAccessory));
  if (visibleSections.length === 0) {
    return null;
  }

  return (
    <div className={cn(flatVariant ? 'space-y-0.5 pb-1' : 'pb-1')}>
      {visibleSections.map((section, sectionIndex) => {
        const isCollapsed = collapsed.has(section.key);
        const isExpanded = expandedSections.has(section.key);
        const displayState = getRecentSectionDisplayState(
          section.items.length,
          initialVisibleCount,
          isExpanded,
        );
        const visibleItems = section.items.slice(0, displayState.visibleCount);
        const canShowFewer = !flatVariant && displayState.canShowFewer;
        const getRenderExtras = buildRenderExtras(visibleItems.map((item) => item.node));
        const renderItem = (item: ActivityItem) => (
          <React.Fragment key={`${item.projectId ?? ''}:${item.node.session.id}`}>
            {renderSessionNode(
              item.node,
              0,
              item.groupDirectory,
              item.projectId,
              false,
              item.secondaryMeta,
              'recent',
              getRenderExtras(item.node),
            )}
          </React.Fragment>
        );

        if (flatVariant) {
          return (
            <div key={section.key} className="space-y-0.5">
              {visibleItems.map(renderItem)}
              {displayState.canShowMore ? (
                <button
                  type="button"
                  onClick={() => showMoreSessions(section.key)}
                  className={cn(SIDEBAR_MUTED_HINT_CLASS, 'hover:text-foreground hover:underline')}
                >
                  {t('sessions.sidebar.group.showMore')}
                </button>
              ) : null}
            </div>
          );
        }

        return (
          <div key={section.key}>
            <SidebarSectionHeader
              title={section.title}
              isFirst={sectionIndex === 0}
              onToggle={() => toggleSection(section.key)}
              expanded={!isCollapsed}
              accessory={headerAccessory}
            />
            {!isCollapsed ? (
              <div className="space-y-0.5">
                {visibleItems.map(renderItem)}
                {displayState.canShowMore ? (
                  <button
                    type="button"
                    onClick={() => showMoreSessions(section.key)}
                    className={cn(SIDEBAR_MUTED_HINT_CLASS, 'hover:text-foreground hover:underline')}
                  >
                    {t('sessions.sidebar.group.showMore')}
                  </button>
                ) : null}
                {canShowFewer ? (
                  <button
                    type="button"
                    onClick={() => resetSectionLimit(section.key)}
                    className={cn(SIDEBAR_MUTED_HINT_CLASS, 'hover:text-foreground hover:underline')}
                  >
                    {t('sessions.sidebar.group.showFewer')}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function visibleSectionsForShortcutPublishing({
  sections,
  collapsed,
  expandedSections,
  initialVisibleCount,
  flatVariant,
}: {
  sections: ActivitySection[];
  collapsed: Set<string>;
  expandedSections: Set<string>;
  initialVisibleCount: number;
  flatVariant: boolean;
}): string[] {
  const ids: string[] = [];
  sections.forEach((section) => {
    if (!flatVariant && collapsed.has(section.key)) return;
    const displayState = getRecentSectionDisplayState(
      section.items.length,
      initialVisibleCount,
      expandedSections.has(section.key),
    );
    section.items.slice(0, displayState.visibleCount).forEach((item) => ids.push(item.node.session.id));
  });
  return ids;
}
