/**
 * The trust prompt for a team's shared project setup.
 *
 * Commands in `<repo>/.openchamber/project.json` run on this machine, and a
 * `git pull` can change them. So the first time a shared setup command or a
 * shared action is about to run, the app shows exactly what would run and
 * asks. The answer is recorded on the instance against a hash of those
 * commands (`trust.hash`); a pull that changes them brings the prompt back.
 *
 * One request is active at a time; a newer one settles the pending one the way
 * that request is dismissed. The dialog (`SharedTrustConfirmDialog`) renders
 * the pending request on every surface.
 */

import { getProjectSetup, updateProjectSetup, type ProjectRef, type ProjectSetup } from './openchamberConfig';

export type SharedTrustChoice = 'trust' | 'skip' | 'cancel';

/**
 * What closing the prompt without choosing means. Worktree creation treats it
 * as `cancel`: the user closed the question, so nothing is created. Requests
 * that cannot be undone (a project action, a space) treat it as `skip`.
 */
type SharedTrustDismissChoice = Exclude<SharedTrustChoice, 'trust'>;

/** Where the commands would run: on this machine, or inside an isolated space. The prompt says which. */
type SharedTrustRunsIn = 'machine' | 'space';

type PendingSharedTrustRequest = {
  project: ProjectRef;
  sharedPath: string;
  runsIn: SharedTrustRunsIn;
  dismissChoice: SharedTrustDismissChoice;
  setupCommands: string[];
  actions: Array<{ id: string; name: string; command: string }>;
  resolve: (choice: SharedTrustChoice) => void;
};

let pendingRequest: PendingSharedTrustRequest | null = null;
const listeners = new Set<() => void>();

const emitChange = (): void => {
  for (const listener of listeners) listener();
};

export const getSharedTrustConfirmationSnapshot = (): PendingSharedTrustRequest | null => pendingRequest;

export const subscribeSharedTrustConfirmation = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const settleSharedTrustConfirmation = (choice: SharedTrustChoice): void => {
  const request = pendingRequest;
  pendingRequest = null;
  emitChange();
  request?.resolve(choice);
};

const askForTrust = (
  project: ProjectRef,
  setup: ProjectSetup,
  runsIn: SharedTrustRunsIn,
  dismissChoice: SharedTrustDismissChoice,
): Promise<SharedTrustChoice> => {
  if (pendingRequest) {
    pendingRequest.resolve(pendingRequest.dismissChoice);
  }
  return new Promise<SharedTrustChoice>((resolve) => {
    pendingRequest = {
      project,
      sharedPath: setup.shared.path,
      runsIn,
      dismissChoice,
      setupCommands: setup.shared.setupWorktree,
      actions: setup.shared.projectActions.map(({ id, name, command }) => ({ id, name, command })),
      resolve,
    };
    emitChange();
  });
};

const answerSharedTrust = async (
  project: ProjectRef,
  setup: ProjectSetup,
  runsIn: SharedTrustRunsIn,
  dismissChoice: SharedTrustDismissChoice,
): Promise<SharedTrustChoice> => {
  if (setup.trust.trusted || setup.trust.hash === null) {
    return 'trust';
  }
  const choice = await askForTrust(project, setup, runsIn, dismissChoice);
  if (choice !== 'trust') {
    return choice;
  }
  const recorded = await updateProjectSetup(project, { sharedTrustHash: setup.trust.hash });
  if (!recorded) {
    // The commands still run this once: the user said yes to exactly these.
    console.warn('Failed to record the trust answer; the prompt will return next time.');
  }
  return choice;
};

/**
 * Make sure the shared commands of `setup` may run. Resolves `true` at once
 * when there is nothing to trust or the current commands were trusted before;
 * otherwise asks, records a "trust" answer on the instance, and resolves
 * `false` when the user chose to run without the shared commands this time.
 * Closing the prompt skips the shared commands: the caller has already begun
 * work that dismissing cannot undo.
 */
export const ensureSharedSetupTrusted = async (project: ProjectRef, setup: ProjectSetup, runsIn: SharedTrustRunsIn = 'machine'): Promise<boolean> => {
  return (await answerSharedTrust(project, setup, runsIn, 'skip')) === 'trust';
};

const resolveWorktreeSetupCommandsForDismissal = async (
  project: ProjectRef,
  runsIn: SharedTrustRunsIn,
  dismissChoice: SharedTrustDismissChoice,
): Promise<string[] | null> => {
  const setup = await getProjectSetup(project);
  if (setup.shared.setupWorktree.length === 0 || setup.personal.setupWorktreeMode === 'replace') {
    return setup.setupWorktree;
  }
  const choice = await answerSharedTrust(project, setup, runsIn, dismissChoice);
  if (choice === 'cancel') {
    return null;
  }
  return choice === 'trust' ? setup.setupWorktree : setup.personal.setupWorktree;
};

/**
 * The setup commands a new worktree should run for `project`, after the trust
 * prompt when the shared ones have not been trusted yet. A "skip" answer
 * leaves only the user's own commands. An isolated space asks the same, saying that they run
 * inside the space; the answer is remembered the same way.
 */
export const resolveWorktreeSetupCommands = async (project: ProjectRef, runsIn: SharedTrustRunsIn = 'machine'): Promise<string[]> => {
  return (await resolveWorktreeSetupCommandsForDismissal(project, runsIn, 'skip')) ?? [];
};

/**
 * The setup commands for a worktree the user is about to create. Closing the
 * trust prompt cancels the creation rather than skipping the shared commands,
 * so this resolves `null` and the caller must not create anything.
 */
export const resolveWorktreeSetupCommandsOrCancel = async (project: ProjectRef, runsIn: SharedTrustRunsIn = 'machine'): Promise<string[] | null> => {
  return resolveWorktreeSetupCommandsForDismissal(project, runsIn, 'cancel');
};

/** Forget the recorded trust answer, so the next shared command asks again. */
export const resetSharedSetupTrust = (project: ProjectRef): Promise<boolean> => (
  updateProjectSetup(project, { sharedTrustHash: null })
);
