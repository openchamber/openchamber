/**
 * Write queue for open plan documents.
 *
 * Debounced autosave and close-time flushes must reach the disk in edit order,
 * and a document re-opened while its own write is still in flight must read
 * the post-write state, not race it. The queue serializes writes per logical
 * document key and deduplicates revisions so a flush of revision N can never
 * run behind, or twice behind, a debounced save of the same revision.
 */

interface PlanSaveQueue {
  /**
   * Queue one write for `key`. Writes for the same key run in schedule order;
   * writes for different keys never block each other. A revision at or below
   * the last queued revision for that key is skipped — the queued write
   * already carries newer content — and the returned promise tracks the
   * outstanding chain so callers can still await it.
   */
  schedule: (key: string, revision: number, write: () => Promise<void>) => Promise<void>;
  /** Resolves when every write queued for `key` has settled. */
  pendingFor: (key: string) => Promise<void>;
  /**
   * Forgets the revision watermark for `key`. Call when a document is freshly
   * loaded: its revision counter restarts, and stale watermarks from a
   * previous open must not swallow the first real edit.
   */
  reset: (key: string) => void;
}

export const createPlanSaveQueue = (): PlanSaveQueue => {
  const chains = new Map<string, Promise<void>>();
  const lastRevision = new Map<string, number>();

  return {
    schedule: (key, revision, write) => {
      if (revision <= (lastRevision.get(key) ?? Number.NEGATIVE_INFINITY)) {
        return chains.get(key) ?? Promise.resolve();
      }
      lastRevision.set(key, revision);
      const previous = chains.get(key) ?? Promise.resolve();
      // A failed write must not poison the chain: the next write for this
      // document is still safe to attempt, and error surfacing belongs to the
      // caller that owns UI state.
      const next = previous.then(write, write);
      chains.set(key, next.catch(() => {
        // Keep newer queued revisions deduplicated, but let the caller retry
        // this exact revision after its write has failed.
        if (lastRevision.get(key) === revision) {
          lastRevision.delete(key);
        }
      }));
      return next;
    },
    pendingFor: async (key) => {
      await chains.get(key);
    },
    reset: (key) => {
      lastRevision.delete(key);
    },
  };
};
