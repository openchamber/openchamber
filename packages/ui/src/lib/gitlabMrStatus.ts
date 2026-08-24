import { useState, useEffect } from 'react';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { GitLabMergeRequestSummary } from '@/lib/api/types';

// Branch MR lookups are cheap to re-request but visible to the user on every
// mount of the surfaces that display them (walkthrough header, git view, work
// status). A shared TTL cache keeps those surfaces consistent with each other
// and stops repeated GitLab calls while a branch is in view.
const CACHE_TTL_MS = 90_000;
const mrCache = new Map<string, { at: number; mr: GitLabMergeRequestSummary | null }>();

const cacheKeyFor = (directory: string, branch: string): string => `${directory}\n${branch}`;

const readCachedMr = (directory: string, branch: string): GitLabMergeRequestSummary | null | undefined => {
  const entry = mrCache.get(cacheKeyFor(directory, branch));
  return entry?.mr;
};

/**
 * Resolve the merge request targeting `branch` in `directory`, preferring the
 * opened request and falling back to a merged one so a just-merged branch still
 * surfaces its request instead of nothing.
 *
 * Returns null when the runtime has no GitLab API, the request fails, or no MR
 * matches — callers only use the result to show or hide an additive chip, so a
 * null answer simply means "nothing to show". Results are cached per
 * directory+branch for CACHE_TTL_MS, including the null case.
 */
export const resolveGitLabMrForBranch = async (
  directory: string,
  branch: string,
): Promise<GitLabMergeRequestSummary | null> => {
  const gitlab = getRegisteredRuntimeAPIs()?.gitlab;
  if (!gitlab?.mrsList || !directory || !branch) {
    return null;
  }

  const key = cacheKeyFor(directory, branch);
  const cached = mrCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.mr;
  }

  let mr: GitLabMergeRequestSummary | null = null;
  try {
    const result = await gitlab.mrsList(directory, { sourceBranch: branch });
    const candidates = result.mrs ?? [];
    mr = candidates.find((item) => item.state === 'opened')
      ?? candidates.find((item) => item.state === 'merged')
      ?? null;
  } catch {
    mr = null;
  }

  mrCache.set(key, { at: Date.now(), mr });
  return mr;
};

/**
 * Subscribe to the branch's merge request. Reads the TTL cache synchronously
 * for the initial render so an already-resolved MR never flashes away while a
 * refresh runs; a cache miss shows a loading state instead of a stale result
 * from another branch.
 */
export const useGitLabMrForBranch = (
  directory: string | null | undefined,
  branch: string | null | undefined,
): { mr: GitLabMergeRequestSummary | null; isLoading: boolean } => {
  const [mr, setMr] = useState<GitLabMergeRequestSummary | null>(() =>
    directory && branch ? (readCachedMr(directory, branch) ?? null) : null
  );
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!directory || !branch) {
      setMr(null);
      setIsLoading(false);
      return;
    }

    let mounted = true;
    const cached = readCachedMr(directory, branch);
    const cacheEntry = mrCache.get(cacheKeyFor(directory, branch));
    const fresh = cacheEntry !== undefined && Date.now() - cacheEntry.at < CACHE_TTL_MS;

    if (fresh) {
      setMr(cached ?? null);
      setIsLoading(false);
      return;
    }

    // A stale entry stays on screen while it refreshes; a missing one shows
    // the loading state rather than a result from a previous branch.
    setMr(cached ?? null);
    setIsLoading(true);

    void resolveGitLabMrForBranch(directory, branch).then((resolved) => {
      if (mounted) {
        setMr(resolved);
        setIsLoading(false);
      }
    });

    return () => {
      mounted = false;
    };
  }, [directory, branch]);

  return { mr, isLoading };
};
