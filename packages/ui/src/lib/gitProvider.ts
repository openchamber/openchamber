import { useEffect, useMemo, useState } from 'react';
import { parseGitHost } from '@/lib/gitHost';
import { getRemotes } from '@/lib/gitApi';
import { useGitLabAuthStore } from '@/stores/useGitLabAuthStore';
import { useGiteaAuthStore } from '@/stores/useGiteaAuthStore';
import {
  useGitProviderDomainsStore,
  normalizeProviderDomain,
  type GitProviderApiBaseUrls,
  type GitProviderDomains,
} from '@/stores/useGitProviderDomainsStore';

export type GitProvider = 'github' | 'gitlab' | 'gitea' | 'other';

/**
 * Per-provider hostname sets used for detection: custom user-configured
 * domains (from the domains store), account-derived base-URL hostnames, and the
 * configured api base host. Built-in defaults (github.com, gitlab.com) are
 * applied inside the detection logic and never need to be present here.
 */
export type GitProviderHosts = {
  github: string[];
  gitlab: string[];
  gitea: string[];
};

const normalizeHostList = (hosts: string[] | undefined): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const host of hosts ?? []) {
    const normalized = normalizeProviderDomain(host);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
};

const GITHUB_API_HOST = 'api.github.com';

/**
 * Hostname of a configured api base URL, or null when unset/unparseable.
 * GitHub Enterprise remotes point at the web host, not the api subdomain, so an
 * `api.github.com` api base maps back to `github.com` (the built-in web host).
 */
const apiBaseHost = (apiBaseUrl: string | undefined): string | null => {
  const host = normalizeProviderDomain(apiBaseUrl ?? '');
  if (!host) return null;
  return host === GITHUB_API_HOST ? 'github.com' : host;
};

/**
 * Build the per-provider detection host sets. Each provider gets its configured
 * api base host (auto-added; github's `api.github.com` maps to `github.com`),
 * plus the account-derived base-URL hosts (gitlab/gitea) and the custom domains
 * from the domains store. All entries are normalized and deduped.
 */
export const buildGitProviderHosts = (input: {
  domains: GitProviderDomains;
  apiBaseUrls: GitProviderApiBaseUrls;
  gitlabAccounts?: Array<{ baseUrl?: string }>;
  giteaAccounts?: Array<{ baseUrl?: string }>;
}): GitProviderHosts => {
  const githubApiHost = apiBaseHost(input.apiBaseUrls.github);
  const gitlabApiHost = apiBaseHost(input.apiBaseUrls.gitlab);
  const giteaApiHost = apiBaseHost(input.apiBaseUrls.gitea);

  return {
    github: normalizeHostList([
      ...(githubApiHost ? [githubApiHost] : []),
      ...input.domains.github,
    ]),
    gitlab: normalizeHostList([
      ...(input.gitlabAccounts ?? [])
        .map((account) => account.baseUrl)
        .filter((url): url is string => Boolean(url)),
      ...(gitlabApiHost ? [gitlabApiHost] : []),
      ...input.domains.gitlab,
    ]),
    gitea: normalizeHostList([
      ...(input.giteaAccounts ?? [])
        .map((account) => account.baseUrl)
        .filter((url): url is string => Boolean(url)),
      ...(giteaApiHost ? [giteaApiHost] : []),
      ...input.domains.gitea,
    ]),
  };
};

/**
 * Classify a repository by the hosts of its remotes. Returns null when there
 * are no remotes to inspect. Built-in defaults apply always: `github.com` is
 * GitHub and `gitlab.com` is GitLab (there is no built-in Gitea host). Custom
 * hosts from `hosts.{github,gitlab,gitea}` are then matched in precedence
 * order github -> gitlab -> gitea (first match wins). Anything else resolves
 * to 'other' so GitHub-branded UI is never offered for a non-GitHub repo.
 */
export const detectGitProvider = (fetchUrls: string[], hosts: GitProviderHosts): GitProvider | null => {
  const remoteHosts = new Set<string>();
  for (const url of fetchUrls) {
    const host = parseGitHost(url);
    if (host) {
      remoteHosts.add(host);
    }
  }
  if (remoteHosts.size === 0) {
    return null;
  }

  const githubHosts = new Set(['github.com', ...normalizeHostList(hosts.github)]);
  const gitlabHosts = new Set(['gitlab.com', ...normalizeHostList(hosts.gitlab)]);
  const giteaHosts = new Set(normalizeHostList(hosts.gitea));

  for (const host of remoteHosts) {
    if (githubHosts.has(host)) {
      return 'github';
    }
  }
  for (const host of remoteHosts) {
    if (gitlabHosts.has(host)) {
      return 'gitlab';
    }
  }
  for (const host of remoteHosts) {
    if (giteaHosts.has(host)) {
      return 'gitea';
    }
  }
  return 'other';
};

const RESOLVE_CACHE_TTL_MS = 60_000;
const resolveCache = new Map<string, { at: number; provider: GitProvider | null }>();

export const resolveGitProvider = async (directory: string, hosts: GitProviderHosts): Promise<GitProvider | null> => {
  const cached = resolveCache.get(directory);
  if (cached && Date.now() - cached.at < RESOLVE_CACHE_TTL_MS) {
    return cached.provider;
  }
  let provider: GitProvider | null = null;
  try {
    const remotes = await getRemotes(directory);
    provider = detectGitProvider(remotes.map((remote) => remote.fetchUrl), hosts);
  } catch {
    provider = null;
  }
  resolveCache.set(directory, { at: Date.now(), provider });
  return provider;
};

/**
 * Resolve the git provider (github | gitlab | gitea | other) of a working
 * directory. Self-hosted instances are recognized through the connected
 * accounts' base URLs and the user-configured custom domains, so the
 * classification stays null/'other' (never 'github') when no host is known —
 * GitHub UI must not leak into a non-GitHub repo regardless of auth state.
 */
export const useGitProvider = (directory: string | null | undefined): GitProvider | null => {
  const gitlabAccounts = useGitLabAuthStore((state) => state.status?.accounts);
  const giteaAccounts = useGiteaAuthStore((state) => state.status?.accounts);
  const domains = useGitProviderDomainsStore((state) => state.domains);
  const apiBaseUrls = useGitProviderDomainsStore((state) => state.apiBaseUrls);
  const hosts = useMemo<GitProviderHosts>(
    () => buildGitProviderHosts({ domains, apiBaseUrls, gitlabAccounts, giteaAccounts }),
    [domains, apiBaseUrls, gitlabAccounts, giteaAccounts],
  );
  const [provider, setProvider] = useState<GitProvider | null>(null);

  useEffect(() => {
    if (!directory) {
      setProvider(null);
      return;
    }
    let cancelled = false;
    void resolveGitProvider(directory, hosts).then((resolved) => {
      if (!cancelled) {
        setProvider(resolved);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [directory, hosts]);

  return provider;
};
