import React from 'react';

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { formatDirectoryName, formatPathForDisplay } from '@/lib/utils';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

/**
 * Picks the project a chat moves into. The conversation goes to the project's
 * root folder; nothing the chat wrote on disk moves with it, which the
 * description says before anything happens.
 */
export const MoveChatToProjectDialog: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (projectDirectory: string) => void;
}> = ({ open, onOpenChange, onPick }) => {
  const { t } = useI18n();
  const projects = useProjectsStore((state) => state.projects);
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('sessions.moveChatToProject.title')}</DialogTitle>
          <DialogDescription>{t('sessions.moveChatToProject.description')}</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[50vh] flex-col gap-0.5 overflow-y-auto">
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--interactive-hover)] focus-visible:bg-[var(--interactive-hover)] focus-visible:outline-none"
              onClick={() => {
                onOpenChange(false);
                onPick(project.path);
              }}
            >
              <Icon name="folder" className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">
                {project.label?.trim() || formatDirectoryName(project.path)}
              </span>
              <span className="min-w-0 max-w-[45%] truncate typography-micro text-muted-foreground">
                {formatPathForDisplay(project.path, homeDirectory)}
              </span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
};
