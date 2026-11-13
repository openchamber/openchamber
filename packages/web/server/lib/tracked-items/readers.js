// The provider reads behind tracked items, each answering one batch in the
// service's terms: `ok` with the provider's live summaries, `disconnected`
// when no account there can answer, `unavailable` when it should be asked
// again later. Accounts are the ones the app is signed in to now, the way
// linked items have always been read.

const STATUSES = new Set(['disconnected', 'unavailable']);

/**
 * `readLiveSummaries({ provider, instance, accountId, refs, issueRefs, discussionRefs, details })`
 * is the source-control module's provider-neutral reader (`details` adds a
 * pull request's failed check names and newest comments): it answers
 * `{ connected: false }` without an account, else `{ connected: true,
 * summaries, issueSummaries, discussionSummaries }`, or a provider's own `{ status }` (GitHub's
 * per-host rate limit and refused token). `trackers` is the tracker
 * registry; each tracker's `liveSummaries(identifiers)` reads its work items.
 */
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

    // A tracker this server does not register (an item a newer client or an
    // older file names) has nobody to answer it: disconnected, never a throw.
    async workItems({ provider, identifiers }) {
      const tracker = await trackers?.implementation(provider);
      if (!(tracker?.liveSummaries instanceof Function)) return { status: 'disconnected' };
      const result = await tracker.liveSummaries(identifiers);
      if (!result?.connected) return { status: 'disconnected' };
      return { status: 'ok', items: result.items ?? [] };
    },
  };
}
