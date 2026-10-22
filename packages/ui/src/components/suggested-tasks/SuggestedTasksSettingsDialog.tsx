import React from 'react';
import { ProjectLabel } from '@/components/layout/ProjectRailPage';
import { ProjectSuggestedTasksTab } from '@/components/sections/projects/ProjectSuggestedTasksTab';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import type { ProjectEntry } from '@/lib/api/types';

/**
 * The inbox's Configure dialog. It holds the project's Suggested tasks
 * settings, the same form as the project's tab in Settings → Projects. Phones
 * get the same dialog, so the lens editor it opens stacks above it.
 */
export function SuggestedTasksSettingsDialog({ project, onOpenChange }: {
  project: ProjectEntry;
  onOpenChange: (open: boolean) => void;
}) {
  const projectRef = React.useMemo(() => ({ id: project.id, path: project.path }), [project.id, project.path]);
  const windowRef = React.useRef<HTMLDivElement | null>(null);
  return (
    <Dialog open onOpenChange={onOpenChange}>
      {/* The height is fixed, so the title stays put and only the form
          scrolls. Focus goes to the window, because the form's first text
          field is far down and focusing it would open the dialog scrolled to
          the middle. */}
      <DialogContent ref={windowRef} initialFocus={windowRef} className="flex h-[min(85vh,40rem)] w-full max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <div className="shrink-0 ps-4 pe-12 pt-5 pb-6 sm:ps-6">
          <DialogTitle>
            <ProjectLabel project={project} />
          </DialogTitle>
        </div>
        <ScrollableOverlay outerClassName="min-h-0 flex-1" className="w-full">
          <div className="@container px-4 pb-6 sm:px-6 [&>section:first-of-type]:border-t-0 [&>section:first-of-type]:pt-0">
            <ProjectSuggestedTasksTab projectRef={projectRef} overInbox />
          </div>
        </ScrollableOverlay>
      </DialogContent>
    </Dialog>
  );
}
