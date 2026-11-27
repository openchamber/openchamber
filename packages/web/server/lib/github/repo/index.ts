import { getRemoteUrl } from '../../git/index.js';
import { sshHostNameOf, sshUserOf } from '../../git/ssh-host-alias.js';
import { isTrustedGitHubHostOrStored } from '../host-trust.js';
import { isGitHubSshUser } from '../api-host.js';

export interface GitHubRepository {
  owner: string;
  repo: string;
  host: string;
  url: string;
}

const parseRemote = (raw: string | number | null | undefined) => {
  const value = String(raw ?? '').trim();
  if (!value) {
    return null;
  }

  let host = null;
  let rest = null;
  let sshUser = null;

  const scp = value.includes('://') ? null : value.match(/^(?:([^@:/\s]+)@)?([^@:/\s]+):(.+)$/);
  if (scp && scp[3] !== undefined) {
    sshUser = scp[1] ?? null;
    host = scp[2];
    rest = scp[3].includes(':') ? null : scp[3];
  } else {
    try {
      const url = new URL(value);
      if (url.protocol === 'ssh:' || url.protocol === 'https:' || url.protocol === 'http:') {
        if (url.protocol === 'ssh:') sshUser = url.username;
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
  return { repository: { owner, repo, host, url: `https://${host}/${owner}/${repo}` }, sshUser };
};

const sshUserFits = (sshUser: string | null, host: string) => sshUser === null || isGitHubSshUser(sshUser, host);

export const parseGitHubRemoteUrl = (raw: string | number | null | undefined): GitHubRepository | null => {
  const parsed = parseRemote(raw);
  return parsed && sshUserFits(parsed.sshUser, parsed.repository.host) ? parsed.repository : null;
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
  const parsed = parseRemote(remoteUrl);
  const repo = parsed ? await repositoryOnTrustedHost(parsed.repository, remoteUrl.trim(), resolveHostName) : null;
  return {
    repo: parsed && repo && sshUserFits(parsed.sshUser, repo.host) ? repo : null,
    remoteUrl,
  };
}
