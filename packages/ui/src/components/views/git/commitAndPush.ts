import type { GitAPI, GitPushResult, GitRemote, GitStatus } from '@/lib/api/types';

type CommitPushGitAPI = Pick<GitAPI, 'gitFetch' | 'getGitStatus' | 'gitPull' | 'gitPush'>;

type PushCommittedChangesOptions = {
  git: CommitPushGitAPI;
  directory: string;
  remote: GitRemote;
  status: GitStatus | null | undefined;
  dirtyWorktreeError: string;
  onPushed?: (result: GitPushResult) => void;
};

export const pushCommittedChanges = async ({
  git,
  directory,
  remote,
  status,
  dirtyWorktreeError,
  onPushed,
}: PushCommittedChangesOptions): Promise<GitPushResult> => {
  const trackingPrefix = `${remote.name}/`;
  const trackedBranch = status?.tracking?.startsWith(trackingPrefix)
    ? status.tracking.slice(trackingPrefix.length)
    : undefined;

  await git.gitFetch(directory, { remote: remote.name });
  const afterFetch = await git.getGitStatus(directory);
  if ((afterFetch.behind ?? 0) > 0) {
    if ((afterFetch.files?.length ?? 0) > 0) {
      throw new Error(dirtyWorktreeError);
    }
    await git.gitPull(directory, { remote: remote.name, branch: trackedBranch, rebase: true });
  }

  const result = await git.gitPush(directory, { remote: remote.name });
  onPushed?.(result);
  return result;
};
