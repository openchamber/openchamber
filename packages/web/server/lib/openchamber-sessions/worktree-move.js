import path from 'node:path';
import { asNonEmptyString } from '../shared/guards.js';
import { OpenChamberControlError, asControlError } from '../openchamber-control/error.js';


/**
 * @param {object} dependencies
 * @param {(directory: string, input: object, options: object) => Promise<{ name: string, branch: string, path: string }>} dependencies.createWorktree
 * @param {(directory: string, input: object, options: object) => Promise<unknown>} dependencies.removeWorktree
 * @param {(directory: string) => Promise<{ setupStillRunning: boolean }>} dependencies.waitForWorktreeReady
 * @param {(input: { sourceDirectory: string, worktreeRoot: string }) => Promise<{ directory: string, fallback: string | null }>} dependencies.resolveStartDirectory
 *   Where the session starts inside the new worktree: the project's OpenCode folder, else the root.
 * @param {(input: { directory: string, parentDirectory: string, parentRemoteName: string }) => Promise<unknown>} dependencies.hydrateCheckout
 * @param {object} dependencies.bootstrapStore
 * @param {(directory: string, options: { message: string, paths: string[] }) => Promise<unknown>} dependencies.stashPush
 * @param {(directory: string, paths: string[]) => Promise<string[]>} dependencies.getPathsWithoutChanges
 * @param {(directory: string, options: { ref: string }) => Promise<unknown>} dependencies.stashApply
 * @param {(directory: string, options: { ref: string }) => Promise<unknown>} dependencies.stashDrop
 * @param {(directory: string) => Promise<Array<{ ref: string, message: string, hash: string }>>} dependencies.listStashes
 * @param {(directory: string, options: { remote: 'local' }) => Promise<{ all: string[], defaultBranches: Record<string, string> }>} dependencies.getBranches
 * @param {(directory: string) => Promise<{ root: string }>} dependencies.resolvePrimaryWorktreeRoot
 * @param {(sessionId: string, directory: string) => Promise<void>} dependencies.moveSession
 * @param {(sourceDirectory: string) => Promise<{ startCommand: string, createCommand?: string, untrustedSkipped: string[] }>} [dependencies.resolveWorktreeSetup]
 *   The project's setup commands for the new worktree (`../projects/worktree-setup.js`); none without it.
 * @param {(message: string, error: unknown) => void} [dependencies.warn]
 */
export const createSessionWorktreeMover = (dependencies) => {
  const {
    createWorktree,
    removeWorktree,
    waitForWorktreeReady,
    resolveStartDirectory,
    hydrateCheckout,
    bootstrapStore,
    stashPush,
    getPathsWithoutChanges,
    stashApply,
    stashDrop,
    listStashes,
    getBranches,
    resolvePrimaryWorktreeRoot,
    moveSession,
    resolveWorktreeSetup = async () => ({ startCommand: '', untrustedSkipped: [] }),
    warn = (message, error) => console.warn(message, error instanceof Error ? error.message : String(error)),
  } = dependencies;

  const resolveDefaultStartRef = async (root) => {
    const branches = await getBranches(root, { remote: 'local' });
    const local = new Set(branches.all);
    const remotes = Object.keys(branches.defaultBranches);
    const remote = remotes.includes('origin') ? 'origin' : remotes[0];
    const name = remote ? branches.defaultBranches[remote] : null;
    if (name && local.has(name)) return name;
    if (name) return `remotes/${remote}/${name}`;
    for (const candidate of ['main', 'master']) {
      if (local.has(candidate)) return candidate;
    }
    return 'HEAD';
  };

  const waitingWorktrees = new Map();

  const findStash = async (directory, predicate) => (await listStashes(directory)).find(predicate) ?? null;

  const carryChanges = async ({ source, destination, sessionId, name, paths }) => {
    const message = `OpenChamber: session ${sessionId} moved to worktree ${name}`;
    const before = new Set((await listStashes(source)).map((entry) => entry.hash));
    await stashPush(source, { message, paths: paths.map((filePath) => path.resolve(source, filePath)) });
    let stash;
    try {
      stash = await findStash(source, (entry) => !before.has(entry.hash) && entry.message.includes(message));
    } catch (error) {
      throw new OpenChamberControlError(
        `The stash list could not be read after stashing the uncommitted changes: ${error instanceof Error ? error.message : String(error)}. If git stash list shows "${message}", the changes are there`,
        500,
      );
    }
    if (!stash) return null;
    try {
      await stashApply(destination, { ref: stash.hash });
    } catch (error) {
      throw new OpenChamberControlError(
        `The uncommitted changes do not apply in the new worktree: ${error instanceof Error ? error.message : String(error)}`,
        409,
        { stash },
      );
    }
    return stash;
  };

  const dropStash = async (directory, stash) => {
    const entry = await findStash(directory, (candidate) => candidate.hash === stash.hash);
    if (entry) await stashDrop(directory, { ref: entry.ref });
  };

  const restoreChanges = async (source, stash) => {
    await stashApply(source, { ref: stash.hash });
    await dropStash(source, stash);
  };

  const removeCreatedWorktree = (root, worktree, deleteLocalBranch) => removeWorktree(root, {
    directory: worktree.path,
    deleteLocalBranch,
    cancelSetup: true,
  }, { bootstrapStore }).catch((error) => {
    warn(`Failed to remove worktree ${worktree.path} after a failed session move:`, error);
  });

  /**
   * `existingBranch` checks out a branch that already exists, local or remote
   * (`origin/feature`), instead of making a new one from `startRef`. `carry`
   * names the files whose uncommitted changes go along; without it nothing
   * does.
   *
   * @param {{ sessionId: string, directory: string, name: string, branchName?: string, startRef?: string, existingBranch?: string, carry?: string[] }} input
   */
  const move = async (input) => {
    const sessionId = asNonEmptyString(input?.sessionId);
    if (!sessionId) throw new OpenChamberControlError('sessionId is required', 400);
    const source = asNonEmptyString(input?.directory);
    if (!source) throw new OpenChamberControlError('The session has no directory to move from', 400);
    const name = asNonEmptyString(input?.name);
    if (!name) throw new OpenChamberControlError('worktree is required: a short folder name for the task', 400);
    const existingBranch = asNonEmptyString(input?.existingBranch);
    const branchName = asNonEmptyString(input?.branchName);
    if (existingBranch && (branchName || asNonEmptyString(input?.startRef))) {
      throw new OpenChamberControlError('existingBranch checks out that branch as it is; do not combine it with branch or startRef', 400);
    }
    const carry = input?.carry ?? [];
    if (!Array.isArray(carry) || carry.some((path) => !asNonEmptyString(path))) {
      throw new OpenChamberControlError('carry is a list of file paths', 400);
    }
    const paths = [...new Set(carry.map((path) => path.trim()))];
    if (paths.length > 0) {
      const unchanged = await getPathsWithoutChanges(source, paths);
      if (unchanged.length > 0) {
        throw new OpenChamberControlError(`carry paths have no uncommitted changes or cannot be resolved by git: ${unchanged.join(', ')}`, 400);
      }
    }

    const { root } = await resolvePrimaryWorktreeRoot(source);
    let startRef = null;
    let worktreeInput;
    let ownsBranch = true;
    if (existingBranch) {
      ownsBranch = !(await getBranches(root, { remote: 'local' })).all.includes(existingBranch);
      worktreeInput = { mode: 'existing', name, existingBranch, setUpstream: true };
    } else {
      startRef = asNonEmptyString(input?.startRef) || await resolveDefaultStartRef(root);
      worktreeInput = { mode: 'new', name, startRef };
      if (branchName) worktreeInput.branchName = branchName;
    }
    const setup = await resolveWorktreeSetup(source);
    if (setup.startCommand) worktreeInput.startCommand = setup.startCommand;
    if (setup.createCommand) worktreeInput.createCommand = setup.createCommand;

    let worktree;
    const waitingKey = JSON.stringify([sessionId, source, root, worktreeInput]);
    const waiting = waitingWorktrees.get(waitingKey);
    waitingWorktrees.delete(waitingKey);
    const retained = waiting && await resolvePrimaryWorktreeRoot(waiting.worktree.path)
      .then((found) => found?.root === root, () => false);
    if (retained) {
      ({ worktree, ownsBranch } = waiting);
    } else {
      try {
        worktree = await createWorktree(root, worktreeInput, {
          bootstrapStore,
          hydrateCheckout: ({ directory, parentRemoteName }) => hydrateCheckout({ directory, parentDirectory: root, parentRemoteName }),
        });
      } catch (error) {
        throw asControlError(error, 'Failed to create the worktree');
      }
    }

    let stash = null;
    let start = { directory: worktree.path, fallback: null };
    let setupStillRunning = false;
    try {
      ({ setupStillRunning } = await waitForWorktreeReady(worktree.path));
      if (!setupStillRunning) {
        start = await resolveStartDirectory({ sourceDirectory: source, worktreeRoot: worktree.path });
        if (paths.length > 0) stash = await carryChanges({ source, destination: worktree.path, sessionId, name, paths });
        await moveSession(sessionId, start.directory);
      }
    } catch (error) {
      const removal = retained ? Promise.resolve() : removeCreatedWorktree(root, worktree, ownsBranch);
      const failure = asControlError(error, 'Failed to move the session into the worktree');
      const pending = stash ?? failure.stash ?? null;
      if (pending) {
        try {
          await restoreChanges(source, pending);
        } catch (restoreError) {
          throw new OpenChamberControlError(
            `${failure.message}. The uncommitted changes are kept in git stash ${pending.hash} (${pending.message}); restoring them failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
            500,
          );
        }
      }
      await removal;
      throw failure;
    }

    if (setupStillRunning) {
      waitingWorktrees.set(waitingKey, { worktree, ownsBranch });
      throw new OpenChamberControlError(
        `The project's setup commands are still running in ${worktree.path}, so session ${sessionId} stayed in ${source} and no files were carried. Call session.moveToWorktree again with the same worktree to move in once they finish`,
        503,
        { partial: true, partialAction: 'worktree-setup-running', directory: worktree.path },
      );
    }

    if (stash) {
      await dropStash(root, stash).catch((error) => {
        warn(`The moved changes are applied, but their stash ${stash.ref} could not be dropped:`, error);
      });
    }

    const result = {
      sessionId,
      directory: start.directory,
      previousDirectory: source,
      worktree: { name: worktree.name, branch: worktree.branch, path: worktree.path, ...(existingBranch ? { existingBranch } : { startRef }) },
      changesMoved: stash !== null,
      carried: paths,
    };
    if (start.fallback) result.startDirectoryFallback = start.fallback;
    if (setup.untrustedSkipped.length > 0) result.untrustedSetupCommandsSkipped = setup.untrustedSkipped;
    return result;
  };

  return { move, resolveDefaultStartRef };
};
