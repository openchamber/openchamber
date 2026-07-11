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
  batchSize?: number;
  /** Right-side chrome on the section title row (e.g. display-mode equalizer). */
  headerAccessory?: React.ReactNode;
};

type RenderExtras = SessionNodeRenderExtras;

const MAX_VISIBLE_RECENT_SESSIONS = 7;

export function SidebarActivitySections({
  sections,
  renderSessionNode,
  currentSessionId,
  editingId,
  openSidebarMenuKey,
  variant = 'section',
  initialVisibleCount = MAX_VISIBLE_RECENT_SESSIONS,
  batchSize = MAX_VISIBLE_RECENT_SESSIONS,
  headerAccessory,
}: Props): React.ReactNode {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const [visibleCountBySection, setVisibleCountBySection] = React.useState<Map<string, number>>(new Map());
  const recentFocusSessionId = useSessionFocusStore((state) => (
    state.focus?.scope === 'recent' ? state.focus.sessionId : null
  ));
  const flatVariant = variant === 'flat';

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

    const requiredCount = targetIndex + 1;
    setVisibleCountBySection((prev) => {
      const currentCount = Math.max(initialVisibleCount, prev.get(section.key) ?? initialVisibleCount);
      if (currentCount >= requiredCount) {
        return prev;
      }
      const next = new Map(prev);
      next.set(section.key, requiredCount);
      return next;
    });
  }, [initialVisibleCount, recentFocusSessionId, sections]);

  const resetSectionLimit = React.useCallback((key: string) => {
    setVisibleCountBySection((prev) => {
      if (!prev.has(key)) {
        return prev;
      }
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const toggleSection = React.useCallback((key: string) => {
    // Collapsing/expanding resets any "show more" batches, matching the
    // worktree/project group behavior.
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

  const showMoreSessions = React.useCallback((key: string, currentVisibleCount: number, totalCount: number) => {
    setVisibleCountBySection((prev) => {
      const nextVisibleCount = Math.min(totalCount, currentVisibleCount + batchSize);
      const next = new Map(prev);
      next.set(key, nextVisibleCount);
      return next;
    });
  }, [batchSize]);

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
        const visibleLimit = Math.max(
          initialVisibleCount,
          visibleCountBySection.get(section.key) ?? initialVisibleCount,
        );
        const visibleItems = section.items.slice(0, visibleLimit);
        const remainingCount = section.items.length - visibleItems.length;
        const canShowFewer = !flatVariant && section.items.length > initialVisibleCount && remainingCount === 0;
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
              {remainingCount > 0 ? (
                <button
                  type="button"
                  onClick={() => showMoreSessions(section.key, visibleItems.length, section.items.length)}
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
                {remainingCount > 0 ? (
                  <button
                    type="button"
                    onClick={() => showMoreSessions(section.key, visibleItems.length, section.items.length)}
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
