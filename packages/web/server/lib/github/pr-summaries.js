// Live status for PRs the client already knows by number.
//
// The sidebar shows many worktrees at once. Asking the full per-branch
// resolver for each of them costs several REST calls per PR; here one GraphQL
// document carries up to SUMMARY_ALIASES_PER_QUERY PRs (state, draft,
// mergeability and their check contexts), and GitHub prices such a document
// at a single point of the GraphQL budget.

import { z } from 'zod';

import { dedupeCheckRuns, summarizeCheckRuns, summarizeCombinedStatuses } from './checks-summary.js';

const SUMMARY_ALIASES_PER_QUERY = 25;
export const MAX_SUMMARY_REFS = 100;

const GITHUB_NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

// Individual check contexts rather than the rollup's counts or state: both
// still count a failed run that a later re-run superseded, which would paint
// a green PR as failing. A hundred contexts per PR does not change the
// document's price (measured: 25 PRs with contexts cost one point).
const SUMMARY_FIELDS = `
  number
  title
  state
  isDraft
  mergeable
  mergeStateStatus
  headRefOid
  commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          contexts(first: 100) {
            nodes {
              __typename
              ... on CheckRun {
                databaseId
                name
                status
                conclusion
                startedAt
                checkSuite { app { databaseId } }
              }
              ... on StatusContext {
                context
                state
              }
            }
          }
        }
      }
    }
  }
`;

const githubName = z.string().trim().regex(GITHUB_NAME_PATTERN);
const summaryRefsSchema = z.array(z.object({
  owner: githubName,
  repo: githubName,
  number: z.number().int().positive(),
})).max(MAX_SUMMARY_REFS);

/**
 * Parse a client-supplied ref list into unique `{ owner, repo, number }`
 * records. Returns null when the payload is not a valid list.
 */
export function parseSummaryRefs(value) {
  const parsed = summaryRefsSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const refs = new Map();
  for (const ref of parsed.data) {
    refs.set(`${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`, ref);
  }
  return [...refs.values()];
}

const checkContextSchema = z.discriminatedUnion('__typename', [
  z.object({
    __typename: z.literal('CheckRun'),
    databaseId: z.number().int().nullable(),
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    startedAt: z.string().nullable(),
    checkSuite: z.object({ app: z.object({ databaseId: z.number().int().nullable() }).nullable() }).nullable(),
  }),
  z.object({
    __typename: z.literal('StatusContext'),
    context: z.string(),
    state: z.string(),
  }),
]);

const prNodeSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: z.boolean(),
  mergeable: z.string().nullable(),
  mergeStateStatus: z.string().nullable(),
  headRefOid: z.string(),
  commits: z.object({
    nodes: z.array(z.object({
      commit: z.object({
        statusCheckRollup: z.object({
          contexts: z.object({ nodes: z.array(checkContextSchema) }),
        }).nullable(),
      }),
    })),
  }),
});

/**
 * Summarize GraphQL check contexts with the REST summarizers, so the sidebar
 * counts exactly what the Git view counts: check runs, deduplicated to the
 * latest run per app and name, win over classic commit statuses.
 */
export function summarizeCheckContexts(contexts) {
  const checkRuns = [];
  const statuses = [];
  for (const context of contexts) {
    if (context.__typename === 'CheckRun') {
      checkRuns.push({
        id: context.databaseId ?? undefined,
        name: context.name,
        app: { id: context.checkSuite?.app?.databaseId ?? undefined },
        status: context.status.toLowerCase(),
        conclusion: context.conclusion ? context.conclusion.toLowerCase() : null,
        started_at: context.startedAt ?? undefined,
      });
    } else {
      statuses.push({ state: context.state.toLowerCase() });
    }
  }
  return checkRuns.length > 0
    ? summarizeCheckRuns(dedupeCheckRuns(checkRuns))
    : summarizeCombinedStatuses(statuses);
}

const PR_STATES = { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' };

const toMergeable = (mergeable) => {
  if (mergeable === 'MERGEABLE') return true;
  if (mergeable === 'CONFLICTING') return false;
  return null;
};

function toSummary(ref, value) {
  const parsed = prNodeSchema.safeParse(value);
  if (!parsed.success || parsed.data.number !== ref.number) {
    return null;
  }
  const node = parsed.data;
  const state = PR_STATES[node.state];
  return {
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    state,
    draft: node.isDraft,
    title: node.title,
    headSha: node.headRefOid,
    mergeable: toMergeable(node.mergeable),
    mergeableState: node.mergeStateStatus ? node.mergeStateStatus.toLowerCase() : null,
    // A closed/merged PR's checks are not actionable; the REST status route
    // drops them too.
    checks: state === 'open'
      ? summarizeCheckContexts(node.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [])
      : null,
  };
}

function buildSummaryQuery(refs) {
  const variables = {};
  const declarations = [];
  const selections = [];
  refs.forEach((ref, index) => {
    variables[`o${index}`] = ref.owner;
    variables[`n${index}`] = ref.repo;
    variables[`p${index}`] = ref.number;
    declarations.push(`$o${index}: String!, $n${index}: String!, $p${index}: Int!`);
    selections.push(`p${index}: repository(owner: $o${index}, name: $n${index}) { pullRequest(number: $p${index}) { ...PrSummary } }`);
  });
  const query = `query(${declarations.join(', ')}) {\n${selections.join('\n')}\n}\nfragment PrSummary on PullRequest {${SUMMARY_FIELDS}}`;
  return { query, variables };
}

// The GraphQL primary limit arrives as HTTP 200 with a RATE_LIMITED error,
// which the REST-oriented check in rate-limit.js cannot see.
export const isGraphqlRateLimitError = (error) => Array.isArray(error?.errors)
  && error.errors.some((entry) => entry?.type === 'RATE_LIMITED');

// GitHub answers a PR it cannot resolve (deleted, no access) with a per-alias
// error next to the data for every other alias. Octokit throws on any error,
// so keep the partial data and only rethrow when there is none.
async function runSummaryQuery(octokit, refs) {
  const { query, variables } = buildSummaryQuery(refs);
  try {
    return await octokit.graphql(query, variables);
  } catch (error) {
    if (!isGraphqlRateLimitError(error) && error?.data) {
      return error.data;
    }
    throw error;
  }
}

/**
 * Fetch live summaries for known PRs. A PR GitHub could not resolve is left
 * out of the result: absence means "unknown", never "closed".
 */
export async function fetchPrSummaries({ octokit, refs }) {
  const summaries = [];
  // Chunks run one after another: GitHub's secondary limits punish bursts of
  // concurrent GraphQL documents more than a short sequence.
  for (let start = 0; start < refs.length; start += SUMMARY_ALIASES_PER_QUERY) {
    const chunk = refs.slice(start, start + SUMMARY_ALIASES_PER_QUERY);
    const data = await runSummaryQuery(octokit, chunk);
    chunk.forEach((ref, index) => {
      const summary = toSummary(ref, data?.[`p${index}`]?.pullRequest);
      if (summary) {
        summaries.push(summary);
      }
    });
  }
  return summaries;
}
