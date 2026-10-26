import React from 'react';

import { CHAT_DRAFT_PROJECT_ID, getChatsRoot, getChatsRootFromDirectory } from '@/lib/chatDirectories';
import { normalizePath } from '@/lib/pathNormalization';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { resolveProjectContextId, type ProjectRef } from '@/lib/projectContextApi';
import { useChatsRoot } from '@/hooks/useChatsRoot';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { WorktreeMetadata } from '@/types/worktree';
import type { ProjectEntry } from '@/lib/api/types';

interface ProjectContextOwnerInput {
  projects: ProjectEntry[];
  worktreesByProject: Map<string, WorktreeMetadata[]>;
  directory: string | null;
  activeProjectId: string | null;
  chatDraftOpen: boolean;
  chatDraftTarget: 'chat' | 'project';
  /** The server-named chats root; null until known. */
  chatsRoot: string | null;
}

export const resolveProjectContextOwner = ({
  projects,
  worktreesByProject,
  directory,
  activeProjectId,
  chatDraftOpen,
  chatDraftTarget,
  chatsRoot: knownChatsRoot,
}: ProjectContextOwnerInput): ProjectRef | null => {
  const chatsRoot = getChatsRootFromDirectory(directory) ?? knownChatsRoot;
  const normalizedDirectory = normalizePath(directory);
  const normalizedChatsRoot = normalizePath(chatsRoot);
  const ownsChats = chatDraftOpen
    ? chatDraftTarget === 'chat'
    : Boolean(normalizedDirectory && normalizedChatsRoot && (
      normalizedDirectory === normalizedChatsRoot || normalizedDirectory.startsWith(`${normalizedChatsRoot}/`)
    ));

  if (ownsChats && chatsRoot) {
    return { id: CHAT_DRAFT_PROJECT_ID, path: chatsRoot };
  }

  const sessionProject = resolveProjectForSessionDirectory(projects, worktreesByProject, directory);
  if (sessionProject) {
    return { id: sessionProject.id, path: sessionProject.path };
  }

  // A concrete directory that resolves to nothing owns nothing. Falling back
  // to the active project here showed one project's knowledge under another
  // project's name (the "plans open empty" bug), so the panel stays empty
  // instead of lying. The active-project fallback is only for states with no
  // directory at all, such as a new-session draft that has not landed yet.
  if (normalizedDirectory) {
    return null;
  }

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  return activeProject ? { id: activeProject.id, path: activeProject.path } : null;
};

/**
 * The project an agent's plan-open request means, outside React. The asking
 * session's directory decides it the way it decides the panel's owner; when
 * the agent named another project, the request's storage id picks it from the
 * registered projects. Null when this window knows no such project.
 */
export const resolvePlanRequestOwner = (directory: string | null, projectId: string): ProjectRef | null => {
  const { projects } = useProjectsStore.getState();
  const owner = resolveProjectContextOwner({
    projects,
    worktreesByProject: useSessionUIStore.getState().availableWorktreesByProject,
    directory,
    activeProjectId: null,
    chatDraftOpen: false,
    chatDraftTarget: 'project',
    chatsRoot: getChatsRoot(),
  });
  if (owner && resolveProjectContextId(owner) === projectId) return owner;
  const registered = projects.find((project) => resolveProjectContextId(project) === projectId);
  return registered ? { id: registered.id, path: registered.path } : null;
};

/** The single owner used by Project knowledge and agent-memory synchronization. */
export const useProjectContextOwner = (directory: string | null): ProjectRef | null => {
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const chatsRoot = useChatsRoot();
  const worktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  const chatDraftOpen = useSessionUIStore((state) => state.newSessionDraft.open);
  const chatDraftTarget = useSessionUIStore((state) => state.newSessionDraft.target);

  return React.useMemo(() => resolveProjectContextOwner({
    projects,
    worktreesByProject,
    directory,
    activeProjectId,
    chatDraftOpen,
    chatDraftTarget,
    chatsRoot,
  }), [
    activeProjectId,
    chatDraftOpen,
    chatDraftTarget,
    chatsRoot,
    directory,
    projects,
    worktreesByProject,
  ]);
};
