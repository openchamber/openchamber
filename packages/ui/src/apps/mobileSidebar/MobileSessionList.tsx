import React from 'react';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import type { SessionProjectListProps } from '@/components/session/sidebar/projects/SessionProjectScroller';
import {
  applyShowControl,
  getProjectLabel,
  grantGroupAccess,
  retryGroupStatus,
  toggleActivityZone,
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
import { MobileFolderRow, MobileGroupHeader, MobileProjectHeader, MobileStatusRow, MobileZoneHeader } from './MobileSectionRows';
import { MobileDraftRow, MobileRunRow, MobileWorktreeRow } from './MobileWorkRows';
import { MOBILE_TREE_GEOMETRY } from './mobileSidebarGeometry';
import { useMobileSidebarActions, useMobileSidebarRowsStore } from './mobileSidebarState';
import { MobileShowControl } from './mobileRowParts';

// Rows that line up with gutterless two-line rows start this far in.
const FLAT_TEXT_INSET_PX = 12;
const NO_FIRST_VISIBLE = (): void => undefined;

const nodeHolds = (nodes: readonly SessionNode[], sessionId: string): boolean => nodes.some((node) => (
  node.session.id === sessionId || nodeHolds(node.children, sessionId)
));

/**
 * The row that shows where the user is: the open run's, the open session's
 * (or its folded work's), else the active project's header.
 */
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

/**
 * The phone's session list: the desktop's row model, drawn with the phone's
 * rows. Works, zones, folders and drafts are the desktop's; what a pointer
 * does on hover or with a right click, a thumb does with a swipe. Rows are
 * virtualized in the list's own scroller, as on the desktop.
 */
export const MobileSessionList: React.FC<SessionProjectListProps> = ({ model, view, actions }) => {
  const { t } = useI18n();
  const phone = useMobileSidebarActions();
  const childStores = useChildStoreManager();
  const geometry = MOBILE_TREE_GEOMETRY;
  const [scrollElement, setScrollElement] = React.useState<HTMLElement | null>(null);
  const rows = model.rowModel.rows;

  // A row that left the list takes its swipe and rename with it: a hidden
  // revealed row would swallow the next tap on a header and the drawer's
  // closing swipe.
  React.useEffect(() => {
    useMobileSidebarRowsStore.getState().forgetUnlisted((key) => model.rowModel.rowIndexByKey.has(key));
  }, [model.rowModel.rowIndexByKey]);

  // The row being renamed stays mounted while it scrolls out of view.
  const renamingKey = useMobileSidebarRowsStore((state) => state.renamingKey);
  const pinnedRowIndexes = React.useMemo(() => {
    const index = renamingKey ? model.rowModel.rowIndexByKey.get(renamingKey) : undefined;
    return new Set(index === undefined ? [] : [index]);
  }, [model.rowModel.rowIndexByKey, renamingKey]);

  // Each time the drawer opens, the row of what is on screen comes into view:
  // the list keeps its scroll between opens.
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
    // Once per opening: the rows changing while it is open must not scroll it.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [phone.openId]);

  const renderRow = React.useCallback((row: SessionSidebarRow): React.ReactNode => {
    switch (row.kind) {
      case 'activity-header':
        return <MobileZoneHeader row={row} onToggle={() => toggleActivityZone(row, { model, actions })} />;
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
      case 'run':
        return <MobileRunRow row={row} geometry={geometry} toggleParent={model.groupProps.toggleParent} />;
      case 'draft':
        return <MobileDraftRow row={row} geometry={geometry} />;
      case 'show-control':
        return <MobileShowControl
          more={row.control === 'more'}
          indent={row.flat ? FLAT_TEXT_INSET_PX : geometry.textLeft(row.depth ?? 0)}
          onClick={() => applyShowControl(row, { model, actions })}
        />;
      case 'status':
        return <MobileStatusRow
          row={row}
          indent={row.flat ? FLAT_TEXT_INSET_PX : geometry.textLeft(row.depth ?? 0)}
          onRetry={() => retryGroupStatus(row, childStores)}
          onGrantAccess={() => { void grantGroupAccess(row, childStores); }}
        />;
      case 'empty':
        if (row.emptyKind === 'sidebar') return model.emptyState;
        if (row.emptyKind === 'search') return model.searchEmptyState;
        return <div className="py-1 typography-micro text-muted-foreground" style={{ paddingInlineStart: geometry.textLeft(row.depth ?? 0) }}>
          {t('sessions.sidebar.group.empty.noArchivedSessions')}
        </div>;
    }
  }, [actions, childStores, geometry, model, phone, t, view.homeDirectory]);

  return (
    // Inset from the screen's edges by the drawer's one gutter (12px, as the
    // header's buttons, the search field and the footer): rows are rounded
    // tiles, not bands across the screen.
    <ScrollShadow ref={setScrollElement} className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 [overflow-anchor:none]">
      <SessionSidebarRows
        model={model.rowModel}
        scrollElement={scrollElement}
        pinnedRowIndexes={pinnedRowIndexes}
        renderRow={renderRow}
        onFirstVisibleIndexChange={NO_FIRST_VISIBLE}
        guideSlotStartPx={geometry.base}
        scrollRequest={scrollRequest}
      />
    </ScrollShadow>
  );
};
