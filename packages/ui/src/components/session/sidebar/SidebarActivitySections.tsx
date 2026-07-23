import React from 'react';
import { cn } from '@/lib/utils';
import type { SessionNode } from './types';
import { useI18n } from '@/lib/i18n';
import { Icon } from "@/components/icon/Icon";
import {
  collectSubtreeContainingId,
  computeNodeStructureKey,
  resolveMenuOpenSessionId,
} from './sessionNodeItemUtils';
import type { SessionNodeRenderExtras } from './sessionNodeItemUtils';

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
  editingId: string | null;
  openSidebarMenuKey: string | null;
  expansionState?: ReadonlySet<string>;
  variant?: 'section' | 'flat';
  initialVisibleCount?: number;
  batchSize?: number;
};

type RenderExtras = SessionNodeRenderExtras;

const MAX_VISIBLE_RECENT_SESSIONS = 7;

export function SidebarActivitySections(props: Props): React.ReactNode {
  const {
    sections,
    renderSessionNode,
    editingId,
    openSidebarMenuKey,
    variant = 'section',
    initialVisibleCount = MAX_VISIBLE_RECENT_SESSIONS,
    batchSize = MAX_VISIBLE_RECENT_SESSIONS,
  } = props;
  const { t } = useI18n();
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const [visibleCountBySection, setVisibleCountBySection] = React.useState<Map<string, number>>(new Map());
  const flatVariant = variant === 'flat';

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
      subtreeContainsEditing,
      menuOpenSessionId,
      nodeStructureKey: nodeStructureKeyByNode.get(child) ?? '',
      childRenderExtrasFor,
    });

    return (node: SessionNode): RenderExtras => ({
      subtreeContainsEditing,
      menuOpenSessionId,
      nodeStructureKey: nodeStructureKeyByNode.get(node) ?? '',
      childRenderExtrasFor,
    });
  }, [editingId, openSidebarMenuKey]);

  const visibleSections = sections.filter((section) => section.items.length > 0);
  if (visibleSections.length === 0) {
    return null;
  }

  return (
    <div className={cn(flatVariant ? 'space-y-0.5 pb-2' : 'space-y-2 pb-2 pt-1')}>
      {visibleSections.map((section) => {
        const isCollapsed = collapsed.has(section.key);
        const visibleLimit = Math.max(
          initialVisibleCount,
          visibleCountBySection.get(section.key) ?? initialVisibleCount,
        );
        const visibleItems = section.items.slice(0, visibleLimit);
        const remainingCount = section.items.length - visibleItems.length;
        const canShowFewer = !flatVariant && section.items.length > initialVisibleCount && remainingCount === 0;
        const getRenderExtras = buildRenderExtras(visibleItems.map((item) => item.node));
        const renderItem = (item: ActivityItem) => renderSessionNode(
          item.node,
          0,
          item.groupDirectory,
          item.projectId,
          false,
          item.secondaryMeta,
          'recent',
          getRenderExtras(item.node),
        );

        if (flatVariant) {
          return (
            <div key={section.key} className="space-y-0.5">
              {visibleItems.map(renderItem)}
              {remainingCount > 0 ? (
                <button
                  type="button"
                  onClick={() => showMoreSessions(section.key, visibleItems.length, section.items.length)}
                  className="mt-0.5 flex items-center justify-start rounded-md px-1.5 py-0.5 text-left text-xs text-muted-foreground/70 leading-tight hover:text-foreground hover:underline"
                >
                  {t('sessions.sidebar.group.showMore')}
                </button>
              ) : null}
            </div>
          );
        }

        return (
          <div key={section.key} className="space-y-1">
            <button
              type="button"
              onClick={() => toggleSection(section.key)}
              className="group flex w-full items-center gap-1 rounded-md px-0.5 py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              aria-expanded={!isCollapsed}
            >
              <span className="inline-flex h-4 w-4 items-center justify-center text-muted-foreground">
                {isCollapsed ? <Icon name="arrow-right-s" className="h-3.5 w-3.5" /> : <Icon name="arrow-down-s" className="h-3.5 w-3.5" />}
              </span>
              <span className="text-[14px] font-normal text-foreground/95">{section.title}</span>
            </button>
            {!isCollapsed ? (
              <div className={cn('space-y-0.5 pl-7')}>
                {visibleItems.map(renderItem)}
                {remainingCount > 0 ? (
                  <button
                    type="button"
                    onClick={() => showMoreSessions(section.key, visibleItems.length, section.items.length)}
                    className="mt-0.5 flex items-center justify-start rounded-md px-1.5 py-0.5 text-left text-xs text-muted-foreground/70 leading-tight hover:text-foreground hover:underline"
                  >
                    {t('sessions.sidebar.group.showMore')}
                  </button>
                ) : null}
                {canShowFewer ? (
                  <button
                    type="button"
                    onClick={() => resetSectionLimit(section.key)}
                    className="mt-0.5 flex items-center justify-start rounded-md px-1.5 py-0.5 text-left text-xs text-muted-foreground/70 leading-tight hover:text-foreground hover:underline"
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
