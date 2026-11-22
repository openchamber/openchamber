import { describe, expect, test } from 'bun:test';

import { dedupeCheckRuns, summarizeCheckRuns } from './checks-summary.js';

// REST listForRef shape, as consumed by routes.js and pr-summaries.js.
const run = (id, status, conclusion, started_at, overrides = {}) => ({
  id,
  name: 'build',
  app: { id: 15368 },
  status,
  conclusion,
  started_at,
  ...overrides,
});

const completedSuccess = (id, started_at) => run(id, 'completed', 'success', started_at);
const completedFailure = (id, started_at) => run(id, 'completed', 'failure', started_at);
const queuedRerun = (id) => run(id, 'queued', null, null);
const waitingRerun = (id) => run(id, 'waiting', null, null);
const requestedRerun = (id) => run(id, 'requested', null, null);
const inProgressRerun = (id, started_at) => run(id, 'in_progress', null, started_at);

const summarizePair = (first, second) => summarizeCheckRuns(dedupeCheckRuns([first, second]));

describe('dedupeCheckRuns with a not-yet-started re-run (#1408)', () => {
  test('keeps a queued re-run with no started_at over the previous completed success, in either payload order', () => {
    const previous = completedSuccess(100, '2026-09-30T10:00:00Z');
    const rerun = queuedRerun(101);
    expect(dedupeCheckRuns([previous, rerun])).toEqual([rerun]);
    expect(dedupeCheckRuns([rerun, previous])).toEqual([rerun]);
  });

  test('summarizes completed-success plus a queued re-run as pending, in either payload order', () => {
    const previous = completedSuccess(100, '2026-09-30T10:00:00Z');
    const rerun = queuedRerun(101);
    for (const summary of [summarizePair(previous, rerun), summarizePair(rerun, previous)]) {
      expect(summary).toMatchObject({ state: 'pending', pending: 1, queued: 1, success: 0, failure: 0, total: 1 });
    }
  });

  test('summarizes completed-failure plus a queued re-run as pending, not failure, in either payload order', () => {
    const previous = completedFailure(100, '2026-09-30T10:00:00Z');
    const rerun = queuedRerun(101);
    for (const summary of [summarizePair(previous, rerun), summarizePair(rerun, previous)]) {
      expect(summary).toMatchObject({ state: 'pending', pending: 1, queued: 1, failure: 0, total: 1 });
    }
  });

  test('keeps a waiting re-run with no started_at over the previous completed run, in either payload order', () => {
    const previous = completedSuccess(100, '2026-09-30T10:00:00Z');
    const rerun = waitingRerun(102);
    expect(dedupeCheckRuns([previous, rerun])).toEqual([rerun]);
    expect(dedupeCheckRuns([rerun, previous])).toEqual([rerun]);
    for (const summary of [summarizePair(previous, rerun), summarizePair(rerun, previous)]) {
      expect(summary).toMatchObject({ state: 'pending', pending: 1, success: 0, failure: 0, total: 1 });
    }
  });

  test('keeps a requested re-run with no started_at over the previous completed run', () => {
    const previous = completedFailure(100, '2026-09-30T10:00:00Z');
    const rerun = requestedRerun(102);
    expect(dedupeCheckRuns([previous, rerun])).toEqual([rerun]);
    expect(dedupeCheckRuns([rerun, previous])).toEqual([rerun]);
    expect(summarizePair(previous, rerun)).toMatchObject({ state: 'pending', failure: 0, total: 1 });
  });

  test('a queued run alone survives dedupe and summarizes as pending', () => {
    const rerun = queuedRerun(101);
    expect(dedupeCheckRuns([rerun])).toEqual([rerun]);
    expect(summarizeCheckRuns(dedupeCheckRuns([rerun]))).toMatchObject({ state: 'pending', pending: 1, queued: 1, total: 1 });
  });

  test('an older queued run does not displace a newer started run', () => {
    const queued = queuedRerun(98);
    const started = inProgressRerun(99, '2026-09-30T10:01:00Z');
    expect(dedupeCheckRuns([queued, started])).toEqual([started]);
    expect(dedupeCheckRuns([started, queued])).toEqual([started]);
  });
});

describe('dedupeCheckRuns controls (both sides timestamped)', () => {
  test('an in-progress re-run still wins over the previous completed run', () => {
    const previous = completedSuccess(100, '2026-09-30T10:00:00Z');
    const rerun = inProgressRerun(101, '2026-09-30T10:05:00Z');
    expect(dedupeCheckRuns([previous, rerun])).toEqual([rerun]);
    expect(dedupeCheckRuns([rerun, previous])).toEqual([rerun]);
    expect(summarizePair(previous, rerun)).toMatchObject({ state: 'pending', inProgress: 1 });
  });

  test('a newer completed re-run still wins over the previous completed run', () => {
    const previous = completedFailure(100, '2026-09-30T10:00:00Z');
    const rerun = completedSuccess(101, '2026-09-30T10:05:00Z');
    expect(dedupeCheckRuns([previous, rerun])).toEqual([rerun]);
    expect(dedupeCheckRuns([rerun, previous])).toEqual([rerun]);
  });

  test('an older completed run does not displace the newer completed run', () => {
    const older = completedFailure(100, '2026-09-30T10:00:00Z');
    const newer = completedSuccess(101, '2026-09-30T10:05:00Z');
    expect(dedupeCheckRuns([newer, older])).toEqual([newer]);
  });

  test('a later-started re-run wins even when its id is smaller', () => {
    const previous = completedFailure(1000, '2026-09-30T10:00:00Z');
    const rerun = completedSuccess(999, '2026-09-30T10:05:00Z');
    expect(dedupeCheckRuns([previous, rerun])).toEqual([rerun]);
    expect(dedupeCheckRuns([rerun, previous])).toEqual([rerun]);
  });

  test('equal timestamps still break ties by larger id', () => {
    const first = completedFailure(100, '2026-09-30T10:00:00Z');
    const second = completedSuccess(101, '2026-09-30T10:00:00Z');
    expect(dedupeCheckRuns([first, second])).toEqual([second]);
    expect(dedupeCheckRuns([second, first])).toEqual([second]);
  });
});
