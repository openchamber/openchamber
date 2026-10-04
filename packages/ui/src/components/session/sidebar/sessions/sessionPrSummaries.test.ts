import { describe, expect, test } from 'bun:test';
import type { PrVisualSummary } from '@/stores/useGitHubPrStatusStore';
import type { LinkedSidebarIssue } from '@/lib/linkedIssues';
import { buildSessionIssueItems, combineSessionPrSummaries, findLinkedPrsWithoutState, getPrStatusLabelKey } from './sessionPrSummaries';

const summary = (number: number, visualState: string, overrides: Partial<PrVisualSummary> = {}): PrVisualSummary => ({
  provider: 'github',
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

describe('findLinkedPrsWithoutState', () => {
  test('keeps linked PRs whose state has not arrived, matching repositories case-insensitively', () => {
    const link = (number: number, owner = 'acme') => ({ owner, repo: 'app', number, url: `https://github.com/${owner}/app/pull/${number}`, title: `PR ${number}` });
    expect(findLinkedPrsWithoutState([link(7, 'Acme'), link(8)], [summary(7, 'open')]).map((entry) => entry.number)).toEqual([8]);
    expect(findLinkedPrsWithoutState([link(7)], [])).toHaveLength(1);
  });
});

describe('linked Linear issues', () => {
  test('take the colour of their state type and show its team name', () => {
    const linear = (identifier: string): LinkedSidebarIssue => ({ source: 'linear', key: `linear:${identifier}`, identifier, url: `https://linear.app/x/issue/${identifier}`, title: 'Old title' });
    const items = buildSessionIssueItems([linear('ENG-1'), linear('ENG-2'), linear('ENG-3')], [], [
      { identifier: 'ENG-1', title: 'Shipped', state: { name: 'Done', type: 'completed' } },
      null,
      { identifier: 'ENG-3', title: 'Working', state: { name: 'In Progress', type: 'started' } },
    ]);
    expect(items.map((item) => [item.label, item.color, item.statusText, item.title])).toEqual([
      ['ENG-3', 'var(--pr-open)', 'In Progress', 'Working'],
      ['ENG-2', null, null, 'Old title'],
      ['ENG-1', 'var(--pr-merged)', 'Done', 'Shipped'],
    ]);
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

describe('buildSessionIssueItems', () => {
  const github = (number: number): LinkedSidebarIssue => ({
    source: 'github', key: `acme/app#${number}`, owner: 'acme', repo: 'app', number, url: `https://github.com/acme/app/issues/${number}`, title: `Issue ${number}`,
  });
  const state = (number: number, value: 'open' | 'completed' | 'not_planned') => ({ owner: 'acme', repo: 'app', number, title: `Live ${number}`, state: value });
  const linear: LinkedSidebarIssue = { source: 'linear', key: 'linear:ENG-1', identifier: 'ENG-1', url: 'https://linear.app/x', title: 'Linear task' };

  test('open issues lead, unknown states follow, closed ones trail', () => {
    const items = buildSessionIssueItems(
      [github(1), linear, github(2), github(3), github(4)],
      [state(1, 'completed'), state(2, 'open'), state(3, 'not_planned'), null],
    );
    expect(items.map((item) => item.label)).toEqual(['#2', 'ENG-1', '#4', '#1', '#3']);
  });

  test('borrows PR colours and never turns orange', () => {
    const [open, done, dropped] = buildSessionIssueItems(
      [github(1), github(2), github(3)],
      [state(1, 'open'), state(2, 'completed'), state(3, 'not_planned')],
    );
    expect([open.color, done.color, dropped.color]).toEqual(['var(--pr-open)', 'var(--pr-merged)', 'var(--pr-closed)']);
    expect(open.title).toBe('Live 1');
  });

  test('a tracker issue has no state: muted, labelled by its identifier', () => {
    const [item] = buildSessionIssueItems([linear], []);
    expect(item).toMatchObject({ label: 'ENG-1', icon: 'linear', color: null, statusKey: null });
  });
});
