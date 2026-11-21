import type { SourceControlReadInput, TrackedItemReaderOptions, TrackedItemReaders, WorkItemsReadInput } from './contracts.js';

export function createTrackedItemReaders({ readLiveSummaries, trackers }: TrackedItemReaderOptions): TrackedItemReaders {
  return {
    async sourceControl({ provider, instance, accountId = null, pulls, issues, discussions = [], details = false }: SourceControlReadInput) {
      if (!(readLiveSummaries instanceof Function)) return { status: 'disconnected' };
      const result = await readLiveSummaries({ provider, instance, accountId, refs: pulls, issueRefs: issues, discussionRefs: discussions, details });
      if (!result?.connected) return { status: 'disconnected' };
      if (result.status === 'disconnected' || result.status === 'unavailable') {
        return result.retryAfterMs !== undefined && Number.isFinite(result.retryAfterMs)
          ? { status: result.status, retryAfterMs: result.retryAfterMs }
          : { status: result.status };
      }
      return { status: 'ok', pulls: result.summaries ?? [], issues: result.issueSummaries ?? [], discussions: result.discussionSummaries ?? [] };
    },

    async workItems({ provider, identifiers }: WorkItemsReadInput) {
      const tracker = await trackers?.implementation(provider);
      if (!(tracker?.liveSummaries instanceof Function)) return { status: 'disconnected' };
      const result = await tracker.liveSummaries(identifiers);
      if (!result?.connected) return { status: 'disconnected' };
      return { status: 'ok', items: result.items ?? [] };
    },
  };
}
