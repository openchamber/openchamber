import React from 'react';
import { cn } from '@/lib/utils';
import type { SessionNode } from '../types';
import { useI18n } from '@/lib/i18n';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { Icon } from "@/components/icon/Icon";
import {
  collectSubtreeContainingId,
  computeNodeStructureKey,
  resolveMenuOpenSessionId,
} from '../sessions/sessionNodeItemUtils';
import type { SessionNodeRenderExtras } from '../sessions/sessionNodeItemUtils';
import { SessionTreeItem, type SessionTreeItemProps } from '../sessions/SessionTreeItem';

export type ActivityItem = {
  node: SessionNode;
  projectId: string | null;
  groupDirectory: string | null;
  secondaryMeta: {
    projectLabel?: string | null;
    branchLabel?: string | null;
  } | null;
};

type ActivitySection = {
  key: 'active-now' | 'chats';
  title: string;
  items: ActivityItem[];
};

type Props = {
  sections: ActivitySection[];
  expansionState?: ReadonlySet<string>;
  variant?: 'section' | 'flat';
  initialVisibleCount?: number;
  batchSize?: number;
  isDesktopShellRuntime: boolean;
  pinnedSessionIds: Set<string>;
  expandedParents: Set<string>;
  hasSessionSearchQuery: boolean;
  normalizedSessionSearchQuery: string;
  notifyOnSubtasks: boolean;
  editingId: string | null;
  editTitle: string;
  copiedSessionId: string | null;
  openSidebarMenuKey: string | null;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  onNewChat?: () => void;
  renderChatsSection?: (items: ActivityItem[]) => React.ReactNode;
} & Pick<SessionTreeItemProps,
  | 'setEditingId'
  | 'setEditTitle'
  | 'toggleParent'
  | 'setOpenSidebarMenuKey'
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
>;

type RenderExtras = SessionNodeRenderExtras;

const MAX_VISIBLE_RECENT_SESSIONS = 7;

export function SidebarActivitySections(props: Props): React.ReactNode {
  const {
    sections,
    variant = 'section',
    initialVisibleCount = MAX_VISIBLE_RECENT_SESSIONS,
    batchSize = MAX_VISIBLE_RECENT_SESSIONS,
  } = props;
  const { t } = useI18n();
  const { pinnedSessionIds } = props;
  const stickyZoneHeaders = useSessionDisplayStore((state) => state.stickyZoneHeaders);
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
    collectSubtreeContainingId(nodes, props.editingId, subtreeContainsEditing);
    const menuOpenSessionId = resolveMenuOpenSessionId(nodes, props.openSidebarMenuKey, 'recent', false);
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
  }, [props.editingId, props.openSidebarMenuKey]);

  const visibleSections = sections.filter((section) => section.items.length > 0 || section.key === 'chats');
  if (visibleSections.length === 0) {
    return null;
  }

  return (
    // No top padding: the recent header must start flush with the scroll
    // edge, otherwise it visually "bumps" a few pixels before sticking.
    <div className={cn(flatVariant ? 'space-y-0.5 pb-2' : 'space-y-2 pb-2')}>
      {visibleSections.map((section) => {
        const isCollapsed = collapsed.has(section.key);
        const visibleLimit = Math.max(
          initialVisibleCount,
          visibleCountBySection.get(section.key) ?? initialVisibleCount,
        );
        const visibleItems = section.items.slice(0, visibleLimit);
        const remainingCount = section.items.length - visibleItems.length;
        const usesCustomRenderer = section.key === 'chats' && Boolean(props.renderChatsSection);
        const canShowFewer = !usesCustomRenderer && !flatVariant && section.items.length > initialVisibleCount && remainingCount === 0;
        const getRenderExtras = buildRenderExtras(visibleItems.map((item) => item.node));
        const renderItem = (item: ActivityItem) => (
          <SessionTreeItem
            key={item.node.session.id}
            node={item.node}
            pinnedSessionIds={pinnedSessionIds}
            expandedParents={props.expandedParents}
            hasSessionSearchQuery={props.hasSessionSearchQuery}
            normalizedSessionSearchQuery={props.normalizedSessionSearchQuery}
            notifyOnSubtasks={props.notifyOnSubtasks}
            editingId={props.editingId}
            editTitle={props.editTitle}
            copiedSessionId={props.copiedSessionId}
            openSidebarMenuKey={props.openSidebarMenuKey}
            mobileVariant={props.mobileVariant}
            alwaysShowActions={props.alwaysShowActions}
            groupDirectory={item.groupDirectory}
            projectId={item.projectId}
            secondaryMeta={item.secondaryMeta}
            renderContext="recent"
            renderExtras={getRenderExtras(item.node)}
            setEditingId={props.setEditingId}
            setEditTitle={props.setEditTitle}
            toggleParent={props.toggleParent}
            setOpenSidebarMenuKey={props.setOpenSidebarMenuKey}
            allowReselect={props.allowReselect}
            onSessionSelected={props.onSessionSelected}
            isSessionSearchOpen={props.isSessionSearchOpen}
            sessionSearchQuery={props.sessionSearchQuery}
            setSessionSearchQuery={props.setSessionSearchQuery}
            setIsSessionSearchOpen={props.setIsSessionSearchOpen}
            deleteSessionConfirm={props.deleteSessionConfirm}
            setDeleteSessionConfirm={props.setDeleteSessionConfirm}
            startFolderRename={props.startFolderRename}
            setCopiedSessionId={props.setCopiedSessionId}
          />
        );

        if (flatVariant) {
          return (
            <div key={section.key} className="space-y-0.5">
              {visibleItems.map(renderItem)}
              {remainingCount > 0 ? (
                <button
                  type="button"
                  onClick={() => showMoreSessions(section.key, visibleItems.length, section.items.length)}
                  className="mt-0.5 flex items-center justify-start rounded-md pl-[26px] pr-1.5 py-0.5 text-left text-xs text-muted-foreground/70 leading-tight hover:text-foreground hover:underline"
                >
                  {t('sessions.sidebar.group.showMore')}
                </button>
              ) : null}
            </div>
          );
        }

        return (
          <div key={section.key} className="relative space-y-1">
            <div className={cn(
              'relative group/chats',
              '-ml-2.5 -mr-2',
              stickyZoneHeaders && 'sticky top-0 z-20 bg-sidebar',
            )} data-sidebar-sticky-header={stickyZoneHeaders ? 'true' : undefined}>
              <button
                type="button"
                onClick={() => toggleSection(section.key)}
                className={cn('group flex w-full items-center gap-1.5 py-1 pl-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50', section.key === 'chats' ? 'pr-10' : 'pr-3.5')}
                aria-expanded={!isCollapsed}
              >
                <span className="inline-flex h-3.5 w-3.5 items-center justify-center">
                  <Icon name={section.key === 'chats' ? 'chat-4' : 'history'} className={cn('h-3.5 w-3.5 text-muted-foreground/80', 'group-hover:hidden')} />
                  <span className="hidden h-3.5 w-3.5 items-center justify-center text-muted-foreground group-hover:inline-flex">
                    {isCollapsed ? <Icon name="arrow-right-s" className="h-3.5 w-3.5" /> : <Icon name="arrow-down-s" className="h-3.5 w-3.5" />}
                  </span>
                </span>
                <span className="text-[14px] font-semibold lowercase text-foreground">{section.title}</span>
              </button>
              {section.key === 'chats' && props.onNewChat ? (
                <button
                  type="button"
                  onClick={(event) => { event.stopPropagation(); props.onNewChat?.(); }}
                  className={cn('absolute right-0.5 top-1/2 z-10 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50', props.alwaysShowActions ? 'opacity-100' : 'opacity-0 pointer-events-none group-hover/chats:opacity-100 group-hover/chats:pointer-events-auto group-focus-within/chats:opacity-100 group-focus-within/chats:pointer-events-auto')}
                  aria-label={t('sessions.sidebar.header.actions.newSession')}
                >
                  <Icon name="add" className="h-4 w-4" />
                </button>
              ) : null}
            </div>
            {!isCollapsed ? (
              <div className={cn('space-y-0.5')}>
                {usesCustomRenderer ? props.renderChatsSection?.(section.items) : visibleItems.map(renderItem)}
                {!usesCustomRenderer && remainingCount > 0 ? (
                  <button
                    type="button"
                    onClick={() => showMoreSessions(section.key, visibleItems.length, section.items.length)}
                    className="mt-0.5 flex items-center justify-start rounded-md pl-[26px] pr-1.5 py-0.5 text-left text-xs text-muted-foreground/70 leading-tight hover:text-foreground hover:underline"
                  >
                    {t('sessions.sidebar.group.showMore')}
                  </button>
                ) : null}
                {canShowFewer ? (
                  <button
                    type="button"
                    onClick={() => resetSectionLimit(section.key)}
                    className="mt-0.5 flex items-center justify-start rounded-md pl-[26px] pr-1.5 py-0.5 text-left text-xs text-muted-foreground/70 leading-tight hover:text-foreground hover:underline"
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
