import React from 'react';
import type { ProjectEntry } from '@/lib/api/types';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSession } from '@/sync/sync-context';
import type { ProjectRef } from '@/lib/openchamberConfig';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import type { WorktreeMetadata } from '@/types/worktree';

export interface ProjectActionsContext {
  projectRef: ProjectRef;
  directory: string;
}

interface ProjectActionsOwnerInput {
  projects: ProjectEntry[];
  worktreesByProject: Map<string, WorktreeMetadata[]>;
  directory: string | null;
  activeProjectId: string | null;
}

const normalize = (value: string): string => {
  if (!value) return '';
  const replaced = value.replace(/\\/g, '/');
  return replaced === '/' ? '/' : replaced.replace(/\/+$/, '');
};

export const resolveProjectActionsOwner = ({
  projects,
  worktreesByProject,
  directory,
  activeProjectId,
}: ProjectActionsOwnerInput): ProjectEntry | null => {
  const normalizedDirectory = normalize(directory ?? '');
  if (normalizedDirectory) {
    const sessionProject = resolveProjectForSessionDirectory(projects, worktreesByProject, normalizedDirectory);
    if (sessionProject) {
      return sessionProject;
    }
  }

  return projects.find((project) => project.id === activeProjectId) ?? null;
};

/**
 * Resolves the active project ref + working directory used by
 * {@link ProjectActionsButton}. Directory priority mirrors the header:
 * worktree → session → draft → project path. A sticky ref keeps the last
 * good context so the actions button doesn't flicker during session switches.
 */
export function useProjectActionsContext(): ProjectActionsContext | null {
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const worktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);

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
  const ownerProject = React.useMemo(() => resolveProjectActionsOwner({
    projects,
    worktreesByProject,
    directory: openDirectory,
    activeProjectId,
  }), [activeProjectId, openDirectory, projects, worktreesByProject]);
  const actionDirectory = React.useMemo(
    () => normalize(openDirectory || ownerProject?.path || ''),
    [openDirectory, ownerProject?.path],
  );
  const activeProjectRef = React.useMemo<ProjectRef | null>(() => {
    if (!ownerProject) {
      return null;
    }
    return { id: ownerProject.id, path: ownerProject.path };
  }, [ownerProject]);

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
