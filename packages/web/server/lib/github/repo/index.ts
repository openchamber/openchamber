import { getRemoteUrl } from '../../git/index.js';
import { sshHostNameOf, sshUserOf } from '../../git/ssh-host-alias.js';
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

  const scp = value.includes('://') ? null : value.match(/^(?:git@)?([^@:/\s]+):(.+)$/);
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

const repositoryOnTrustedHost = async (repo: GitHubRepository, remoteUrl: string, resolveHostName: typeof sshHostNameOf) => {
  if (await isTrustedGitHubHostOrStored(repo.host)) return repo;
  if (remoteUrl.includes('://')) return null;
  const host = await resolveHostName(repo.host, sshUserOf(remoteUrl));
  if (!host || host === repo.host.toLowerCase() || !(await isTrustedGitHubHostOrStored(host))) return null;
  return { ...repo, host, url: `https://${host}/${repo.owner}/${repo.repo}` };
};

export async function resolveGitHubRepoFromDirectory(directory: string, remoteName = 'origin', resolveHostName = sshHostNameOf) {
  const remoteUrl = await getRemoteUrl(directory, remoteName).catch(() => null);
  if (!remoteUrl) {
    return { repo: null, remoteUrl: null };
  }
  const repo = parseGitHubRemoteUrl(remoteUrl);
  return {
    repo: repo ? await repositoryOnTrustedHost(repo, remoteUrl.trim(), resolveHostName) : null,
    remoteUrl,
  };
}
