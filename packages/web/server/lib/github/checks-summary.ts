export interface CheckRun {
  id?: number | undefined;
  name?: string;
  app?: { id?: number | undefined; slug?: string } | null;
  started_at?: string | null | undefined;
  status?: string;
  conclusion?: string | null;
}

export interface ChecksSummary {
  state: 'failure' | 'pending' | 'success' | 'unknown';
  total: number;
  success: number;
  failure: number;
  pending: number;
  inProgress: number;
  queued: number;
  startedAt?: string;
}

interface SummarizedCheckRun {
  status?: unknown;
  conclusion?: unknown;
  started_at?: unknown;
}

const isStartTime = (value: unknown): value is string => typeof value === 'string';

export function dedupeCheckRuns<Run extends CheckRun | null | undefined>(checkRuns: readonly Run[]) {
  const byName = new Map<string, Run>();
  for (const run of checkRuns) {
    const key = `${run?.app?.id ?? run?.app?.slug ?? ''}::${run?.name ?? ''}`;
    const previous = byName.get(key);
    if (!previous) {
      byName.set(key, run);
      continue;
    }
    const previousStartedAt = Date.parse(previous?.started_at || '') || 0;
    const startedAt = Date.parse(run?.started_at || '') || 0;
    if (startedAt > previousStartedAt
      || (startedAt === previousStartedAt && (run?.id ?? 0) > (previous?.id ?? 0))) {
      byName.set(key, run);
    }
  }
  return Array.from(byName.values());
}

export function summarizeCheckRuns(checkRuns: readonly (SummarizedCheckRun | null | undefined)[]) {
  const counts = { success: 0, failure: 0, pending: 0, inProgress: 0, queued: 0 };
  let startedAt: string | null = null;
  for (const run of checkRuns) {
    const status = run?.status;
    const conclusion = run?.conclusion;
    if (status === 'in_progress') {
      counts.pending += 1;
      counts.inProgress += 1;
      const runStartedAt = isStartTime(run?.started_at) ? run.started_at : null;
      if (runStartedAt && (!startedAt || runStartedAt < startedAt)) {
        startedAt = runStartedAt;
      }
      continue;
    }
    if (status === 'queued') {
      counts.pending += 1;
      counts.queued += 1;
      continue;
    }
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
  const summary: ChecksSummary = { state, total, ...counts };
  if (startedAt) summary.startedAt = startedAt;
  return summary;
}

export function summarizeCombinedStatuses(statuses: readonly { state: string }[]) {
  const counts = { success: 0, failure: 0, pending: 0 };
  statuses.forEach((s) => {
    if (s.state === 'success') counts.success += 1;
    else if (s.state === 'failure' || s.state === 'error') counts.failure += 1;
    else if (s.state === 'pending') counts.pending += 1;
  });
  const total = counts.success + counts.failure + counts.pending;
  const state: ChecksSummary['state'] = counts.failure > 0
    ? 'failure'
    : (counts.pending > 0 ? 'pending' : (total > 0 ? 'success' : 'unknown'));
  return { state, total, ...counts, inProgress: counts.pending, queued: 0 };
}
