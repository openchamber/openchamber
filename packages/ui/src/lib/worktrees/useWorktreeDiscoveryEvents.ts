import React from 'react';
import { checkIsGitRepository } from '@/lib/gitApi';
import { refreshProjectWorktrees, type ProjectRef } from '@/lib/worktrees/worktreeManager';

type UseWorktreeDiscoveryEventsOptions = {
  enabled?: boolean;
};

const normalizePath = (value: string): string => {
  const replaced = value.trim().replace(/\\/g, '/');
  if (replaced === '/') return '/';
  return replaced.length > 1 ? replaced.replace(/\/+$/, '') : replaced;
};

const buildEventsUrl = (directory: string): string => {
  const url = new URL('/api/git/worktrees/events', window.location.origin);
  url.searchParams.set('directory', directory);
  return url.toString();
};

export function useWorktreeDiscoveryEvents(
  projects: ProjectRef[],
  options: UseWorktreeDiscoveryEventsOptions = {},
): void {
  const enabled = options.enabled ?? true;
  const projectKey = React.useMemo(() => projects
    .map((project) => `${project.id}:${normalizePath(project.path)}`)
    .join('|'), [projects]);

  React.useEffect(() => {
    if (!enabled || typeof window === 'undefined' || typeof window.EventSource !== 'function') {
      return;
    }

    let cancelled = false;
    const cleanupCallbacks: Array<() => void> = [];

    const subscribe = async () => {
      const uniqueProjects = new Map<string, ProjectRef>();
      for (const project of projects) {
        const path = normalizePath(project.path);
        if (!path) continue;
        uniqueProjects.set(path, { id: project.id, path });
      }

      await Promise.all(Array.from(uniqueProjects.values()).map(async (project) => {
        const isGitRepo = await checkIsGitRepository(project.path).catch(() => false);
        if (cancelled || !isGitRepo) return;

        const source = new EventSource(buildEventsUrl(project.path));
        let refreshTimer: ReturnType<typeof setTimeout> | null = null;
        let opened = false;

        const handleOpen = () => {
          opened = true;
        };

        const handleError = () => {
          if (!opened) {
            source.close();
          }
        };

        const scheduleRefresh = () => {
          if (refreshTimer) {
            clearTimeout(refreshTimer);
          }
          refreshTimer = setTimeout(() => {
            refreshTimer = null;
            void refreshProjectWorktrees(project).catch((error) => {
              console.warn('Failed to refresh worktrees after metadata change:', error);
            });
          }, 250);
        };

        source.addEventListener('open', handleOpen);
        source.addEventListener('error', handleError);
        source.addEventListener('worktree.changed', scheduleRefresh);
        cleanupCallbacks.push(() => {
          if (refreshTimer) {
            clearTimeout(refreshTimer);
            refreshTimer = null;
          }
          source.removeEventListener('open', handleOpen);
          source.removeEventListener('error', handleError);
          source.removeEventListener('worktree.changed', scheduleRefresh);
          source.close();
        });
      }));
    };

    void subscribe();

    return () => {
      cancelled = true;
      for (const cleanup of cleanupCallbacks.splice(0)) {
        cleanup();
      }
    };
  }, [enabled, projectKey, projects]);
}
