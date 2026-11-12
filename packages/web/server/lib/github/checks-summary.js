// Aggregate check runs into the summary shape shared by pr/status,
// pulls/context and pr/summaries, so every surface counts the same checks. Keeps `pending` as queued+in_progress+unconcluded for
// existing consumers while exposing the split and the earliest start time so
// the UI can show live "running for N minutes" state.
// A re-run leaves the previous completed check run in the listForRef payload
// alongside the new in-progress one. GitHub's UI shows only the latest run
// per (app, name); mirror that so counts match what users see on github.com.
export function dedupeCheckRuns(checkRuns) {
  const byName = new Map();
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

export function summarizeCheckRuns(checkRuns) {
  const counts = { success: 0, failure: 0, pending: 0, inProgress: 0, queued: 0 };
  let startedAt = null;
  for (const run of checkRuns) {
    const status = run?.status;
    const conclusion = run?.conclusion;
    if (status === 'in_progress') {
      counts.pending += 1;
      counts.inProgress += 1;
      const runStartedAt = typeof run?.started_at === 'string' ? run.started_at : null;
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
  return { state, total, ...counts, ...(startedAt ? { startedAt } : {}) };
}

export function summarizeCombinedStatuses(statuses) {
  const counts = { success: 0, failure: 0, pending: 0 };
  statuses.forEach((s) => {
    if (s.state === 'success') counts.success += 1;
    else if (s.state === 'failure' || s.state === 'error') counts.failure += 1;
    else if (s.state === 'pending') counts.pending += 1;
  });
  const total = counts.success + counts.failure + counts.pending;
  const state = counts.failure > 0
    ? 'failure'
    : (counts.pending > 0 ? 'pending' : (total > 0 ? 'success' : 'unknown'));
  return { state, total, ...counts, inProgress: counts.pending, queued: 0 };
}
