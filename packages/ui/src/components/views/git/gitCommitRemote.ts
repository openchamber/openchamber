import type { GitRemote } from '@/lib/api/types';

const GITHUB_HTTPS_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;
const GITHUB_SSH_RE = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i;
const GITHUB_SSH_SCHEME_RE = /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;
const HEX_HASH_RE = /^[0-9a-f]{7,40}$/i;

const getRemoteUrl = (remote: GitRemote): string | null => {
  const fetchUrl = remote.fetchUrl.trim();
  if (fetchUrl.length > 0) {
    return fetchUrl;
  }

  const pushUrl = remote.pushUrl.trim();
  return pushUrl.length > 0 ? pushUrl : null;
};

const matchGitHubUrl = (url: string | null | undefined): RegExpMatchArray | null => {
  if (!url) return null;
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  return trimmed.match(GITHUB_HTTPS_RE)
    ?? trimmed.match(GITHUB_SSH_RE)
    ?? trimmed.match(GITHUB_SSH_SCHEME_RE);
};

export function selectGitCommitHoverRemote(remotes: GitRemote[]): { name: string; url: string } | null {
  // First pass: look for origin remote
  let originRemote: GitRemote | undefined;
  let topGitHubRemote: GitRemote | undefined;

  for (const remote of remotes) {
    const url = getRemoteUrl(remote);
    if (!url) continue;

    if (remote.name === 'origin') {
      originRemote = remote;
      if (matchGitHubUrl(url)) {
        // Origin is GitHub, it's the winner
        return { name: remote.name, url };
      }
    } else if (!topGitHubRemote && matchGitHubUrl(url)) {
      // Track first non-origin GitHub remote as backup
      topGitHubRemote = remote;
    }
  }

  // If origin exists but isn't GitHub, prefer a GitHub remote over it
  if (originRemote && topGitHubRemote) {
    const topGitHubUrl = getRemoteUrl(topGitHubRemote);
    if (topGitHubUrl) {
      return { name: topGitHubRemote.name, url: topGitHubUrl };
    }
  }

  // Fall back to origin if it has a URL, or top GitHub, or first remote with URL
  const ranked = [...remotes].sort((left, right) => {
    if (left.name === 'origin' && right.name !== 'origin') {
      return -1;
    }
    if (right.name === 'origin' && left.name !== 'origin') {
      return 1;
    }
    return 0;
  });

  for (const remote of ranked) {
    const url = getRemoteUrl(remote);
    if (url) {
      return { name: remote.name, url };
    }
  }

  return null;
}

export function buildGitHubCommitUrl(remoteUrl: string | null | undefined, hash: string): string | null {
  if (!remoteUrl || !HEX_HASH_RE.test(hash)) {
    return null;
  }

  const match = matchGitHubUrl(remoteUrl);

  if (!match) {
    return null;
  }

  const [, owner, repo] = match;
  if (!owner || !repo) {
    return null;
  }

  return `https://github.com/${owner}/${repo}/commit/${hash}`;
}
