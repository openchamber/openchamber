import { describe, expect, spyOn, test, vi } from 'bun:test';

import { createGitHubResources, gitHubRefusalMessage, responseError } from './resources.js';
import { isGitHubRateLimitError } from './rate-limit.js';

const openPull = {
  number: 42,
  state: 'open',
  merged: false,
  merged_at: null,
  title: 'Add a feature',
  html_url: 'https://github.com/acme/app/pull/42',
  body: '',
  draft: false,
  base: { ref: 'main' },
  head: { ref: 'feature', label: 'acme:feature' },
  user: { id: 2, login: 'contributor' },
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-02T00:00:00Z',
};

const httpError = (status, message) => Object.assign(new Error(message), {
  status,
  response: { status, data: { message } },
});

describe('resource error boundaries', () => {
  test('refusal messages retain inherited fields and unchecked fallback values', () => {
    const refusal = Object.create({ response: { data: { message: 'Provider refused' } } });
    expect(gitHubRefusalMessage(refusal)).toBe('Provider refused');
    expect(gitHubRefusalMessage({ response: { data: { message: ' ' } }, message: 17 })).toBe(17);
    expect(gitHubRefusalMessage(null)).toBeUndefined();
  });

  test('response errors preserve the original body while Error coerces its message', () => {
    const body = { error: 17, code: 'PROVIDER_FAILURE' };
    const failure = responseError(403, body);
    expect(failure.message).toBe('17');
    expect(failure.sourceControlResponse).toEqual({ status: 403, body });
    expect(failure.sourceControlResponse.body).toBe(body);
    expect(responseError(403, { error: undefined }).message).toBe('');
  });
});

const makeResources = (permission, octokit = {}) => createGitHubResources({
  load: async () => ({
    rateLimit: {
      isGitHubRateLimited: () => false,
      noteIfGitHubRateLimit: () => false,
      isGitHubRateLimitError,
    },
  }),
  accountOf: () => ({
    user: { login: 'octocat' },
    octokit: {
      graphql: octokit.graphql,
      rest: {
        pulls: { get: async () => ({ data: openPull }) },
        checks: {
          listForRef: async () => { throw httpError(500, 'checks unavailable'); },
        },
        repos: {
          getCombinedStatusForRef: async () => { throw httpError(500, 'statuses unavailable'); },
          getCollaboratorPermissionLevel: permission,
        },
        ...(octokit.rest ?? {}),
      },
    },
  }),
  resolveRepo: async () => ({ repo: { owner: 'acme', repo: 'app', host: 'github.com' } }),
  resolveNetwork: async () => null,
  resolvePrStatus: async () => ({
    repo: { owner: 'acme', repo: 'app', host: 'github.com' },
    pr: openPull,
    defaultBranch: 'main',
    resolvedRemoteName: 'origin',
  }),
  readContributorProvenance: undefined,
  invalidateAccount: () => {},
});

const session = { instance: 'github.com', accountId: 'acct', credentialRevision: 'cred-1' };
// Six minutes: past the five-minute refusal TTL, without importing the
// module's private constant.
const CAN_MERGE_TEST_OFFSET_MS = 6 * 60_000;
const readStatus = (resources, accountId = session.accountId) => resources.changeRequestStatus({
  session: { ...session, accountId }, directory: '/repo', branch: 'feature', remote: 'origin',
});

describe('changeRequestStatus merge permission', () => {
  test('a refused merge permission is remembered instead of re-asked on every poll (#5954)', async () => {
    const permission = vi.fn(async () => {
      throw httpError(403, 'Must have admin access to repository');
    });
    const resources = makeResources(permission);

    const first = await readStatus(resources);
    expect(first.canMerge).toBe(false);
    expect(permission).toHaveBeenCalledTimes(1);

    const second = await readStatus(resources);
    expect(second.canMerge).toBe(false);
    // The refusal is remembered per host, account and repository: the second
    // poll never reaches GitHub again, which is the log noise the issue reports.
    expect(permission).toHaveBeenCalledTimes(1);
  });

  test('an allowed permission still answers true', async () => {
    const permission = vi.fn(async () => ({ data: { permission: 'admin' } }));
    const resources = makeResources(permission);

    const first = await readStatus(resources);
    expect(first.canMerge).toBe(true);
    expect(permission).toHaveBeenCalledTimes(1);
  });

  test('a non-refusal failure is not remembered', async () => {
    const permission = vi.fn(async () => { throw httpError(502, 'bad gateway'); });
    const resources = makeResources(permission);

    const first = await readStatus(resources);
    expect(first.canMerge).toBe(false);
    const second = await readStatus(resources);
    expect(second.canMerge).toBe(false);
    // A transient failure asks again: only a 403 refusal is stable.
    expect(permission).toHaveBeenCalledTimes(2);
  });

  test('a rate-limit 403 is not remembered as a refusal (#5954)', async () => {
    // Quota exhaustion lands on the permission check (the last GitHub call of
    // a status read) and lifts within minutes; memoizing it would pin a wrong
    // canMerge for the whole TTL, including after the limit clears.
    const permission = vi.fn(async () => {
      throw Object.assign(new Error('rate limit exceeded'), {
        status: 403,
        response: { status: 403, headers: { 'x-ratelimit-remaining': '0' } },
      });
    });
    const resources = makeResources(permission);

    const first = await readStatus(resources);
    expect(first.canMerge).toBe(false);
    const second = await readStatus(resources);
    expect(second.canMerge).toBe(false);
    expect(permission).toHaveBeenCalledTimes(2);
  });

  test('a grant is picked up once the refusal window has passed', async () => {
    const permission = vi.fn()
      .mockRejectedValueOnce(httpError(403, 'Must have admin access to repository'))
      .mockResolvedValue({ data: { permission: 'admin' } });
    const resources = makeResources(permission);

    const refused = await readStatus(resources);
    expect(refused.canMerge).toBe(false);

    // Inside the window the memo answers without asking GitHub: the log
    // noise the issue reports stays silent even though the mock now grants.
    const cached = await readStatus(resources);
    expect(cached.canMerge).toBe(false);
    expect(permission).toHaveBeenCalledTimes(1);

    // Past the window the next read asks again, and a successful check
    // clears the refusal for good. A re-login clears it sooner, through the
    // credential revision in the key.
    const realNow = Date.now.bind(Date);
    let offsetMs = 0;
    const nowSpy = spyOn(Date, 'now').mockImplementation(() => realNow() + offsetMs);
    try {
      offsetMs = CAN_MERGE_TEST_OFFSET_MS;
      const granted = await readStatus(resources);
      expect(granted.canMerge).toBe(true);
      expect(permission).toHaveBeenCalledTimes(2);
      const staysGranted = await readStatus(resources);
      expect(staysGranted.canMerge).toBe(true);
      expect(permission).toHaveBeenCalledTimes(3);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('storing a refusal removes expired refusals for other accounts', async () => {
    let now = 1_000_000;
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    const stored = spyOn(Map.prototype, 'set');
    try {
      const permission = vi.fn(async () => { throw httpError(403, 'Forbidden'); });
      const resources = makeResources(permission);
      await readStatus(resources, 'expired-account');
      const index = stored.mock.calls.findIndex(([key]) => key === JSON.stringify([
        'github.com', 'expired-account', 'cred-1', 'acme', 'app',
      ]));
      const refusals = stored.mock.contexts[index];
      expect(refusals.size).toBe(1);
      now += 5 * 60_000;
      await readStatus(resources, 'fresh-account');
      expect(refusals.size).toBe(1);
      expect([...refusals.keys()]).toEqual([JSON.stringify([
        'github.com', 'fresh-account', 'cred-1', 'acme', 'app',
      ])]);
    } finally {
      stored.mockRestore();
      clock.mockRestore();
    }
  });

  test('refusals retain at most 1000 entries and evict the oldest first', async () => {
    const clock = spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      const permission = vi.fn(async () => { throw httpError(403, 'Forbidden'); });
      const resources = makeResources(permission);
      for (let index = 0; index <= 1000; index += 1) {
        await readStatus(resources, `account-${index}`);
      }
      expect(permission).toHaveBeenCalledTimes(1001);
      await readStatus(resources, 'account-1');
      await readStatus(resources, 'account-1000');
      expect(permission).toHaveBeenCalledTimes(1001);
      await readStatus(resources, 'account-0');
      expect(permission).toHaveBeenCalledTimes(1002);
    } finally {
      clock.mockRestore();
    }
  });
});

test('the GitHub picker looks up a pasted Enterprise PR URL in its named repository', async () => {
  const host = 'git.example.com';
  const repo = { owner: 'acme', repo: 'app', host };
  const url = `https://${host}/acme/app/pull/42`;
  const pull = {
    __typename: 'PullRequest', number: 42, title: 'Update the app', url, body: '',
    createdAt: openPull.created_at, updatedAt: openPull.updated_at,
    author: null, labels: null, comments: { totalCount: 0 }, headRepository: null,
    repository: { name: 'app', owner: { login: 'acme' } },
    state: 'OPEN', isDraft: false, headRefName: 'feature', baseRefName: 'main', headRefOid: 'abc',
  };
  const graphql = vi.fn(async (document) => document.includes('ReferenceLookup')
    ? { a0: { issueOrPullRequest: pull } }
    : { search: { issueCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } });
  const resources = createGitHubResources({
    load: async () => ({ rateLimit: { isGitHubRateLimited: () => false } }),
    accountOf: () => ({ octokit: { graphql } }),
    resolveRepo: async () => ({ repo }),
    resolveNetwork: async () => [{ ...repo, source: 'origin' }, { owner: 'upstream', repo: 'app', source: 'upstream' }],
  });
  const read = (query) => resources.references({ session, directory: '/repo', kind: 'pull', state: 'open', query });

  const result = await read(`${url}/files`);
  expect(result.items).toMatchObject([{ kind: 'pull', number: 42, url }]);
  expect(graphql).toHaveBeenCalledTimes(1);
  expect(graphql).toHaveBeenCalledWith(expect.stringContaining('ReferenceLookup'), { number: 42, o0: 'acme', n0: 'app' });

  graphql.mockClear();
  await read(`https://${host}/unrelated/app/pull/42`);
  expect(graphql).not.toHaveBeenCalled();
});

describe('listChangeRequests filters', () => {
  const makeListResources = () => {
    const list = vi.fn(async () => ({ data: [], headers: {} }));
    const search = vi.fn(async () => ({ data: { total_count: 0, items: [] } }));
    const resources = createGitHubResources({
      load: async () => ({
        rateLimit: {
          isGitHubRateLimited: () => false,
          noteIfGitHubRateLimit: () => false,
          isGitHubRateLimitError,
        },
      }),
      accountOf: () => ({
        user: { login: 'octocat' },
        octokit: { rest: { pulls: { list, get: async () => ({ data: openPull }) }, search: { issuesAndPullRequests: search } } },
      }),
      resolveRepo: async () => ({ repo: { owner: 'acme', repo: 'app', host: 'github.com' } }),
      resolveNetwork: async () => null,
      resolvePrStatus: async () => ({ repo: null }),
      readContributorProvenance: undefined,
      invalidateAccount: () => {},
    });
    return { resources, list, search };
  };
  const read = (resources, options = {}) => resources.listChangeRequests({
    session, directory: '/repo', page: 1, remote: 'origin', ...options,
  });

  test('reads the default open board view from the REST list', async () => {
    const { resources, list, search } = makeListResources();
    await read(resources);
    expect(search).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ state: 'open', per_page: 50, page: 1 }));
  });

  test('an unknown state or people value reads the default open board view', async () => {
    const { resources, list, search } = makeListResources();
    await read(resources, { state: 'everything', people: 'everyone' });
    expect(search).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ state: 'open' }));
  });

  test('a closed or all board view reads the REST list, which answers those states', async () => {
    const { resources, list, search } = makeListResources();
    await read(resources, { state: 'closed' });
    expect(search).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ state: 'closed', per_page: 50, page: 1 }));

    await read(resources, { state: 'all' });
    expect(search).not.toHaveBeenCalled();
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'all' }));
  });

  test('merged, labels, people and text still search, which is all the REST list cannot express', async () => {
    const merged = makeListResources();
    await read(merged.resources, { state: 'merged' });
    expect(merged.list).not.toHaveBeenCalled();
    expect(merged.search).toHaveBeenCalledWith(expect.objectContaining({ q: expect.stringContaining('is:merged') }));

    const labelled = makeListResources();
    await read(labelled.resources, { state: 'closed', labels: ['bug'] });
    expect(labelled.list).not.toHaveBeenCalled();
  });

  test('a board page narrowed by state, people or labels searches instead', async () => {
    const { resources, list, search } = makeListResources();
    await read(resources, { state: 'closed', people: 'reviewRequested', labels: ['bug'] });
    expect(list).not.toHaveBeenCalled();
    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      q: 'repo:acme/app is:pr is:closed sort:updated-desc review-requested:@me label:"bug"',
      per_page: 50,
      page: 1,
    }));
  });
});


describe('change request context reviews', () => {
  const resourcesWith = (reviews, requestedReviewers, graphql) => createGitHubResources({
    load: async () => ({
      rateLimit: { isGitHubRateLimited: () => false, noteIfGitHubRateLimit: () => false, isGitHubRateLimitError },
    }),
    accountOf: () => ({
      user: { login: 'octocat' },
      octokit: {
        graphql: graphql ?? (async () => ({ repository: { pullRequest: {
          reviews: { totalCount: reviews.length, nodes: reviews },
          latestOpinionatedReviews: { pageInfo: { hasNextPage: false }, nodes: [] },
          latestReviews: { pageInfo: { hasNextPage: false }, nodes: [] },
        } } })),
        rest: {
          pulls: {
            get: async () => ({ data: { ...openPull, user: { id: 1, login: 'contributor' }, requested_reviewers: requestedReviewers ?? [] } }),
            listReviewComments: async () => ({ data: [] }),
            listFiles: async () => ({ data: [] }),
          },
          issues: { listComments: async () => ({ data: [] }) },
          checks: { listForRef: async () => { throw httpError(500, 'checks unavailable'); } },
          repos: { getCombinedStatusForRef: async () => { throw httpError(500, 'statuses unavailable'); } },
        },
      },
    }),
    resolveRepo: async () => ({ repo: { owner: 'acme', repo: 'app', host: 'github.com' } }),
    resolveNetwork: async () => null,
    resolvePrStatus: async () => null,
    invalidateAccount: () => {},
  });

  const review = (id, login, state, createdAt, avatarUrl) => ({
    databaseId: id, author: { login, avatarUrl: avatarUrl ?? null }, body: '', state, createdAt, url: `r${id}`,
  });

  test('carries every submitted review of the newest page, newest first, dismissed included', async () => {
    const resources = resourcesWith([
      review(1, 'bob', 'APPROVED', '2026-10-01T10:00:00Z'),
      review(2, 'ann', 'DISMISSED', '2026-10-01T12:00:00Z', 'https://a/ann.png'),
      review(3, 'cid', 'PENDING', null),
      review(4, 'dee', 'SOMETHING_ELSE', null),
    ]);
    const context = await resources.changeRequestContext({
      session, context: {}, directory: '/repo', number: 42, includeDiff: false, includeCIDetails: false, includeTimeline: false,
    });

    expect(context.reviews).toEqual([
      { id: '2', state: 'dismissed', author: { login: 'ann', avatarUrl: 'https://a/ann.png' }, submittedAt: '2026-10-01T12:00:00Z' },
      { id: '1', state: 'approved', author: { login: 'bob', avatarUrl: undefined }, submittedAt: '2026-10-01T10:00:00Z' },
      { id: '3', state: 'pending', author: { login: 'cid', avatarUrl: undefined }, submittedAt: null },
    ]);
  });

  test('carries requested reviewers and one state per person without the timeline', async () => {
    const resources = resourcesWith([
      review(1, 'bob', 'APPROVED', '2026-10-01T10:00:00Z'),
      review(2, 'ann', 'DISMISSED', '2026-10-01T12:00:00Z', 'https://a/ann.png'),
      review(3, 'cid', 'PENDING', null),
    ], [
      { login: 'bob', avatar_url: 'https://a/bob.png' },
      { login: 'eve' },
      { login: 'ann' },
    ]);
    const read = (includeTimeline) => resources.changeRequestContext({
      session, context: {}, directory: '/repo', number: 42, includeDiff: false, includeCIDetails: false, includeTimeline,
    });

    const plain = await read(false);
    expect(plain.reviewers).toEqual([
      { provider: 'github', instance: 'github.com', id: 'bob', username: 'bob', avatarUrl: 'https://a/bob.png' },
      { provider: 'github', instance: 'github.com', id: 'eve', username: 'eve' },
      { provider: 'github', instance: 'github.com', id: 'ann', username: 'ann' },
    ]);
    // The dismissed review leaves its author pending; the unpublished draft says nothing.
    expect(plain.reviewerStates.map(({ user, state }) => [user.username, state])).toEqual([
      ['bob', 'approved'], ['ann', 'pending'], ['eve', 'pending'],
    ]);

    const timeline = await read(true);
    expect(timeline.reviewers).toEqual(plain.reviewers);
    expect(timeline.reviewerStates).toEqual(plain.reviewerStates);
  });

  test('a comment after an approval leaves the approval standing', async () => {
    const resources = resourcesWith([
      review(1, 'ann', 'CHANGES_REQUESTED', '2026-10-01T10:00:00Z'),
      review(2, 'bo', 'COMMENTED', '2026-10-01T11:00:00Z'),
      review(3, 'ann', 'COMMENTED', '2026-10-01T12:00:00Z'),
    ]);
    const context = await resources.changeRequestContext({
      session, context: {}, directory: '/repo', number: 42, includeDiff: false, includeCIDetails: false, includeTimeline: false,
    });

    expect(context.reviewerStates.map(({ user, state }) => [user.username, state])).toEqual([
      ['ann', 'changes_requested'], ['bo', 'commented'],
    ]);
  });

  test('a failed or unreadable reviews read keeps the requested reviewers without claiming a state', async () => {
    const read = (resources) => resources.changeRequestContext({
      session, context: {}, directory: '/repo', number: 42, includeDiff: false, includeCIDetails: false, includeTimeline: false,
    });
    const failed = await read(resourcesWith([], [{ login: 'eve' }], async () => { throw httpError(502, 'reviews unavailable'); }));
    expect(failed.changeRequest).toMatchObject({ number: 42 });
    expect(failed.reviewers.map((user) => user.username)).toEqual(['eve']);
    expect(failed).not.toHaveProperty('reviews');
    expect(failed).not.toHaveProperty('reviewerStates');

    const unreadable = await read(resourcesWith([{ databaseId: 9, state: 'APPROVED' }], [{ login: 'eve' }]));
    expect(unreadable).not.toHaveProperty('reviews');
    expect(unreadable).not.toHaveProperty('reviewerStates');

    const empty = await read(resourcesWith([], []));
    expect(empty.reviews).toEqual([]);
    expect(empty.reviewerStates).toEqual([]);
  });
});

const timelineIssue = {
  number: 1,
  title: 'First issue',
  html_url: 'https://github.com/acme/app/issues/1',
  state: 'open',
  user: { id: 1, login: 'octocat' },
  labels: [],
};

const crossReference = {
  createdAt: '2026-11-12T16:47:27Z',
  willCloseTarget: false,
  actor: { login: 'gaojunran' },
  source: {
    __typename: 'Issue',
    number: 5,
    title: 'Mentioning issue',
    url: 'https://github.com/acme/app/issues/5',
    repository: { nameWithOwner: 'acme/app' },
  },
};

const timelineGraphql = (nodes = [crossReference]) => vi.fn(async () => ({
  repository: { issueOrPullRequest: { timelineItems: { nodes } } },
}));

const timelineRest = () => ({
  issues: {
    get: async () => ({ data: timelineIssue }),
    listComments: async () => ({ data: [] }),
  },
  pulls: {
    get: async () => ({ data: openPull }),
    listReviewComments: async () => ({ data: [] }),
    listFiles: async () => ({ data: [] }),
    listReviews: async () => ({ data: [] }),
  },
});

const expectedReference = {
  kind: 'issue',
  number: 5,
  title: 'Mentioning issue',
  url: 'https://github.com/acme/app/issues/5',
  repo: 'acme/app',
  createdAt: '2026-11-12T16:47:27Z',
  willCloseTarget: false,
};

describe('GitHub timeline references', () => {
  test('an issue read carries references only when they are asked for', async () => {
    const graphql = timelineGraphql();
    const asked = makeResources(undefined, { graphql, rest: timelineRest() });
    const issue = await asked.getIssue({ session, directory: '/repo', number: 1, remote: 'origin', context: { repositoryId: 'repo-1', bindingRevision: 1 }, includeReferences: true });
    expect(issue.references).toHaveLength(1);
    expect(issue.references[0]).toMatchObject(expectedReference);
    expect(graphql).toHaveBeenCalledTimes(1);

    const quietGraphql = timelineGraphql();
    const quiet = makeResources(undefined, { graphql: quietGraphql, rest: timelineRest() });
    const plain = await quiet.getIssue({ session, directory: '/repo', number: 1, remote: 'origin', context: { repositoryId: 'repo-1', bindingRevision: 1 } });
    expect(plain).not.toHaveProperty('references');
    expect(quietGraphql).not.toHaveBeenCalled();
  });

  test('a change request context carries references only when they are asked for, never for the timeline alone', async () => {
    const graphql = timelineGraphql();
    const asked = makeResources(undefined, { graphql, rest: timelineRest() });
    const context = await asked.changeRequestContext({ session, directory: '/repo', number: 42, remote: 'origin', context: { repositoryId: 'repo-1', bindingRevision: 1 }, includeTimeline: true, includeReferences: true });
    expect(context.references).toHaveLength(1);
    expect(context.references[0]).toMatchObject(expectedReference);
    expect(graphql.mock.calls.filter(([query]) => String(query).includes('ReferenceLinks'))).toHaveLength(1);

    const quietGraphql = timelineGraphql();
    const quiet = makeResources(undefined, { graphql: quietGraphql, rest: timelineRest() });
    const plain = await quiet.changeRequestContext({ session, directory: '/repo', number: 42, remote: 'origin', context: { repositoryId: 'repo-1', bindingRevision: 1 }, includeTimeline: true });
    expect(plain).not.toHaveProperty('references');
    expect(quietGraphql.mock.calls.filter(([query]) => String(query).includes('ReferenceLinks'))).toHaveLength(0);
  });

  test('a failed timeline read leaves the item readable without references', async () => {
    const graphql = vi.fn(async () => { throw httpError(502, 'timeline unavailable'); });
    const resources = makeResources(undefined, { graphql, rest: timelineRest() });

    const issue = await resources.getIssue({ session, directory: '/repo', number: 1, remote: 'origin', context: { repositoryId: 'repo-1', bindingRevision: 1 }, includeReferences: true });
    expect(issue).toMatchObject({ number: 1, title: 'First issue' });
    expect(issue).not.toHaveProperty('references');

    const context = await resources.changeRequestContext({ session, directory: '/repo', number: 42, remote: 'origin', context: { repositoryId: 'repo-1', bindingRevision: 1 }, includeTimeline: true, includeReferences: true });
    expect(context.changeRequest).toMatchObject({ number: 42 });
    expect(context).not.toHaveProperty('references');
  });
});

describe('resolveChangeRequestSource classification', () => {
  const headSha = 'a'.repeat(40);
  const resolveSource = (headRepo) => createGitHubResources({
    load: async () => ({ rateLimit: { isGitHubRateLimited: () => false } }),
    accountOf: () => ({
      octokit: { rest: { pulls: { get: async () => ({ data: {
        ...openPull, user: { id: 1, login: 'contributor' }, head: { ref: 'feature', sha: headSha, repo: {
          name: headRepo.name, owner: { login: headRepo.owner },
          html_url: `https://git.example.com/${headRepo.owner}/${headRepo.name}`,
          clone_url: `https://git.example.com/${headRepo.owner}/${headRepo.name}.git`,
        } },
      } }) } } },
    }),
    resolveRepo: async () => ({ repo: { owner: 'acme', repo: 'app', host: 'git.example.com' } }),
    resolveNetwork: async () => [{ owner: 'acme', repo: 'app', source: 'origin' }],
  }).resolveChangeRequestSource({
    session: { ...session, instance: 'git.example.com' },
    context: { directory: '/repo', primaryRemote: 'origin' },
    project: { id: 'acme/app', owner: 'acme', name: 'app' },
    number: 42, expectedHeadSha: headSha, requestedRemoteName: 'origin',
  });

  test('a head GitHub spells differently from the remote is the same repository', async () => {
    expect(await resolveSource({ owner: 'Acme', name: 'App' })).toMatchObject({ classification: 'same-repository' });
  });

  test('a head in another repository is a contributor fork', async () => {
    expect(await resolveSource({ owner: 'someone', name: 'app' })).toMatchObject({ classification: 'contributor-fork' });
  });
});
