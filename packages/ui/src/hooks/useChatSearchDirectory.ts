import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionStore } from '@/stores/useSessionStore';
import type { Session } from '@opencode-ai/sdk/v2';

export const useChatSearchDirectory = (): string | undefined => {
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const sessions = useSessionStore((state) => state.sessions);
  const worktreeMap = useSessionStore((state) => state.worktreeMetadata);
  const newSessionDraft = useSessionStore((state) => state.newSessionDraft);

  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const projects = useProjectsStore((state) => state.projects);

  const fallbackDirectory = useDirectoryStore((state) => state.currentDirectory);

  if (currentSessionId) {
    const worktreeMetadata = worktreeMap.get(currentSessionId);
    if (worktreeMetadata?.path) {
      return worktreeMetadata.path;
    }

    type SessionWithDirectory = Session & { directory?: string };
    const currentSession = sessions.find((session) => session.id === currentSessionId) as SessionWithDirectory | undefined;
    if (currentSession?.directory) {
      return currentSession.directory;
    }
  }

  if (newSessionDraft?.open && (newSessionDraft.bootstrapPendingDirectory || newSessionDraft.directoryOverride)) {
    return (newSessionDraft.bootstrapPendingDirectory || newSessionDraft.directoryOverride) ?? undefined;
  }

  if (activeProjectId) {
    const activeProject = projects.find((project) => project.id === activeProjectId);
    if (activeProject?.path) {
      return activeProject.path;
    }
  }

  return fallbackDirectory ?? undefined;
};
