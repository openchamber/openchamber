import type { ProjectEntry } from '@/lib/api/types';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';

/**
 * Resolves which project the Settings pages describe.
 *
 * `settingsProjectPath` is the user's pick in the Settings project selector.
 * Until they make one — or when the project it names is gone — Settings follows
 * the app's active project, so nothing looks different before it is used.
 */
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

/**
 * Directory the Settings pages read and write configuration for.
 *
 * Settings has its own project selector. Picking a project there used to call
 * `setActiveProject`, which moves the whole app — chat, sessions, files, git —
 * so reading another project's MCP servers silently relocated the user.
 */
export const useSettingsDirectory = (): string | null => {
  const settingsProjectPath = useUIStore((state) => state.settingsProjectPath);
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);

  return resolveSettingsDirectory(settingsProjectPath, projects, activeProjectId);
};
