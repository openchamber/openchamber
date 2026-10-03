import { describe, expect, it } from 'vitest';

import { buildReferenceSearchQuery, fetchReferenceDetail, parseReferenceLookup, readReferenceFilter, toReference } from './reference-search.js';

const origin = { owner: 'acme', repo: 'app', source: 'origin' };
const upstream = { owner: 'Upstream', repo: 'App', source: 'upstream' };
const repos = [origin, upstream];

const common = (number, repository = { name: 'app', owner: { login: 'acme' } }) => ({
  number,
  title: `Item ${number}`,
  url: `https://github.com/acme/app/issues/${number}`,
  createdAt: '2026-09-01T10:00:00Z',
  updatedAt: '2026-09-30T10:00:00Z',
  body: 'Steps to reproduce',
  author: { login: 'octo', avatarUrl: 'https://avatars/octo' },
  labels: { nodes: [{ name: 'bug', color: 'd73a4a' }, null] },
  comments: { totalCount: 4 },
  repository,
});

describe('buildReferenceSearchQuery', () => {
  it('lists open items of one kind across the network, newest activity first', () => {
    expect(buildReferenceSearchQuery({ repos, kind: 'issue', filter: 'open', text: '' }))
      .toBe('repo:acme/app repo:Upstream/App is:issue is:open sort:updated-desc');
    expect(buildReferenceSearchQuery({ repos: [origin], kind: 'pull', filter: 'reviewRequested', text: ' crash ' }))
      .toBe('repo:acme/app is:pr is:open sort:updated-desc review-requested:@me crash');
  });

  it('leaves state and sort to the user when their text sets them', () => {
    expect(buildReferenceSearchQuery({ repos: [origin], kind: 'issue', filter: 'assigned', text: 'is:closed sort:created-asc' }))
      .toBe('repo:acme/app is:issue assignee:@me is:closed sort:created-asc');
  });

  it('reads an unknown filter as open', () => {
    expect(readReferenceFilter('everything')).toBe('open');
    expect(readReferenceFilter('created')).toBe('created');
  });
});

describe('parseReferenceLookup', () => {
  it('looks a number up in every repo of the network', () => {
    expect(parseReferenceLookup('#42', repos)).toEqual({ number: 42, repos });
    expect(parseReferenceLookup(' 42 ', repos)).toEqual({ number: 42, repos });
  });

  it('looks a link up only in its own repo, whatever its kind', () => {
    expect(parseReferenceLookup('https://github.com/upstream/app/pull/7/files', repos)).toEqual({ number: 7, repos: [upstream] });
    expect(parseReferenceLookup('github.com/acme/app/issues/3', repos)).toEqual({ number: 3, repos: [origin] });
    expect(parseReferenceLookup('https://github.com/other/repo/issues/3', repos)).toEqual({ number: 3, repos: [] });
  });

  it('treats anything else as search text', () => {
    expect(parseReferenceLookup('crash on 42', repos)).toBeNull();
    expect(parseReferenceLookup('', repos)).toBeNull();
  });
});

describe('toReference', () => {
  it('maps an issue with GitHub close reasons', () => {
    const open = toReference({ __typename: 'Issue', ...common(1), state: 'OPEN', stateReason: null }, repos);
    expect(open).toEqual({
      kind: 'issue',
      number: 1,
      title: 'Item 1',
      url: 'https://github.com/acme/app/issues/1',
      body: 'Steps to reproduce',
      bodyTruncated: false,
      createdAt: '2026-09-01T10:00:00Z',
      updatedAt: '2026-09-30T10:00:00Z',
      author: { login: 'octo', avatarUrl: 'https://avatars/octo' },
      labels: [{ name: 'bug', color: 'd73a4a' }],
      commentCount: 4,
      sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
      state: 'open',
    });
    expect(toReference({ __typename: 'Issue', ...common(2), state: 'CLOSED', stateReason: 'NOT_PLANNED' }, repos)?.state).toBe('not_planned');
    expect(toReference({ __typename: 'Issue', ...common(3), state: 'CLOSED', stateReason: 'COMPLETED' }, repos)?.state).toBe('completed');
  });

  it('maps a PR with its branches and head repo', () => {
    const pull = toReference({
      __typename: 'PullRequest',
      ...common(9, { name: 'app', owner: { login: 'upstream' } }),
      state: 'OPEN',
      isDraft: true,
      headRefName: 'fix/crash',
      baseRefName: 'main',
      headRefOid: 'abc',
      headRepository: { name: 'app', url: 'https://github.com/acme/app', sshUrl: 'git@github.com:acme/app.git', owner: { login: 'acme' } },
    }, repos);
    expect(pull).toMatchObject({
      kind: 'pull',
      number: 9,
      state: 'open',
      draft: true,
      head: 'fix/crash',
      base: 'main',
      sourceRepo: { owner: 'Upstream', repo: 'App', source: 'upstream' },
      headRepo: { owner: 'acme', repo: 'app', url: 'https://github.com/acme/app', cloneUrl: 'https://github.com/acme/app.git', sshUrl: 'git@github.com:acme/app.git' },
    });
    expect(toReference({
      __typename: 'PullRequest',
      ...common(10),
      state: 'MERGED',
      isDraft: false,
      headRefName: 'a',
      baseRefName: 'main',
      headRefOid: 'abc',
      headRepository: null,
    }, repos)).toMatchObject({ state: 'merged', headRepo: null });
  });

  it('cuts a very long description for the preview', () => {
    const issue = toReference({ __typename: 'Issue', ...common(4), body: 'x'.repeat(25_000), state: 'OPEN', stateReason: null }, repos);
    expect(issue?.body).toHaveLength(20_000);
    expect(issue?.bodyTruncated).toBe(true);
  });

  it('rejects nodes from other repos and malformed nodes', () => {
    expect(toReference({ __typename: 'Issue', ...common(5, { name: 'other', owner: { login: 'x' } }), state: 'OPEN', stateReason: null }, repos)).toBeNull();
    expect(toReference({ __typename: 'Issue', number: 'five' }, repos)).toBeNull();
    expect(toReference(null, repos)).toBeNull();
  });
});

describe('fetchReferenceDetail', () => {
  const graphqlReturning = (item) => ({ graphql: async () => ({ repository: { issueOrPullRequest: item } }) });
  const author = { login: 'octo', avatarUrl: 'https://avatars/octo' };
  const contexts = [
    { __typename: 'CheckRun', databaseId: 1, name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: null, checkSuite: { app: { databaseId: 5 } } },
    { __typename: 'CheckRun', databaseId: 2, name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: null, checkSuite: { app: { databaseId: 5 } } },
  ];
  const pull = (state, reviews = []) => ({
    __typename: 'PullRequest',
    number: 9,
    state,
    reviewDecision: 'CHANGES_REQUESTED',
    additions: 12,
    deletions: 3,
    changedFiles: 2,
    comments: { totalCount: 1, nodes: [{ author, body: 'first', createdAt: '2026-10-01T10:00:00Z', url: 'u1' }] },
    reviews: { nodes: reviews },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: contexts } } } }] },
  });

  it('reads an issue with its comments', async () => {
    const detail = await fetchReferenceDetail({ octokit: graphqlReturning({
      __typename: 'Issue',
      number: 3,
      comments: { totalCount: 80, nodes: [{ author: null, body: 'hi', createdAt: null, url: 'u' }] },
    }), owner: 'acme', repo: 'app', number: 3 });
    expect(detail).toEqual({
      number: 3,
      comments: [{ author: null, body: 'hi', createdAt: null, url: 'u', path: null, line: null, review: null }],
      commentTotal: 80,
      pull: null,
    });
  });

  it('merges a PR review into its comments, oldest first, with size, review and checks', async () => {
    const detail = await fetchReferenceDetail({ octokit: graphqlReturning(pull('OPEN', [
      { author, body: '', state: 'COMMENTED', createdAt: '2026-10-01T09:00:00Z', url: 'r1', comments: { nodes: [
        { author, body: 'nit', createdAt: '2026-10-01T09:00:00Z', url: 'c1', path: 'src/a.ts', line: null, originalLine: 7 },
      ] } },
      { author, body: '', state: 'APPROVED', createdAt: '2026-10-01T11:00:00Z', url: 'r2', comments: { nodes: [] } },
    ])), owner: 'acme', repo: 'app', number: 9 });
    expect(detail?.comments.map((comment) => [comment.body, comment.review, comment.path, comment.line])).toEqual([
      ['nit', 'commented', 'src/a.ts', 7],
      ['first', null, null, null],
      ['', 'approved', null, null],
    ]);
    expect(detail?.pull).toEqual({
      reviewDecision: 'changes_requested',
      additions: 12,
      deletions: 3,
      changedFiles: 2,
      checks: expect.objectContaining({ state: 'failure', total: 2, success: 1, failure: 1 }),
    });
  });

  it('drops checks for a merged PR and answers null for a missing number', async () => {
    expect((await fetchReferenceDetail({ octokit: graphqlReturning(pull('MERGED')), owner: 'acme', repo: 'app', number: 9 }))?.pull?.checks).toBeNull();
    expect(await fetchReferenceDetail({ octokit: graphqlReturning(null), owner: 'acme', repo: 'app', number: 9 })).toBeNull();
  });
});
