import React from 'react';

import { CHAT_DRAFT_PROJECT_ID, getChatsRootForHome, getChatsRootFromDirectory } from '@/lib/chatDirectories';
import { normalizePath } from '@/lib/pathNormalization';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import type { ProjectRef } from '@/lib/projectContextApi';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
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
  homeDirectory: string | null;
}

export const resolveProjectContextOwner = ({
  projects,
  worktreesByProject,
  directory,
  activeProjectId,
  chatDraftOpen,
  chatDraftTarget,
  homeDirectory,
}: ProjectContextOwnerInput): ProjectRef | null => {
  const chatsRoot = getChatsRootFromDirectory(directory) ?? getChatsRootForHome(homeDirectory);
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

/** The single owner used by Project knowledge and agent-memory synchronization. */
export const useProjectContextOwner = (directory: string | null): ProjectRef | null => {
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
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
    homeDirectory,
  }), [
    activeProjectId,
    chatDraftOpen,
    chatDraftTarget,
    directory,
    homeDirectory,
    projects,
    worktreesByProject,
  ]);
};
