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

const DOMAINS_STORAGE_KEY = 'openchamber.git-provider-domains';

const EMPTY_DOMAINS: GitProviderDomains = { github: [], gitlab: [], gitea: [] };

/**
 * Normalize a raw user-supplied domain into a bare hostname. Accepts plain
 * hostnames, URLs (scheme/port/path stripped), and scp-like git remotes with
 * or without a user prefix (`git@host:owner/repo.git`, `host:owner/repo.git`).
 * Returns null for empty or unparseable input.
 */
export const normalizeProviderDomain = (raw: string): string | null => parseGitHost(raw);

const normalizeDomainList = (entries: unknown): string[] => {
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

type GitProviderDomainsStore = {
  domains: GitProviderDomains;
  setDomains: (provider: GitProviderName, domains: string[]) => void;
};

export const useGitProviderDomainsStore = create<GitProviderDomainsStore>()(
  persist(
    (set, get) => ({
      domains: EMPTY_DOMAINS,
      setDomains: (provider, domains) => {
        set({
          domains: {
            ...get().domains,
            [provider]: normalizeDomainList(domains),
          },
        } as Partial<GitProviderDomainsStore>);
      },
    }),
    {
      name: DOMAINS_STORAGE_KEY,
      storage: createDeferredSafeJSONStorage(),
      partialize: (state) => ({ domains: state.domains }),
      merge: (persistedState, currentState) => {
        const persisted = (persistedState as { domains?: Partial<GitProviderDomains> } | null)?.domains;
        return {
          ...currentState,
          // Missing or malformed entries collapse to empty arrays so the full
          // three-provider shape is always produced after hydration.
          domains: {
            github: normalizeDomainList(persisted?.github),
            gitlab: normalizeDomainList(persisted?.gitlab),
            gitea: normalizeDomainList(persisted?.gitea),
          },
        };
      },
    },
  ),
);
