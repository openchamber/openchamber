
import { z } from 'zod';

import { dedupeCheckRuns, summarizeCheckRuns, summarizeCombinedStatuses } from './checks-summary.js';

const SUMMARY_ALIASES_PER_QUERY = 25;
export const MAX_SUMMARY_REFS = 100;

const GITHUB_NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

const SUMMARY_FIELDS = `
  number
  title
  state
  isDraft
  mergeable
  mergeStateStatus
  isInMergeQueue
  mergeQueueEntry { state position }
  autoMergeRequest { enabledAt mergeMethod }
  headRefOid
  baseRefName
  comments { totalCount }
  reviews { totalCount }
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

const ACTIVITY_FIELDS = `
  recentComments: comments(last: 10) { nodes { createdAt author { __typename login } } }
  recentReviews: reviews(last: 10) { nodes { submittedAt author { __typename login } } }
`;

const ISSUE_FIELDS = `
  number
  title
  state
  stateReason
`;

const DISCUSSION_FIELDS = `
  number
  title
  closed
  stateReason
  isAnswered
`;

const githubName = z.string().trim().regex(GITHUB_NAME_PATTERN);
const summaryRefsSchema = z.array(z.object({
  owner: githubName,
  repo: githubName,
  number: z.number().int().positive(),
  host: z.string().trim().max(255).optional(),
})).max(MAX_SUMMARY_REFS);

export function parseSummaryRefs(value) {
  const parsed = summaryRefsSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const refs = new Map();
  for (const ref of parsed.data) {
    const host = (ref.host ?? '').trim().toLowerCase() || 'github.com';
    refs.set(`${host}::${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`, ref);
  }
  return [...refs.values()];
}

export const checkContextSchema = z.discriminatedUnion('__typename', [
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

const activityNodesSchema = (timeField) => z.object({
  nodes: z.array(z.object({
    [timeField]: z.string().nullable(),
    author: z.object({ __typename: z.string(), login: z.string() }).nullable(),
  }).nullable()),
}).nullish();

const prNodeSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: z.boolean(),
  mergeable: z.string().nullable(),
  mergeStateStatus: z.string().nullable(),
  isInMergeQueue: z.boolean().optional(),
  mergeQueueEntry: z.object({ state: z.string(), position: z.number().int().nonnegative() }).nullish(),
  autoMergeRequest: z.object({ enabledAt: z.string(), mergeMethod: z.string() }).nullish(),
  headRefOid: z.string(),
  baseRefName: z.string(),
  comments: z.object({ totalCount: z.number().int() }).nullish(),
  reviews: z.object({ totalCount: z.number().int() }).nullish(),
  recentComments: activityNodesSchema('createdAt'),
  recentReviews: activityNodesSchema('submittedAt'),
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

export function summarizeCheckContexts(contexts) {
  const { checkRuns, statuses } = splitCheckContexts(contexts);
  return checkRuns.length > 0
    ? summarizeCheckRuns(dedupeCheckRuns(checkRuns))
    : summarizeCombinedStatuses(statuses);
}

function splitCheckContexts(contexts) {
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
      statuses.push({ name: context.context, state: context.state.toLowerCase() });
    }
  }
  return { checkRuns, statuses };
}

const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

function failedCheckNames(contexts) {
  const { checkRuns, statuses } = splitCheckContexts(contexts);
  if (checkRuns.length > 0) {
    return dedupeCheckRuns(checkRuns)
      .filter((run) => run.status !== 'in_progress' && run.status !== 'queued' && run.conclusion && !PASSING_CONCLUSIONS.has(run.conclusion))
      .map((run) => run.name);
  }
  return statuses.filter((status) => status.state === 'failure' || status.state === 'error').map((status) => status.name);
}

function recentActivityOf(node) {
  const entries = [
    ...(node.recentComments?.nodes ?? []).map((entry) => entry && { author: entry.author, at: entry.createdAt }),
    ...(node.recentReviews?.nodes ?? []).map((entry) => entry && { author: entry.author, at: entry.submittedAt }),
  ];
  return entries
    .filter((entry) => entry?.author && entry.at)
    .map((entry) => ({
      author: entry.author.__typename === 'Bot' ? `${entry.author.login}[bot]` : entry.author.login,
      at: entry.at,
    }))
    .sort((left, right) => (left.at < right.at ? 1 : left.at > right.at ? -1 : 0));
}

const issueNodeSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.enum(['OPEN', 'CLOSED']),
  stateReason: z.string().nullable(),
});

const toIssueState = (node) => {
  if (node.state === 'OPEN') return 'open';
  return node.stateReason === 'NOT_PLANNED' || node.stateReason === 'DUPLICATE' ? 'not_planned' : 'completed';
};

function toIssueSummary(ref, value) {
  const parsed = issueNodeSchema.safeParse(value);
  if (!parsed.success || parsed.data.number !== ref.number) {
    return null;
  }
  return {
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    title: parsed.data.title,
    state: toIssueState(parsed.data),
  };
}

const DISCUSSION_CLOSE_REASONS = { RESOLVED: 'resolved', OUTDATED: 'outdated', DUPLICATE: 'duplicate' };

export const toDiscussionState = (node) => (node.closed ? DISCUSSION_CLOSE_REASONS[node.stateReason] ?? 'resolved' : 'open');

const discussionNodeSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  closed: z.boolean(),
  stateReason: z.string().nullable(),
  isAnswered: z.boolean().nullable(),
});

function toDiscussionSummary(ref, value) {
  const parsed = discussionNodeSchema.safeParse(value);
  if (!parsed.success || parsed.data.number !== ref.number) {
    return null;
  }
  return {
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    title: parsed.data.title,
    state: toDiscussionState(parsed.data),
    answered: parsed.data.isAnswered,
  };
}

const PR_STATES = { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' };

const toMergeable = (mergeable) => {
  if (mergeable === 'MERGEABLE') return true;
  if (mergeable === 'CONFLICTING') return false;
  return null;
};

function toSummary(ref, value, details) {
  const parsed = prNodeSchema.safeParse(value);
  if (!parsed.success || parsed.data.number !== ref.number) {
    return null;
  }
  const node = parsed.data;
  const state = PR_STATES[node.state];
  const contexts = node.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
  const summary = {
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    state,
    draft: node.isDraft,
    title: node.title,
    headSha: node.headRefOid,
    base: node.baseRefName,
    mergeable: toMergeable(node.mergeable),
    mergeableState: node.mergeStateStatus ? node.mergeStateStatus.toLowerCase() : null,
    isInMergeQueue: node.isInMergeQueue ?? false,
    mergeQueueEntry: node.mergeQueueEntry ?? null,
    autoMergeRequest: node.autoMergeRequest ?? null,
    checks: state === 'open' ? summarizeCheckContexts(contexts) : null,
  };
  if (node.comments && node.reviews) summary.activity = node.comments.totalCount + node.reviews.totalCount;
  if (details) {
    summary.failedChecks = state === 'open' ? failedCheckNames(contexts) : [];
    summary.recentActivity = recentActivityOf(node);
  }
  return summary;
}

function buildSummaryQuery(entries, details) {
  const variables = {};
  const declarations = [];
  const selections = [];
  entries.forEach(({ kind, ref }, index) => {
    variables[`o${index}`] = ref.owner;
    variables[`n${index}`] = ref.repo;
    variables[`p${index}`] = ref.number;
    declarations.push(`$o${index}: String!, $n${index}: String!, $p${index}: Int!`);
    const field = {
      issue: `issue(number: $p${index}) { ...IssueSummary }`,
      discussion: `discussion(number: $p${index}) { ...DiscussionSummary }`,
      pull: `pullRequest(number: $p${index}) { ...PrSummary }`,
    }[kind];
    selections.push(`a${index}: repository(owner: $o${index}, name: $n${index}) { ${field} }`);
  });
  const fragments = [
    entries.some((entry) => entry.kind === 'pull') ? `fragment PrSummary on PullRequest {${SUMMARY_FIELDS}${details ? ACTIVITY_FIELDS : ''}}` : '',
    entries.some((entry) => entry.kind === 'issue') ? `fragment IssueSummary on Issue {${ISSUE_FIELDS}}` : '',
    entries.some((entry) => entry.kind === 'discussion') ? `fragment DiscussionSummary on Discussion {${DISCUSSION_FIELDS}}` : '',
  ].filter(Boolean);
  const query = `query(${declarations.join(', ')}) {\n${selections.join('\n')}\n}\n${fragments.join('\n')}`;
  return { query, variables };
}

// external: https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api#exceeding-the-rate-limit GraphQL primary rate limits arrive as HTTP 200 errors.
export const isGraphqlRateLimitError = (error) => Array.isArray(error?.errors)
  && error.errors.some((entry) => entry?.type === 'RATE_LIMITED');

async function runSummaryQuery(octokit, entries, details) {
  const { query, variables } = buildSummaryQuery(entries, details);
  try {
    return await octokit.graphql(query, variables);
  } catch (error) {
    if (!isGraphqlRateLimitError(error) && error?.data) {
      return error.data;
    }
    throw error;
  }
}

export async function fetchPrSummaries({ octokit, refs, issueRefs = [], discussionRefs = [], details = false }) {
  const entries = [
    ...refs.map((ref) => ({ kind: 'pull', ref })),
    ...issueRefs.map((ref) => ({ kind: 'issue', ref })),
    ...discussionRefs.map((ref) => ({ kind: 'discussion', ref })),
  ];
  const summaries = [];
  const issueSummaries = [];
  const discussionSummaries = [];
  // external: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#avoid-concurrent-requests Serial batches avoid bursts that trigger secondary limits.
  for (let start = 0; start < entries.length; start += SUMMARY_ALIASES_PER_QUERY) {
    const chunk = entries.slice(start, start + SUMMARY_ALIASES_PER_QUERY);
    const data = await runSummaryQuery(octokit, chunk, details);
    chunk.forEach(({ kind, ref }, index) => {
      const repository = data?.[`a${index}`];
      if (kind === 'issue') {
        const summary = toIssueSummary(ref, repository?.issue);
        if (summary) issueSummaries.push(summary);
        return;
      }
      if (kind === 'discussion') {
        const summary = toDiscussionSummary(ref, repository?.discussion);
        if (summary) discussionSummaries.push(summary);
        return;
      }
      const summary = toSummary(ref, repository?.pullRequest, details);
      if (summary) summaries.push(summary);
    });
  }
  return { summaries, issueSummaries, discussionSummaries };
}
