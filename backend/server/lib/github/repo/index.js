import { getRemoteUrl } from '../../git/index.js';

export const parseGitHubRemoteUrl = (raw) => {
  if (typeof raw !== 'string') {
    return null;
  }
  const value = raw.trim();
  if (!value) {
    return null;
  }

  // git@github.com:OWNER/REPO.git
  if (value.startsWith('git@github.com:')) {
    const rest = value.slice('git@github.com:'.length);
    const cleaned = rest.endsWith('.git') ? rest.slice(0, -4) : rest;
    const [owner, repo] = cleaned.split('/');
    if (!owner || !repo) return null;
    return { owner, repo, url: `https://github.com/${owner}/${repo}` };
  }

  // ssh://git@github.com/OWNER/REPO.git
  if (value.startsWith('ssh://git@github.com/')) {
    const rest = value.slice('ssh://git@github.com/'.length);
    const cleaned = rest.endsWith('.git') ? rest.slice(0, -4) : rest;
    const [owner, repo] = cleaned.split('/');
    if (!owner || !repo) return null;
    return { owner, repo, url: `https://github.com/${owner}/${repo}` };
  }

  // https://github.com/OWNER/REPO(.git)
  try {
    const url = new URL(value);
    if (url.hostname !== 'github.com') {
      return null;
    }
    const path = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
    const cleaned = path.endsWith('.git') ? path.slice(0, -4) : path;
    const [owner, repo] = cleaned.split('/');
    if (!owner || !repo) return null;
    return { owner, repo, url: `https://github.com/${owner}/${repo}` };
  } catch {
    return null;
  }
};

export async function resolveGitHubRepoFromDirectory(directory, remoteName = 'origin') {
  const remoteUrl = await getRemoteUrl(directory, remoteName).catch(() => null);
  if (!remoteUrl) {
    return { repo: null, remoteUrl: null };
  }
  return {
    repo: parseGitHubRemoteUrl(remoteUrl),
    remoteUrl,
  };
}
