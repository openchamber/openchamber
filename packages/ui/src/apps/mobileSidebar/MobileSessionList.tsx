import React from 'react';
import type { SessionProjectListProps } from '@/components/session/sidebar/projects/SessionProjectScroller';
import {
  applyShowControl,
  getProjectLabel,
  grantGroupAccess,
  retryGroupStatus,
  toggleActivityZone,
  toggleProjectsCaption,
} from '@/components/session/sidebar/projects/sessionProjectListActions';
import { SessionSidebarRows } from '@/components/session/sidebar/SessionSidebarRows';
import type { SessionSidebarRow } from '@/components/session/sidebar/sessionSidebarRowModel';
import { isGroupWork } from '@/components/session/sidebar/works/sidebarWorks';
import type { SessionNode } from '@/components/session/sidebar/types';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useChildStoreManager } from '@/sync/sync-context';
import { MobileSessionRow } from './MobileSessionRow';
import { MobileFolderRow, MobileGroupHeader, MobileProjectHeader, MobileProjectsCaption, MobileStatusRow, MobileZoneHeader } from './MobileSectionRows';
import { MobileDraftRow, MobileRunRow, MobileWorktreeRow } from './MobileWorkRows';
import { MOBILE_TREE_GEOMETRY } from './mobileSidebarGeometry';
import { useMobileSidebarActions, useMobileSidebarRowsStore } from './mobileSidebarState';
import { MobileShowControl } from './mobileRowParts';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { SidebarConversationRow, SidebarSearchArchivedCaption, SidebarSearchShowMore, SidebarSearchMore } from '@/components/session/sidebar/SidebarConversationRow';

const FLAT_TEXT_INSET_PX = 12;
const NO_FIRST_VISIBLE = (): void => undefined;

const nodeHolds = (nodes: readonly SessionNode[], sessionId: string): boolean => nodes.some((node) => (
  node.session.id === sessionId || nodeHolds(node.children, sessionId)
));

const findCurrentRowIndex = (
  rows: readonly SessionSidebarRow[],
  current: { sessionId: string | null; runKey: string | null; projectId: string | null },
): number => {
  const { sessionId, runKey, projectId } = current;
  if (runKey) {
    const index = rows.findIndex((row) => row.kind === 'run' && row.run.key === runKey);
    if (index >= 0) return index;
  }
  if (sessionId) {
    const index = rows.findIndex((row) => (
      (row.kind === 'session' && row.node.session.id === sessionId)
      || (row.kind === 'run' && row.run.memberIds.includes(sessionId))
      || (row.kind === 'group-header' && nodeHolds(row.group.sessions, sessionId))
    ));
    if (index >= 0) return index;
  }
  return projectId ? rows.findIndex((row) => row.kind === 'project-header' && row.section.project.id === projectId) : -1;
};

export const MobileSessionList: React.FC<SessionProjectListProps> = ({ model, view, actions }) => {
  const { t } = useI18n();
  const phone = useMobileSidebarActions();
  const childStores = useChildStoreManager();
  const geometry = MOBILE_TREE_GEOMETRY;
  const [scrollElement, setScrollElement] = React.useState<HTMLElement | null>(null);
  const rows = model.rowModel.rows;

  React.useEffect(() => {
    useMobileSidebarRowsStore.getState().forgetUnlisted((key) => model.rowModel.rowIndexByKey.has(key));
  }, [model.rowModel.rowIndexByKey]);

  const renamingKey = useMobileSidebarRowsStore((state) => state.renamingKey);
  const pinnedRowIndexes = React.useMemo(() => {
    const index = renamingKey ? model.rowModel.rowIndexByKey.get(renamingKey) : undefined;
    return new Set(index === undefined ? [] : [index]);
  }, [model.rowModel.rowIndexByKey, renamingKey]);

  const [scrollRequest, setScrollRequest] = React.useState<{ index: number; id: number } | null>(null);
  const rowsRef = React.useRef(rows);
  rowsRef.current = rows;
  React.useEffect(() => {
    if (phone.openId === 0) return;
    const index = findCurrentRowIndex(rowsRef.current, {
      sessionId: useSessionUIStore.getState().currentSessionId,
      runKey: useUIStore.getState().runOverviewKey,
      projectId: model.groupProps.activeProjectId,
    });
    if (index >= 0) setScrollRequest({ index, id: phone.openId });
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [phone.openId]);

  const renderRow = React.useCallback((row: SessionSidebarRow): React.ReactNode => {
    switch (row.kind) {
      case 'activity-header':
        return <MobileZoneHeader row={row} onToggle={() => toggleActivityZone(row, { model, actions })} />;
      case 'caption':
        return <MobileProjectsCaption row={row} onToggle={() => toggleProjectsCaption(row, { model })} />;
      case 'project-header': {
        const project = row.section.project;
        return <MobileProjectHeader
          row={row}
          label={getProjectLabel(project, view.homeDirectory)}
          isRepo={Boolean(model.projectRepoStatus.get(project.id))}
          active={model.groupProps.activeProjectId === project.id}
          onToggle={() => actions.toggleProject(project.id)}
          onNewSession={() => {
            actions.setActiveProjectIdOnly(project.id);
            actions.openNewSessionDraft({ selectedProjectId: project.id, directoryOverride: project.normalizedPath });
            phone.close();
          }}
          onNewLead={() => {
            actions.setActiveProjectIdOnly(project.id);
            actions.openNewSessionDraft({ selectedProjectId: project.id, directoryOverride: project.normalizedPath, lead: true });
            phone.close();
          }}
          onRemove={() => actions.removeProject(project.id)}
        />;
      }
      case 'group-header':
        return isGroupWork(row.group)
          ? <MobileWorktreeRow row={row} geometry={geometry} onToggle={actions.group.onToggleCollapsedGroup} />
          : <MobileGroupHeader row={row} geometry={geometry} onToggle={actions.group.onToggleCollapsedGroup} />;
      case 'folder-header':
        return <MobileFolderRow row={row} geometry={geometry} />;
      case 'session':
        return <MobileSessionRow row={row} geometry={geometry} toggleParent={model.groupProps.toggleParent} />;
      case 'search-result':
        return <SidebarConversationRow result={row.result} context={row.context} mobile search={model.search} onOpened={phone.close} />;
      case 'search-archived-caption':
        return <SidebarSearchArchivedCaption />;
      case 'search-show-more':
        return <SidebarSearchShowMore mobile section={row.section} hidden={row.hidden} onShow={model.search?.showMore} />;
      case 'search-more':
        return <SidebarSearchMore mobile onLoadMore={() => model.search?.loadMore(row.section)} />;
      case 'run':
        return <MobileRunRow row={row} geometry={geometry} toggleParent={model.groupProps.toggleParent} />;
      case 'draft':
        return <MobileDraftRow row={row} geometry={geometry} />;
      case 'show-control':
        return <MobileShowControl
          more={row.more}
          fewer={row.fewer}
          hiddenNodes={row.hiddenNodes}
          indent={row.flat ? FLAT_TEXT_INSET_PX : row.detailed ? geometry.detailedLeft(row.depth ?? 0) : geometry.textLeft(row.depth ?? 0)}
          onShow={(control) => applyShowControl(row, control, { model, actions })}
        />;
      case 'status':
        return <MobileStatusRow
          row={row}
          indent={row.flat ? FLAT_TEXT_INSET_PX : row.detailed ? geometry.detailedLeft(row.depth ?? 0) : geometry.textLeft(row.depth ?? 0)}
          onRetry={() => retryGroupStatus(row, childStores)}
          onGrantAccess={() => { void grantGroupAccess(row, childStores); }}
        />;
      case 'empty':
        if (row.emptyKind === 'sidebar') return model.emptyState;
        if (row.emptyKind === 'search') return model.searchEmptyState;
        return <div className="py-1 typography-micro text-muted-foreground" style={{ paddingInlineStart: geometry.textLeft(row.depth ?? 0) }}>
          {row.emptyKind === 'section' ? t('sessions.sidebar.sections.empty') : t('sessions.sidebar.group.empty.noArchivedSessions')}
        </div>;
    }
  }, [actions, childStores, geometry, model, phone, t, view.homeDirectory]);

  return (
    <ScrollableOverlay ref={setScrollElement} outerClassName="min-h-0 flex-1" className="px-3 pb-4 [overflow-anchor:none]" useScrollShadow disableHorizontal>
      <SessionSidebarRows
        model={model.rowModel}
        scrollElement={scrollElement}
        pinnedRowIndexes={pinnedRowIndexes}
        renderRow={renderRow}
        onFirstVisibleIndexChange={NO_FIRST_VISIBLE}
        guideSlotStartPx={geometry.base}
        scrollRequest={scrollRequest}
      />
    </ScrollableOverlay>
  );
};
