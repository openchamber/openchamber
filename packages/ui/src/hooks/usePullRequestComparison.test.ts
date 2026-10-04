import { describe, expect, test } from 'bun:test';
import type { ChangeRequest } from '@/lib/source-control/types';
import { mergePullRequestPage } from './usePullRequestComparison';

const github = { provider: 'github', instance: 'github.com' } as const;

const pr = (owner: string, number: number): ChangeRequest => ({
  ...github,
  id: `${owner}/repo#${number}`,
  number,
  project: { ...github, id: `${owner}/repo`, owner, name: 'repo', url: `https://github.com/${owner}/repo` },
  title: `PR ${number}`,
  url: `https://github.com/${owner}/repo/pull/${number}`,
  state: 'open',
  draft: false,
  base: 'main',
  head: `branch-${number}`,
});

describe('mergePullRequestPage', () => {
  test('a refresh keeps the pull requests of a project that failed this time', () => {
    const upstream = pr('upstream', 1);
    const merged = mergePullRequestPage(
      [upstream, pr('fork', 2)],
      { items: [], page: 1, hasMore: false, incompleteProjectIds: ['upstream/repo'] },
      false,
    );
    expect(merged).toEqual({ prs: [upstream], incompleteProjectIds: ['upstream/repo'] });
  });

  test('an empty list with a failed project is reported as partial, not as none', () => {
    const merged = mergePullRequestPage([], { items: [], page: 1, hasMore: false, incompleteProjectIds: ['upstream/repo'] }, false);
    expect(merged.incompleteProjectIds).toEqual(['upstream/repo']);
  });

  test('a complete page replaces what was shown', () => {
    const fresh = pr('fork', 3);
    expect(mergePullRequestPage([pr('upstream', 1)], { items: [fresh], page: 1, hasMore: false }, false))
      .toEqual({ prs: [fresh], incompleteProjectIds: [] });
  });

  test('loading more appends to what was shown', () => {
    const first = pr('fork', 1);
    const second = pr('fork', 2);
    expect(mergePullRequestPage([first], { items: [second], page: 2, hasMore: false }, true).prs).toEqual([first, second]);
  });
});
