const STATUSES = new Set(['disconnected', 'unavailable']);

export function createTrackedItemReaders({ readLiveSummaries, trackers }) {
  return {
    async sourceControl({ provider, instance, accountId = null, pulls, issues, discussions = [], details = false }) {
      if (!(readLiveSummaries instanceof Function)) return { status: 'disconnected' };
      const result = await readLiveSummaries({ provider, instance, accountId, refs: pulls, issueRefs: issues, discussionRefs: discussions, details });
      if (!result?.connected) return { status: 'disconnected' };
      if (STATUSES.has(result.status)) {
        return Number.isFinite(result.retryAfterMs)
          ? { status: result.status, retryAfterMs: result.retryAfterMs }
          : { status: result.status };
      }
      return { status: 'ok', pulls: result.summaries ?? [], issues: result.issueSummaries ?? [], discussions: result.discussionSummaries ?? [] };
    },

    async workItems({ provider, identifiers }) {
      const tracker = await trackers?.implementation(provider);
      if (!(tracker?.liveSummaries instanceof Function)) return { status: 'disconnected' };
      const result = await tracker.liveSummaries(identifiers);
      if (!result?.connected) return { status: 'disconnected' };
      return { status: 'ok', items: result.items ?? [] };
    },
  };
}
