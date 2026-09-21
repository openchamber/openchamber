import type { GitHubCheckRun, GitHubChecksSummary } from '@/lib/api/types';

/**
 * Client-side mirror of the server's check-run aggregation so surfaces that
 * hold the detailed run list (pulls/context) can derive the same summary the
 * pr/status endpoint produces, instead of showing two differently-aged
 * aggregates side by side.
 */
export const summarizeCheckRuns = (checkRuns: readonly GitHubCheckRun[]): GitHubChecksSummary => {
  const counts = { success: 0, failure: 0, pending: 0, inProgress: 0, queued: 0 };
  let startedAt: string | undefined;
  for (const run of checkRuns) {
    if (run.status === 'in_progress') {
      counts.pending += 1;
      counts.inProgress += 1;
      if (run.startedAt && (!startedAt || run.startedAt < startedAt)) {
        startedAt = run.startedAt;
      }
      continue;
    }
    if (run.status === 'queued') {
      counts.pending += 1;
      counts.queued += 1;
      continue;
    }
    const conclusion = typeof run.conclusion === 'string' ? run.conclusion.toLowerCase() : '';
    if (!conclusion) {
      counts.pending += 1;
      continue;
    }
    if (conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped') {
      counts.success += 1;
    } else {
      counts.failure += 1;
    }
  }
  const total = counts.success + counts.failure + counts.pending;
  const state = counts.failure > 0
    ? 'failure'
    : (counts.pending > 0 ? 'pending' : (total > 0 ? 'success' : 'unknown'));
  return { state, total, ...counts, ...(startedAt ? { startedAt } : {}) };
};
