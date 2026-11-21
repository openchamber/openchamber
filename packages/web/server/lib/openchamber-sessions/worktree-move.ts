import path from 'node:path';
import { asNonEmptyString } from '../shared/guards.js';
import { OpenChamberControlError, asControlError } from '../openchamber-control/error.js';
import type { ControlErrorStash } from '../openchamber-control/error.js';
import type { createWorktreeBootstrapStore } from '../git/worktree-bootstrap-storage.js';
import type { removeWorktree as removeWorktreeDefault, stashPush as stashPushDefault, stashApply as stashApplyDefault, stashDrop as stashDropDefault } from '../git/service.js';
import type { createFeatureRoutesRuntime } from '../server-frame/feature-routes-runtime.js';
import type { WorktreeSetup } from '../projects/contracts.js';
import type { StartDirectoryResult } from './worktree-start-directory.js';

export interface MoveWorktreeInput {
  sessionId?: unknown;
  directory?: unknown;
  name?: unknown;
  branchName?: unknown;
  startRef?: unknown;
  existingBranch?: unknown;
  carry?: unknown;
}

export interface SessionMoveWorktree {
  name: string;
  branch: string;
  path: string;
}

interface WorktreeCreateInput {
  mode: 'new' | 'existing';
  name: string;
  branchName?: string;
  startRef?: string;
  existingBranch?: string;
  setUpstream?: boolean;
  startCommand?: string;
  createCommand?: string;
}

type BootstrapStore = ReturnType<typeof createWorktreeBootstrapStore>;
type HydrateCheckout = ReturnType<typeof createFeatureRoutesRuntime>['hydrateBoundCheckout'];
type MoveWorktreeSetup = Pick<WorktreeSetup, 'startCommand' | 'untrustedSkipped'> & { createCommand?: string };

interface WorktreeMoverDependencies {
  createWorktree: (directory: string, input: WorktreeCreateInput, options: {
    bootstrapStore: BootstrapStore;
    hydrateCheckout: (input: { directory: string; parentRemoteName: string }) => ReturnType<HydrateCheckout>;
  }) => Promise<SessionMoveWorktree>;
  removeWorktree: (directory: string, input: { directory: string; deleteLocalBranch: boolean; cancelSetup: boolean }, options: { bootstrapStore: BootstrapStore }) => ReturnType<typeof removeWorktreeDefault>;
  waitForWorktreeReady: (directory: string) => Promise<{ setupStillRunning: boolean }>;
  resolveStartDirectory: (input: { sourceDirectory: string; worktreeRoot: string }) => Promise<StartDirectoryResult>;
  hydrateCheckout: HydrateCheckout;
  bootstrapStore: BootstrapStore;
  stashPush: (directory: string, options: { message: string; paths: string[] }) => ReturnType<typeof stashPushDefault>;
  getPathsWithoutChanges: (directory: string, paths: string[]) => Promise<string[]>;
  stashApply: (directory: string, options: { ref: string }) => ReturnType<typeof stashApplyDefault>;
  stashDrop: (directory: string, options: { ref: string }) => ReturnType<typeof stashDropDefault>;
  listStashes: (directory: string) => Promise<ControlErrorStash[]>;
  getBranches: (directory: string, options: { remote: 'local' }) => Promise<{ all: string[]; defaultBranches: Record<string, string> }>;
  resolvePrimaryWorktreeRoot: (directory: string) => Promise<{ root: string }>;
  moveSession: (sessionId: string, directory: string) => Promise<void>;
  resolveWorktreeSetup?: (sourceDirectory: string) => Promise<MoveWorktreeSetup>;
  warn?: (message: string, cause: unknown) => void;
}

export interface MoveWorktreeResult {
  sessionId: string;
  directory: string;
  previousDirectory: string;
  worktree: SessionMoveWorktree & { existingBranch?: string; startRef?: string | null };
  changesMoved: boolean;
  carried: string[];
  startDirectoryFallback?: Exclude<StartDirectoryResult['fallback'], null>;
  untrustedSetupCommandsSkipped?: string[];
}

const isCarryList = (value: unknown): value is string[] =>
  Array.isArray(value) && !value.some((path) => !asNonEmptyString(path));

export const createSessionWorktreeMover = (dependencies: WorktreeMoverDependencies) => {
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
    resolveWorktreeSetup = async (): Promise<MoveWorktreeSetup> => ({ startCommand: '', untrustedSkipped: [] }),
    warn = (message, error) => console.warn(message, error instanceof Error ? error.message : String(error)),
  } = dependencies;

  const resolveDefaultStartRef = async (root: string) => {
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

  const waitingWorktrees = new Map<string, { worktree: SessionMoveWorktree; ownsBranch: boolean }>();

  const findStash = async (directory: string, predicate: (entry: ControlErrorStash) => boolean) => (await listStashes(directory)).find(predicate) ?? null;

  const carryChanges = async ({ source, destination, sessionId, name, paths }: { source: string; destination: string; sessionId: string; name: string; paths: string[] }) => {
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

  const dropStash = async (directory: string, stash: ControlErrorStash) => {
    const entry = await findStash(directory, (candidate) => candidate.hash === stash.hash);
    if (entry) await stashDrop(directory, { ref: entry.ref });
  };

  const restoreChanges = async (source: string, stash: ControlErrorStash) => {
    await stashApply(source, { ref: stash.hash });
    await dropStash(source, stash);
  };

  const removeCreatedWorktree = (root: string, worktree: SessionMoveWorktree, deleteLocalBranch: boolean) => removeWorktree(root, {
    directory: worktree.path,
    deleteLocalBranch,
    cancelSetup: true,
  }, { bootstrapStore }).catch((error) => {
    warn(`Failed to remove worktree ${worktree.path} after a failed session move:`, error);
  });

  const move = async (input: MoveWorktreeInput): Promise<MoveWorktreeResult> => {
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
    if (!isCarryList(carry)) {
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
    let worktreeInput: WorktreeCreateInput;
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

    let worktree: SessionMoveWorktree;
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

    let stash: ControlErrorStash | null = null;
    let start: StartDirectoryResult = { directory: worktree.path, fallback: null };
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

    const result: MoveWorktreeResult = {
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
