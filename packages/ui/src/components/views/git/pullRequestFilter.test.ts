import { describe, expect, test } from 'bun:test';

import type { ChangeRequest, Project, SourceControlIdentity, SourceControlUser } from '@/lib/source-control/types';

import { DEFAULT_PULL_REQUEST_FILTER, filterPullRequests, pullRequestFilterChoices, pullRequestListState, type PullRequestFilter } from './pullRequestFilter';

const IDENTITY: SourceControlIdentity = { provider: 'github', instance: 'github.com' };

const user = (username: string): SourceControlUser => ({ ...IDENTITY, id: `user-${username}`, username });

const project = (owner: string, name = 'project'): Project => ({
  ...IDENTITY, id: `${owner}/${name}`, owner, name, url: `https://github.com/${owner}/${name}`,
});

const changeRequest = (overrides: Partial<ChangeRequest>): ChangeRequest => ({
  ...IDENTITY,
  id: 'pr',
  number: 1,
  project: project('upstream'),
  title: 'A pull request',
  url: 'https://github.com/upstream/project/pull/1',
  state: 'open',
  draft: false,
  base: 'main',
  head: 'feature',
  ...overrides,
});

const filtered = (filter: Partial<PullRequestFilter>) => (prs: ChangeRequest[]) => (
  filterPullRequests(prs, { ...DEFAULT_PULL_REQUEST_FILTER, ...filter }).map((pr) => pr.number)
);

describe('the pull request filter predicate', () => {
  const open = changeRequest({ number: 1, state: 'open', draft: false });
  const draft = changeRequest({ number: 2, state: 'open', draft: true });
  const closedDraft = changeRequest({ number: 3, state: 'closed', draft: true });
  const closed = changeRequest({ number: 4, state: 'closed', draft: false });
  const merged = changeRequest({ number: 5, state: 'merged', draft: false });
  const all = [open, draft, closedDraft, closed, merged];

  test('the default filter keeps open items, drafts included', () => {
    expect(filtered({})(all)).toEqual([1, 2]);
  });

  test('status narrows by open, closed, and merged', () => {
    expect(filtered({ status: 'all' })(all)).toEqual([1, 2, 3, 4, 5]);
    expect(filtered({ status: 'open' })(all)).toEqual([1, 2]);
    expect(filtered({ status: 'closed' })(all)).toEqual([3, 4]);
    expect(filtered({ status: 'merged' })(all)).toEqual([5]);
  });

  test('draft matches open drafts only', () => {
    expect(filtered({ status: 'draft' })(all)).toEqual([2]);
  });

  test('repository matches the loaded owner and repository name', () => {
    const fork = changeRequest({ number: 6, project: project('fork') });
    expect(filtered({ repository: 'upstream/project' })([...all, fork])).toEqual([1, 2]);
    expect(filtered({ repository: 'fork/project' })([...all, fork])).toEqual([6]);
  });

  test('author matches the login and leaves out items without one', () => {
    const mine = changeRequest({ number: 6, author: user('nebula') });
    const theirs = changeRequest({ number: 7, author: user('octocat') });
    const anonymous = changeRequest({ number: 8 });
    expect(filtered({ author: 'nebula' })([mine, theirs, anonymous])).toEqual([6]);
    expect(filtered({ author: 'octocat' })([mine, theirs, anonymous])).toEqual([7]);
  });

  test('labels match every selected label, not just one of them', () => {
    const both = changeRequest({ number: 6, labels: [{ name: 'bug' }, { name: 'docs' }] });
    const bug = changeRequest({ number: 7, labels: [{ name: 'bug' }] });
    const none = changeRequest({ number: 8 });
    expect(filtered({ labels: ['bug'] })([both, bug, none])).toEqual([6, 7]);
    expect(filtered({ labels: ['bug', 'docs'] })([both, bug, none])).toEqual([6]);
    expect(filtered({ labels: [] })([both, bug, none])).toEqual([6, 7, 8]);
  });

  test('all criteria must hold together', () => {
    const match = changeRequest({ number: 6, author: user('nebula'), labels: [{ name: 'bug' }] });
    const otherAuthor = changeRequest({ number: 7, author: user('octocat'), labels: [{ name: 'bug' }] });
    const otherLabel = changeRequest({ number: 8, author: user('nebula'), labels: [{ name: 'docs' }] });
    expect(filtered({ status: 'open', author: 'nebula', labels: ['bug'] })([match, otherAuthor, otherLabel])).toEqual([6]);
  });
});

describe('the pull request filter choices', () => {
  test('collects each repository, author and label once, with labels sorted', () => {
    const choices = pullRequestFilterChoices([
      changeRequest({ number: 1, author: user('nebula'), labels: [{ name: 'docs' }, { name: 'bug' }] }),
      changeRequest({ number: 2, author: user('nebula'), labels: [{ name: 'bug' }] }),
      changeRequest({ number: 3, project: project('fork'), author: user('octocat') }),
    ], DEFAULT_PULL_REQUEST_FILTER);
    expect(choices.repositories).toEqual(['upstream/project', 'fork/project']);
    expect(choices.authors).toEqual(['nebula', 'octocat']);
    expect(choices.labels.map((label) => label.name)).toEqual(['bug', 'docs']);
  });

  test('keeps a chosen repository and author that the loaded rows no longer carry', () => {
    const choices = pullRequestFilterChoices([], { ...DEFAULT_PULL_REQUEST_FILTER, repository: 'fork/project', author: 'octocat' });
    expect(choices.repositories).toEqual(['fork/project']);
    expect(choices.authors).toEqual(['octocat']);
  });
});

test('closed and merged rows are read only for a status that shows them', () => {
  expect(pullRequestListState('open')).toBe('open');
  expect(pullRequestListState('draft')).toBe('open');
  expect(pullRequestListState('all')).toBe('all');
  expect(pullRequestListState('closed')).toBe('all');
  expect(pullRequestListState('merged')).toBe('all');
});
