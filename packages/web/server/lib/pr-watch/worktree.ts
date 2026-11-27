import { getCheckedOutBranch, getRepositoryRemoteUrls, resolveRepositoryGitPaths } from '../git/service.js';

interface PullRequestCheckout {
  directory: string;
  head: string;
  owner: string;
  repo: string;
}

const SCP_REMOTE = /^(?:[^@/\s]+@)?[^:/\s]+:(.+)$/;

const repositoryPathOfRemote = (remoteUrl: string) => {
  const scp = remoteUrl.includes('://') ? null : SCP_REMOTE.exec(remoteUrl);
  const remotePath = scp?.[1] ?? (URL.canParse(remoteUrl) ? new URL(remoteUrl).pathname : '');
  return remotePath.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').toLowerCase();
};

export async function isPullRequestWorktree({ directory, head, owner, repo }: PullRequestCheckout) {
  if (await getCheckedOutBranch(directory) !== head) return false;
  const gitPaths = await resolveRepositoryGitPaths(directory);
  if (!gitPaths.supported || gitPaths.gitDirectory === gitPaths.commonDirectory) return false;
  const repository = `${owner}/${repo}`.toLowerCase();
  const remotes = await getRepositoryRemoteUrls(directory);
  return remotes.some((remote) => repositoryPathOfRemote(remote.fetchUrl) === repository || repositoryPathOfRemote(remote.pushUrl) === repository);
}
