/**
 * Fills the scheduled-task worktree bridge (#1959).
 *
 * The scheduled-tasks runtime is created before the git routes exist, so it
 * holds an empty bridge object and calls into it at run time. This module is
 * the wiring that gives that object its three functions: create a run
 * worktree through the same pipeline the New worktree dialog drives, remove a
 * run worktree the way the routes remove one, and answer whether a directory
 * is a git repository.
 *
 * It lives apart from `feature-routes-runtime.js` so the mapping can be tested
 * without building the whole route surface: a missing brace there once broke
 * the server's parse, and no test covered this wiring.
 */
/**
 * The bridge as it stands before the git routes register.
 *
 * Creation fails with a reason instead of returning nothing: a run that lands
 * in the boot window is told so, rather than being handed an empty answer that
 * reads as "not a git repository" and runs over the checkout (#1959). Removal
 * is a no-op because nothing was created, and the probe says "git" so the run
 * reaches creation and gets that reason.
 */
export const createUnregisteredScheduledWorktreeBridge = () => ({
  create: () => Promise.reject(new Error('worktree bridge not registered yet')),
  remove: () => Promise.resolve(),
  isGitRepository: () => true,
});

export const fillScheduledWorktreeBridge = (bridge, dependencies) => {
  if (!(bridge instanceof Object)) {
    return bridge;
  }

  const {
    createWorktree,
    createWorktreeInstanceDisposer,
    removeWorktree,
    isGitRepository,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    bootstrapStore,
  } = dependencies;

  if (createWorktree instanceof Function) {
    bridge.create = ({ projectDirectory, baseBranch }) =>
      createWorktree(projectDirectory, {
        mode: 'new',
        // No start ref means the new branch starts where the checkout is.
        ...(baseBranch ? { startRef: baseBranch } : {}),
      }).then((created) => ({
        directory: created.path,
        branch: created.branch || null,
        name: created.name || null,
      }));
  } else {
    bridge.create = null;
  }

  bridge.remove = ({ projectDirectory, worktreeDirectory, deleteLocalBranch }) =>
    removeWorktree(projectDirectory, {
      directory: worktreeDirectory,
      // A scheduled run keeps nothing behind on purpose: the branch was created
      // for this run, like a finished multi-run lane's (#1959).
      deleteLocalBranch: deleteLocalBranch !== false,
      // The run's OpenCode instance is released by path, the same way a
      // deleted worktree's is.
      disposeInstance: createWorktreeInstanceDisposer instanceof Function
        ? createWorktreeInstanceDisposer({ buildOpenCodeUrl, getOpenCodeAuthHeaders })
        : undefined,
    }, { bootstrapStore });

  // A probe error must stay an error: the runtime decides what to do with it,
  // and a plain `false` would read as "not a git repository" and quietly run
  // the task in the checkout (#1959).
  bridge.isGitRepository = (projectDirectory) => isGitRepository(projectDirectory);

  return bridge;
};
