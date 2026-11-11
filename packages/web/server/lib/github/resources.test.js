import { describe, expect, spyOn, test, vi } from 'bun:test';

import { createGitHubResources } from './resources.js';
import { isGitHubRateLimitError } from './rate-limit.js';
import { matchesGitHubRepositoryUrl } from './mappers.js';

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
  user: { login: 'contributor' },
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-02T00:00:00Z',
};

const httpError = (status, message) => Object.assign(new Error(message), {
  status,
  response: { status, data: { message } },
});

const makeResources = (permission) => createGitHubResources({
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
      rest: {
        pulls: { get: async () => ({ data: openPull }) },
        checks: {
          listForRef: async () => { throw httpError(500, 'checks unavailable'); },
        },
        repos: {
          getCombinedStatusForRef: async () => { throw httpError(500, 'statuses unavailable'); },
          getCollaboratorPermissionLevel: permission,
        },
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

describe('enterprise repository search', () => {
  test.each([
    ['company.ghe.com', 'https://api.company.ghe.com/repos/acme/app'],
    ['github.example.com', 'https://github.example.com/api/v3/repos/acme/app'],
    ['github.com', 'https://api.github.com/repos/acme/app'],
  ])('reads an issue from the API of %s and rejects another host', async (instance, repositoryUrl) => {
    let resultUrl = repositoryUrl;
    const get = vi.fn(async () => ({ data: { number: 7, title: 'Issue', html_url: `https://${instance}/acme/app/issues/7`, state: 'open' } }));
    const resources = createGitHubResources({
      accountOf: () => ({ octokit: { rest: { search: { issuesAndPullRequests: async () => ({ data: {
        total_count: 1, items: [{ number: 7, repository_url: resultUrl }],
      } }) }, issues: { get } } } }),
      resolveRepo: async () => ({ repo: { owner: 'acme', repo: 'app', host: instance } }),
      resolveNetwork: async () => null,
    });
    const input = { session: { ...session, instance }, directory: '/repo', page: 1, query: 'issue', remote: 'origin' };
    expect((await resources.listIssues(input)).items[0]).toMatchObject({ number: 7, instance });
    resultUrl = 'https://attacker.example/repos/acme/app';
    await expect(resources.listIssues(input)).rejects.toMatchObject({ code: 'MALFORMED_PROVIDER_RESPONSE' });
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe('enterprise pull request worktree source', () => {
  test.each([
    ['git@ssh.company.ghe.com:alice/app.git', true],
    ['aliceuser@ssh.company.ghe.com:alice/app.git', true],
    ['ssh://aliceuser@ssh.company.ghe.com/alice/app.git', true],
    ['ssh://ssh.company.ghe.com/alice/app.git', false],
    ['aliceuser@ssh.company.ghe.com:other/app.git', false],
    ['https://aliceuser@company.ghe.com/alice/app.git', false],
  ])('validates the SSH repository URL %s', (url, expected) => {
    expect(matchesGitHubRepositoryUrl(url, 'alice', 'app')).toBe(expected);
  });

  test('accepts the head on the bound host and refuses a clone on another host', async () => {
    const instance = 'company.ghe.com';
    const head = {
      ref: 'feature', sha: 'a'.repeat(40), repo: { owner: { login: 'alice' }, name: 'app',
        html_url: `https://${instance}/alice/app`, clone_url: `https://${instance}/alice/app.git`,
        ssh_url: 'aliceuser@ssh.company.ghe.com:alice/app.git' },
    };
    const resources = createGitHubResources({
      accountOf: () => ({ octokit: { rest: { pulls: { get: async () => ({ data: {
        number: 7, title: 'PR', html_url: `https://${instance}/acme/app/pull/7`, state: 'open', base: { ref: 'main' }, head,
      } }) } } } }),
      resolveRepo: async () => ({ repo: { owner: 'acme', repo: 'app', host: instance } }),
      resolveNetwork: async () => null,
    });
    const input = { session: { ...session, instance }, context: { directory: '/repo', primaryRemote: 'origin' },
      project: { id: 'acme/app', owner: 'acme', name: 'app' }, number: 7, expectedHeadSha: head.sha, requestedRemoteName: 'pr-alice' };
    expect(await resources.resolveChangeRequestSource(input)).toMatchObject({ endpoint: `https://${instance}/alice/app.git`, headSha: head.sha });
    head.repo.clone_url = 'https://other.example/alice/app.git';
    await expect(resources.resolveChangeRequestSource(input)).rejects.toMatchObject({ code: 'MALFORMED_PROVIDER_RESPONSE' });
  });
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
