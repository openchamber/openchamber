import path from 'node:path';
import { asNonEmptyString } from '../shared/guards.js';
import { OpenChamberControlError, asControlError } from '../openchamber-control/error.js';

/**
 * Moves a running session into a new worktree of its repository: the agent's
 * way of leaving a branch that already belongs to another piece of work.
 *
 * The worktree is made by the same pipeline as the New worktree dialog and
 * `session.create`, so it lands where the sidebar expects it. The session
 * itself is moved last, so that until the final step nothing the user sees has
 * changed.
 *
 * Only the files the agent names in `carry` go along, through one git stash
 * that both worktrees can see. Everything else uncommitted stays in the source
 * checkout: git cannot tell the agent's edits from the user's or another
 * session's in the same directory, and neither can OpenCode, whose session
 * diff is a snapshot of the whole working tree. The agent knows which files it
 * wrote. A failure anywhere removes the worktree again and puts the carried
 * changes back where they were; when even that fails the stash is left in
 * place and the error names it, so nothing is lost.
 */

/**
 * @param {object} dependencies
 * @param {(directory: string, input: object, options: object) => Promise<{ name: string, branch: string, path: string }>} dependencies.createWorktree
 * @param {(directory: string, input: object, options: object) => Promise<unknown>} dependencies.removeWorktree
 * @param {(directory: string) => Promise<void>} dependencies.waitForWorktreeReady
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
 * @param {(message: string, error: unknown) => void} [dependencies.warn]
 */
export const createSessionWorktreeMover = (dependencies) => {
  const {
    createWorktree,
    removeWorktree,
    waitForWorktreeReady,
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
    warn = (message, error) => console.warn(message, error instanceof Error ? error.message : String(error)),
  } = dependencies;

  /**
   * The branch a task starts from when the caller named none: the remote's
   * default branch as a local branch, else its remote-tracking ref, else a
   * conventional name, else the primary checkout's HEAD.
   */
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

  const findStash = async (directory, predicate) => (await listStashes(directory)).find(predicate) ?? null;

  /**
   * Stash the named files' changes and apply them in the worktree. The
   * stash is identified by its commit hash, never by `stash@{0}`: another
   * stash pushed meanwhile would otherwise be the one applied. Whether the
   * push stashed anything is read from the stash list, not from git's
   * message: a git that speaks another language reports a clean checkout in
   * words `stashPush` does not recognise.
   */
  const carryChanges = async ({ source, destination, sessionId, name, paths }) => {
    const message = `OpenChamber: session ${sessionId} moved to worktree ${name}`;
    const before = new Set((await listStashes(source)).map((entry) => entry.hash));
    await stashPush(source, { message, paths: paths.map((filePath) => path.resolve(source, filePath)) });
    let stash;
    try {
      stash = await findStash(source, (entry) => !before.has(entry.hash) && entry.message.includes(message));
    } catch (error) {
      // The changes may already be in the stash; a failure here must still say where.
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

  /** Put the stashed changes back into the source checkout and drop the stash. */
  const restoreChanges = async (source, stash) => {
    await stashApply(source, { ref: stash.hash });
    await dropStash(source, stash);
  };

  // A branch that existed before the move stays; only one the move made goes with the worktree.
  const removeCreatedWorktree = (root, worktree, deleteLocalBranch) => removeWorktree(root, {
    directory: worktree.path,
    deleteLocalBranch,
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
      // A remote branch gets a local branch that tracks it; a local one keeps its own tracking.
      worktreeInput = { mode: 'existing', name, existingBranch, setUpstream: true };
    } else {
      startRef = asNonEmptyString(input?.startRef) || await resolveDefaultStartRef(root);
      worktreeInput = { mode: 'new', name, startRef };
      if (branchName) worktreeInput.branchName = branchName;
    }

    let worktree;
    try {
      worktree = await createWorktree(root, worktreeInput, {
        bootstrapStore,
        hydrateCheckout: ({ directory, parentRemoteName }) => hydrateCheckout({ directory, parentDirectory: root, parentRemoteName }),
      });
    } catch (error) {
      throw asControlError(error, 'Failed to create the worktree');
    }

    let stash = null;
    try {
      await waitForWorktreeReady(worktree.path);
      if (paths.length > 0) stash = await carryChanges({ source, destination: worktree.path, sessionId, name, paths });
      await moveSession(sessionId, worktree.path);
    } catch (error) {
      await removeCreatedWorktree(root, worktree, ownsBranch);
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
      throw failure;
    }

    if (stash) {
      await dropStash(root, stash).catch((error) => {
        warn(`The moved changes are applied, but their stash ${stash.ref} could not be dropped:`, error);
      });
    }

    return {
      sessionId,
      directory: worktree.path,
      previousDirectory: source,
      worktree: { name: worktree.name, branch: worktree.branch, path: worktree.path, ...(existingBranch ? { existingBranch } : { startRef }) },
      changesMoved: stash !== null,
      // What the agent named; anything else uncommitted stayed where it was.
      carried: paths,
    };
  };

  return { move, resolveDefaultStartRef };
};
