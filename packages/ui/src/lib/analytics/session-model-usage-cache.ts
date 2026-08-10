import type { SessionModelBreakdown } from "@/lib/analytics/aggregate";

/**
 * Module-scoped model-usage cache for analytics. Lives outside the
 * `useSessionModelUsage` hook so it survives AnalyticsPage unmount/remount
 * (page re-opens) and progressive loads from a previous visit are reused
 * instead of re-fetched.
 *
 * Clear via {@link clearSessionModelUsageCache} on runtime endpoint switch
 * or sign-out so stale usage data from a previous runtime is not served.
 */
export const sessionModelUsageCache = new Map<string, SessionModelBreakdown>();

/**
 * Fingerprints (`sessionId:time.updated`) of sessions whose messages have
 * already been fetched and processed. Prevents redundant re-fetches when the
 * page is re-opened with an unchanged session list.
 */
export const processedSessionFingerprints = new Set<string>();

/**
 * Upper bound on cached sessions. Both structures evict the oldest entry
 * (FIFO) once this size is reached, so a long-lived desktop/VS Code host that
 * views many sessions over days cannot grow the cache without limit. Eviction
 * is graceful: an evicted session falls back to session-level attribution (or
 * reloads on the next page open) instead of leaking memory.
 */
const MAX_CACHED_SESSIONS = 1000;

/** Record a session breakdown, evicting the oldest entry when the cap is hit. */
export const setSessionModelUsage = (
  sessionId: string,
  breakdown: SessionModelBreakdown,
): void => {
  if (sessionModelUsageCache.size >= MAX_CACHED_SESSIONS) {
    const oldest = sessionModelUsageCache.keys().next().value;
    if (oldest !== undefined) sessionModelUsageCache.delete(oldest);
  }
  sessionModelUsageCache.set(sessionId, breakdown);
};

/** Mark a session fingerprint processed, evicting the oldest when capped. */
export const markSessionProcessed = (fingerprint: string): void => {
  if (processedSessionFingerprints.size >= MAX_CACHED_SESSIONS) {
    const oldest = processedSessionFingerprints.values().next().value;
    if (oldest !== undefined) processedSessionFingerprints.delete(oldest);
  }
  processedSessionFingerprints.add(fingerprint);
};

/**
 * Clear the module-level model-usage cache and processed-fingerprint set.
 * Call when the runtime endpoint switches (web/desktop/VS Code/mobile) or the
 * user signs out so stale usage data is not served from a previous runtime.
 */
export const clearSessionModelUsageCache = (): void => {
  sessionModelUsageCache.clear();
  processedSessionFingerprints.clear();
};
