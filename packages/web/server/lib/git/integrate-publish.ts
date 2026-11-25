import type { GitCommandResult, WorktreeEntry } from './service-contracts.js';

interface IntegratePublisherDependencies {
  runGit(cwd: string, args: string[]): Promise<GitCommandResult>;
  listWorktrees(repoRoot: string): Promise<WorktreeEntry[]>;
  pathExists(target: string): Promise<boolean>;
}

const errorText = (result: GitCommandResult) => (result.stderr || result.message || '').trim();

export const createIntegratePublisher = ({ runGit, listWorktrees, pathExists }: IntegratePublisherDependencies) => {
  const runOrThrow = async (cwd: string, args: string[], failure: string) => {
    const result = await runGit(cwd, args);
    if (!result.success) {
      throw new Error(result.message || failure);
    }
    return result;
  };

  const readHead = async (tmpDir: string) =>
    (await runOrThrow(tmpDir, ['rev-parse', '--verify', 'HEAD'], 'Failed to read the temporary checkout')).stdout.trim();

  const readBranchTip = async (repoRoot: string, targetBranch: string) =>
    (await runOrThrow(
      repoRoot,
      ['rev-parse', '--verify', `refs/heads/${targetBranch}`],
      `Branch not found: ${targetBranch}`,
    )).stdout.trim();

  const findBranchCheckout = async (repoRoot: string, targetBranch: string) => {
    const alias = await runGit(repoRoot, ['symbolic-ref', '--quiet', `refs/heads/${targetBranch}`]);
    if (alias.success) {
      throw new Error(`Branch ${targetBranch} is an alias of ${alias.stdout.trim().replace(/^refs\/heads\//, '')}. Choose that branch as the target.`);
    }
    const entries = await listWorktrees(repoRoot);
    const holders = entries
      .filter((entry) => entry.branchRef === `refs/heads/${targetBranch}`)
      .map((entry) => entry.worktree);
    if (holders.length > 1) {
      throw new Error(`Branch ${targetBranch} is checked out in more than one checkout (${holders.join(', ')}). Switch all but one to another branch and try again.`);
    }
    const holder = holders[0] ?? null;
    if (holder && !await pathExists(holder)) {
      throw new Error(`Branch ${targetBranch} is checked out at ${holder}, but that folder is missing. Restore or remove that worktree and try again.`);
    }
    return holder;
  };

  const fastForwardToUpstream = async (tmpDir: string, targetBranch: string) => {
    const upstream = await runGit(tmpDir, ['rev-parse', '--verify', '--quiet', `${targetBranch}@{upstream}`]);
    if (!upstream.success) {
      return;
    }
    const ff = await runGit(tmpDir, ['merge', '--ff-only', upstream.stdout.trim()]);
    if (!ff.success) {
      throw new Error(errorText(ff) || 'Fast-forward failed');
    }
  };

  const publish = async ({ repoRoot, targetBranch, targetSha, tmpDir, result }: { repoRoot: string; targetBranch: string; targetSha: string; tmpDir: string; result: string }) => {
    if (await readBranchTip(repoRoot, targetBranch) !== targetSha) {
      throw new Error(`Branch ${targetBranch} moved while its commits were being integrated, so nothing was published. The integrated commits are in ${tmpDir}. Abort and start again.`);
    }
    const holder = await findBranchCheckout(repoRoot, targetBranch);
    const before = holder ? await runGit(holder, ['status', '--porcelain']) : null;
    const published = holder
      ? await runGit(holder, ['merge', '--ff-only', '--no-squash', '--no-autostash', '--no-overwrite-ignore', result])
      : await runGit(tmpDir, ['fetch', '--no-tags', '--no-prune', '.', `${result}:refs/heads/${targetBranch}`]);
    if (await readBranchTip(repoRoot, targetBranch) === result) {
      return;
    }
    const reason = errorText(published);
    if (!holder) {
      throw new Error(`Could not update ${targetBranch}. ${reason}`);
    }
    const after = await runGit(holder, ['status', '--porcelain']);
    throw new Error(after.stdout === before?.stdout
      ? `Could not update ${targetBranch} in its checkout at ${holder}. Nothing there was changed. ${reason}`
      : `Updating ${targetBranch} stopped partway: files in its checkout at ${holder} changed but the branch did not move. Try again to finish. ${reason}`);
  };

  return { readHead, readBranchTip, findBranchCheckout, fastForwardToUpstream, publish };
};
