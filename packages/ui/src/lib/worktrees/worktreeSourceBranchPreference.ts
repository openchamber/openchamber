interface WorktreeSourceBranchArgs {
  branches: readonly string[];
  /** The branch checked out at the project root, when known. */
  rootBranch: string | null;
  /**
   * The bound remote's default branch (from `defaultBranches`), when known.
   * Preferred over the root checkout: a new worktree is usually a new task,
   * and a root sitting on a feature branch would carry its unmerged work in.
   */
  defaultBranch?: string | null;
  /** The remote `defaultBranch` belongs to; its tracking ref is fresher than a local branch. */
  remote?: string;
}

/**
 * The branch a new worktree starts from unless the user picks another: the
 * remote's default branch as the remote has it (its tracking ref, else the
 * local branch of that name), else the one the project root is on, else
 * `main`, `master`, or the first branch. An earlier pick is deliberately not
 * remembered: it silently based later worktrees on a branch that had moved on.
 */
export const resolveDefaultSourceBranch = ({ branches, rootBranch, defaultBranch, remote }: WorktreeSourceBranchArgs): string => {
  if (defaultBranch) {
    const tracking = remote ? `remotes/${remote}/${defaultBranch}` : null;
    if (tracking && branches.includes(tracking)) return tracking;
    if (branches.includes(defaultBranch)) return defaultBranch;
  }
  if (rootBranch && branches.includes(rootBranch)) return rootBranch;
  if (branches.includes('main')) return 'main';
  if (branches.includes('master')) return 'master';
  return branches[0] ?? '';
};

/**
 * Where a branch on top of `branch` starts: its local copy, which may hold
 * work not pushed yet, else its copy on `origin`, else on another remote.
 * Empty when the repository has neither.
 */
export const resolveBranchOnTopSource = (branches: readonly string[], branch: string): string => {
  if (branches.includes(branch)) return branch;
  if (branches.includes(`remotes/origin/${branch}`)) return `remotes/origin/${branch}`;
  return branches.find((candidate) => candidate.startsWith('remotes/') && candidate.split('/').slice(2).join('/') === branch) ?? '';
};
