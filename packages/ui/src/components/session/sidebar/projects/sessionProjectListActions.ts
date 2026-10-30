import { requestDirectoryAccess } from '@/lib/desktop';
import { formatDirectoryName } from '@/lib/utils';
import { refreshGlobalSessions } from '@/stores/useGlobalSessionsStore';
import type { useChildStoreManager } from '@/sync/sync-context';
import { PROJECTS_CAPTION_COLLAPSE_KEY, type SessionSidebarRow } from '../sessionSidebarRowModel';
import { formatProjectLabel } from '../utils';
import type { SessionProjectListProps } from './SessionProjectScroller';
import type { ProjectSection } from './sessionProjectRender';

// What a row of the list does when used, the same whichever list draws it:
// the desktop's scroller or the phone's rows.

export const getProjectLabel = (project: ProjectSection['project'], homeDirectory: string | null): string => formatProjectLabel(
  project.label?.trim() || formatDirectoryName(project.normalizedPath, homeDirectory) || project.normalizedPath,
);

/** Folds or opens a zone. Folding forgets its reveal: opened again, it starts from the default. */
export const toggleActivityZone = (
  row: Extract<SessionSidebarRow, { kind: 'activity-header' }>,
  { model, actions }: Pick<SessionProjectListProps, 'model' | 'actions'>,
): void => {
  if (!row.collapsed) {
    const containerKey = `activity:${row.activityKey}`;
    actions.group.resetGroupSessionLimit(containerKey);
    model.state.setVisibleActivityCountByKey((current) => {
      if (!current.has(containerKey)) return current;
      const next = new Map(current);
      next.delete(containerKey);
      return next;
    });
  }
  model.state.setCollapsedActivityKeys((current) => {
    const next = new Set(current);
    if (next.has(row.activityKey)) next.delete(row.activityKey); else next.add(row.activityKey);
    return next;
  });
};

/** Folds or opens the zone a reveal line closes. */
export const toggleShowControlZone = (
  row: Extract<SessionSidebarRow, { kind: 'show-control' }>,
  props: Pick<SessionProjectListProps, 'model' | 'actions'>,
): void => {
  if (!row.activityKey) return;
  toggleActivityZone({
    kind: 'activity-header',
    key: `activity:${row.activityKey}:header`,
    estimateSize: 0,
    activityKey: row.activityKey,
    collapsed: false,
    forceExpanded: false,
  }, props);
};

/** Folds or opens every project under the Projects caption at once. */
export const toggleProjectsCaption = ({ model }: Pick<SessionProjectListProps, 'model'>): void => {
  model.state.setCollapsedActivityKeys((current) => {
    const next = new Set(current);
    if (next.has(PROJECTS_CAPTION_COLLAPSE_KEY)) next.delete(PROJECTS_CAPTION_COLLAPSE_KEY); else next.add(PROJECTS_CAPTION_COLLAPSE_KEY);
    return next;
  });
};

/** Show more, or Show less back to the first batch, under a zone or a group. */
export const applyShowControl = (
  row: Extract<SessionSidebarRow, { kind: 'show-control' }>,
  control: 'more' | 'fewer',
  { model, actions }: Pick<SessionProjectListProps, 'model' | 'actions'>,
): void => {
  if (row.containerKey.startsWith('activity:')) {
    model.state.setVisibleActivityCountByKey((current) => {
      const next = new Map(current);
      if (control === 'more') next.set(row.containerKey, row.currentCount + row.increment); else next.delete(row.containerKey);
      return next;
    });
  } else if (control === 'more') actions.group.showMoreGroupSessions(row.containerKey, row.currentCount, row.increment);
  else actions.group.resetGroupSessionLimit(row.containerKey);
};

/**
 * Dragging the reveal line sets how many rows show, from the closed header to
 * every row. The floor drops the stored limit, so the group opens on its first
 * page next time.
 */
export const setShowControlCount = (
  row: Extract<SessionSidebarRow, { kind: 'show-control' }>,
  count: number,
  { model, actions }: Pick<SessionProjectListProps, 'model' | 'actions'>,
): void => {
  const nextCount = Math.min(row.maxCount, Math.max(row.minCount, Math.round(count)));
  if (row.containerKey.startsWith('activity:')) {
    model.state.setVisibleActivityCountByKey((current) => {
      if (current.get(row.containerKey) === nextCount) return current;
      const next = new Map(current);
      if (nextCount === row.minCount) next.delete(row.containerKey);
      else next.set(row.containerKey, nextCount);
      return next;
    });
    return;
  }
  if (nextCount === row.minCount) actions.group.resetGroupSessionLimit(row.containerKey);
  else actions.group.setGroupSessionLimit(row.containerKey, nextCount);
};

/** Loads a group's sessions again: the global list, or the group's directory. */
export const retryGroupStatus = (
  row: Extract<SessionSidebarRow, { kind: 'status' }>,
  childStores: ReturnType<typeof useChildStoreManager>,
): void => {
  if (!row.status.directory) {
    void refreshGlobalSessions();
    return;
  }
  childStores.requestBootstrap({ directory: row.status.directory, priority: 'expanded', reason: row.group.isMain ? 'project-expanded' : 'worktree-expanded', force: true });
};

/** Asks the system for access to a group's directory, then loads it. */
export const grantGroupAccess = async (
  row: Extract<SessionSidebarRow, { kind: 'status' }>,
  childStores: ReturnType<typeof useChildStoreManager>,
): Promise<void> => {
  if (!row.status.directory) return;
  const result = await requestDirectoryAccess(row.status.directory);
  if (result.success) retryGroupStatus(row, childStores);
};
