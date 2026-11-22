import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { spaceIdOfDirectory } from '@/lib/spaces/space-route';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { spacesWithNewProject } from './space-catalog-sync';
import { useSessionUIStore } from './session-ui-store';

export const subscribeSpaceSessionProject = (runtimeKey: string): (() => void) => useSpacesStore.subscribe((state, previous) => {
  if (state.spaces === previous.spaces || runtimeKey !== getRuntimeKey()) return;
  const session = useSessionUIStore.getState();
  const spaceId = spaceIdOfDirectory(session.currentSessionDirectory);
  if (!session.currentSessionId || spaceId === null || !spacesWithNewProject(state.spaces, previous.spaces).has(spaceId)) return;
  const projects = useProjectsStore.getState();
  const project = resolveProjectForSessionDirectory(projects.projects, session.availableWorktreesByProject, session.currentSessionDirectory);
  if (!project) return;
  if (projects.activeProjectId !== project.id) projects.setActiveProjectIdOnly(project.id);
  if (!session.currentSessionKeepsSingleProject) useSessionDisplayStore.getState().setSingleProjectId(project.id);
});
