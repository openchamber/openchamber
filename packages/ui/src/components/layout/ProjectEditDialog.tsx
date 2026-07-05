import React from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { ProjectSettingsPanel } from '@/components/sections/projects/ProjectSettingsPanel';
import type { ProjectIdentitySaveData } from '@/components/sections/projects/useProjectIdentityForm';
import type { ProjectEntry } from '@/lib/api/types';

interface ProjectEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: ProjectEntry | null;
  onSave: (data: ProjectIdentitySaveData) => void | Promise<void>;
}

export const ProjectEditDialog: React.FC<ProjectEditDialogProps> = ({
  open,
  onOpenChange,
  project,
  onSave,
}) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full max-w-2xl gap-0 overflow-hidden p-0">
        <ScrollableOverlay outerClassName="max-h-[min(90vh,48rem)]" className="w-full bg-background">
          <div className="w-full p-3 sm:p-6 sm:pt-8">
            {open && project ? (
              <ProjectSettingsPanel project={project} onIdentitySave={onSave} />
            ) : null}
          </div>
        </ScrollableOverlay>
      </DialogContent>
    </Dialog>
  );
};
