import React from 'react';

import { ProjectNotesTodoPanel } from '@/components/session/project-context/ProjectNotesTodoPanel';
import { useGitStore } from '@/stores/useGitStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { formatDirectoryName } from '@/lib/utils';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectContextOwner } from '@/hooks/useProjectContextOwner';
import { CHAT_DRAFT_PROJECT_ID } from '@/lib/chatDirectories';
import type { ProjectRef } from '@/lib/projectContextApi';
import { useI18n } from '@/lib/i18n';

export const ProjectContextPanel: React.FC<{
  onActionComplete?: () => void;
  onOpenPlan?: (plan: { id: string; title: string; projectRef: ProjectRef }) => void;
}> = ({ onActionComplete, onOpenPlan }) => {
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const { t } = useI18n();
  const gitDirectories = useGitStore((state) => state.directories);
  const chatSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);

  // One owner decision shared with the panel, agent memory, and PlanView:
  // chats resolve to the Chats owner, worktrees to their project, and an
  // unrecognized directory owns nothing (null) rather than borrowing
  // whichever project happens to be active.
  const projectRef = useProjectContextOwner(chatSessionDirectory);

  // Display-only lookup: a user-renamed project label wins over the directory
  // name. The owner decision stays with the hook — this must not reintroduce
  // a fallback.
  const projects = useProjectsStore((state) => state.projects);
  const labeledProject = React.useMemo(
    () => (projectRef ? projects.find((project) => project.id === projectRef.id) ?? null : null),
    [projectRef, projects],
  );

  const projectLabel = React.useMemo(() => {
    if (!projectRef) {
      return null;
    }
    if (projectRef.id === CHAT_DRAFT_PROJECT_ID) {
      return t('sessions.sidebar.activity.chatsTitle');
    }
    return labeledProject?.label?.trim()
      || formatDirectoryName(projectRef.path, homeDirectory)
      || projectRef.path;
  }, [homeDirectory, labeledProject, projectRef, t]);

  const canCreateWorktree = React.useMemo(() => {
    if (!projectRef || projectRef.id === CHAT_DRAFT_PROJECT_ID) {
      return false;
    }
    return gitDirectories.get(projectRef.path)?.isGitRepo === true;
  }, [gitDirectories, projectRef]);

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
