import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { ProjectSettingsPanel } from '@/components/sections/projects/ProjectSettingsPanel';
import type { ProjectIdentitySaveData } from '@/components/sections/projects/useProjectIdentityForm';
import { useI18n } from '@/lib/i18n';

export const ProjectsPage: React.FC = () => {
  const { t } = useI18n();
  const projects = useProjectsStore((state) => state.projects);
  const updateProjectMeta = useProjectsStore((state) => state.updateProjectMeta);
  const selectedId = useUIStore((state) => state.settingsProjectsSelectedId);
  const setSelectedId = useUIStore((state) => state.setSettingsProjectsSelectedId);

  const selectedProject = React.useMemo(() => {
    if (!selectedId) return null;
    return projects.find((p) => p.id === selectedId) ?? null;
  }, [projects, selectedId]);

  React.useEffect(() => {
    if (projects.length === 0) {
      setSelectedId(null);
      return;
    }
    if (selectedId && projects.some((p) => p.id === selectedId)) {
      return;
    }
    setSelectedId(projects[0].id);
  }, [projects, selectedId, setSelectedId]);

  const handleIdentitySave = React.useCallback(async (data: ProjectIdentitySaveData) => {
    if (!selectedProject) return;
    updateProjectMeta(selectedProject.id, {
      label: data.label,
      icon: data.icon,
      color: data.color,
      iconBackground: data.iconBackground,
      defaultModel: data.defaultModel ?? null,
    });
  }, [selectedProject, updateProjectMeta]);

  if (!selectedProject) {
    return (
      <ScrollableOverlay outerClassName="h-full" className="w-full">
        <div className="mx-auto w-full max-w-4xl p-3 sm:p-6 sm:pt-8">
          <p className="typography-meta text-muted-foreground">{t('settings.projects.page.empty.noProjects')}</p>
        </div>
      </ScrollableOverlay>
    );
  }

  return (
    <ScrollableOverlay outerClassName="h-full" className="w-full bg-background">
      <div className="mx-auto w-full max-w-4xl p-3 sm:p-6 sm:pt-8">
        <ProjectSettingsPanel project={selectedProject} onIdentitySave={handleIdentitySave} />
      </div>
    </ScrollableOverlay>
  );
};
