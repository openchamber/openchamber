import { describe, expect, test } from 'bun:test';

import {
  MAX_SUMMARY_REFS,
  fetchPrSummaries,
  isGraphqlRateLimitError,
  parseSummaryRefs,
  summarizeCheckContexts,
} from './pr-summaries.js';

const checkRun = (name, status, conclusion, startedAt, overrides = {}) => ({
  __typename: 'CheckRun',
  databaseId: Date.parse(startedAt),
  name,
  status,
  conclusion,
  startedAt,
  checkSuite: { app: { databaseId: 15368 } },
  ...overrides,
});

const prNode = (number, overrides = {}) => ({
  number,
  title: `PR ${number}`,
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  headRefOid: `sha-${number}`,
  commits: {
    nodes: [{
      commit: {
        statusCheckRollup: {
          contexts: {
            nodes: [
              checkRun('build', 'COMPLETED', 'SUCCESS', '2026-09-30T10:00:00Z'),
              checkRun('tests', 'COMPLETED', 'SUCCESS', '2026-09-30T10:00:00Z'),
            ],
          },
        },
      },
    }],
  },
  ...overrides,
});

// Answers every alias of a document from `nodes` (PRs) and `issues` (by
// number) and records how many refs each document carried.
const fakeOctokit = (nodes, { fail, issues = new Map() } = {}) => {
  const documents = [];
  return {
    documents,
    graphql: async (query, variables) => {
      const indexes = Object.keys(variables).filter((name) => name.startsWith('p')).map((name) => name.slice(1));
      documents.push(indexes.length);
      const data = Object.fromEntries(indexes.map((index) => {
        const number = variables[`p${index}`];
        if (query.includes(`issue(number: $p${index})`)) {
          const issue = issues.get(number) ?? null;
          return [`a${index}`, issue ? { issue } : null];
        }
        const node = nodes.get(number) ?? null;
        return [`a${index}`, node ? { pullRequest: node } : null];
      }));
      if (fail) {
        throw fail(data);
      }
      return data;
    },
  };
};

describe('parseSummaryRefs', () => {
  test('dedupes refs case-insensitively', () => {
    expect(parseSummaryRefs([
      { owner: 'Acme', repo: 'App', number: 7 },
      { owner: 'acme', repo: 'app', number: 7 },
      { owner: 'acme', repo: 'app', number: 8 },
    ])).toEqual([
      { owner: 'acme', repo: 'app', number: 7 },
      { owner: 'acme', repo: 'app', number: 8 },
    ]);
  });

  test('keeps the same owner/repo/number distinct across hosts', () => {
    expect(parseSummaryRefs([
      { owner: 'acme', repo: 'app', number: 7 },
      { owner: 'acme', repo: 'app', number: 7, host: 'github.acme.com' },
      { owner: 'acme', repo: 'app', number: 7, host: 'gitlab.com' },
    ])).toEqual([
      { owner: 'acme', repo: 'app', number: 7 },
      { owner: 'acme', repo: 'app', number: 7, host: 'github.acme.com' },
      { owner: 'acme', repo: 'app', number: 7, host: 'gitlab.com' },
    ]);
  });

  test('accepts an optional host and trims it', () => {
    expect(parseSummaryRefs([
      { owner: 'acme', repo: 'app', number: 7, host: ' github.acme.com ' },
    ])).toEqual([
      { owner: 'acme', repo: 'app', number: 7, host: 'github.acme.com' },
    ]);
  });

  test('rejects malformed payloads', () => {
    expect(parseSummaryRefs(null)).toBe(null);
    expect(parseSummaryRefs([{ owner: 'acme', repo: 'app', number: 0 }])).toBe(null);
    expect(parseSummaryRefs([{ owner: 'acme', repo: 'app', number: '7' }])).toBe(null);
    expect(parseSummaryRefs([{ owner: 'ac me', repo: 'app', number: 7 }])).toBe(null);
    expect(parseSummaryRefs([{ owner: 'acme', repo: 'app"){x}', number: 7 }])).toBe(null);
    const tooMany = Array.from({ length: MAX_SUMMARY_REFS + 1 }, (_, index) => ({ owner: 'acme', repo: 'app', number: index + 1 }));
    expect(parseSummaryRefs(tooMany)).toBe(null);
  });
});

describe('summarizeCheckContexts', () => {
  test('a re-run that passed hides the failed attempt it replaced', () => {
    expect(summarizeCheckContexts([
      checkRun('automation', 'COMPLETED', 'FAILURE', '2026-09-28T06:51:15Z'),
      checkRun('automation', 'COMPLETED', 'SUCCESS', '2026-09-28T06:56:33Z'),
      checkRun('label', 'COMPLETED', 'SUCCESS', '2026-09-28T06:51:14Z'),
    ])).toEqual({ state: 'success', total: 2, success: 2, failure: 0, pending: 0, inProgress: 0, queued: 0 });
  });

  test('buckets check runs like the REST summary', () => {
    expect(summarizeCheckContexts([
      checkRun('a', 'COMPLETED', 'SUCCESS', '2026-09-30T10:00:00Z'),
      checkRun('b', 'COMPLETED', 'SKIPPED', '2026-09-30T10:00:00Z'),
      checkRun('c', 'COMPLETED', 'NEUTRAL', '2026-09-30T10:00:00Z'),
      checkRun('d', 'IN_PROGRESS', null, '2026-09-30T10:01:00Z'),
      checkRun('e', 'QUEUED', null, '2026-09-30T10:00:00Z'),
      checkRun('f', 'COMPLETED', 'TIMED_OUT', '2026-09-30T10:00:00Z'),
      { __typename: 'StatusContext', context: 'ci/legacy', state: 'FAILURE' },
    ])).toEqual({
      state: 'failure', total: 6, success: 3, failure: 1, pending: 2, inProgress: 1, queued: 1, startedAt: '2026-09-30T10:01:00Z',
    });
  });

  test('falls back to commit statuses without check runs', () => {
    expect(summarizeCheckContexts([
      { __typename: 'StatusContext', context: 'ci/a', state: 'SUCCESS' },
      { __typename: 'StatusContext', context: 'ci/b', state: 'PENDING' },
    ])).toEqual({ state: 'pending', total: 2, success: 1, failure: 0, pending: 1, inProgress: 1, queued: 0 });
  });

  test('a commit without any checks is unknown', () => {
    expect(summarizeCheckContexts([])).toEqual({ state: 'unknown', total: 0, success: 0, failure: 0, pending: 0, inProgress: 0, queued: 0 });
  });
});

describe('fetchPrSummaries', () => {
  test('packs 25 PRs per GraphQL document', async () => {
    const refs = Array.from({ length: 26 }, (_, index) => ({ owner: 'acme', repo: 'app', number: index + 1 }));
    const octokit = fakeOctokit(new Map(refs.map((ref) => [ref.number, prNode(ref.number)])));

    const { summaries } = await fetchPrSummaries({ octokit, refs });

    expect(octokit.documents).toEqual([25, 1]);
    expect(summaries).toHaveLength(26);
  });

  test('maps a merged PR without checks or mergeability', async () => {
    const octokit = fakeOctokit(new Map([[7, prNode(7, { state: 'MERGED', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })]]));

    const { summaries: [summary] } = await fetchPrSummaries({ octokit, refs: [{ owner: 'acme', repo: 'app', number: 7 }] });

    expect(summary).toEqual({
      owner: 'acme',
      repo: 'app',
      number: 7,
      state: 'merged',
      draft: false,
      title: 'PR 7',
      headSha: 'sha-7',
      mergeable: null,
      mergeableState: 'unknown',
      checks: null,
    });
  });

  test('keeps partial data when some PRs cannot be resolved', async () => {
    const octokit = fakeOctokit(new Map([[7, prNode(7)]]), {
      fail: (data) => Object.assign(new Error('Could not resolve to a PullRequest'), {
        data,
        errors: [{ type: 'NOT_FOUND', path: ['a1', 'pullRequest'] }],
      }),
    });

    const { summaries } = await fetchPrSummaries({
      octokit,
      refs: [{ owner: 'acme', repo: 'app', number: 7 }, { owner: 'acme', repo: 'app', number: 8 }],
    });

    expect(summaries.map((summary) => summary.number)).toEqual([7]);
  });

  test('reads issues in the same documents as PRs', async () => {
    const issue = (number, state, stateReason) => ({ number, title: `Issue ${number}`, state, stateReason });
    const octokit = fakeOctokit(new Map([[7, prNode(7)]]), {
      issues: new Map([
        [11, issue(11, 'OPEN', null)],
        [12, issue(12, 'CLOSED', 'COMPLETED')],
        [13, issue(13, 'CLOSED', 'NOT_PLANNED')],
        [14, issue(14, 'CLOSED', 'DUPLICATE')],
      ]),
    });
    const ref = (number) => ({ owner: 'acme', repo: 'app', number });

    const { summaries, issueSummaries } = await fetchPrSummaries({ octokit, refs: [ref(7)], issueRefs: [11, 12, 13, 14, 15].map(ref) });

    expect(octokit.documents).toEqual([6]);
    expect(summaries.map((summary) => summary.number)).toEqual([7]);
    expect(issueSummaries.map((summary) => [summary.number, summary.state])).toEqual([
      [11, 'open'], [12, 'completed'], [13, 'not_planned'], [14, 'not_planned'],
    ]);
    expect(issueSummaries[0].title).toBe('Issue 11');
  });

  test('a rate-limited document fails the call instead of reading as empty', async () => {
    const limited = Object.assign(new Error('API rate limit exceeded'), {
      data: {},
      errors: [{ type: 'RATE_LIMITED' }],
    });
    const octokit = fakeOctokit(new Map([[7, prNode(7)]]), { fail: () => limited });

    await expect(fetchPrSummaries({ octokit, refs: [{ owner: 'acme', repo: 'app', number: 7 }] })).rejects.toBe(limited);
    expect(isGraphqlRateLimitError(limited)).toBe(true);
  });
});
