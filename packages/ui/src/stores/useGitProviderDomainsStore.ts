import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { parseGitHost } from '@/lib/gitHost';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';

export type GitProviderName = 'github' | 'gitlab' | 'gitea';

/**
 * Per-provider custom hostnames used to generalize git provider detection.
 * Every entry is a normalized hostname: lowercase, no scheme, port, or path.
 */
export type GitProviderDomains = {
  github: string[];
  gitlab: string[];
  gitea: string[];
};

/**
 * Per-provider configured API base URLs, as entered in server settings
 * (`gitProviders.<provider>.apiBaseUrl`). Normalized: empty string when unset,
 * otherwise trimmed with any trailing slashes stripped but scheme and path kept
 * (e.g. `https://github.example.com/api/v3`).
 */
export type GitProviderApiBaseUrls = {
  github: string;
  gitlab: string;
  gitea: string;
};

const DOMAINS_STORAGE_KEY = 'openchamber.git-provider-domains';

const EMPTY_DOMAINS: GitProviderDomains = { github: [], gitlab: [], gitea: [] };
const EMPTY_API_BASE_URLS: GitProviderApiBaseUrls = { github: '', gitlab: '', gitea: '' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const GIT_PROVIDERS = ['github', 'gitlab', 'gitea'] as const;

/**
 * Normalize a raw user-supplied domain into a bare hostname. Accepts plain
 * hostnames, URLs (scheme/port/path stripped), and scp-like git remotes with
 * or without a user prefix (`git@host:owner/repo.git`, `host:owner/repo.git`).
 * Returns null for empty or unparseable input.
 */
export const normalizeProviderDomain = (raw: string): string | null => parseGitHost(raw);

/**
 * Normalize arbitrary input into a list of bare, deduped hostnames. Non-array
 * input yields `[]`; each entry runs through `normalizeProviderDomain`.
 */
export const normalizeDomainList = (entries: unknown): string[] => {
  if (!Array.isArray(entries)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    const host = normalizeProviderDomain(typeof entry === 'string' ? entry : '');
    if (host && !seen.has(host)) {
      seen.add(host);
      result.push(host);
    }
  }
  return result;
};

/**
 * Normalize a configured API base URL: empty (or non-string) input collapses to
 * `''`; otherwise trim and strip trailing slashes while keeping scheme + path.
 */
export const normalizeApiBaseUrl = (raw: unknown): string => {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) {
    return '';
  }
  return value.replace(/\/+$/, '');
};

/**
 * Normalize a server `gitProviders` config into per-provider `{ apiBaseUrl,
 * detectUrls }` pairs. Unknown or malformed entries are dropped; provider keys
 * outside the known set are ignored.
 */
const normalizeGitProvidersConfig = (config: unknown): {
  apiBaseUrls: GitProviderApiBaseUrls;
  domains: GitProviderDomains;
} => {
  const apiBaseUrls: GitProviderApiBaseUrls = { ...EMPTY_API_BASE_URLS };
  const domains: GitProviderDomains = { github: [], gitlab: [], gitea: [] };
  if (!isRecord(config)) {
    return { apiBaseUrls, domains };
  }
  for (const provider of GIT_PROVIDERS) {
    const entry = config[provider];
    if (!isRecord(entry)) continue;
    apiBaseUrls[provider] = normalizeApiBaseUrl(entry.apiBaseUrl);
    domains[provider] = normalizeDomainList(entry.detectUrls);
  }
  return { apiBaseUrls, domains };
};

type GitProviderDomainsStore = {
  domains: GitProviderDomains;
  apiBaseUrls: GitProviderApiBaseUrls;
  /**
   * Per-project api base url overrides, keyed by project id. Server-authoritative
   * and intentionally NOT persisted (the server owns the config file); hydrated
   * on demand and cleared when the override is removed server-side.
   */
  projectApiBaseUrls: Record<string, GitProviderApiBaseUrls>;
  setDomains: (provider: GitProviderName, domains: string[]) => void;
  setApiBaseUrl: (provider: GitProviderName, url: string) => void;
  /** Apply the server's `gitProviders` settings, keeping the server authoritative. */
  hydrateFromServer: (gitProvidersConfig?: unknown) => void;
  /** Store one project's server-authoritative git provider override; drops the key when empty. */
  hydrateProjectFromServer: (projectId: string, config?: unknown) => void;
  /** Remove a project's override entry. */
  clearProjectGitProviders: (projectId: string) => void;
};

export const useGitProviderDomainsStore = create<GitProviderDomainsStore>()(
  persist(
    (set, get) => ({
      domains: EMPTY_DOMAINS,
      apiBaseUrls: EMPTY_API_BASE_URLS,
      projectApiBaseUrls: {},
      setDomains: (provider, domains) => {
        set({
          domains: {
            ...get().domains,
            [provider]: normalizeDomainList(domains),
          },
        } as Partial<GitProviderDomainsStore>);
      },
      setApiBaseUrl: (provider, url) => {
        set({
          apiBaseUrls: {
            ...get().apiBaseUrls,
            [provider]: normalizeApiBaseUrl(url),
          },
        } as Partial<GitProviderDomainsStore>);
      },
      hydrateFromServer: (gitProvidersConfig) => {
        const { apiBaseUrls, domains } = normalizeGitProvidersConfig(gitProvidersConfig);
        const currentDomains = get().domains;
        // One-time migration: when the server has no detect urls for a provider,
        // keep whatever was previously persisted locally (the localStorage cache,
        // hydrated into `domains`) so existing users' custom domains are not lost
        // on upgrade. Whenever the server carries detect urls it wins outright,
        // and the persist middleware keeps mirroring state back to localStorage
        // as a cache — the server stays authoritative on later hydrates.
        for (const provider of GIT_PROVIDERS) {
          if (domains[provider].length === 0 && currentDomains[provider].length > 0) {
            domains[provider] = currentDomains[provider];
          }
        }
        set({ domains, apiBaseUrls } as Partial<GitProviderDomainsStore>);
      },
      hydrateProjectFromServer: (projectId, config) => {
        if (!projectId) return;
        const { apiBaseUrls } = normalizeGitProvidersConfig(config);
        const hasAny = Boolean(apiBaseUrls.github || apiBaseUrls.gitlab || apiBaseUrls.gitea);
        const current = get().projectApiBaseUrls[projectId];
        const unchanged = hasAny
          ? current !== undefined
            && current.github === apiBaseUrls.github
            && current.gitlab === apiBaseUrls.gitlab
            && current.gitea === apiBaseUrls.gitea
          : current === undefined;
        if (unchanged) return;
        set((state) => {
          const next = { ...state.projectApiBaseUrls };
          if (hasAny) {
            next[projectId] = apiBaseUrls;
          } else {
            delete next[projectId];
          }
          return { projectApiBaseUrls: next };
        });
      },
      clearProjectGitProviders: (projectId) => {
        if (!projectId || get().projectApiBaseUrls[projectId] === undefined) return;
        set((state) => {
          const next = { ...state.projectApiBaseUrls };
          delete next[projectId];
          return { projectApiBaseUrls: next };
        });
      },
    }),
    {
      name: DOMAINS_STORAGE_KEY,
      storage: createDeferredSafeJSONStorage(),
      partialize: (state) => ({ domains: state.domains, apiBaseUrls: state.apiBaseUrls }),
      merge: (persistedState, currentState) => {
        const persisted = (persistedState as {
          domains?: Partial<GitProviderDomains>;
          apiBaseUrls?: Partial<GitProviderApiBaseUrls>;
        } | null);
        return {
          ...currentState,
          // Missing or malformed entries collapse to the canonical shape so the
          // full three-provider shape is always produced after hydration.
          domains: {
            github: normalizeDomainList(persisted?.domains?.github),
            gitlab: normalizeDomainList(persisted?.domains?.gitlab),
            gitea: normalizeDomainList(persisted?.domains?.gitea),
          },
          apiBaseUrls: {
            github: normalizeApiBaseUrl(persisted?.apiBaseUrls?.github),
            gitlab: normalizeApiBaseUrl(persisted?.apiBaseUrls?.gitlab),
            gitea: normalizeApiBaseUrl(persisted?.apiBaseUrls?.gitea),
          },
        };
      },
    },
  ),
);
