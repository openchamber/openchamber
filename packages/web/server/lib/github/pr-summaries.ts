
import { z } from 'zod';

import { dedupeCheckRuns, summarizeCheckRuns, summarizeCombinedStatuses } from './checks-summary.js';
import type { Octokit } from '@octokit/rest';
import { graphqlAliasesSchema, hasProperty } from './contracts.js';
import type { GitHubEnvelope } from './contracts.js';
import { isProviderString } from './mappers.js';

export type SummaryRef = z.infer<typeof summaryRefsSchema>[number];
type CheckContext = z.infer<typeof checkContextSchema>;
type PrNode = z.infer<typeof prNodeSchema>;
type SummaryEntry = { kind: 'pull' | 'issue' | 'discussion'; ref: SummaryRef; queueRemoval?: boolean };
export type PullSummaryRef = SummaryRef & { queueRemoval?: boolean };
type PrSummary = NonNullable<ReturnType<typeof toSummary>>;
type QueueRemoval = { id: string; createdAt: string; reason?: string | null };
export interface PullSummary {
  owner: string; repo: string; number: number; state: string; draft: boolean; title: string; headSha: string; base: string;
  mergeable: boolean | null; mergeableState: string | null; isInMergeQueue: boolean;
  mergeQueueEntry: PrNode['mergeQueueEntry']; autoMergeRequest: PrNode['autoMergeRequest'];
  latestQueueRemoval?: QueueRemoval | null;
  checks: ReturnType<typeof summarizeCheckContexts> | null;
  activity?: number; failedChecks?: string[]; recentActivity?: ReturnType<typeof recentActivityOf>;
}

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

const QUEUE_REMOVAL_FIELDS = `
  timelineItems(last: 1, itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT]) {
    nodes { ... on RemovedFromMergeQueueEvent { id createdAt reason } }
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

export function parseSummaryRefs(value: z.input<typeof summaryRefsSchema>) {
  const parsed = summaryRefsSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const refs = new Map<string, SummaryRef>();
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

const activityNodesSchema = (timeField: string) => z.object({
  nodes: z.array(z.object({
    [timeField]: z.string().nullable(),
    author: z.object({ __typename: z.string(), login: z.string() }).nullable(),
  }).nullable()),
}).nullish();

const queueRemovalPullSchema = z.object({
  timelineItems: z.object({
    nodes: z.array(z.object({
      id: z.string().min(1),
      createdAt: z.iso.datetime({ offset: true }),
      reason: z.string().nullish().catch(undefined),
    })).max(1),
  }),
});

type QueueRemovalEvent = z.infer<typeof queueRemovalPullSchema>['timelineItems']['nodes'][number];
const graphqlErrorPathSchema = z.array(z.union([z.string(), z.number()])).catch([]);

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

export function summarizeCheckContexts(contexts: CheckContext[]) {
  const { checkRuns, statuses } = splitCheckContexts(contexts);
  return checkRuns.length > 0
    ? summarizeCheckRuns(dedupeCheckRuns(checkRuns))
    : summarizeCombinedStatuses(statuses);
}

function splitCheckContexts(contexts: CheckContext[]) {
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

function failedCheckNames(contexts: CheckContext[]) {
  const { checkRuns, statuses } = splitCheckContexts(contexts);
  if (checkRuns.length > 0) {
    return dedupeCheckRuns(checkRuns)
      .filter((run) => run.status !== 'in_progress' && run.status !== 'queued' && run.conclusion && !PASSING_CONCLUSIONS.has(run.conclusion))
      .map((run) => run.name);
  }
  return statuses.filter((status) => status.state === 'failure' || status.state === 'error').map((status) => status.name);
}

function recentActivityOf(node: PrNode) {
  const entries = [
    ...(node.recentComments?.nodes ?? []).map((entry) => entry && { author: entry.author, at: entry.createdAt }),
    ...(node.recentReviews?.nodes ?? []).map((entry) => entry && { author: entry.author, at: entry.submittedAt }),
  ];
  return entries
    .filter((entry): entry is { author: { __typename: string; login: string }; at: string } => Boolean(entry?.author && entry.at)
      && hasProperty(entry?.author, '__typename') && isProviderString(entry.author.__typename)
      && hasProperty(entry.author, 'login') && isProviderString(entry.author.login) && isProviderString(entry.at))
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

const toIssueState = (node: z.infer<typeof issueNodeSchema>) => {
  if (node.state === 'OPEN') return 'open';
  return node.stateReason === 'NOT_PLANNED' || node.stateReason === 'DUPLICATE' ? 'not_planned' : 'completed';
};

function toIssueSummary(ref: SummaryRef, value: GitHubEnvelope['issue']) {
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
const discussionReason = (reason: string | null): reason is keyof typeof DISCUSSION_CLOSE_REASONS => reason !== null && reason in DISCUSSION_CLOSE_REASONS;

export const toDiscussionState = (node: { closed: boolean; stateReason: string | null }) => (node.closed ? (discussionReason(node.stateReason) ? DISCUSSION_CLOSE_REASONS[node.stateReason] : undefined) ?? 'resolved' : 'open');

const discussionNodeSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  closed: z.boolean(),
  stateReason: z.string().nullable(),
  isAnswered: z.boolean().nullable(),
});

function toDiscussionSummary(ref: SummaryRef, value: GitHubEnvelope['discussion']) {
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

const toMergeable = (mergeable: string | null) => {
  if (mergeable === 'MERGEABLE') return true;
  if (mergeable === 'CONFLICTING') return false;
  return null;
};

function queueRemovalOf(event: QueueRemovalEvent | undefined, alias: string, errorPaths: (string | number)[][]): QueueRemoval | null | undefined {
  let reasonUnavailable = false;
  for (const path of errorPaths) {
    if (path.length === 0) {
      if (!event) return undefined;
      continue;
    }
    const [repoAlias, pull, field, nodes, index, leaf] = path;
    if (repoAlias !== alias || (pull !== undefined && pull !== 'queueRemoval')
      || (field !== undefined && field !== 'timelineItems')) continue;
    if (!event || nodes !== 'nodes' || index !== 0 || leaf !== 'reason') return undefined;
    reasonUnavailable = true;
  }
  if (!event) return null;
  const { id, createdAt, reason } = event;
  return reasonUnavailable || reason === undefined ? { id, createdAt } : { id, createdAt, reason };
}

function toSummary(ref: SummaryRef, value: GitHubEnvelope['pullRequest'], details: boolean) {
  const parsed = prNodeSchema.safeParse(value);
  if (!parsed.success || parsed.data.number !== ref.number) {
    return null;
  }
  const node = parsed.data;
  const state = PR_STATES[node.state];
  const contexts = node.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
  const summary: PullSummary = {
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

function buildSummaryQuery(entries: SummaryEntry[], details: boolean, queueRemovals: boolean) {
  const variables: Record<string, string | number> = {};
  const declarations: string[] = [];
  const selections: string[] = [];
  entries.forEach(({ kind, ref, queueRemoval }, index) => {
    variables[`o${index}`] = ref.owner;
    variables[`n${index}`] = ref.repo;
    variables[`p${index}`] = ref.number;
    declarations.push(`$o${index}: String!, $n${index}: String!, $p${index}: Int!`);
    const field = {
      issue: `issue(number: $p${index}) { ...IssueSummary }`,
      discussion: `discussion(number: $p${index}) { ...DiscussionSummary }`,
      pull: `pullRequest(number: $p${index}) { ...PrSummary }${queueRemovals && queueRemoval ? ` queueRemoval: pullRequest(number: $p${index}) {${QUEUE_REMOVAL_FIELDS}}` : ''}`,
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

export const isGraphqlRateLimitError = (error: unknown): error is { errors: unknown[] } => hasProperty(error, 'errors') && Array.isArray(error.errors)
  && error.errors.some((entry: GitHubEnvelope['errors']) => hasProperty(entry, 'type') && entry.type === 'RATE_LIMITED');

async function runSummaryQuery(octokit: Octokit, entries: SummaryEntry[], details: boolean, queueRemovals = true): Promise<{ data: z.infer<typeof graphqlAliasesSchema>; errorPaths: (string | number)[][] }> {
  const { query, variables } = buildSummaryQuery(entries, details, queueRemovals);
  try {
    return { data: graphqlAliasesSchema.parse(await octokit.graphql<unknown>(query, variables)), errorPaths: [] };
  } catch (error) {
    if (!isGraphqlRateLimitError(error) && hasProperty(error, 'data') && error.data) {
      const errors: unknown[] = hasProperty(error, 'errors') && Array.isArray(error.errors) && error.errors.length > 0
        ? error.errors : [error];
      const errorPaths = errors.map((entry) => graphqlErrorPathSchema.parse(hasProperty(entry, 'path') ? entry.path : undefined));
      return { data: graphqlAliasesSchema.parse(error.data), errorPaths };
    }
    const rejectedByGraphql = hasProperty(error, 'errors') && Array.isArray(error.errors);
    const timedOutAtGateway = hasProperty(error, 'status') && (error.status === 502 || error.status === 504);
    if (queueRemovals && entries.some((entry) => entry.queueRemoval) && !isGraphqlRateLimitError(error)
      && (rejectedByGraphql || timedOutAtGateway)) {
      return runSummaryQuery(octokit, entries, details, false);
    }
    throw error;
  }
}

export async function fetchPrSummaries({ octokit, refs, issueRefs = [], discussionRefs = [], details = false }: {
  octokit: Octokit; refs: PullSummaryRef[]; issueRefs?: SummaryRef[]; discussionRefs?: SummaryRef[]; details?: boolean;
}) {
  const entries: SummaryEntry[] = [
    ...refs.map(({ queueRemoval, ...ref }): SummaryEntry => ({ kind: 'pull', ref, queueRemoval: queueRemoval === true })),
    ...issueRefs.map((ref): SummaryEntry => ({ kind: 'issue', ref })),
    ...discussionRefs.map((ref): SummaryEntry => ({ kind: 'discussion', ref })),
  ];
  const summaries: PrSummary[] = [];
  const issueSummaries: NonNullable<ReturnType<typeof toIssueSummary>>[] = [];
  const discussionSummaries: NonNullable<ReturnType<typeof toDiscussionSummary>>[] = [];
  for (let start = 0; start < entries.length; start += SUMMARY_ALIASES_PER_QUERY) {
    const chunk = entries.slice(start, start + SUMMARY_ALIASES_PER_QUERY);
    const { data, errorPaths } = await runSummaryQuery(octokit, chunk, details);
    chunk.forEach(({ kind, ref }, index) => {
      const alias = `a${index}`;
      const repository = data?.[alias];
      if (kind === 'issue') {
        const summary = toIssueSummary(ref, hasProperty(repository, 'issue') ? repository.issue : undefined);
        if (summary) issueSummaries.push(summary);
        return;
      }
      if (kind === 'discussion') {
        const summary = toDiscussionSummary(ref, hasProperty(repository, 'discussion') ? repository.discussion : undefined);
        if (summary) discussionSummaries.push(summary);
        return;
      }
      const summary = toSummary(ref, hasProperty(repository, 'pullRequest') ? repository.pullRequest : undefined, details);
      if (!summary) return;
      const removal = queueRemovalPullSchema.safeParse(hasProperty(repository, 'queueRemoval') ? repository.queueRemoval : undefined);
      if (removal.success) {
        const latestQueueRemoval = queueRemovalOf(removal.data.timelineItems.nodes[0], alias, errorPaths);
        if (latestQueueRemoval !== undefined) summary.latestQueueRemoval = latestQueueRemoval;
      }
      summaries.push(summary);
    });
  }
  return { summaries, issueSummaries, discussionSummaries };
}
