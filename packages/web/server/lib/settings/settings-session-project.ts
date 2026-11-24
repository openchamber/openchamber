import type { createSettingsFileState } from './settings-file-state.js';
import type { SettingsDocument } from './settings-helpers.js';
import type { SettingsProject } from './settings-normalization-runtime.js';

type ResolveProject = (projects: SettingsProject[]) => SettingsProject | Promise<SettingsProject>;

export const createSessionProjectRegistrar = ({ save, settingsFileState, readSettingsStrict, sanitizeProjects, writeSettings }: {
  save: (operation: () => Promise<SettingsProject>) => Promise<SettingsProject>;
  settingsFileState: Pick<ReturnType<typeof createSettingsFileState>, 'readForWrite'>;
  readSettingsStrict: () => Promise<SettingsDocument>;
  sanitizeProjects: (projects: SettingsDocument[string]) => SettingsProject[] | undefined;
  writeSettings: (text: string, expectedRevision: number) => Promise<void>;
}) => (resolveProject: ResolveProject) => save(async () => {
  const snapshot = await settingsFileState.readForWrite('settings');
  const current = snapshot.missing && snapshot.document ? snapshot.document : await readSettingsStrict();
  if (Array.isArray(current) || (current.projects !== undefined && !Array.isArray(current.projects))) {
    throw new Error('Project registry is malformed');
  }
  const projects = sanitizeProjects(current.projects) || [];
  const project = await resolveProject(projects);
  if (!projects.some((entry) => entry.id === project.id)) {
    await writeSettings(JSON.stringify({ ...current, projects: [...(current.projects || []), project] }, null, 2), snapshot.revision ?? 0);
  }
  return project;
});
