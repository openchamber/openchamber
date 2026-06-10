import React from 'react';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSession } from '@/sync/sync-context';
import type { ProjectRef } from '@/lib/openchamberConfig';

export interface ProjectActionsContext {
  projectRef: ProjectRef;
  directory: string;
}

const normalize = (value: string): string => {
  if (!value) return '';
  const replaced = value.replace(/\\/g, '/');
  return replaced === '/' ? '/' : replaced.replace(/\/+$/, '');
};

/**
 * Resolves the active project ref + working directory used by
 * {@link ProjectActionsButton}. Directory priority mirrors the header:
 * worktree → session → draft → project path. A sticky ref keeps the last
 * good context so the actions button doesn't flicker during session switches.
 */
export function useProjectActionsContext(): ProjectActionsContext | null {
  const activeProject = useProjectsStore((state) => {
    if (!state.activeProjectId) {
      return null;
    }
    return state.projects.find((project) => project.id === state.activeProjectId) ?? null;
  });

  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSession = useSession(currentSessionId ?? null);

  const worktreePath = useSessionUIStore((state) => {
    if (!currentSessionId) return '';
    return state.worktreeMetadata.get(currentSessionId)?.path ?? '';
  });
  const draftDirectory = useSessionUIStore((state) => {
    if (!state.newSessionDraft?.open) {
      return '';
    }
    return normalize(state.newSessionDraft.bootstrapPendingDirectory ?? state.newSessionDraft.directoryOverride ?? '');
  });

  const worktreeDirectory = React.useMemo(() => normalize(worktreePath || ''), [worktreePath]);
  const sessionDirectory = React.useMemo(() => {
    const raw = typeof currentSession?.directory === 'string' ? currentSession.directory : '';
    return normalize(raw || '');
  }, [currentSession?.directory]);

  const openDirectory = worktreeDirectory || sessionDirectory || draftDirectory;
  const actionDirectory = React.useMemo(
    () => normalize(openDirectory || activeProject?.path || ''),
    [activeProject?.path, openDirectory],
  );
  const activeProjectRef = React.useMemo<ProjectRef | null>(() => {
    if (!activeProject) {
      return null;
    }
    return { id: activeProject.id, path: activeProject.path };
  }, [activeProject]);

  const lastContextRef = React.useRef<ProjectActionsContext | null>(null);
  React.useEffect(() => {
    if (activeProjectRef && actionDirectory) {
      lastContextRef.current = { projectRef: activeProjectRef, directory: actionDirectory };
    }
  }, [actionDirectory, activeProjectRef]);

  return React.useMemo(() => {
    if (activeProjectRef && actionDirectory) {
      return { projectRef: activeProjectRef, directory: actionDirectory };
    }
    return lastContextRef.current;
  }, [activeProjectRef, actionDirectory]);
}
