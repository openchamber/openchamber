import { useState, useEffect } from 'react';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { GiteaPullRequestSummary } from '@/lib/api/types';

// Branch PR lookups are cheap to re-request but visible to the user on every
// mount of the surfaces that display them (walkthrough header, git view, work
// status). A shared TTL cache keeps those surfaces consistent with each other
// and stops repeated Gitea calls while a branch is in view.
const CACHE_TTL_MS = 90_000;
const prCache = new Map<string, { at: number; pr: GiteaPullRequestSummary | null }>();

const cacheKeyFor = (directory: string, branch: string): string => `${directory}\n${branch}`;

const readCachedPr = (directory: string, branch: string): GiteaPullRequestSummary | null | undefined => {
  const entry = prCache.get(cacheKeyFor(directory, branch));
  return entry?.pr;
};

/**
 * Resolve the pull request targeting `branch` in `directory`, preferring the
 * open request and falling back to a merged one so a just-merged branch still
 * surfaces its request instead of nothing.
 *
 * Returns null when the runtime has no Gitea API, the request fails, or no PR
 * matches — callers only use the result to show or hide an additive chip, so a
 * null answer simply means "nothing to show". Results are cached per
 * directory+branch for CACHE_TTL_MS, including the null case.
 */
export const resolveGiteaPrForBranch = async (
  directory: string,
  branch: string,
): Promise<GiteaPullRequestSummary | null> => {
  const gitea = getRegisteredRuntimeAPIs()?.gitea;
  if (!gitea?.prsList || !directory || !branch) {
    return null;
  }

  const key = cacheKeyFor(directory, branch);
  const cached = prCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.pr;
  }

  let pr: GiteaPullRequestSummary | null = null;
  try {
    const result = await gitea.prsList(directory, { sourceBranch: branch });
    const candidates = result.prs ?? [];
    pr = candidates.find((item) => item.state === 'open')
      ?? candidates.find((item) => item.state === 'merged')
      ?? null;
  } catch {
    pr = null;
  }

  prCache.set(key, { at: Date.now(), pr });
  return pr;
};

/**
 * Subscribe to the branch's pull request. Reads the TTL cache synchronously
 * for the initial render so an already-resolved PR never flashes away while a
 * refresh runs; a cache miss shows a loading state instead of a stale result
 * from another branch.
 */
export const useGiteaPrForBranch = (
  directory: string | null | undefined,
  branch: string | null | undefined,
): { pr: GiteaPullRequestSummary | null; isLoading: boolean } => {
  const [pr, setPr] = useState<GiteaPullRequestSummary | null>(() =>
    directory && branch ? (readCachedPr(directory, branch) ?? null) : null
  );
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!directory || !branch) {
      setPr(null);
      setIsLoading(false);
      return;
    }

    let mounted = true;
    const cached = readCachedPr(directory, branch);
    const cacheEntry = prCache.get(cacheKeyFor(directory, branch));
    const fresh = cacheEntry !== undefined && Date.now() - cacheEntry.at < CACHE_TTL_MS;

    if (fresh) {
      setPr(cached ?? null);
      setIsLoading(false);
      return;
    }

    // A stale entry stays on screen while it refreshes; a missing one shows
    // the loading state rather than a result from a previous branch.
    setPr(cached ?? null);
    setIsLoading(true);

    void resolveGiteaPrForBranch(directory, branch).then((resolved) => {
      if (mounted) {
        setPr(resolved);
        setIsLoading(false);
      }
    });

    return () => {
      mounted = false;
    };
  }, [directory, branch]);

  return { pr, isLoading };
};
