import { describe, expect, test } from 'bun:test';
import type { PrVisualSummary } from '@/stores/useGitHubPrStatusStore';
import { combineSessionPrSummaries, getPrStatusLabelKey } from './sessionPrSummaries';

const summary = (number: number, visualState: string, overrides: Partial<PrVisualSummary> = {}): PrVisualSummary => ({
  number,
  visualState,
  prState: visualState === 'merged' || visualState === 'closed' ? visualState : 'open',
  draft: visualState === 'draft',
  title: `PR ${number}`,
  url: `https://github.com/acme/app/pull/${number}`,
  base: null,
  head: null,
  checks: null,
  canMerge: null,
  mergeableState: null,
  repo: { owner: 'acme', repo: 'app' },
  ...overrides,
});

describe('combineSessionPrSummaries', () => {
  test('leads with the PR that needs attention first', () => {
    const combined = combineSessionPrSummaries(summary(1, 'merged'), [summary(2, 'open'), summary(3, 'blocked')]);
    expect(combined.map((entry) => entry.number)).toEqual([3, 2, 1]);
  });

  test('lists a PR that is both the branch PR and linked once, keeping the branch entry', () => {
    const branch = summary(7, 'open', { canMerge: true });
    const combined = combineSessionPrSummaries(branch, [summary(7, 'open', { repo: { owner: 'ACME', repo: 'App' } })]);
    expect(combined).toEqual([branch]);
  });

  test('keeps PRs with the same number from different repositories apart', () => {
    const combined = combineSessionPrSummaries(null, [summary(7, 'open'), summary(7, 'open', { repo: { owner: 'acme', repo: 'web' } })]);
    expect(combined).toHaveLength(2);
  });
});

describe('getPrStatusLabelKey', () => {
  test('a PR waiting for a required review is open, not ready to merge', () => {
    expect(getPrStatusLabelKey(summary(1, 'open', { mergeableState: 'blocked', canMerge: true })))
      .toBe('sessions.sidebar.group.pr.status.open');
  });

  test('names the reason an orange PR needs fixing', () => {
    expect(getPrStatusLabelKey(summary(1, 'blocked', { mergeableState: 'dirty' }))).toBe('sessions.sidebar.group.pr.status.mergeConflicts');
    expect(getPrStatusLabelKey(summary(1, 'blocked', { checks: { state: 'failure', total: 2, success: 1, failure: 1, pending: 0 } })))
      .toBe('sessions.sidebar.group.pr.status.checksFailing');
  });
});
