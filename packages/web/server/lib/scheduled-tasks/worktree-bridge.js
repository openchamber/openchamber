export const createUnregisteredScheduledWorktreeBridge = () => ({
  create: () => Promise.reject(new Error('worktree bridge not registered yet')),
  remove: () => Promise.reject(new Error('worktree bridge not registered yet')),
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
    deleteBranch,
    isGitRepository,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    bootstrapStore,
  } = dependencies;

  if (createWorktree instanceof Function) {
    bridge.create = ({ projectDirectory, baseBranch }) => {
      const input = { mode: 'new' };
      if (baseBranch) input.startRef = baseBranch;
      return createWorktree(projectDirectory, input).then((created) => ({
        directory: created.path,
        branch: created.branch || null,
        name: created.name || null,
      }));
    };
  } else {
    bridge.create = null;
  }

  bridge.remove = async ({ projectDirectory, worktreeDirectory, deleteLocalBranch, branch, removeDirectory = true }) => {
    if (removeDirectory) await removeWorktree(projectDirectory, {
      directory: worktreeDirectory,
      deleteLocalBranch: false,
      disposeInstance: createWorktreeInstanceDisposer instanceof Function
        ? createWorktreeInstanceDisposer({ buildOpenCodeUrl, getOpenCodeAuthHeaders })
        : undefined,
    }, { bootstrapStore });
    if (deleteLocalBranch !== false && branch) {
      await deleteBranch(projectDirectory, branch, { force: true, ifExists: true });
    }
  };

  bridge.isGitRepository = (projectDirectory) => isGitRepository(projectDirectory, { strict: true });

  return bridge;
};
