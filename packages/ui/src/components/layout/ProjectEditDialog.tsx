import React from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { ProjectSettingsPanel } from '@/components/sections/projects/ProjectSettingsPanel';
import type { ProjectSettingsTab } from '@/components/sections/projects/projectSettingsTabs';
import type { ProjectIdentitySaveData } from '@/components/sections/projects/useProjectIdentityForm';
import type { ProjectEntry } from '@/lib/api/types';
import { useUIStore } from '@/stores/useUIStore';

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
  const setWorktreesPageProjectId = useUIStore((state) => state.setWorktreesPageProjectId);
  // Every opening starts on the first tab.
  const [tab, setTab] = React.useState<ProjectSettingsTab>('general');
  React.useEffect(() => {
    if (open) setTab('general');
  }, [open]);

  const projectId = project?.id ?? null;
  const handleOpenWorktrees = React.useMemo(() => {
    if (!projectId) return undefined;
    return () => {
      onOpenChange(false);
      setWorktreesPageProjectId(projectId);
    };
  }, [onOpenChange, projectId, setWorktreesPageProjectId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(85vh,40rem)] w-full max-w-2xl flex-col gap-0 overflow-hidden p-0">
        {open && project ? (
          <ProjectSettingsPanel
            frame="dialog"
            project={project}
            onIdentitySave={onSave}
            tab={tab}
            onTabChange={setTab}
            onOpenWorktrees={handleOpenWorktrees}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
