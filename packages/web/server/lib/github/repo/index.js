import { getRemoteUrl } from '../../git/index.js';
import { isTrustedGitHubHost } from '../host-trust.js';

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
  const repo = parseGitHubRemoteUrl(remoteUrl);
  // A remote whose host the server never authenticated with (not github.com,
  // no stored gh login) must not resolve to a repo: it would pair the
  // host-pinned enterprise token with an arbitrary remote. Such remotes report
  // `repo: null`, the same shape as a remote that is not GitHub, so every
  // route skips them and no token is ever minted for the host. This is the
  // single choke point every remote resolution (and `resolveRemoteCandidates`
  // per remote) passes through.
  return {
    repo: repo && isTrustedGitHubHost(repo.host) ? repo : null,
    remoteUrl,
  };
}
