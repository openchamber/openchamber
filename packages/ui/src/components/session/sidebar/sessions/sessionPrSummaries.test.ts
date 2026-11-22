import { describe, expect, test } from 'bun:test';
import type { PrVisualSummary } from '@/stores/useGitHubPrStatusStore';
import type { LinkedSidebarChange, LinkedSidebarIssue } from '@/lib/linkedIssues';
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

  test('keeps a GitHub PR and a GitLab merge request with the same path and number apart', () => {
    const combined = combineSessionPrSummaries(null, [summary(7, 'open'), summary(7, 'open', { provider: 'gitlab' })]);
    expect(combined.map((entry) => entry.provider)).toEqual(['github', 'gitlab']);
  });
});

describe('findLinkedPrsWithoutState', () => {
  test('keeps linked PRs whose state has not arrived, matching repositories case-insensitively', () => {
    const link = (number: number, owner = 'acme', provider = 'github'): LinkedSidebarChange => ({
      key: `${owner}#${number}`, identifier: `#${number}`, url: `https://github.com/${owner}/app/pull/${number}`, title: `PR ${number}`,
      repository: { key: `${owner}#${number}`, provider, instance: 'github.com', owner, repo: 'app', number, thread: 'pull' },
    });
    const other: LinkedSidebarChange = { key: 'guest:x', identifier: 'X-1', url: 'https://x', title: 'Guest' };
    expect(findLinkedPrsWithoutState([link(7, 'Acme'), link(8), other], [summary(7, 'open')]).map((entry) => entry.repository?.number)).toEqual([8]);
    expect(findLinkedPrsWithoutState([link(7)], [])).toHaveLength(1);
    // The same path and number on another provider is another change request.
    expect(findLinkedPrsWithoutState([link(7, 'acme', 'acme-forge')], [summary(7, 'open')])).toHaveLength(1);
  });
});

describe('linked tracker items', () => {
  test('take the colour of their state category and show the state\'s own name', () => {
    const linear = (identifier: string): LinkedSidebarIssue => ({ source: 'tracker', provider: 'linear', key: `linear:${identifier}`, identifier, url: `https://linear.app/x/issue/${identifier}`, title: 'Old title' });
    const items = buildSessionIssueItems([linear('ENG-1'), linear('ENG-2'), linear('ENG-3')], [], [
      { identifier: 'ENG-1', title: 'Shipped', state: { name: 'Done', category: 'done' } },
      null,
      { identifier: 'ENG-3', title: 'Working', state: { name: 'In Progress', category: 'in-progress' } },
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

  test('an open PR with checks still running says so, never ready to merge', () => {
    expect(getPrStatusLabelKey(summary(1, 'open', { canMerge: true, mergeableState: 'clean', checks: { state: 'pending', total: 2, success: 1, failure: 0, pending: 1 } })))
      .toBe('sessions.sidebar.group.pr.status.checksRunning');
  });

  test('a conflict outranks checks still running', () => {
    expect(getPrStatusLabelKey(summary(1, 'blocked', { mergeableState: 'dirty', checks: { state: 'pending', total: 2, success: 1, failure: 0, pending: 1 } })))
      .toBe('sessions.sidebar.group.pr.status.mergeConflicts');
  });
});

describe('buildSessionIssueItems', () => {
  const github = (number: number): LinkedSidebarIssue => ({
    source: 'repository', key: `acme/app#${number}`, identifier: `#${number}`, url: `https://github.com/acme/app/issues/${number}`, title: `Issue ${number}`,
    ref: { key: `acme/app#${number}`, provider: 'github', instance: 'github.com', owner: 'acme', repo: 'app', number, thread: 'issue' },
  });
  const state = (number: number, value: 'open' | 'completed' | 'not_planned') => ({ owner: 'acme', repo: 'app', number, title: `Live ${number}`, state: value });
  const linear: LinkedSidebarIssue = { source: 'tracker', provider: 'linear', key: 'linear:ENG-1', identifier: 'ENG-1', url: 'https://linear.app/x', title: 'Linear task' };

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

  test('a tracker the UI has no mark for wears the generic issue mark', () => {
    const [item] = buildSessionIssueItems([{ ...linear, provider: 'acme-tickets' }], []);
    expect(item.icon).toBe('record-circle');
  });
});

describe('GitLab issues on a session row', () => {
  test('take their colour from their own live state, in order', () => {
    const ref = (number: number) => ({ key: `gitlab|${number}`, provider: 'gitlab', instance: 'https://gitlab.com', owner: 'team', repo: 'app', number, thread: 'issue' as const });
    const items = buildSessionIssueItems([
      { source: 'repository', key: 'a', ref: ref(1), identifier: '#1', url: 'u1', title: 'One' },
      { source: 'repository', key: 'b', ref: ref(2), identifier: '#2', url: 'u2', title: 'Two' },
    ], [
      { owner: 'team', repo: 'app', number: 1, title: 'One', state: 'completed' },
      { owner: 'team', repo: 'app', number: 2, title: 'Two', state: 'open' },
    ]);
    expect(items.map((item) => [item.label, item.color, item.statusKey])).toEqual([
      ['#2', 'var(--pr-open)', 'sessions.sidebar.group.issue.status.open'],
      ['#1', 'var(--pr-merged)', 'sessions.sidebar.group.issue.status.completed'],
    ]);
  });
});
