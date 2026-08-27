import React from 'react';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { refreshGlobalSessions, refreshGlobalSessionsForDirectories, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useAllLiveSessions, useChildStoreManager } from '@/sync/sync-context';
import { getAllSyncSessions } from '@/sync/sync-refs';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { buildSessionBootstrapDemands } from './sessionBootstrapDemands';
import { buildKnownSessionDirectories } from './sessionListDirectories';
import { useAuthoritativeSessionCleanup } from './useAuthoritativeSessionCleanup';
import { normalizePath } from '../utils';
import { selectWorktreeDiscoveryProjects } from '../sessions/worktreeDiscoveryProjects';
import { useUIStore } from '@/stores/useUIStore';

const EMPTY_WORKTREES_BY_PROJECT = new Map();

type UseSessionListSyncOptions = {
  isVSCode: boolean;
};

export const useSessionListSync = ({
  isVSCode,
}: UseSessionListSyncOptions) => {
  const childStores = useChildStoreManager();
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  const availableWorktreesByProject = useSessionUIStore((state) => isVSCode ? EMPTY_WORKTREES_BY_PROJECT : state.availableWorktreesByProject);
  const backgroundProjectSessionLoadingEnabled = useUIStore((state) => state.backgroundProjectSessionLoadingEnabled);
  const globalActiveSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const archivedSessions = useGlobalSessionsStore((state) => state.archivedSessions);
  const hasAuthoritativeGlobalSessions = useGlobalSessionsStore((state) => state.status === 'ready');
  const liveSessions = useAllLiveSessions();
  const eligibilitySessions = React.useMemo(() => {
    const sessions = [...globalActiveSessions];
    const sessionIds = new Set(sessions.map((session) => session.id));
    for (const session of liveSessions) {
      if (sessionIds.has(session.id)) continue;
      sessionIds.add(session.id);
      sessions.push(session);
    }
    return sessions;
  }, [globalActiveSessions, liveSessions]);
  const eligibleProjects = React.useMemo(
    () => backgroundProjectSessionLoadingEnabled
      ? projects
      : selectWorktreeDiscoveryProjects(
        projects,
        activeProjectId,
        eligibilitySessions,
        availableWorktreesByProject,
        isVSCode,
      ),
    [activeProjectId, availableWorktreesByProject, backgroundProjectSessionLoadingEnabled, eligibilitySessions, isVSCode, projects],
  );
  const knownDirectories = React.useMemo(
    () => buildKnownSessionDirectories(eligibleProjects, availableWorktreesByProject, { includeWorktrees: !isVSCode }),
    [availableWorktreesByProject, eligibleProjects, isVSCode],
  );
  const bootstrapDemandOwner = `session-list-sync:${React.useId()}`;

  React.useEffect(() => {
    childStores.setBootstrapDemand(bootstrapDemandOwner, buildSessionBootstrapDemands({
      knownDirectories,
      activeProjectDirectory: normalizePath(projects.find((project) => project.id === activeProjectId)?.path ?? null),
      activeProjectId,
      collapsedProjects: new Set(),
      collapsedGroups: new Set(),
      currentDirectory,
      currentSessionDirectory,
    }));
    return () => childStores.clearBootstrapDemand(bootstrapDemandOwner);
  }, [activeProjectId, bootstrapDemandOwner, childStores, currentDirectory, currentSessionDirectory, knownDirectories, projects]);

  const knownProjectSessionDirectoriesRef = React.useRef<Set<string> | null>(null);
  React.useEffect(() => {
    const directories = new Set(knownDirectories);
    const previous = knownProjectSessionDirectoriesRef.current;
    knownProjectSessionDirectoriesRef.current = directories;
    const added = previous ? [...directories].filter((directory) => !previous.has(directory)) : isVSCode ? [...directories] : [];
    if (added.length) void refreshGlobalSessionsForDirectories(added, getAllSyncSessions());
  }, [isVSCode, knownDirectories]);

  React.useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let refreshAll = false;
    const directories = new Set<string>();
    const unsubscribe = subscribeOpenchamberEvents((event) => {
      if (event.type === 'scheduled-task-ran') refreshAll = true;
      else if (event.type === 'session-created') directories.add(event.directory);
      else return;
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        timeout = null;
        if (refreshAll) {
          refreshAll = false;
          directories.clear();
          void refreshGlobalSessions(getAllSyncSessions());
          return;
        }
        const requested = [...directories];
        directories.clear();
        if (requested.length) void refreshGlobalSessionsForDirectories(requested, getAllSyncSessions());
      }, 500);
    });
    return () => {
      if (timeout) clearTimeout(timeout);
      unsubscribe();
    };
  }, []);

  const cleanupSessions = React.useMemo(
    () => [...globalActiveSessions, ...archivedSessions],
    [archivedSessions, globalActiveSessions],
  );
  useAuthoritativeSessionCleanup({
    enabled: true,
    hasAuthoritativeGlobalSessions,
    sessions: cleanupSessions,
  });
};
