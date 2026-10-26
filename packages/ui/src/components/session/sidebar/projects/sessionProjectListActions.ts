import { requestDirectoryAccess } from '@/lib/desktop';
import { formatDirectoryName } from '@/lib/utils';
import { refreshGlobalSessions } from '@/stores/useGlobalSessionsStore';
import type { useChildStoreManager } from '@/sync/sync-context';
import type { SessionSidebarRow } from '../sessionSidebarRowModel';
import { formatProjectLabel } from '../utils';
import type { SessionProjectListProps } from './SessionProjectScroller';
import type { ProjectSection } from './sessionProjectRender';

// What a row of the list does when used, the same whichever list draws it:
// the desktop's scroller or the phone's rows.

export const getProjectLabel = (project: ProjectSection['project'], homeDirectory: string | null): string => formatProjectLabel(
  project.label?.trim() || formatDirectoryName(project.normalizedPath, homeDirectory) || project.normalizedPath,
);

/** Folds or opens a zone. Folding forgets its Show more: opened again, it starts from the default reveal. */
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

/** Show more or Show fewer under a zone or a group. */
export const applyShowControl = (
  row: Extract<SessionSidebarRow, { kind: 'show-control' }>,
  { model, actions }: Pick<SessionProjectListProps, 'model' | 'actions'>,
): void => {
  if (row.containerKey.startsWith('activity:')) {
    model.state.setVisibleActivityCountByKey((current) => {
      const next = new Map(current);
      if (row.control === 'more') next.set(row.containerKey, row.currentCount + row.increment); else next.delete(row.containerKey);
      return next;
    });
  } else if (row.control === 'more') actions.group.showMoreGroupSessions(row.containerKey, row.currentCount, row.increment);
  else actions.group.resetGroupSessionLimit(row.containerKey);
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
