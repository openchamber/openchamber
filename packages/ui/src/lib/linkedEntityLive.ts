import { useCallback, useEffect, useState } from 'react';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { buildForgeProvider } from '@/lib/forge/adapters';
import { parseLinkedIssueRef, type LinkedIssue } from '@/lib/linkedIssues';

/**
 * Live state of a linked issue/PR, fetched through the forge facade.
 *
 * The linked-issues snapshot stores title and identity only — state, draft
 * and the freshest title belong to the forge. This module resolves them on
 * demand for the work-status cards, mirroring the `gitlabMrStatus.ts` pattern:
 * a module-level TTL cache shared across every surface that mounts the same
 * entity, a synchronous cache read for the initial render (so an
 * already-resolved entity never flashes back to the stale snapshot), and
 * `null` for "no authoritative live data" — never a guessed value.
 *
 * Fetches are mount-driven and refresh-driven only; nothing here polls.
 */

export type LinkedEntityLive = {
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  title: string;
  fetchedAt: number;
};

const CACHE_TTL_MS = 60_000;
const liveCache = new Map<string, { at: number; result: LinkedEntityLive | null }>();

const cacheKeyFor = (id: string): string => id;

const readCachedLive = (id: string): LinkedEntityLive | null | undefined =>
  liveCache.get(cacheKeyFor(id))?.result;

/** Drop the cached live state for one linked entity, e.g. after it was rewritten. */
export const linkedEntityLiveInvalidate = (id: string): void => {
  liveCache.delete(cacheKeyFor(id));
};

/**
 * Resolve the live state of one linked entity, or null when it cannot be
 * resolved: an unparseable id, a runtime without the provider's API, a fetch
 * that fails, or an entity the forge no longer knows.
 *
 * The fetch is addressed to `directory` and lets the provider resolve the
 * repository from the session's remotes, exactly like the facade's other
 * directory-addressed calls. Cross-repo entities therefore resolve only when
 * the session's repo is the entity's repo; anything else reports null
 * ("live unavailable") rather than guessing.
 *
 * Pull-request context is heavier than a status card needs — the facade's
 * only PR lookup fetches comments/files/diff too — but it is the single
 * facade path available, the wire call is cached server-side, and the
 * snapshot row survives regardless, so the extra weight is acceptable.
 */
export const resolveLinkedEntityLive = async (
  entry: LinkedIssue,
  directory: string,
): Promise<LinkedEntityLive | null> => {
  const ref = parseLinkedIssueRef(entry);
  if (!ref || !directory) return null;

  const apis = getRegisteredRuntimeAPIs();
  const provider = apis ? buildForgeProvider(entry.provider ?? ref.provider, apis) : null;
  if (!provider) return null;

  const key = cacheKeyFor(entry.id);
  const cached = liveCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.result;
  }

  let result: LinkedEntityLive | null = null;
  try {
    if (entry.kind === 'pull') {
      const context = await provider.getPullRequestContext(directory, ref.number);
      const pr = context.pr;
      if (pr) {
        result = { state: pr.state, draft: pr.draft, title: pr.title, fetchedAt: Date.now() };
      }
    } else {
      const detail = await provider.getIssue(directory, ref.number);
      const issue = detail.issue;
      if (issue) {
        result = { state: issue.state, draft: false, title: issue.title, fetchedAt: Date.now() };
      }
    }
  } catch {
    result = null;
  }

  liveCache.set(key, { at: Date.now(), result });
  return result;
};

/**
 * Subscribe to one linked entity's live state. Reads the TTL cache
 * synchronously for the initial render; a cache miss shows the loading state
 * rather than a result from a previous fetch. `unavailable` means a fetch ran
 * and resolved to nothing — never a not-yet-fetched state.
 *
 * `refresh` invalidates the cache and refetches this one entry.
 */
export const useLinkedEntityLive = (
  entry: LinkedIssue,
  directory: string | null | undefined,
): { live: LinkedEntityLive | null; loading: boolean; unavailable: boolean; refresh: () => void } => {
  const [live, setLive] = useState<LinkedEntityLive | null>(() =>
    directory ? (readCachedLive(entry.id) ?? null) : null,
  );
  const [loading, setLoading] = useState(false);
  // Whether the first fetch for this entity has settled — the difference
  // between "not fetched yet" and "fetched and found nothing". Without it a
  // cache-miss mount would report `unavailable` for one frame before the
  // effect marks the fetch as loading.
  const [settled, setSettled] = useState<boolean>(() =>
    directory ? readCachedLive(entry.id) !== undefined : false,
  );
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!directory) {
      setLive(null);
      setLoading(false);
      setSettled(false);
      return;
    }

    let mounted = true;
    const cached = readCachedLive(entry.id);
    const cacheEntry = liveCache.get(cacheKeyFor(entry.id));
    const fresh = cacheEntry !== undefined && Date.now() - cacheEntry.at < CACHE_TTL_MS;

    if (fresh) {
      setLive(cached ?? null);
      setLoading(false);
      setSettled(true);
      return;
    }

    // A stale entry stays on screen while it refreshes; a missing one shows
    // the loading state rather than a result from a previous entity.
    setLive(cached ?? null);
    setLoading(true);
    setSettled(false);

    void resolveLinkedEntityLive(entry, directory).then((resolved) => {
      if (mounted) {
        setLive(resolved);
        setLoading(false);
        setSettled(true);
      }
    });

    return () => {
      mounted = false;
    };
  }, [entry, directory, tick]);

  const refresh = useCallback(() => {
    linkedEntityLiveInvalidate(entry.id);
    setTick((current) => current + 1);
  }, [entry.id]);

  return { live, loading, unavailable: settled && !loading && live === null, refresh };
};
