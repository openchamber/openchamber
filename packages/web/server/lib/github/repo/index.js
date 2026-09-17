import { getRemoteUrl } from '../../git/index.js';

export const parseGitHubRemoteUrl = (raw) => {
  // Coerce at the I/O boundary: git always passes a string remote, but callers
  // may hand us null/undefined. Non-strings coerce to a form the remote
  // patterns below cannot match, so they fall through to null.
  const value = String(raw ?? '').trim();
  if (!value) {
    return null;
  }

  let host = null;
  let rest = null;

  // scp-style remote: git@HOST:OWNER/REPO(.git)
  const scp = value.match(/^git@([^:/\s]+):(.+)$/);
  if (scp) {
    host = scp[1];
    rest = scp[2].includes(':') ? null : scp[2];
  } else {
    // URI-style remote: ssh://git@HOST/... or http(s)://HOST/...
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
