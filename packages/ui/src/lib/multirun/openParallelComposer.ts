import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

export function openParallelComposer(prompt = ''): void {
  const projects = useProjectsStore.getState();
  const project = projects.projects.find((entry) => entry.id === projects.activeProjectId) ?? projects.projects[0];
  useUIStore.getState().closeMainSurfaces();
  useSessionUIStore.getState().openNewSessionDraft(project
    ? { target: 'project', selectedProjectId: project.id, directoryOverride: project.path }
    : { target: 'project' });
  useUIStore.getState().requestParallelComposer(prompt);
}
