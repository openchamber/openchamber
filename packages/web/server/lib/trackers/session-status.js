/**
 * Fans session events out to every tracker that comments on sessions
 * (`sessionStatus.createRuntime`). A tracker's runtime is created on the first
 * event after its implementation loads; events that arrive while it loads are
 * kept (up to `maxPending`) and handed over once it is ready. A failed load is
 * retried on a later event, no sooner than `retryAfterMs`, so one transient
 * import failure at startup never silences a tracker until restart, and a
 * tracker that keeps failing is not re-imported on every event.
 */
export function createTrackerSessionStatus({
  registry,
  now = Date.now,
  retryAfterMs = 30_000,
  maxPending = 200,
  warn = (...args) => console.warn(...args),
}) {
  // Per tracker id: { runtime } once created, { pending } while loading,
  // { failedAt } after a failed load, { none: true } for a tracker without one.
  const states = new Map();

  const load = (id) => {
    const state = { pending: [] };
    states.set(id, state);
    registry.implementation(id).then((tracker) => {
      const createRuntime = tracker?.sessionStatus?.createRuntime;
      if (!(createRuntime instanceof Function)) {
        states.set(id, { none: true });
        return;
      }
      const runtime = createRuntime();
      states.set(id, { runtime });
      for (const payload of state.pending) runtime.processPayload(payload);
    }).catch((error) => {
      states.set(id, { failedAt: now() });
      warn(`[trackers] ${id}: session status runtime did not start:`, error?.message || error);
    });
  };

  /** A tracker that left the registry (an extension paused or removed): its runtime stops and its state goes. */
  const forget = (id) => {
    const state = states.get(id);
    if (!state) return;
    states.delete(id);
    try {
      state.runtime?.stop?.();
    } catch (error) {
      warn(`[trackers] ${id}: session status runtime did not stop:`, error?.message || error);
    }
  };

  /**
   * Host events only. A session inside an isolated space runs its own OpenCode
   * and its own trackers; the hub hands such events only to subscribers that
   * asked for spaces (`server/index.js` does not), and one that arrives marked
   * with a space is dropped here as well, so no comment ever names a space's
   * session with the host's link.
   */
  const processPayload = (payload, { spaceId = null } = {}) => {
    if (spaceId) return;
    const current = registry.list();
    for (const id of [...states.keys()]) {
      if (!current.includes(id)) forget(id);
    }
    for (const id of current) {
      const state = states.get(id);
      if (state?.runtime) {
        state.runtime.processPayload(payload);
        continue;
      }
      if (state?.none) continue;
      if (state?.pending) {
        if (state.pending.length < maxPending) state.pending.push(payload);
        continue;
      }
      if (state?.failedAt !== undefined && now() - state.failedAt < retryAfterMs) continue;
      load(id);
      states.get(id).pending.push(payload);
    }
  };

  return { processPayload, forget };
}
