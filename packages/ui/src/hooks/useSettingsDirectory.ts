import type { ProjectEntry } from '@/lib/api/types';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';

export const resolveSettingsDirectory = (
  settingsProjectPath: string | null,
  projects: ProjectEntry[],
  activeProjectId: string | null,
): string | null => {
  if (settingsProjectPath && projects.some((project) => project.path === settingsProjectPath)) {
    return settingsProjectPath;
  }

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? projects[0];
  return activeProject?.path ?? null;
};

export const useSettingsDirectory = (): string | null => {
  const settingsProjectPath = useUIStore((state) => state.settingsProjectPath);
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);

  return resolveSettingsDirectory(settingsProjectPath, projects, activeProjectId);
};
