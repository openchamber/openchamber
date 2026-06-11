import React from 'react';
import { cn } from '@/lib/utils';
import type { SessionNode } from './types';
import { useI18n } from '@/lib/i18n';
import { Icon } from "@/components/icon/Icon";

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
  renderSessionNode: (node: SessionNode, depth?: number, groupDirectory?: string | null, projectId?: string | null, archivedBucket?: boolean, secondaryMeta?: { projectLabel?: string | null; branchLabel?: string | null } | null, renderContext?: 'project' | 'recent') => React.ReactNode;
  variant?: 'section' | 'flat';
  initialVisibleCount?: number;
  batchSize?: number;
};

const MAX_VISIBLE_RECENT_SESSIONS = 7;

export function SidebarActivitySections({
  sections,
  renderSessionNode,
  variant = 'section',
  initialVisibleCount = MAX_VISIBLE_RECENT_SESSIONS,
  batchSize = MAX_VISIBLE_RECENT_SESSIONS,
}: Props): React.ReactNode {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const [visibleCountBySection, setVisibleCountBySection] = React.useState<Map<string, number>>(new Map());
  const flatVariant = variant === 'flat';

  const toggleSection = React.useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const showMoreSessions = React.useCallback((key: string, currentVisibleCount: number, totalCount: number) => {
    setVisibleCountBySection((prev) => {
      const nextVisibleCount = flatVariant
        ? Math.min(totalCount, currentVisibleCount + batchSize)
        : totalCount;
      const next = new Map(prev);
      next.set(key, nextVisibleCount);
      return next;
    });
  }, [batchSize, flatVariant]);

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

        if (flatVariant) {
          return (
            <div key={section.key} className="space-y-0.5">
              {visibleItems.map((item) => renderSessionNode(item.node, 0, item.groupDirectory, item.projectId, false, item.secondaryMeta, 'recent'))}
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
                {visibleItems.map((item) => renderSessionNode(item.node, 0, item.groupDirectory, item.projectId, false, item.secondaryMeta, 'recent'))}
                {remainingCount > 0 ? (
                  <button
                    type="button"
                    onClick={() => showMoreSessions(section.key, visibleItems.length, section.items.length)}
                    className="mt-0.5 flex items-center justify-start rounded-md px-1.5 py-0.5 text-left text-xs text-muted-foreground/70 leading-tight hover:text-foreground hover:underline"
                  >
                    {remainingCount === 1
                      ? t('sessions.sidebar.group.showMoreSingle', { count: remainingCount })
                      : t('sessions.sidebar.group.showMorePlural', { count: remainingCount })}
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
