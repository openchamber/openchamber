import { useEffect, useMemo, useState } from 'react';
import { getRemotes } from '@/lib/gitApi';
import { useGitLabAuthStore } from '@/stores/useGitLabAuthStore';

export type GitProvider = 'github' | 'gitlab' | 'other';

const parseGitRemoteHost = (value: string): string | null => {
  const url = value.trim();
  if (!url) {
    return null;
  }
  // scp-like form: git@host:owner/repo.git
  const at = url.indexOf('@');
  if (at >= 0) {
    const rest = url.slice(at + 1);
    const colon = rest.indexOf(':');
    if (colon > 0 && !rest.slice(0, colon).includes('/')) {
      return rest.slice(0, colon).toLowerCase();
    }
  }
  try {
    const parsed = new URL(url.includes('://') ? url : `ssh://${url}`);
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
};

const normalizeGitLabHost = (baseUrl: string | undefined): string | null => {
  if (!baseUrl) {
    return null;
  }
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * Classify a repository by the hosts of its remotes. Returns null when there
 * are no remotes to inspect. GitHub wins on `github.com`; a remote is treated
 * as GitLab when it is `gitlab.com` or matches a connected GitLab instance
 * base URL (self-hosted). Anything else resolves to 'other' so GitHub-branded
 * UI is not offered for non-GitHub repositories.
 */
export const detectGitProvider = (fetchUrls: string[], gitlabHosts: string[]): GitProvider | null => {
  const hosts = new Set<string>();
  for (const url of fetchUrls) {
    const host = parseGitRemoteHost(url);
    if (host) {
      hosts.add(host);
    }
  }
  if (hosts.size === 0) {
    return null;
  }
  if (hosts.has('github.com')) {
    return 'github';
  }
  const gitlabHostsSet = new Set([
    'gitlab.com',
    ...gitlabHosts.map(normalizeGitLabHost).filter((host): host is string => Boolean(host)),
  ]);
  for (const host of hosts) {
    if (gitlabHostsSet.has(host)) {
      return 'gitlab';
    }
  }
  return 'other';
};

const RESOLVE_CACHE_TTL_MS = 60_000;
const resolveCache = new Map<string, { at: number; provider: GitProvider | null }>();

export const resolveGitProvider = async (directory: string, gitlabHosts: string[]): Promise<GitProvider | null> => {
  const cached = resolveCache.get(directory);
  if (cached && Date.now() - cached.at < RESOLVE_CACHE_TTL_MS) {
    return cached.provider;
  }
  let provider: GitProvider | null = null;
  try {
    const remotes = await getRemotes(directory);
    provider = detectGitProvider(remotes.map((remote) => remote.fetchUrl), gitlabHosts);
  } catch {
    provider = null;
  }
  resolveCache.set(directory, { at: Date.now(), provider });
  return provider;
};

/**
 * Resolve the git provider (github | gitlab | other) of a working directory.
 * Self-hosted GitLab instances are recognized through the connected GitLab
 * accounts' base URLs, so the classification stays null/'other' (never
 * 'github') when no account is known yet — GitHub UI must not leak into a
 * GitLab repo regardless of auth state.
 */
export const useGitProvider = (directory: string | null | undefined): GitProvider | null => {
  const gitlabAccounts = useGitLabAuthStore((state) => state.status?.accounts);
  const gitlabHosts = useMemo(
    () => (gitlabAccounts ?? []).map((account) => account.baseUrl),
    [gitlabAccounts],
  );
  const [provider, setProvider] = useState<GitProvider | null>(null);

  useEffect(() => {
    if (!directory) {
      setProvider(null);
      return;
    }
    let cancelled = false;
    void resolveGitProvider(directory, gitlabHosts).then((resolved) => {
      if (!cancelled) {
        setProvider(resolved);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [directory, gitlabHosts]);

  return provider;
};
