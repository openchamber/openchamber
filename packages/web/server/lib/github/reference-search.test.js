import { describe, expect, it } from 'vitest';

import {
  buildReferenceSearchQuery, fetchDiscussionDetail, fetchReferenceDetail, parseReferenceLookup, readPullStatusRefs,
  readReferencePeople, readReferenceState, reviewCommentExcerpt, searchGitHubReferences, searchGitHubReferencesAcross, toReference,
} from './reference-search.js';

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
    expect(buildReferenceSearchQuery({ repos, kind: 'issue', state: 'open', people: 'any', text: '' }))
      .toBe('repo:acme/app repo:Upstream/App is:issue is:open sort:updated-desc');
    expect(buildReferenceSearchQuery({ repos: [origin], kind: 'pull', state: 'open', people: 'reviewRequested', text: ' crash ' }))
      .toBe('repo:acme/app is:pr is:open sort:updated-desc review-requested:@me crash');
  });

  it('combines a state with whose items they are', () => {
    expect(buildReferenceSearchQuery({ repos: [origin], kind: 'pull', state: 'closed', people: 'created', text: '' }))
      .toBe('repo:acme/app is:pr is:closed sort:updated-desc author:@me');
    expect(buildReferenceSearchQuery({ repos: [origin], kind: 'pull', state: 'merged', people: 'assigned', text: '' }))
      .toBe('repo:acme/app is:pr is:merged sort:updated-desc assignee:@me');
    expect(buildReferenceSearchQuery({ repos: [origin], kind: 'issue', state: 'all', people: 'any', text: '' }))
      .toBe('repo:acme/app is:issue sort:updated-desc');
  });

  it('reads issue-only nonsense as the nearest list: merged as closed, review requests as anyone', () => {
    expect(buildReferenceSearchQuery({ repos: [origin], kind: 'issue', state: 'merged', people: 'reviewRequested', text: '' }))
      .toBe('repo:acme/app is:issue is:closed sort:updated-desc');
  });

  it('leaves state and sort to the user when their text sets them', () => {
    expect(buildReferenceSearchQuery({ repos: [origin], kind: 'issue', state: 'open', people: 'assigned', text: 'is:closed sort:created-asc' }))
      .toBe('repo:acme/app is:issue assignee:@me is:closed sort:created-asc');
  });

  it('searches discussions as their own type: no kind, unanswered as open questions, no assignee', () => {
    expect(buildReferenceSearchQuery({ repos: [origin], kind: 'discussion', state: 'unanswered', people: 'assigned', text: '' }))
      .toBe('repo:acme/app is:open is:unanswered sort:updated-desc');
    expect(buildReferenceSearchQuery({ repos: [origin], kind: 'discussion', state: 'closed', people: 'created', text: 'category:Ideas' }))
      .toBe('repo:acme/app is:closed sort:updated-desc author:@me category:Ideas');
    // Only a discussion is unanswered; elsewhere that reads as open.
    expect(buildReferenceSearchQuery({ repos: [origin], kind: 'issue', state: 'unanswered', people: 'any', text: '' }))
      .toBe('repo:acme/app is:issue is:open sort:updated-desc');
    expect(buildReferenceSearchQuery({ repos: [origin], kind: 'discussion', state: 'open', people: 'any', text: 'is:answered' }))
      .toBe('repo:acme/app sort:updated-desc is:answered');
  });

  it('reads unknown values as open and anyone', () => {
    expect(readReferenceState('everything')).toBe('open');
    expect(readReferenceState('merged')).toBe('merged');
    expect(readReferenceState('unanswered')).toBe('unanswered');
    expect(readReferencePeople('everyone')).toBe('any');
    expect(readReferencePeople('created')).toBe('created');
  });
});

describe('readPullStatusRefs', () => {
  it('reads `owner/repo#number` refs without a host as github.com', () => {
    expect(readPullStatusRefs('acme/app#1,  Upstream/App#42 ,acme/app#1')).toEqual([
      { owner: 'acme', repo: 'app', number: 1 },
      { owner: 'Upstream', repo: 'App', number: 42 },
    ]);
  });

  it('carries an enterprise host, normalised, and keeps same-numbered refs on different hosts apart', () => {
    expect(readPullStatusRefs('acme/app#1@GHE.Example.com')).toEqual([{ owner: 'acme', repo: 'app', number: 1, host: 'ghe.example.com' }]);
    expect(readPullStatusRefs('acme/app#1@ghe.example.com,acme/app#1')).toEqual([
      { owner: 'acme', repo: 'app', number: 1, host: 'ghe.example.com' },
      { owner: 'acme', repo: 'app', number: 1 },
    ]);
  });

  it('treats an explicit github.com host as the default', () => {
    expect(readPullStatusRefs('acme/app#1@github.com,acme/app#2@github.com')).toEqual([
      { owner: 'acme', repo: 'app', number: 1 },
      { owner: 'acme', repo: 'app', number: 2 },
    ]);
  });

  it('rejects an empty, malformed, or oversized list', () => {
    expect(readPullStatusRefs('')).toBeNull();
    expect(readPullStatusRefs('acme/app#x')).toBeNull();
    expect(readPullStatusRefs('acme/app')).toBeNull();
    expect(readPullStatusRefs('acme/app#1@a@b')).toBeNull();
    expect(readPullStatusRefs(Array.from({ length: 31 }, (_, index) => `acme/app#${index + 1}`).join(','))).toBeNull();
  });
});
describe('searchGitHubReferencesAcross', () => {
  const entries = Array.from({ length: 85 }, (_value, index) => ({ owner: 'acme', repo: `repo${index}`, source: 'origin', directory: `/folder/${index}` }));
  const node = (number, repo, updatedAt) => ({ __typename: 'Issue', ...common(number, { name: repo, owner: { login: 'acme' } }), updatedAt, state: 'OPEN', stateReason: null });
  const options = { kind: 'issue', state: 'open', people: 'any', text: '', onGroupError: async (_group, error) => { throw error; } };

  it('chunks at 40 repos, merges pages, and resumes only unfinished searches with stable totals', async () => {
    const calls = [];
    let active = 0;
    let maximum = 0;
    const octokit = { graphql: async (_query, variables) => {
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      calls.push(variables);
      active--;
      const firstRepo = variables.q.match(/repo:acme\/(repo\d+)/)[1];
      const ongoing = firstRepo === 'repo0' && !variables.after;
      return { search: { issueCount: 10, pageInfo: { hasNextPage: ongoing, endCursor: ongoing ? 'next' : null },
        nodes: [node(Number(firstRepo.slice(4)) + 1, firstRepo, firstRepo === 'repo0' ? '2026-01-01' : '2026-02-01')],
      } };
    } };
    const groups = [{ accountId: 'a', octokit, repos: entries }];
    const page = await searchGitHubReferencesAcross({ ...options, groups });
    expect(calls.map((call) => call.q.match(/repo:/g).length)).toEqual([40, 40, 5]);
    expect(maximum).toBeLessThanOrEqual(4);
    expect(page.items.map((item) => item.number)).toEqual([41, 81, 1]);
    expect(page.items[0].directory).toBe('/folder/40');
    expect(page.total).toBe(30);
    expect(page.hasMore).toBe(true);
    const next = await searchGitHubReferencesAcross({ ...options, groups, cursor: page.cursor });
    expect(calls).toHaveLength(4);
    expect(calls[3].after).toBe('next');
    expect(next).toMatchObject({ total: 30, hasMore: false, cursor: null });
    for (const cursor of ['bad!', Buffer.from('{}').toString('base64url'), Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(page.cursor, 'base64url')), extra: true })).toString('base64url')]) {
      await expect(searchGitHubReferencesAcross({ ...options, groups, cursor })).rejects.toMatchObject({ status: 400 });
    }
    await expect(searchGitHubReferencesAcross({ ...options, groups, text: 'changed', cursor: page.cursor })).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(4);
  });

  it('looks up numbers across many repos in bounded documents and URLs only in their repository', async () => {
    const calls = [];
    const octokit = { graphql: async (_query, variables) => {
      calls.push(variables);
      return Object.fromEntries(Object.keys(variables).filter((key) => /^n\d+$/.test(key)).map((key) => [
        `a${key.slice(1)}`, { issueOrPullRequest: node(7, variables[key], '2026-02-01') },
      ]));
    } };
    const groups = [{ accountId: 'a', octokit, repos: entries }];
    const page = await searchGitHubReferencesAcross({ ...options, groups, text: '#7' });
    expect(page).toMatchObject({ total: 85, hasMore: false, cursor: null });
    expect(calls.map((call) => Object.keys(call).filter((key) => /^n\d+$/.test(key)).length)).toEqual([40, 40, 5]);
    calls.length = 0;
    const url = await searchGitHubReferencesAcross({ ...options, groups, text: 'https://github.com/acme/repo41/issues/7' });
    expect(url.items).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].n0).toBe('repo41');
  });

  it('keeps every page newest first, holding back what a quieter search read until the busier one passes it', async () => {
    const calls = [];
    const pagesOf = {
      repo0: { null: { more: 'a2', nodes: [node(1, 'repo0', '2026-10-05'), node(2, 'repo0', '2026-10-04')] }, a2: { more: null, nodes: [node(3, 'repo0', '2026-10-03')] } },
      repo1: { null: { more: null, nodes: [node(4, 'repo1', '2026-10-01'), node(5, 'repo1', '2026-09-01')] } },
    };
    const octokit = (repo) => ({ graphql: async (_query, variables) => {
      calls.push(`${repo}:${variables.after}`);
      const page = pagesOf[repo][String(variables.after)];
      return { search: { issueCount: page.nodes.length, pageInfo: { hasNextPage: page.more !== null, endCursor: page.more }, nodes: page.nodes } };
    } });
    const groups = [
      { accountId: 'a', octokit: octokit('repo0'), repos: entries.slice(0, 1) },
      { accountId: 'b', octokit: octokit('repo1'), repos: entries.slice(1, 2) },
    ];
    const first = await searchGitHubReferencesAcross({ ...options, groups });
    expect(first.items.map((item) => item.number)).toEqual([1, 2]);
    expect(first.hasMore).toBe(true);
    const second = await searchGitHubReferencesAcross({ ...options, groups, cursor: first.cursor });
    expect(second.items.map((item) => item.number)).toEqual([3, 4, 5]);
    expect(second).toMatchObject({ hasMore: false, cursor: null });
    expect(calls).toEqual(['repo0:null', 'repo1:null', 'repo0:a2', 'repo1:null']);
  });

  it('pins a single search to its query too, and rejects a bare GitHub cursor', async () => {
    const octokit = { graphql: async (_query, variables) => ({ search: {
      issueCount: 31, pageInfo: { hasNextPage: !variables.after, endCursor: variables.after ? null : 'next' }, nodes: [node(variables.after ? 3 : 1, 'repo0', '2026-01-01')],
    } }) };
    const groups = [{ accountId: 'a', octokit, repos: entries.slice(0, 1) }];
    const first = await searchGitHubReferencesAcross({ ...options, groups });
    expect(first).toMatchObject({ hasMore: true, total: 31 });
    const second = await searchGitHubReferencesAcross({ ...options, groups, cursor: first.cursor });
    expect(second.items.map((item) => item.number)).toEqual([3]);
    await expect(searchGitHubReferencesAcross({ ...options, groups, cursor: 'next' })).rejects.toMatchObject({ status: 400 });
    await expect(searchGitHubReferencesAcross({ ...options, groups: [...groups, { accountId: 'b', octokit, repos: entries.slice(1, 2) }], cursor: first.cursor }))
      .rejects.toMatchObject({ status: 400 });
  });
});


describe('parseReferenceLookup', () => {
  it('looks a number up in every repo of the network', () => {
    expect(parseReferenceLookup('#42', repos)).toEqual({ number: 42, repos, family: 'item' });
    expect(parseReferenceLookup(' 42 ', repos)).toEqual({ number: 42, repos, family: 'item' });
    // The discussions list reads a number as a discussion.
    expect(parseReferenceLookup('#42', repos, 'discussion')).toEqual({ number: 42, repos, family: 'discussion' });
  });

  it('looks a link up only in its own repo, whatever its kind', () => {
    expect(parseReferenceLookup('https://github.com/upstream/app/pull/7/files', repos)).toEqual({ number: 7, repos: [upstream], family: 'item' });
    expect(parseReferenceLookup('github.com/acme/app/issues/3', repos)).toEqual({ number: 3, repos: [origin], family: 'item' });
    expect(parseReferenceLookup('https://github.com/other/repo/issues/3', repos)).toEqual({ number: 3, repos: [], family: 'item' });
  });

  it('looks a discussion link up only in the discussions list, and searches a link of the other family as text', () => {
    expect(parseReferenceLookup('https://github.com/acme/app/discussions/5#discussioncomment-1', repos, 'discussion'))
      .toEqual({ number: 5, repos: [origin], family: 'discussion' });
    expect(parseReferenceLookup('https://github.com/acme/app/discussions/5', repos)).toBeNull();
    expect(parseReferenceLookup('https://github.com/acme/app/issues/5', repos, 'discussion')).toBeNull();
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

  it('maps a discussion with its category, close reason and answer', () => {
    const node = (number, overrides = {}) => ({
      __typename: 'Discussion',
      ...common(number),
      url: `https://github.com/acme/app/discussions/${number}`,
      closed: false,
      stateReason: null,
      isAnswered: false,
      locked: false,
      upvoteCount: 3,
      category: { name: 'Q&A', emojiHTML: '<div>🙏</div>', isAnswerable: true },
      ...overrides,
    });
    expect(toReference(node(5), repos)).toMatchObject({
      kind: 'discussion',
      number: 5,
      url: 'https://github.com/acme/app/discussions/5',
      state: 'open',
      answered: false,
      upvotes: 3,
      locked: false,
      category: { name: 'Q&A', emoji: '🙏', answerable: true },
      commentCount: 4,
    });
    // A category that takes no answers says nothing about one, and HTML that is no emoji is dropped.
    expect(toReference(node(6, { isAnswered: null, category: { name: 'Ideas', emojiHTML: '<div><img src=x></div>', isAnswerable: false } }), repos))
      .toMatchObject({ answered: null, category: { name: 'Ideas', emoji: null, answerable: false } });
    expect(toReference(node(7, { closed: true, stateReason: 'OUTDATED' }), repos)?.state).toBe('outdated');
    expect(toReference(node(8, { closed: true, stateReason: 'DUPLICATE' }), repos)?.state).toBe('duplicate');
    // Closed before GitHub kept reasons: resolved, GitHub's default.
    expect(toReference(node(9, { closed: true, stateReason: null }), repos)?.state).toBe('resolved');
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
  const pull = (reviews = [], threads = []) => ({
    __typename: 'PullRequest',
    number: 9,
    state: 'OPEN',
    reviewDecision: 'CHANGES_REQUESTED',
    headCommit: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
      { __typename: 'CheckRun', databaseId: 1, name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: null, checkSuite: { app: { databaseId: 15368 } } },
      { __typename: 'CheckRun', databaseId: 2, name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: null, checkSuite: { app: { databaseId: 15368 } } },
    ] } } } }] },
    reviewRequests: { nodes: [
      { requestedReviewer: { __typename: 'User', login: 'hubot', avatarUrl: null } },
      { requestedReviewer: { __typename: 'Team' } },
      { requestedReviewer: null },
    ] },
    additions: 12,
    deletions: 3,
    changedFiles: 2,
    comments: { totalCount: 1, nodes: [{ author, body: 'first', createdAt: '2026-10-01T10:00:00Z', url: 'u1' }] },
    commits: { totalCount: 1, nodes: [{ commit: {
      oid: 'abc1234', messageHeadline: 'fix: the thing', committedDate: '2026-10-01T08:00:00Z', url: 'https://github.com/acme/app/commit/abc1234',
      author: { name: 'Octo Cat', user: author },
    } }] },
    reviews: { nodes: reviews },
    reviewThreads: { nodes: threads },
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

  it('merges a PR review into its comments, oldest first, with size and review', async () => {
    const detail = await fetchReferenceDetail({ octokit: graphqlReturning(pull([
      { author, body: '', state: 'COMMENTED', createdAt: '2026-10-01T09:00:00Z', url: 'r1' },
      { author, body: '', state: 'APPROVED', createdAt: '2026-10-01T11:00:00Z', url: 'r2' },
    ], [{
      id: 'PRRT_one', isResolved: false, viewerCanResolve: true, viewerCanUnresolve: false, viewerCanReply: true,
      comments: { nodes: [{ author, body: 'nit', createdAt: '2026-10-01T09:00:00Z', url: 'c1', path: 'src/a.ts', line: null, originalLine: 7 }] },
    }])), owner: 'acme', repo: 'app', number: 9 });
    expect(detail?.comments.map((comment) => [comment.body, comment.review, comment.path, comment.line])).toEqual([
      ['nit', 'commented', 'src/a.ts', 7],
      ['first', null, null, null],
      ['', 'approved', null, null],
    ]);
    expect(detail?.pull).toEqual({
      reviewDecision: 'changes_requested',
      reviewers: [{ id: 'hubot', login: 'hubot', avatarUrl: undefined }],
      checks: expect.objectContaining({ state: 'failure', total: 2, success: 1, failure: 1 }),
      additions: 12,
      deletions: 3,
      changedFiles: 2,
      commits: [{
        sha: 'abc1234',
        headline: 'fix: the thing',
        author: { login: 'octo', avatarUrl: 'https://avatars/octo' },
        authorName: 'Octo Cat',
        committedAt: '2026-10-01T08:00:00Z',
        url: 'https://github.com/acme/app/commit/abc1234',
      }],
      commitTotal: 1,
      stack: null,
    });
  });

  it('reads the stack a PR is a layer of, bottom first, and leaves it unknown where the host has none', async () => {
    const layer = (number, position, state = 'OPEN') => ({
      position,
      pullRequest: { number, title: `Layer ${number}`, url: `https://github.com/acme/app/pull/${number}`, state, isDraft: false, headRefName: `layer-${number}` },
    });
    const stacked = { ...pull(), stack: { number: 4, baseRefName: 'main', entries: { nodes: [layer(12, 2), layer(11, 1, 'MERGED'), layer(13, 3)] } } };
    const detail = await fetchReferenceDetail({ octokit: graphqlReturning(stacked), owner: 'acme', repo: 'app', number: 12 });
    expect(detail?.pull?.stack).toEqual({
      number: 4,
      base: 'main',
      layers: [
        { number: 11, title: 'Layer 11', url: 'https://github.com/acme/app/pull/11', state: 'merged', draft: false, head: 'layer-11' },
        { number: 12, title: 'Layer 12', url: 'https://github.com/acme/app/pull/12', state: 'open', draft: false, head: 'layer-12' },
        { number: 13, title: 'Layer 13', url: 'https://github.com/acme/app/pull/13', state: 'open', draft: false, head: 'layer-13' },
      ],
    });

    // An older GitHub Enterprise Server has no stacks: the detail still answers.
    const octokit = {
      graphql: async (query) => {
        if (query.includes('PullStack')) throw new Error("Field 'stack' doesn't exist on type 'PullRequest'");
        return { repository: { issueOrPullRequest: pull() } };
      },
    };
    const withoutStacks = await fetchReferenceDetail({ octokit, owner: 'acme', repo: 'app', number: 9 });
    expect(withoutStacks?.pull).not.toHaveProperty('stack');
    expect(withoutStacks?.pull?.additions).toBe(12);
  });

  it('reads a review thread as its first comment with the replies under it', async () => {
    const detail = await fetchReferenceDetail({ octokit: graphqlReturning(pull([], [{
      id: 'PRRT_two', isResolved: true, viewerCanResolve: false, viewerCanUnresolve: true, viewerCanReply: true,
      comments: { nodes: [
        { author, body: 'rename this', createdAt: '2026-10-01T09:00:00Z', url: 'c1', path: 'src/a.ts', line: 3, originalLine: 3 },
        { author: null, body: 'done', createdAt: '2026-10-01T10:00:00Z', url: 'c2', path: 'src/a.ts', line: 3, originalLine: 3 },
      ] },
    }])), owner: 'acme', repo: 'app', number: 9 });
    const opener = detail?.comments.find((comment) => comment.url === 'c1');
    expect(opener?.thread).toEqual({
      id: 'PRRT_two',
      resolved: true,
      // A resolved thread is reopened, so that is the permission that counts.
      canResolve: true,
      canReply: true,
      replies: [{ author: null, body: 'done', createdAt: '2026-10-01T10:00:00Z', url: 'c2', path: 'src/a.ts', line: 3, review: 'commented' }],
    });
    expect(detail?.comments.some((comment) => comment.url === 'c2')).toBe(false);
  });

  it('carries the lines a review comment sits on, read from the end of its hunk', async () => {
    const diffHunk = '@@ -10,4 +10,5 @@ export function run() {\n   const a = 1;\n-  const b = 2;\n+  const b = 3;\n+  const c = 4;\n   return a;';
    const detail = await fetchReferenceDetail({ octokit: graphqlReturning(pull([], [{
      id: 'PRRT_three', isResolved: false, viewerCanResolve: true, viewerCanUnresolve: false, viewerCanReply: true,
      comments: { nodes: [
        { author, body: '```suggestion\n  const c = 5;\n```', createdAt: '2026-10-01T09:00:00Z', url: 'c1', path: 'src/a.ts', line: 13, originalLine: 13, startLine: 12, originalStartLine: 12, diffHunk },
      ] },
    }])), owner: 'acme', repo: 'app', number: 9 });
    expect(detail?.comments.find((comment) => comment.url === 'c1')?.excerpt).toEqual({ startLine: 12, lines: ['  const c = 4;', '  return a;'] });
  });

  it('leaves the excerpt out where the hunk does not cover the comment', () => {
    const base = { line: 5, originalLine: 5, startLine: null, originalStartLine: null };
    expect(reviewCommentExcerpt({ ...base, diffHunk: null })).toBeUndefined();
    expect(reviewCommentExcerpt({ ...base, startLine: 1, diffHunk: '@@ -1 +1 @@\n+only' })).toBeUndefined();
    expect(reviewCommentExcerpt({ ...base, diffHunk: 'not a hunk' })).toBeUndefined();
    // An outdated comment reads its original range.
    expect(reviewCommentExcerpt({ line: null, originalLine: 2, startLine: null, originalStartLine: null, diffHunk: '@@ -1,2 +1,2 @@\n one\n+two' }))
      .toEqual({ startLine: 2, lines: ['two'] });
  });

  it('answers null for a missing number', async () => {
    expect(await fetchReferenceDetail({ octokit: graphqlReturning(null), owner: 'acme', repo: 'app', number: 9 })).toBeNull();
  });
});

describe('discussions', () => {
  const author = { login: 'octo', avatarUrl: 'https://avatars/octo' };
  const comment = (id, overrides = {}) => ({
    id, author, body: `comment ${id}`, createdAt: '2026-10-01T10:00:00Z', url: `u-${id}`,
    isAnswer: false, viewerCanMarkAsAnswer: true, viewerCanUnmarkAsAnswer: false, replies: { nodes: [] }, ...overrides,
  });
  const discussion = (overrides = {}) => ({
    number: 5, locked: false, viewerCanUpdate: false, viewerCanClose: true, viewerCanReopen: true,
    category: { isAnswerable: true },
    comments: { totalCount: 2, nodes: [
      comment('DC_1', { isAnswer: true, viewerCanMarkAsAnswer: false, viewerCanUnmarkAsAnswer: true, replies: { nodes: [{ author: null, body: 'thanks', createdAt: null, url: 'r1' }] } }),
      comment('DC_2'),
    ] },
    ...overrides,
  });
  const graphqlReturning = (value) => ({ graphql: async () => ({ repository: { discussion: value } }) });

  it('reads each comment as a thread of its replies, with whether it is the answer and may be changed', async () => {
    const detail = await fetchDiscussionDetail({ octokit: graphqlReturning(discussion()), owner: 'acme', repo: 'app', number: 5 });
    expect(detail).toEqual({
      number: 5,
      comments: [
        {
          author, body: 'comment DC_1', createdAt: '2026-10-01T10:00:00Z', url: 'u-DC_1', path: null, line: null, review: null,
          thread: { id: 'DC_1', resolved: false, canResolve: false, canReply: true, replies: [
            { author: null, body: 'thanks', createdAt: null, url: 'r1', path: null, line: null, review: null },
          ] },
          answer: { chosen: true, canChange: true },
        },
        {
          author, body: 'comment DC_2', createdAt: '2026-10-01T10:00:00Z', url: 'u-DC_2', path: null, line: null, review: null,
          thread: { id: 'DC_2', resolved: false, canResolve: false, canReply: true, replies: [] },
          answer: { chosen: false, canChange: true },
        },
      ],
      commentTotal: 2,
      pull: null,
      discussion: { canComment: true, canClose: true, canReopen: true },
    });
  });

  it('takes no answers outside a Q&A category and no comments on a locked one from who may not update it', async () => {
    const detail = await fetchDiscussionDetail({
      octokit: graphqlReturning(discussion({ locked: true, category: { isAnswerable: false } })), owner: 'acme', repo: 'app', number: 5,
    });
    expect(detail.comments.every((entry) => entry.answer === undefined && entry.thread.canReply === false)).toBe(true);
    expect(detail.discussion.canComment).toBe(false);
    await expect(fetchDiscussionDetail({ octokit: graphqlReturning(null), owner: 'acme', repo: 'app', number: 5 })).resolves.toBeNull();
  });

  it('lists discussions with the discussion search, and looks a number up as a discussion', async () => {
    const queries = [];
    const node = { __typename: 'Discussion', ...common(5), closed: false, stateReason: null, isAnswered: null, locked: false, upvoteCount: 0,
      category: { name: 'Ideas', emojiHTML: '<div>💡</div>', isAnswerable: false } };
    const octokit = {
      graphql: async (query, variables) => {
        queries.push({ query, variables });
        if (query.includes('ReferenceLookup')) return { a0: { discussion: node }, a1: { discussion: null } };
        return { search: { discussionCount: 41, pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [node] } };
      },
    };
    const page = await searchGitHubReferences({ octokit, repos, kind: 'discussion', state: 'open', people: 'any', text: '', cursor: null });
    expect(page).toMatchObject({ cursor: 'c1', hasMore: true, total: 41 });
    expect(page.items.map((item) => [item.kind, item.number])).toEqual([['discussion', 5]]);
    expect(queries[0].query).toContain('type: DISCUSSION');
    expect(queries[0].query).not.toContain('IssueReference');

    const lookup = await searchGitHubReferences({ octokit, repos, kind: 'discussion', state: 'open', people: 'any', text: '#5', cursor: null });
    expect(lookup.items.map((item) => item.number)).toEqual([5]);
    expect(queries[1].query).toContain('discussion(number: $number)');
    expect(queries[1].query).not.toContain('issueOrPullRequest');
  });
});
