import { getRemoteUrl } from '../../git/index.js';
import { isTrustedGitHubHostOrStored } from '../host-trust.js';

export interface GitHubRepository {
  owner: string;
  repo: string;
  host: string;
  url: string;
}

export const parseGitHubRemoteUrl = (raw: string | number | null | undefined): GitHubRepository | null => {
  const value = String(raw ?? '').trim();
  if (!value) {
    return null;
  }

  let host = null;
  let rest = null;

  const scp = value.match(/^git@([^:/\s]+):(.+)$/);
  if (scp && scp[2] !== undefined) {
    host = scp[1];
    rest = scp[2].includes(':') ? null : scp[2];
  } else {
    try {
      const url = new URL(value);
      const sshGit = url.protocol === 'ssh:' && url.username === 'git';
      if (sshGit || url.protocol === 'https:' || url.protocol === 'http:') {
        host = url.hostname;
        rest = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
      }
    } catch {
      return null;
    }
  }

  if (!host || !rest) return null;
  const [owner, repo] = rest.replace(/\.git$/, '').split('/');
  if (!owner || !repo) return null;
  return { owner, repo, host, url: `https://${host}/${owner}/${repo}` };
};

export async function resolveGitHubRepoFromDirectory(directory: string, remoteName = 'origin') {
  const remoteUrl = await getRemoteUrl(directory, remoteName).catch(() => null);
  if (!remoteUrl) {
    return { repo: null, remoteUrl: null };
  }
  const repo = parseGitHubRemoteUrl(remoteUrl);
  return {
    repo: repo && (await isTrustedGitHubHostOrStored(repo.host)) ? repo : null,
    remoteUrl,
  };
}
