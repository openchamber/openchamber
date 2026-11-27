import { describe, expect, test } from 'bun:test';

import type { ChangeRequest, Project, SourceControlIdentity } from '@/lib/source-control/types';

import {
  DEFAULT_PULL_REQUEST_FILTER, PULL_REQUEST_PEOPLE, PULL_REQUEST_STATES, pullRequestFilterChoices, pullRequestsInRepository,
} from './pullRequestFilter';

const IDENTITY: SourceControlIdentity = { provider: 'github', instance: 'github.com' };

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

const inRepository = (repository: string) => (prs: ChangeRequest[]) => (
  pullRequestsInRepository(prs, repository).map((pr) => pr.number)
);

describe('the pull request repository narrowing', () => {
  const upstream = changeRequest({ number: 1, project: project('upstream') });
  const fork = changeRequest({ number: 2, project: project('fork') });

  test('no choice keeps every answered row', () => {
    expect(inRepository('')([upstream, fork])).toEqual([1, 2]);
  });

  test('a chosen repository keeps only its rows', () => {
    expect(inRepository('upstream/project')([upstream, fork])).toEqual([1]);
    expect(inRepository('fork/project')([upstream, fork])).toEqual([2]);
  });

  test('the available states and people are the board pull ones', () => {
    expect([...PULL_REQUEST_STATES]).toEqual(['open', 'merged', 'closed', 'all']);
    expect([...PULL_REQUEST_PEOPLE]).toEqual(['any', 'assigned', 'created', 'reviewRequested']);
    expect(DEFAULT_PULL_REQUEST_FILTER).toEqual({ state: 'open', people: 'any', repository: '', labels: [] });
  });
});

describe('the pull request filter choices', () => {
  test('collects each repository and label once, with labels sorted', () => {
    const choices = pullRequestFilterChoices([
      changeRequest({ number: 1, labels: [{ name: 'docs' }, { name: 'bug' }] }),
      changeRequest({ number: 2, labels: [{ name: 'bug' }] }),
      changeRequest({ number: 3, project: project('fork') }),
    ], DEFAULT_PULL_REQUEST_FILTER);
    expect(choices.repositories).toEqual(['upstream/project', 'fork/project']);
    expect(choices.labels.map((label) => label.name)).toEqual(['bug', 'docs']);
  });

  test('keeps a chosen repository the answered rows no longer carry', () => {
    const choices = pullRequestFilterChoices([], { ...DEFAULT_PULL_REQUEST_FILTER, repository: 'fork/project' });
    expect(choices.repositories).toEqual(['fork/project']);
  });
});
