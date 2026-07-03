import React from 'react';
import { Button } from '@/components/ui/button';
import { ProjectIdentityFields } from '@/components/sections/projects/ProjectIdentityFields';
import type { useProjectIdentityForm } from '@/components/sections/projects/useProjectIdentityForm';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type ProjectIdentityFormState = ReturnType<typeof useProjectIdentityForm>;

type ProjectIdentityEditorProps = {
  form: ProjectIdentityFormState;
  onSave: () => void | Promise<void>;
  className?: string;
};

export const ProjectIdentityEditor: React.FC<ProjectIdentityEditorProps> = ({
  form,
  onSave,
  className,
}) => {
  const { t } = useI18n();
  const project = form.project;

  if (!project) {
    return null;
  }

  const headerLabel = project.label ?? t('settings.projects.page.title.default');

  return (
    <div className={cn('mb-8', className)}>
      <div className="mb-4 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="typography-ui-header font-semibold text-foreground truncate">
            {headerLabel}
          </h2>
          <p className="typography-meta text-muted-foreground truncate" title={project.path}>
            {project.path}
          </p>
        </div>
      </div>

      <ProjectIdentityFields form={form} />

      <div className="mt-0.5 px-2 py-1">
        <Button
          onClick={() => void onSave()}
          disabled={!form.hasChanges || !form.name.trim() || form.isUploadingIcon || form.isRemovingCustomIcon}
          size="xs"
          className="!font-normal"
        >
          {t('settings.common.actions.saveChanges')}
        </Button>
      </div>
    </div>
  );
};
