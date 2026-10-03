import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

/**
 * Opens a new-session draft for the active project with the composer in "Run
 * in parallel" mode, optionally prefilled. Every launcher entry point (command
 * palette, "start a run from this answer") goes through here.
 * A run needs a project, so the draft never targets managed Chats.
 */
export function openParallelComposer(prompt = ''): void {
  const projects = useProjectsStore.getState();
  const project = projects.projects.find((entry) => entry.id === projects.activeProjectId) ?? projects.projects[0];
  useUIStore.getState().closeMainSurfaces();
  useSessionUIStore.getState().openNewSessionDraft(project
    ? { target: 'project', selectedProjectId: project.id, directoryOverride: project.path }
    : { target: 'project' });
  useUIStore.getState().requestParallelComposer(prompt);
}
