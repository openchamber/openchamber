import { requestDirectoryAccess } from '@/lib/desktop';
import { formatDirectoryName } from '@/lib/utils';
import { refreshGlobalSessions } from '@/stores/useGlobalSessionsStore';
import type { useChildStoreManager } from '@/sync/sync-context';
import { PROJECTS_CAPTION_COLLAPSE_KEY, type SessionSidebarRow } from '../sessionSidebarRowModel';
import { formatProjectLabel } from '../utils';
import type { SessionProjectListProps } from './SessionProjectScroller';
import type { ProjectSection } from './sessionProjectRender';


export const getProjectLabel = (project: ProjectSection['project'], homeDirectory: string | null): string => formatProjectLabel(
  project.label?.trim() || formatDirectoryName(project.normalizedPath, homeDirectory) || project.normalizedPath,
);

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

export const toggleProjectsCaption = (
  row: Extract<SessionSidebarRow, { kind: 'caption' }>,
  { model }: Pick<SessionProjectListProps, 'model'>,
): void => {
  const key = row.caption === 'projects' ? PROJECTS_CAPTION_COLLAPSE_KEY : row.caption;
  model.state.setCollapsedActivityKeys((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
};

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

export const grantGroupAccess = async (
  row: Extract<SessionSidebarRow, { kind: 'status' }>,
  childStores: ReturnType<typeof useChildStoreManager>,
): Promise<void> => {
  if (!row.status.directory) return;
  const result = await requestDirectoryAccess(row.status.directory);
  if (result.success) retryGroupStatus(row, childStores);
};
