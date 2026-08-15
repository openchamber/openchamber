import { getRemoteUrl } from '../git/index.js';
import { getGiteaAuthAccounts, normalizeBaseUrl } from './auth.js';
import { getEffectiveProviderApiBaseUrl } from '../git-providers/project-config.js';

// When no explicit host allowlist is provided, accept any host that matches the
// base URL of a stored Gitea account. Gitea/Forgejo is self-hosted, so there is
// no default host. Never github.com or gitlab.com — those belong to other
// providers and must not be classified as Gitea.
function acceptedHosts(knownHosts) {
  const hosts = new Set();
  if (knownHosts instanceof Set) {
    for (const host of knownHosts) {
      if (typeof host === 'string' && host.trim()) {
        hosts.add(host.trim().toLowerCase());
      }
    }
    return hosts;
  }
  if (Array.isArray(knownHosts)) {
    for (const host of knownHosts) {
      if (typeof host === 'string' && host.trim()) {
        hosts.add(host.trim().toLowerCase());
      }
    }
    return hosts;
  }

  for (const account of getGiteaAuthAccounts()) {
    try {
      const host = new URL(normalizeBaseUrl(account.baseUrl) || account.baseUrl).hostname.toLowerCase();
      if (host) {
        hosts.add(host);
      }
    } catch {
      // ignore malformed stored account base URLs
    }
  }
  return hosts;
}

/**
 * Parse a Gitea/Forgejo remote URL into `{ owner, repo, host, baseUrl, url }`.
 *
 * Gitea repos are flat `owner/repo` (no multi-segment namespaces). Supports:
 * - `git@HOST:owner/repo.git`
 * - `ssh://git@HOST/owner/repo.git`
 * - `https://HOST/owner/repo(.git)`
 *
 * `knownHosts` (optional Set of hostnames) restricts which hosts are accepted.
 * When omitted, hosts from stored auth accounts are accepted. `github.com` and
 * `gitlab.com` are never accepted.
 */
export const parseGiteaRemoteUrl = (raw, knownHosts) => {
  if (typeof raw !== 'string') {
    return null;
  }
  const value = raw.trim();
  if (!value) {
    return null;
  }

  let host = '';
  let path = '';

  // git@HOST:owner/repo.git
  const scpLike = value.match(/^git@([^:]+):(.+)$/);
  if (scpLike) {
    host = scpLike[1].toLowerCase();
    path = scpLike[2];
  } else if (value.startsWith('ssh://') || /^https?:\/\//.test(value)) {
    try {
      const url = new URL(value);
      host = url.hostname.toLowerCase();
      path = url.pathname.replace(/^\/+/, '');
    } catch {
      return null;
    }
  } else {
    return null;
  }

  if (!host) {
    return null;
  }
  if (host === 'github.com' || host === 'gitlab.com') {
    return null;
  }
  if (!acceptedHosts(knownHosts).has(host)) {
    return null;
  }

  path = path.replace(/\/+$/, '');
  if (path.endsWith('.git')) {
    path = path.slice(0, -4);
  }
  const segments = path.split('/').filter(Boolean);
  // Gitea repos are flat owner/repo — exactly two segments.
  if (segments.length !== 2) {
    return null;
  }
  const owner = segments[0];
  const repo = segments[1];
  if (!owner || !repo) {
    return null;
  }

  return {
    owner,
    repo,
    host,
    baseUrl: `https://${host}`,
    url: `https://${host}/${owner}/${repo}`,
  };
};

export async function resolveGiteaRepoFromDirectory(directory, remoteName = 'origin') {
  const remoteUrl = await getRemoteUrl(directory, remoteName).catch(() => null);
  if (!remoteUrl) {
    return { repo: null, remoteUrl: null };
  }
  // A per-project API base override makes its host acceptable for directory
  // resolution even when no connected account covers it.
  const overrideBaseUrl = getEffectiveProviderApiBaseUrl('gitea', directory);
  let knownHosts;
  if (overrideBaseUrl) {
    knownHosts = acceptedHosts();
    try {
      const host = new URL(overrideBaseUrl).hostname.toLowerCase();
      if (host) {
        knownHosts.add(host);
      }
    } catch {
      // ignore a malformed override base URL
    }
  }
  return {
    repo: parseGiteaRemoteUrl(remoteUrl, knownHosts),
    remoteUrl,
  };
}
