import React from 'react';
import { refreshProjectWorktrees, type ProjectRef } from '@/lib/worktrees/worktreeManager';

type UseWorktreeDiscoveryEventsOptions = {
  enabled?: boolean;
};

export type WorktreeChangedEventDetail = {
  directory: string;
  reason?: string;
  at?: number;
};

export const WORKTREE_CHANGED_EVENT = 'openchamber:worktree-changed';

const normalizePath = (value: string): string => {
  const replaced = value.trim().replace(/\\/g, '/');
  if (replaced === '/') return '/';
  return replaced.length > 1 ? replaced.replace(/\/+$/, '') : replaced;
};

export function useWorktreeDiscoveryEvents(
  projects: ProjectRef[],
  options: UseWorktreeDiscoveryEventsOptions = {},
): void {
  const enabled = options.enabled ?? true;
  const projectByPath = React.useMemo(() => {
    const next = new Map<string, ProjectRef>();
    for (const project of projects) {
      const path = normalizePath(project.path);
      if (!path) continue;
      next.set(path, { id: project.id, path });
    }
    return next;
  }, [projects]);

  React.useEffect(() => {
    if (!enabled || typeof window === 'undefined') {
      return;
    }

    const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

    const scheduleRefresh = (project: ProjectRef) => {
      const path = normalizePath(project.path);
      const existing = refreshTimers.get(path);
      if (existing) {
        clearTimeout(existing);
      }
      const timer = setTimeout(() => {
        refreshTimers.delete(path);
        void refreshProjectWorktrees(project).catch((error) => {
          console.warn('Failed to refresh worktrees after metadata change:', error);
        });
      }, 250);
      refreshTimers.set(path, timer);
    };

    const handleWorktreeChanged = (event: Event) => {
      const detail = (event as CustomEvent<WorktreeChangedEventDetail>).detail;
      const directory = typeof detail?.directory === 'string' ? normalizePath(detail.directory) : '';
      if (!directory) return;

      const project = projectByPath.get(directory);
      if (!project) return;
      scheduleRefresh(project);
    };

    window.addEventListener(WORKTREE_CHANGED_EVENT, handleWorktreeChanged);
    return () => {
      window.removeEventListener(WORKTREE_CHANGED_EVENT, handleWorktreeChanged);
      for (const timer of refreshTimers.values()) {
        clearTimeout(timer);
      }
      refreshTimers.clear();
    };
  }, [enabled, projectByPath]);
}
