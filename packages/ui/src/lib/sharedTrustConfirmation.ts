/**
 * The trust prompt for a team's shared project setup.
 *
 * Commands in `<repo>/.openchamber/project.json` run on this machine, and a
 * `git pull` can change them. So the first time a shared setup command or a
 * shared action is about to run, the app shows exactly what would run and
 * asks. The answer is recorded on the instance against a hash of those
 * commands (`trust.hash`); a pull that changes them brings the prompt back.
 *
 * One request is active at a time; a newer one settles the pending one as
 * `skip`. The dialog (`SharedTrustConfirmDialog`) renders the pending request
 * on every surface.
 */

import { getProjectSetup, updateProjectSetup, type ProjectRef, type ProjectSetup } from './openchamberConfig';

export type SharedTrustChoice = 'trust' | 'skip';

/** Where the commands would run: on this machine, or inside an isolated space. The prompt says which. */
type SharedTrustRunsIn = 'machine' | 'space';

type PendingSharedTrustRequest = {
  project: ProjectRef;
  sharedPath: string;
  runsIn: SharedTrustRunsIn;
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

const askForTrust = (project: ProjectRef, setup: ProjectSetup, runsIn: SharedTrustRunsIn): Promise<SharedTrustChoice> => {
  if (pendingRequest) {
    pendingRequest.resolve('skip');
  }
  return new Promise<SharedTrustChoice>((resolve) => {
    pendingRequest = {
      project,
      sharedPath: setup.shared.path,
      runsIn,
      setupCommands: setup.shared.setupWorktree,
      actions: setup.shared.projectActions.map(({ id, name, command }) => ({ id, name, command })),
      resolve,
    };
    emitChange();
  });
};

/**
 * Make sure the shared commands of `setup` may run. Resolves `true` at once
 * when there is nothing to trust or the current commands were trusted before;
 * otherwise asks, records a "trust" answer on the instance, and resolves
 * `false` when the user chose to run without the shared commands this time.
 */
export const ensureSharedSetupTrusted = async (project: ProjectRef, setup: ProjectSetup, runsIn: SharedTrustRunsIn = 'machine'): Promise<boolean> => {
  if (setup.trust.trusted || setup.trust.hash === null) {
    return true;
  }
  const choice = await askForTrust(project, setup, runsIn);
  if (choice !== 'trust') {
    return false;
  }
  const recorded = await updateProjectSetup(project, { sharedTrustHash: setup.trust.hash });
  if (!recorded) {
    // The commands still run this once: the user said yes to exactly these.
    console.warn('Failed to record the trust answer; the prompt will return next time.');
  }
  return true;
};

/**
 * The setup commands a new worktree should run for `project`, after the trust
 * prompt when the shared ones have not been trusted yet. A "skip" answer
 * leaves only the user's own commands. An isolated space asks the same, saying that they run
 * inside the space; the answer is remembered the same way.
 */
export const resolveWorktreeSetupCommands = async (project: ProjectRef, runsIn: SharedTrustRunsIn = 'machine'): Promise<string[]> => {
  const setup = await getProjectSetup(project);
  if (setup.shared.setupWorktree.length === 0 || setup.personal.setupWorktreeMode === 'replace') {
    return setup.setupWorktree;
  }
  if (await ensureSharedSetupTrusted(project, setup, runsIn)) {
    return setup.setupWorktree;
  }
  return setup.personal.setupWorktree;
};

/** Forget the recorded trust answer, so the next shared command asks again. */
export const resetSharedSetupTrust = (project: ProjectRef): Promise<boolean> => (
  updateProjectSetup(project, { sharedTrustHash: null })
);
