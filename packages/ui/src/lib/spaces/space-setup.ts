
import { fetchProjectSetup, getProjectSetup, getWorktreeSetupWaitEnabled } from '@/lib/openchamberConfig';
import { resolveWorktreeSetupCommands } from '@/lib/sharedTrustConfirmation';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { runSpaceSetup, SpacesRequestError, type SpaceEntry } from './spaces-api';

export type SpaceSetupPlan = { commands: string[]; waitBeforeSending: boolean };

const projectRefOf = (projectDirectory: string) => ({
  id: useProjectsStore.getState().projects.find((project) => project.path === projectDirectory)?.id ?? '',
  path: projectDirectory,
});

export const resolveSpaceSetupPlan = async (projectDirectory: string): Promise<SpaceSetupPlan> => {
  const project = projectRefOf(projectDirectory);
  const commands = await resolveWorktreeSetupCommands(project, 'space');
  if (commands.length === 0) return { commands, waitBeforeSending: false };
  return { commands, waitBeforeSending: await getWorktreeSetupWaitEnabled(project) };
};

export const readProjectHasSetup = (projectDirectory: string): Promise<boolean> =>
  fetchProjectSetup(projectRefOf(projectDirectory)).then((setup) => setup.setupWorktree.length > 0, () => true);

export const runSpaceSetupAgain = async (entry: SpaceEntry): Promise<SpaceEntry> => {
  if (entry.projectDirectory === null) {
    throw new SpacesRequestError('project_not_registered', 'The project of this space is no longer registered.', 0);
  }
  const project = projectRefOf(entry.projectDirectory);
  const commands = await resolveWorktreeSetupCommands(project, 'space');
  if (commands.length === 0) {
    const setup = await getProjectSetup(project);
    const skipped = setup.shared.setupWorktree.length > 0 && setup.personal.setupWorktreeMode !== 'replace';
    throw skipped
      ? new SpacesRequestError('space_setup_shared_skipped', 'The setup commands from the repository were skipped.', 0)
      : new SpacesRequestError('space_setup_no_commands', 'This project has no setup commands.', 0);
  }
  return runSpaceSetup(entry.id, commands);
};
