import type { GitAPI, GitPullResult, GitPushResult, GitRemote, GitStatus } from '@/lib/api/types';
import type { I18nKey, I18nParams } from '@/lib/i18n';
import { hasUncommittedTrackedChanges } from './changeStatus';

type CommitPushGitAPI = Pick<GitAPI, 'gitFetch' | 'getGitStatus' | 'gitPull' | 'gitPush'>;

type PushCommittedChangesOptions = {
  git: CommitPushGitAPI;
  directory: string;
  remote: GitRemote;
  dirtyWorktreeError: string;
  onPulled?: (result: GitPullResult) => void;
  /** The rebase stopped on conflicts and stays in progress; nothing is pushed. */
  onConflict?: (conflictFiles: string[]) => void;
  onPushed?: (result: GitPushResult) => void;
};

/** Rebase the current branch onto the branch it tracks on `remote`. */
export const pullUpstreamChanges = (
  git: Pick<GitAPI, 'gitPull'>,
  directory: string,
  remote: GitRemote,
  tracking: GitStatus['tracking'],
): Promise<GitPullResult> => {
  const trackingPrefix = `${remote.name}/`;
  const branch = tracking?.startsWith(trackingPrefix) ? tracking.slice(trackingPrefix.length) : undefined;
  return git.gitPull(directory, { remote: remote.name, branch, rebase: true });
};

type PullToast = { key: I18nKey; params?: I18nParams };

/** Toast for a completed pull; conflicts are handled by the caller. */
export const describePulledFiles = (fileCount: number, remoteName: string): PullToast => {
  if (fileCount === 0) return { key: 'gitView.toast.alreadyUpToDate' };
  return {
    key: fileCount === 1 ? 'gitView.toast.pulledFilesSingle' : 'gitView.toast.pulledFilesPlural',
    params: { count: fileCount, name: remoteName },
  };
};

export const pushCommittedChanges = async ({
  git,
  directory,
  remote,
  dirtyWorktreeError,
  onPulled,
  onConflict,
  onPushed,
}: PushCommittedChangesOptions): Promise<GitPushResult | null> => {
  await git.gitFetch(directory, { remote: remote.name });
  const afterFetch = await git.getGitStatus(directory);
  if ((afterFetch.behind ?? 0) > 0) {
    if (hasUncommittedTrackedChanges(afterFetch.files)) {
      throw new Error(dirtyWorktreeError);
    }
    const result = await pullUpstreamChanges(git, directory, remote, afterFetch.tracking);
    if (result.conflict) {
      onConflict?.(result.conflictFiles ?? []);
      return null;
    }
    onPulled?.(result);
  }

  // Fetch/pull follow the upstream; Git owns the independently configured push destination.
  const result = await git.gitPush(directory);
  if (result.pushed.length > 0) onPushed?.(result);
  return result;
};
