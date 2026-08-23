import React from 'react';

import { ProjectNotesTodoPanel } from '@/components/session/project-context/ProjectNotesTodoPanel';
import { useGitStore } from '@/stores/useGitStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { formatDirectoryName } from '@/lib/utils';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { CHAT_DRAFT_PROJECT_ID, getChatsRootForHome, getChatsRootFromDirectory, isChatDirectoryPath } from '@/lib/chatDirectories';
import { useI18n } from '@/lib/i18n';

export const ProjectContextPanel: React.FC<{
  onActionComplete?: () => void;
  onOpenPlan?: (plan: { id: string; title: string }) => void;
}> = ({ onActionComplete, onOpenPlan }) => {
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const projects = useProjectsStore((state) => state.projects);
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const { t } = useI18n();
  const gitDirectories = useGitStore((state) => state.directories);
  const isChatContext = useSessionUIStore((state) => (
    state.newSessionDraft.open
      ? state.newSessionDraft.target === 'chat'
      : isChatDirectoryPath(state.currentSessionDirectory)
  ));
  const chatSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  const chatsRoot = getChatsRootFromDirectory(chatSessionDirectory) ?? getChatsRootForHome(homeDirectory);

  const activeProject = React.useMemo(() => {
    if (isChatContext) return null;
    if (activeProjectId) {
      return projects.find((project) => project.id === activeProjectId) ?? projects[0] ?? null;
    }
    return projects[0] ?? null;
  }, [activeProjectId, isChatContext, projects]);

  const projectRef = React.useMemo(() => {
    if (isChatContext && chatsRoot) {
      return { id: CHAT_DRAFT_PROJECT_ID, path: chatsRoot };
    }
    if (!activeProject) {
      return null;
    }
    return {
      id: activeProject.id,
      path: activeProject.path,
    };
  }, [activeProject, chatsRoot, isChatContext]);

  const projectLabel = React.useMemo(() => {
    if (isChatContext) return t('sessions.sidebar.activity.chatsTitle');
    if (!activeProject) {
      return null;
    }
    return activeProject.label?.trim()
      || formatDirectoryName(activeProject.path, homeDirectory)
      || activeProject.path;
  }, [activeProject, homeDirectory, isChatContext, t]);

  const canCreateWorktree = React.useMemo(() => {
    if (!activeProject) {
      return false;
    }
    return gitDirectories.get(activeProject.path)?.isGitRepo === true;
  }, [activeProject, gitDirectories]);

  return (
    /* The panel scrolls its own tab content; a scroller here would nest. */
    <div className="h-full min-h-0 overflow-hidden bg-background">
      <ProjectNotesTodoPanel
        projectRef={projectRef}
        projectLabel={projectLabel}
        canCreateWorktree={canCreateWorktree}
        onActionComplete={onActionComplete}
        onOpenPlan={onOpenPlan}
      />
    </div>
  );
};
