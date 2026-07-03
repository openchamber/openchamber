import React from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { ProjectIdentityEditor } from '@/components/sections/projects/ProjectIdentityEditor';
import { useProjectIdentityForm } from '@/components/sections/projects/useProjectIdentityForm';
import type { ProjectEntry } from '@/lib/api/types';

interface ProjectEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: ProjectEntry | null;
  onSave: (data: {
    label: string;
    icon: string | null;
    color: string | null;
    iconBackground: string | null;
    defaultModel: string | undefined;
  }) => void;
}

export const ProjectEditDialog: React.FC<ProjectEditDialogProps> = ({
  open,
  onOpenChange,
  project,
  onSave,
}) => {
  const form = useProjectIdentityForm(open ? project : null);

  const handleSave = React.useCallback(async () => {
    const data = await form.prepareSaveData();
    if (!data) return;
    onSave(data);
    onOpenChange(false);
  }, [form, onOpenChange, onSave]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full max-w-4xl gap-0 overflow-hidden p-0 sm:max-w-xl">
        <ScrollableOverlay outerClassName="max-h-[min(85vh,40rem)]" className="w-full bg-background">
          <div className="mx-auto w-full max-w-4xl p-3 sm:p-6 sm:pt-8">
            <ProjectIdentityEditor form={form} onSave={handleSave} className="mb-0" />
          </div>
        </ScrollableOverlay>
      </DialogContent>
    </Dialog>
  );
};
