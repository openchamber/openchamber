interface WorktreeSourceBranchArgs {
  branches: readonly string[];
  rootBranch: string | null;
  defaultBranch?: string | null;
  remote?: string;
}

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

export const resolveBranchOnTopSource = (branches: readonly string[], branch: string): string => {
  if (branches.includes(branch)) return branch;
  if (branches.includes(`remotes/origin/${branch}`)) return `remotes/origin/${branch}`;
  return branches.find((candidate) => candidate.startsWith('remotes/') && candidate.split('/').slice(2).join('/') === branch) ?? '';
};
