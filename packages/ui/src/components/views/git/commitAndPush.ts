import type { GitAPI, GitPullResult, GitPushResult, GitRemote } from '@/lib/api/types';

type CommitPushGitAPI = Pick<GitAPI, 'gitFetch' | 'getGitStatus' | 'gitPull' | 'gitPush'>;

type PushCommittedChangesOptions = {
  git: CommitPushGitAPI;
  directory: string;
  remote: GitRemote;
  dirtyWorktreeError: string;
  onPulled?: (result: GitPullResult) => void;
  onPushed?: (result: GitPushResult) => void;
};

export const pushCommittedChanges = async ({
  git,
  directory,
  remote,
  dirtyWorktreeError,
  onPulled,
  onPushed,
}: PushCommittedChangesOptions): Promise<GitPushResult> => {
  await git.gitFetch(directory, { remote: remote.name });
  const afterFetch = await git.getGitStatus(directory);
  const trackingPrefix = `${remote.name}/`;
  const trackedBranch = afterFetch.tracking?.startsWith(trackingPrefix)
    ? afterFetch.tracking.slice(trackingPrefix.length)
    : undefined;
  if ((afterFetch.behind ?? 0) > 0) {
    if ((afterFetch.files?.length ?? 0) > 0) {
      throw new Error(dirtyWorktreeError);
    }
    const result = await git.gitPull(directory, { remote: remote.name, branch: trackedBranch, rebase: true });
    onPulled?.(result);
  }

  // Fetch/pull follow the upstream; Git owns the independently configured push destination.
  const result = await git.gitPush(directory);
  if (result.pushed.length > 0) onPushed?.(result);
  return result;
};
