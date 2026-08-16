import { getRemoteUrl } from '../git/index.js';
import { getGitLabAuthAccounts, normalizeBaseUrl } from './auth.js';
import { getEffectiveProviderApiBaseUrl, getProjectProviderFromDirectory } from '../git-providers/project-config.js';

// When no explicit host allowlist is provided, accept gitlab.com or any host
// that matches the base URL of a stored GitLab account. Never github.com.
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

  hosts.add('gitlab.com');
  for (const account of getGitLabAuthAccounts()) {
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
 * Parse a GitLab remote URL into `{ namespace, project, host, baseUrl, url }`.
 *
 * Supports:
 * - `git@HOST:NS/PROJ.git` (NS may be multi-segment, e.g. `a/b/c`)
 * - `ssh://git@HOST/NS/PROJ.git`
 * - `https://HOST/NS/PROJ(.git)`
 *
 * `knownHosts` (optional Set of hostnames) restricts which hosts are accepted.
 * When omitted, `gitlab.com` and hosts from stored auth accounts are accepted.
 * github.com is never accepted.
 */
export const parseGitLabRemoteUrl = (raw, knownHosts, options = {}) => {
  if (typeof raw !== 'string') {
    return null;
  }
  const value = raw.trim();
  if (!value) {
    return null;
  }

  let host = '';
  let path = '';

  // git@HOST:NS/PROJ.git
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
  if (host === 'github.com') {
    return null;
  }
  if (!options.allowAnyHost && !acceptedHosts(knownHosts).has(host)) {
    return null;
  }

  path = path.replace(/\/+$/, '');
  if (path.endsWith('.git')) {
    path = path.slice(0, -4);
  }
  const segments = path.split('/').filter(Boolean);
  if (segments.length < 2) {
    return null;
  }
  const project = segments[segments.length - 1];
  const namespace = segments.slice(0, -1).join('/');
  if (!project || !namespace) {
    return null;
  }

  return {
    namespace,
    project,
    host,
    baseUrl: `https://${host}`,
    url: `https://${host}/${namespace}/${project}`,
  };
};

export async function resolveGitLabRepoFromDirectory(directory, remoteName = 'origin') {
  const remoteUrl = await getRemoteUrl(directory, remoteName).catch(() => null);
  if (!remoteUrl) {
    return { repo: null, remoteUrl: null };
  }
  // A per-project API base override makes its host acceptable for directory
  // resolution even when no connected account covers it.
  const overrideBaseUrl = getEffectiveProviderApiBaseUrl('gitlab', directory);
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
  // A forced gitlab provider (per-project override) accepts any remote host.
  const forcedProvider = getProjectProviderFromDirectory(directory);
  return {
    repo: parseGitLabRemoteUrl(remoteUrl, knownHosts, { allowAnyHost: forcedProvider === 'gitlab' }),
    remoteUrl,
  };
}
