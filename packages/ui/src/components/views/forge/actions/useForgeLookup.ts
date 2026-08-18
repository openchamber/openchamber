import { useEffect, useState } from 'react';
import type { ForgeProvider } from '@/lib/forge/provider';
import type { ForgeLabel, ForgeMilestone, ForgeUser } from '@/lib/forge/types';

/** Which picker a lookup feeds; each maps onto one `provider.search*` method. */
export type ForgeLookupKind = 'users' | 'labels' | 'milestones' | 'branches' | 'tags';

/**
 * A normalized, display-ready row for the shared forge lookup dropdown.
 * The owning surface maps provider result shapes onto this.
 */
export interface ForgeLookupOption {
  /** Stable key (login / label name / milestone title / branch / tag). */
  key: string;
  /** Primary display text. */
  label: string;
  /** Secondary line (e.g. a user's real name). */
  secondary?: string;
  avatarUrl?: string;
  /** Label color dot (hex as returned by the provider). */
  color?: string;
}

/** Resolve the dropdown option shape for a given provider/kind result. */
const toLookupOptions = (
  kind: ForgeLookupKind,
  users: ForgeUser[],
  labels: ForgeLabel[],
  milestones: ForgeMilestone[],
  branches: string[],
  tags: string[],
): ForgeLookupOption[] => {
  switch (kind) {
    case 'users':
      return users.map((user) => ({
        key: user.login,
        label: user.login,
        ...(user.name ? { secondary: user.name } : {}),
        ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
      }));
    case 'labels':
      return labels.map((label) => ({
        key: label.name,
        label: label.name,
        ...(label.color ? { color: label.color } : {}),
      }));
    case 'milestones':
      return milestones.map((milestone) => ({ key: milestone.title, label: milestone.title }));
    case 'branches':
      return branches.map((branch) => ({ key: branch, label: branch }));
    case 'tags':
      return tags.map((tag) => ({ key: tag, label: tag }));
  }
};

// --- Short-TTL lookup cache ---
//
// The lookup is debounced but still fires once per settled (kind, directory,
// repo, query), so a picker interaction that re-asks for the same repo/query
// (reopening the dropdown, switching fields back and forth) would re-hit the
// provider. A short module-local TTL serves a fresh-enough result synchronously,
// skipping both the network call and the debounce timer.
//
// Only `connected: true` results are cached: a failed or disconnected lookup must
// never masquerade as an authoritative empty list (correctness invariant), so it
// is never stored and is always re-fetched.

const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 200;

interface ForgeLookupCacheEntry {
  options: ForgeLookupOption[];
  expiresAt: number;
}

const lookupCache = new Map<string, ForgeLookupCacheEntry>();

const cacheKey = (
  kind: ForgeLookupKind,
  directory: string,
  sourceRepo: string | null | undefined,
  query: string,
): string => `${kind}|${directory}|${sourceRepo ?? ''}|${query}`;

/** Drop expired entries and bound the map size on each write. */
const pruneCache = (now: number): void => {
  for (const [key, entry] of lookupCache) {
    if (entry.expiresAt <= now) lookupCache.delete(key);
  }
  // Map iteration is insertion-ordered, so dropping oldest first keeps the
  // most recently written entries when the map overflows.
  let excess = lookupCache.size - CACHE_MAX_ENTRIES;
  if (excess > 0) {
    for (const key of lookupCache.keys()) {
      if (excess <= 0) break;
      lookupCache.delete(key);
      excess -= 1;
    }
  }
};

/**
 * Debounced repo-scoped lookup for forge pickers. Fetches through the facade
 * `search*` method for `kind` 250ms after the query settles, keeps the dropdown
 * from firing on every keystroke, and never surfaces stale results (an
 * out-of-order response is dropped). `connected: false` results are treated as
 * "no authoritative options", never as a valid empty list.
 *
 * Successful results are cached per (kind, directory, repo, query) for
 * `CACHE_TTL_MS`; a hit serves synchronously without a network call or debounce.
 */
export const useForgeLookup = ({
  provider,
  directory,
  sourceRepo,
  kind,
  query,
}: {
  provider: ForgeProvider;
  directory: string;
  sourceRepo?: string | null;
  kind: ForgeLookupKind;
  query: string;
}): { options: ForgeLookupOption[]; loading: boolean; initialized: boolean } => {
  const [options, setOptions] = useState<ForgeLookupOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    const key = cacheKey(kind, directory, sourceRepo, query);
    const now = Date.now();
    const cached = lookupCache.get(key);
    if (cached && cached.expiresAt > now) {
      // Fresh enough: serve without the network call or the debounce timer.
      setOptions(cached.options);
      setLoading(false);
      setInitialized(true);
      return;
    }
    if (cached) lookupCache.delete(key);

    let cancelled = false;

    const timer = window.setTimeout(() => {
      setLoading(true);
      void (async () => {
        try {
          if (cancelled) return;
          let next: ForgeLookupOption[] = [];
          let connected = false;
          if (kind === 'users') {
            const run = provider.searchUsers?.(directory, query, { sourceRepo });
            if (run) {
              const result = await run;
              connected = result.connected;
              if (connected) next = toLookupOptions('users', result.users ?? [], [], [], [], []);
            }
          } else if (kind === 'labels') {
            const run = provider.searchLabels?.(directory, query, { sourceRepo });
            if (run) {
              const result = await run;
              connected = result.connected;
              if (connected) next = toLookupOptions('labels', [], result.labels ?? [], [], [], []);
            }
          } else if (kind === 'milestones') {
            const run = provider.searchMilestones?.(directory, query, { sourceRepo });
            if (run) {
              const result = await run;
              connected = result.connected;
              if (connected) next = toLookupOptions('milestones', [], [], result.milestones ?? [], [], []);
            }
          } else if (kind === 'branches') {
            const run = provider.searchBranches?.(directory, query, { sourceRepo });
            if (run) {
              const result = await run;
              connected = result.connected;
              if (connected) next = toLookupOptions('branches', [], [], [], result.branches ?? [], []);
            }
          } else if (kind === 'tags') {
            const run = provider.searchTags?.(directory, query, { sourceRepo });
            if (run) {
              const result = await run;
              connected = result.connected;
              if (connected) next = toLookupOptions('tags', [], [], [], [], result.tags ?? []);
            }
          }
          if (cancelled) return;
          setOptions(next);
          if (connected) {
            lookupCache.set(key, { options: next, expiresAt: Date.now() + CACHE_TTL_MS });
            pruneCache(Date.now());
          }
        } catch {
          if (!cancelled) setOptions([]);
        } finally {
          if (!cancelled) {
            setLoading(false);
            setInitialized(true);
          }
        }
      })();
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [directory, kind, provider, query, sourceRepo]);

  return { options, loading, initialized };
};
