import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { WorktreeSectionContent } from '@/components/sections/openchamber/WorktreeSectionContent';

// Full-page worktree management surface for a single project, opened from the
// project menu in the sidebar. Renders only the worktree list (setup commands
// stay in project settings); the New-worktree action leads the content flow.
export function WorktreesView(): React.ReactNode {
  const { t } = useI18n();
  const projectId = useUIStore((state) => state.worktreesPageProjectId);
  const setNewWorktreeDialogOpen = useUIStore((state) => state.setNewWorktreeDialogOpen);
  const setActiveProjectIdOnly = useProjectsStore((state) => state.setActiveProjectIdOnly);
  const project = useProjectsStore((state) => state.projects.find((entry) => entry.id === projectId) ?? null);

  if (!projectId || !project) return null;

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-background">
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto w-full max-w-4xl space-y-4">
          <div className="flex items-center">
            <Button
              size="sm"
              onClick={() => {
                setActiveProjectIdOnly(project.id);
                setNewWorktreeDialogOpen(true);
              }}
            >
              <Icon name="node-tree" className="mr-1 h-3.5 w-3.5" />
              {t('sessions.sidebar.project.actions.newWorktree')}
            </Button>
          </div>
          <WorktreeSectionContent projectRef={{ id: project.id, path: project.path }} sections="list-only" />
        </div>
      </div>
    </div>
  );
}
