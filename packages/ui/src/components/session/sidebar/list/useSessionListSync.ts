import React from 'react';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { refreshGlobalSessions, refreshGlobalSessionsForDirectories, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useChildStoreManager } from '@/sync/sync-context';
import { getAllSyncSessions } from '@/sync/sync-refs';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { buildSessionBootstrapDemands } from './sessionBootstrapDemands';
import { buildKnownSessionDirectories, getSessionDirectoriesToSync } from './sessionListDirectories';
import { useAuthoritativeSessionCleanup } from './useAuthoritativeSessionCleanup';
import { normalizePath } from '../utils';

const EMPTY_WORKTREES_BY_PROJECT = new Map();

type UseSessionListSyncOptions = {
  isVSCode: boolean;
};

export const useSessionListSync = ({
  isVSCode,
}: UseSessionListSyncOptions) => {
  const childStores = useChildStoreManager();
  const projects = useProjectsStore((state) => state.projects);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  const availableWorktreesByProject = useSessionUIStore((state) => isVSCode ? EMPTY_WORKTREES_BY_PROJECT : state.availableWorktreesByProject);
  const knownDirectories = React.useMemo(
    () => buildKnownSessionDirectories(projects, availableWorktreesByProject, { includeWorktrees: !isVSCode }),
    [availableWorktreesByProject, isVSCode, projects],
  );
  const globalActiveSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const archivedSessions = useGlobalSessionsStore((state) => state.archivedSessions);
  const hasAuthoritativeGlobalSessions = useGlobalSessionsStore((state) => state.status === 'ready');
  const bootstrapDemandOwner = `session-list-sync:${React.useId()}`;

  // The only bootstrap demand owner. Known projects and worktrees are not
  // demanded: their rows and sessions come from the global session list, so
  // initializing them only created one OpenCode instance per directory at
  // startup. Manual retry from a sidebar notice still requests bootstrap
  // through the scheduler with `force`.
  React.useEffect(() => {
    childStores.setBootstrapDemand(bootstrapDemandOwner, buildSessionBootstrapDemands({
      currentDirectory,
      currentSessionDirectory,
    }));
    return () => childStores.clearBootstrapDemand(bootstrapDemandOwner);
  }, [bootstrapDemandOwner, childStores, currentDirectory, currentSessionDirectory]);

  const runtimeKey = getRuntimeKey();
  const knownProjectSessionDirectoriesRef = React.useRef<Set<string> | null>(null);
  const knownRuntimeKeyRef = React.useRef(runtimeKey);
  React.useEffect(() => {
    const directories = new Set(knownDirectories);
    // Each runtime owns its own session lists, so a runtime switch restarts
    // syncing from scratch instead of trusting directories seen before.
    const runtimeChanged = knownRuntimeKeyRef.current !== runtimeKey;
    knownRuntimeKeyRef.current = runtimeKey;
    const previous = runtimeChanged ? null : knownProjectSessionDirectoriesRef.current;
    knownProjectSessionDirectoriesRef.current = directories;
    const projectRoots = new Set(
      projects
        .map((project) => normalizePath(project.path))
        .filter((path): path is string => Boolean(path)),
    );
    const added = getSessionDirectoriesToSync(directories, previous, { isVSCode, projectRoots });
    if (added.length) void refreshGlobalSessionsForDirectories(added, getAllSyncSessions());
  }, [isVSCode, knownDirectories, projects, runtimeKey]);

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
