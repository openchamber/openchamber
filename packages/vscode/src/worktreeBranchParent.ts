type RunGit = (cwd: string, args: string[]) => Promise<{ success: boolean; stdout: string }>;

const output = async (runGit: RunGit, cwd: string, args: string[]) => {
  const result = await runGit(cwd, args);
  return result.success ? String(result.stdout || '').trim() : '';
};

const startBranchName = async (runGit: RunGit, primaryWorktree: string, startRef: string) => {
  const fullName = await output(runGit, primaryWorktree, ['rev-parse', '--symbolic-full-name', startRef]);
  if (fullName.startsWith('refs/heads/')) return fullName.slice('refs/heads/'.length);
  if (!fullName.startsWith('refs/remotes/')) return null;
  const remoteRef = fullName.slice('refs/remotes/'.length);
  const remotes = (await output(runGit, primaryWorktree, ['remote'])).split('\n').map((name) => name.trim()).filter(Boolean);
  const remote = remotes.filter((name) => remoteRef.startsWith(`${name}/`)).sort((a, b) => b.length - a.length)[0];
  return remote ? remoteRef.slice(remote.length + 1) : null;
};

export async function recordWorktreeBranchParent(runGit: RunGit, primaryWorktree: string, branch: string, startRef: string) {
  const parent = await startBranchName(runGit, primaryWorktree, startRef);
  if (!parent || parent === branch) return;
  await runGit(primaryWorktree, ['config', `branch.${branch}.gh-merge-base`, parent]);
}
