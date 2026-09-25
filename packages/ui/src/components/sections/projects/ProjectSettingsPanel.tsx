import React from 'react';
import { WorktreeSectionContent } from '@/components/sections/openchamber/WorktreeSectionContent';
import { ProjectActionsSection } from '@/components/sections/projects/ProjectActionsSection';
import { ProjectIdentityFields } from '@/components/sections/projects/ProjectIdentityFields';
import { ProjectShellEnvSection } from '@/components/sections/projects/ProjectShellEnvSection';
import { SharedProjectConfigSection } from '@/components/sections/projects/SharedProjectConfigSection';
import {
  useProjectIdentityForm,
  type ProjectIdentitySaveData,
} from '@/components/sections/projects/useProjectIdentityForm';
import { useProjectIdentityAutoSave } from '@/components/sections/projects/useProjectIdentityAutoSave';
import { isVSCodeRuntime } from '@/lib/desktop';
import type { ProjectEntry } from '@/lib/api/types';

type ProjectSettingsPanelProps = {
  project: ProjectEntry | null;
  onIdentitySave: (data: ProjectIdentitySaveData) => void | Promise<void>;
  /**
   * The project-edit dialog hides the worktree section — worktrees have
   * their own full-page surface (project menu → Manage worktrees). Settings
   * keeps the full panel.
   */
  showWorktrees?: boolean;
};

export const ProjectSettingsPanel: React.FC<ProjectSettingsPanelProps> = ({
  project,
  onIdentitySave,
  showWorktrees = true,
}) => {
  const form = useProjectIdentityForm(project);
  // The shell environment is a server-owned spawn concern; VS Code runs its
  // own processes, so the setting is not offered there.
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);

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

  return (
    <div className="space-y-0">
      <ProjectIdentityFields form={form} />
      <ProjectActionsSection projectRef={projectRef} />
      {isVSCode ? null : <ProjectShellEnvSection projectRef={projectRef} />}
      {showWorktrees ? <WorktreeSectionContent projectRef={projectRef} /> : null}
      <SharedProjectConfigSection projectRef={projectRef} />
    </div>
  );
};
