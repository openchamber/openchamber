// The project's worktree setup commands for a space (5d-4): chosen the way a new worktree chooses
// them, the shared ones from the repository only after the trust prompt, and run by the host
// inside the space. What runs now and how the last run ended is in the journey list.

import { getProjectSetup, getWorktreeSetupWaitEnabled } from '@/lib/openchamberConfig';
import { resolveWorktreeSetupCommands } from '@/lib/sharedTrustConfirmation';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { runSpaceSetup, SpacesRequestError, type SpaceEntry } from './spaces-api';

/** What a space runs once its code arrived, and whether the first message waits for it. */
export type SpaceSetupPlan = { commands: string[]; waitBeforeSending: boolean };

/** The project as the setup helpers name it: by its path, which is what names its setup file. */
const projectRefOf = (projectDirectory: string) => ({
  id: useProjectsStore.getState().projects.find((project) => project.path === projectDirectory)?.id ?? '',
  path: projectDirectory,
});

/**
 * The setup commands a new space of this project runs, after the trust prompt when the shared
 * ones were not trusted yet, and the project's "wait for setup commands" setting.
 */
export const resolveSpaceSetupPlan = async (projectDirectory: string): Promise<SpaceSetupPlan> => {
  const project = projectRefOf(projectDirectory);
  const commands = await resolveWorktreeSetupCommands(project, 'space');
  if (commands.length === 0) return { commands, waitBeforeSending: false };
  return { commands, waitBeforeSending: await getWorktreeSetupWaitEnabled(project) };
};

/**
 * Runs the project's setup commands again in a running space, as they are in the project's
 * settings now. Nothing to run refuses with a code of its own, so the group can say why: the
 * project has none, or the user skipped the repository's at the trust prompt and has none of their own.
 */
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
