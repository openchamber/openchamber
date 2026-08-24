import { getRemoteUrl } from '../../git/index.js';
import { getProviderApiBaseUrl, githubWebOriginFromApiBase } from '../../git-providers/config.js';

const getGitHubWebOrigin = () => githubWebOriginFromApiBase(getProviderApiBaseUrl('github'));

const webHostFromOrigin = (webOrigin) => {
  try {
    return new URL(webOrigin).hostname || 'github.com';
  } catch {
    return 'github.com';
  }
};

export const parseGitHubRemoteUrl = (raw, { host = 'github.com', webOrigin = 'https://github.com' } = {}) => {
  if (typeof raw !== 'string') {
    return null;
  }
  const value = raw.trim();
  if (!value) {
    return null;
  }

  // git@github.com:OWNER/REPO.git
  const scpPrefix = `git@${host}:`;
  if (value.startsWith(scpPrefix)) {
    const rest = value.slice(scpPrefix.length);
    const cleaned = rest.endsWith('.git') ? rest.slice(0, -4) : rest;
    const [owner, repo] = cleaned.split('/');
    if (!owner || !repo) return null;
    return { owner, repo, url: `${webOrigin}/${owner}/${repo}` };
  }

  // ssh://git@github.com/OWNER/REPO.git
  const sshPrefix = `ssh://git@${host}/`;
  if (value.startsWith(sshPrefix)) {
    const rest = value.slice(sshPrefix.length);
    const cleaned = rest.endsWith('.git') ? rest.slice(0, -4) : rest;
    const [owner, repo] = cleaned.split('/');
    if (!owner || !repo) return null;
    return { owner, repo, url: `${webOrigin}/${owner}/${repo}` };
  }

  // https://github.com/OWNER/REPO(.git)
  try {
    const url = new URL(value);
    if (url.hostname !== host) {
      return null;
    }
    const path = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
    const cleaned = path.endsWith('.git') ? path.slice(0, -4) : path;
    const [owner, repo] = cleaned.split('/');
    if (!owner || !repo) return null;
    return { owner, repo, url: `${webOrigin}/${owner}/${repo}` };
  } catch {
    return null;
  }
};

export async function resolveGitHubRepoFromDirectory(directory, remoteName = 'origin') {
  const remoteUrl = await getRemoteUrl(directory, remoteName).catch(() => null);
  if (!remoteUrl) {
    return { repo: null, remoteUrl: null };
  }
  const webOrigin = getGitHubWebOrigin();
  const host = webHostFromOrigin(webOrigin);
  return {
    repo: parseGitHubRemoteUrl(remoteUrl, { host, webOrigin }),
    remoteUrl,
  };
}
