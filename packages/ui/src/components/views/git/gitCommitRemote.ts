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

export function selectGitCommitHoverRemote(remotes: GitRemote[]): { name: string; url: string } | null {
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

  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const match = trimmed.match(GITHUB_HTTPS_RE)
    ?? trimmed.match(GITHUB_SSH_RE)
    ?? trimmed.match(GITHUB_SSH_SCHEME_RE);

  if (!match) {
    return null;
  }

  const [, owner, repo] = match;
  if (!owner || !repo) {
    return null;
  }

  return `https://github.com/${owner}/${repo}/commit/${hash}`;
}
