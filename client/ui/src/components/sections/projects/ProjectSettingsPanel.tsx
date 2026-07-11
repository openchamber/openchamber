import React from 'react';
import { WorktreeSectionContent } from '@/components/sections/openchamber/WorktreeSectionContent';
import { ProjectActionsSection } from '@/components/sections/projects/ProjectActionsSection';
import { ProjectIdentityFields } from '@/components/sections/projects/ProjectIdentityFields';
import {
  useProjectIdentityForm,
  type ProjectIdentitySaveData,
} from '@/components/sections/projects/useProjectIdentityForm';
import { useProjectIdentityAutoSave } from '@/components/sections/projects/useProjectIdentityAutoSave';
import type { ProjectEntry } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';

type ProjectSettingsPanelProps = {
  project: ProjectEntry | null;
  onIdentitySave: (data: ProjectIdentitySaveData) => void | Promise<void>;
};

export const ProjectSettingsPanel: React.FC<ProjectSettingsPanelProps> = ({
  project,
  onIdentitySave,
}) => {
  const { t } = useI18n();
  const form = useProjectIdentityForm(project);

  const projectRef = React.useMemo(() => {
    if (!project) {
      return null;
    }
    return { id: project.id, path: project.path };
  }, [project]);

  const handleIdentitySave = React.useCallback(async (data: ProjectIdentitySaveData) => {
    await onIdentitySave(data);
  }, [onIdentitySave]);

  useProjectIdentityAutoSave(form, handleIdentitySave);

  if (!project || !projectRef) {
    return null;
  }

  const headerLabel = project.label ?? t('settings.projects.page.title.default');

  return (
    <div className="space-y-0">
      <div className="mb-5 px-1">
        <h2 className="typography-ui-header font-semibold text-foreground truncate">
          {headerLabel}
        </h2>
        <p className="typography-meta text-muted-foreground truncate" title={project.path}>
          {project.path}
        </p>
      </div>

      <ProjectIdentityFields form={form} />
      <ProjectActionsSection projectRef={projectRef} />
      <WorktreeSectionContent projectRef={projectRef} />
    </div>
  );
};
