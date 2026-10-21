// Issues and pull requests for the reference picker.
//
// A page carries what the rows and most of the preview need: state, author,
// labels, comment count, body, and for a PR its draft flag and branches. One
// GraphQL search document answers a whole page, where the REST list plus
// per-PR enrichment it replaces cost up to 51 calls per search. A pasted link
// or number skips search and reads that item directly, whatever its kind.
//
// Comments, and a PR's size and review decision, are read for one item at a
// time, when the preview shows it. Measured on openchamber/openchamber (30
// open PRs): the cheap fields answer a page in about 2.5 s, size adds about
// 2 s, the review decision about 4 s and checks about 3 s, which together run
// into GitHub's 10 s search timeout. One item's detail answers in about a
// second.
//
// A PR's checks and mergeability come from a status request for the PRs a
// page shows, after the page: the sidebar's own summaries, so both colour a PR
// the same way, and the preview's checks line reads the same answer as its
// colour. Measured on the same repo: 30 PRs answer in about 4 to 7 s, almost
// all of it GitHub working out mergeability, which is why it is not part of
// the page.

import { z } from 'zod';
import { createHash } from 'node:crypto';

import { checkContextSchema, isGraphqlRateLimitError, parseSummaryRefs, summarizeCheckContexts } from './pr-summaries.js';

const REFERENCE_PAGE_SIZE = 30;
const ACROSS_REPO_CHUNK_SIZE = 40;
const ACROSS_CONCURRENCY = 4;

const acrossContextSchema = z.strictObject({
  directory: z.string().trim().min(1),
  repositoryId: z.string().min(1),
  provider: z.literal('github'),
  instance: z.string().min(1),
  accountId: z.string().min(1),
  bindingRevision: z.number().int().nonnegative(),
  primaryRemote: z.string().min(1),
});
const acrossRequestSchema = z.strictObject({
  contexts: z.array(acrossContextSchema),
  kind: z.enum(['issue', 'pull']),
  state: z.enum(['open', 'closed', 'merged', 'all']).optional(),
  people: z.enum(['any', 'assigned', 'created', 'reviewRequested']).optional(),
  query: z.string().optional(),
  // The first page sends no cursor as null, like the single-repository list.
  cursor: z.string().max(100_000).nullable().optional(),
});

const invalidAcrossCursor = () => Object.assign(new Error('Invalid references cursor'), { status: 400, code: 'INVALID_REFERENCES_CURSOR' });

/** Validate the JSON read request before any folder or credential access. */
export function readReferencesAcrossRequest(body) {
  const parsed = acrossRequestSchema.safeParse(body);
  if (!parsed.success) return null;
  const folders = new Map();
  for (const context of parsed.data.contexts) {
    if (!folders.has(context.directory)) folders.set(context.directory, context);
  }
  return folders.size > 100 ? null : { ...parsed.data, contexts: [...folders.values()], directories: parsed.data.contexts.map((context) => context.directory) };
}

/** Bounded fan-out for folder resolution and provider search. */
export async function mapReferencesAcross(entries, operation) {
  const results = new Array(entries.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(ACROSS_CONCURRENCY, entries.length) }, async () => {
    while (next < entries.length) {
      const index = next++;
      results[index] = await operation(entries[index], index);
    }
  }));
  return results;
}
// The preview shows the description; the attach path reads the full one.
const BODY_PREVIEW_MAX = 20_000;
// Keys match the filter schema below.
// The list's state and whose items it shows combine, one qualifier each.
const SEARCH_STATES = {
  open: 'is:open',
  closed: 'is:closed',
  merged: 'is:merged',
  all: '',
};
const SEARCH_PEOPLE = {
  any: '',
  assigned: 'assignee:@me',
  created: 'author:@me',
  reviewRequested: 'review-requested:@me',
};

const COMMON_FIELDS = `
  number
  title
  url
  createdAt
  updatedAt
  body
  author { login avatarUrl }
  labels(first: 6) { nodes { name color } }
  comments { totalCount }
  repository { name owner { login } }
`;

const REFERENCE_FRAGMENTS = `
fragment IssueReference on Issue {
  ${COMMON_FIELDS}
  state
  stateReason
}
fragment PullReference on PullRequest {
  ${COMMON_FIELDS}
  state
  isDraft
  headRefName
  baseRefName
  headRefOid
  headRepository { name url sshUrl owner { login } }
}
`;

// The newest comments and reviews; `totalCount` says how many there are.
const DETAIL_COMMENT_LIMIT = 50;
// The newest commits, so the preview can show what each review answered.
const DETAIL_COMMIT_LIMIT = 50;
// The newest review threads, and the comments that open and answer each.
const DETAIL_THREAD_LIMIT = 50;
const DETAIL_THREAD_COMMENT_LIMIT = 50;

const DETAIL_QUERY = `
query ReferenceDetail($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue {
        number
        comments(last: ${DETAIL_COMMENT_LIMIT}) { totalCount nodes { ...DetailComment } }
      }
      ... on PullRequest {
        number
        state
        reviewDecision
        # The preview's checks, from the PR itself rather than the list's batch.
        headCommit: commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun { databaseId name status conclusion startedAt checkSuite { app { databaseId } } }
                    ... on StatusContext { context state }
                  }
                }
              }
            }
          }
        }
        reviewRequests(first: 30) { nodes { requestedReviewer { __typename ... on User { login avatarUrl } } } }
        additions
        deletions
        changedFiles
        comments(last: ${DETAIL_COMMENT_LIMIT}) { totalCount nodes { ...DetailComment } }
        commits(last: ${DETAIL_COMMIT_LIMIT}) {
          totalCount
          nodes { commit { oid messageHeadline committedDate url author { name user { login avatarUrl } } } }
        }
        reviews(last: 30) {
          nodes { author { login avatarUrl } body state createdAt url }
        }
        # Comments on lines come as the threads they open, replies included.
        reviewThreads(last: ${DETAIL_THREAD_LIMIT}) {
          nodes {
            id
            isResolved
            viewerCanResolve
            viewerCanUnresolve
            viewerCanReply
            comments(first: ${DETAIL_THREAD_COMMENT_LIMIT}) {
              nodes { author { login avatarUrl } body createdAt url path line originalLine }
            }
          }
        }
      }
    }
  }
}
fragment DetailComment on IssueComment { author { login avatarUrl } body createdAt url }
`;

const SEARCH_QUERY = `
query ReferenceSearch($q: String!, $first: Int!, $after: String) {
  search(type: ISSUE, query: $q, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ...IssueReference
      ...PullReference
    }
  }
}
${REFERENCE_FRAGMENTS}
`;

const userSchema = z.object({ login: z.string(), avatarUrl: z.string().nullable().optional() }).nullable();
const repositorySchema = z.object({ name: z.string(), owner: z.object({ login: z.string() }) });

const commonSchema = {
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  body: z.string().nullable(),
  author: userSchema,
  labels: z.object({ nodes: z.array(z.object({ name: z.string(), color: z.string().nullable() }).nullable()) }).nullable(),
  comments: z.object({ totalCount: z.number().int() }),
  repository: repositorySchema,
};

const issueNodeSchema = z.object({
  __typename: z.literal('Issue'),
  ...commonSchema,
  state: z.enum(['OPEN', 'CLOSED']),
  stateReason: z.string().nullable(),
});

const pullNodeSchema = z.object({
  __typename: z.literal('PullRequest'),
  ...commonSchema,
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: z.boolean(),
  headRefName: z.string(),
  baseRefName: z.string(),
  headRefOid: z.string(),
  headRepository: z.object({
    name: z.string(),
    url: z.string(),
    sshUrl: z.string().nullable().optional(),
    owner: z.object({ login: z.string() }),
  }).nullable(),
});

const detailCommentSchema = z.object({
  author: userSchema,
  body: z.string(),
  createdAt: z.string().nullable(),
  url: z.string(),
});

const detailSchema = z.object({
  repository: z.object({
    issueOrPullRequest: z.discriminatedUnion('__typename', [
      z.object({
        __typename: z.literal('Issue'),
        number: z.number().int(),
        comments: z.object({ totalCount: z.number().int(), nodes: z.array(detailCommentSchema) }),
      }),
      z.object({
        __typename: z.literal('PullRequest'),
        number: z.number().int(),
        state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
        reviewDecision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullable(),
        headCommit: z.object({
          nodes: z.array(z.object({
            commit: z.object({
              statusCheckRollup: z.object({ contexts: z.object({ nodes: z.array(checkContextSchema) }) }).nullable(),
            }),
          })),
        }),
        reviewRequests: z.object({
          nodes: z.array(z.object({
            requestedReviewer: z.object({
              __typename: z.string(),
              login: z.string().optional(),
              avatarUrl: z.string().nullable().optional(),
            }).nullable(),
          })),
        }),
        additions: z.number().int(),
        deletions: z.number().int(),
        changedFiles: z.number().int(),
        comments: z.object({ totalCount: z.number().int(), nodes: z.array(detailCommentSchema) }),
        commits: z.object({
          totalCount: z.number().int(),
          nodes: z.array(z.object({
            commit: z.object({
              oid: z.string(),
              messageHeadline: z.string(),
              committedDate: z.string().nullable(),
              url: z.string().nullable(),
              author: z.object({ name: z.string().nullable(), user: userSchema }).nullable(),
            }),
          })),
        }),
        reviews: z.object({
          nodes: z.array(z.object({
            author: userSchema,
            body: z.string(),
            state: z.string(),
            createdAt: z.string().nullable(),
            url: z.string(),
          })),
        }),
        reviewThreads: z.object({
          nodes: z.array(z.object({
            id: z.string().min(1),
            isResolved: z.boolean(),
            viewerCanResolve: z.boolean(),
            viewerCanUnresolve: z.boolean(),
            viewerCanReply: z.boolean(),
            comments: z.object({
              nodes: z.array(detailCommentSchema.extend({
                path: z.string().nullable(),
                line: z.number().int().nullable(),
                originalLine: z.number().int().nullable(),
              })),
            }),
          })),
        }),
      }),
    ]).nullable(),
  }).nullable(),
});

// A stack is rarely taller than a handful of layers; GitHub pages the rest.
const STACK_LAYER_LIMIT = 50;

// Asked beside the detail rather than inside it: a host whose schema has no
// stacks (an older GitHub Enterprise Server) fails this query alone.
const STACK_QUERY = `
query PullStack($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on PullRequest {
        stack {
          number
          baseRefName
          entries(first: ${STACK_LAYER_LIMIT}) {
            nodes { position pullRequest { number title url state isDraft headRefName } }
          }
        }
      }
    }
  }
}
`;

const stackSchema = z.object({
  repository: z.object({
    issueOrPullRequest: z.object({
      __typename: z.string(),
      stack: z.object({
        number: z.number().int(),
        baseRefName: z.string(),
        entries: z.object({
          nodes: z.array(z.object({
            position: z.number().int(),
            pullRequest: z.object({
              number: z.number().int(),
              title: z.string(),
              url: z.string(),
              state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
              isDraft: z.boolean(),
              headRefName: z.string(),
            }).nullable(),
          })),
        }),
      }).nullable().optional(),
    }).nullable(),
  }).nullable(),
});

/**
 * The stack a PR is a layer of, bottom layer first, or null when it is in
 * none (an issue is in none either).
 */
export async function fetchPullStack({ octokit, owner, repo, number }) {
  const parsed = stackSchema.parse(await octokit.graphql(STACK_QUERY, { owner, repo, number }));
  const stack = parsed.repository?.issueOrPullRequest?.stack;
  if (!stack) return null;
  const layers = stack.entries.nodes
    .filter((entry) => entry.pullRequest !== null)
    .sort((left, right) => left.position - right.position)
    .map(({ pullRequest }) => ({
      number: pullRequest.number,
      title: pullRequest.title,
      url: pullRequest.url,
      state: PULL_STATES[pullRequest.state],
      draft: pullRequest.isDraft,
      head: pullRequest.headRefName,
    }));
  return { number: stack.number, base: stack.baseRefName, layers };
}

const referenceNodeSchema = z.discriminatedUnion('__typename', [issueNodeSchema, pullNodeSchema]);

const REVIEW_DECISIONS = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested', REVIEW_REQUIRED: 'review_required' };
const PULL_STATES = { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' };

const repoKey = (owner, repo) => `${owner.toLowerCase()}/${repo.toLowerCase()}`;

const previewBody = (body) => {
  const text = body ?? '';
  return text.length > BODY_PREVIEW_MAX
    ? { body: text.slice(0, BODY_PREVIEW_MAX), bodyTruncated: true }
    : { body: text, bodyTruncated: false };
};

/**
 * One GraphQL node as a picker item, or null when it is not an issue or PR
 * of a repository the project searches. `repos` is the searched network:
 * the item keeps which of them it came from.
 */
export function toReference(value, repos) {
  const parsed = referenceNodeSchema.safeParse(value);
  if (!parsed.success) return null;
  const node = parsed.data;
  const sourceRepo = repos.find((entry) => repoKey(entry.owner, entry.repo) === repoKey(node.repository.owner.login, node.repository.name));
  if (!sourceRepo) return null;
  const common = {
    number: node.number,
    title: node.title,
    url: node.url,
    ...previewBody(node.body),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    author: node.author ? { login: node.author.login, avatarUrl: node.author.avatarUrl ?? undefined } : null,
    labels: (node.labels?.nodes ?? [])
      .filter((label) => label !== null)
      .map((label) => ({ name: label.name, color: label.color ?? undefined })),
    commentCount: node.comments.totalCount,
    sourceRepo: { owner: sourceRepo.owner, repo: sourceRepo.repo, source: sourceRepo.source },
  };
  if (node.__typename === 'Issue') {
    const state = node.state === 'OPEN'
      ? 'open'
      : node.stateReason === 'NOT_PLANNED' || node.stateReason === 'DUPLICATE' ? 'not_planned' : 'completed';
    return { kind: 'issue', ...common, state };
  }
  const state = PULL_STATES[node.state];
  return {
    kind: 'pull',
    ...common,
    state,
    draft: node.isDraft,
    head: node.headRefName,
    base: node.baseRefName,
    headSha: node.headRefOid,
    headRepo: node.headRepository
      ? {
          owner: node.headRepository.owner.login,
          repo: node.headRepository.name,
          url: node.headRepository.url,
          // A worktree from a fork's PR fetches over HTTPS first.
          cloneUrl: `${node.headRepository.url}.git`,
          sshUrl: node.headRepository.sshUrl ?? undefined,
        }
      : null,
  };
}

const REVIEW_STATES = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested', COMMENTED: 'commented', DISMISSED: 'dismissed' };

const toAuthor = (author) => (author ? { login: author.login, avatarUrl: author.avatarUrl ?? undefined } : null);

const byCreatedAt = (left, right) => (Date.parse(left.createdAt ?? '') || 0) - (Date.parse(right.createdAt ?? '') || 0);

/**
 * Comments of one issue or PR, oldest first, and for a PR its size, review
 * decision and checks. A PR's reviews join the comments: a review's own text
 * (or its verdict when it has none), and each review thread as the comment
 * that opened it, with its replies, whether it is resolved, and what this
 * account may do with it.
 * Null when the repo has no such number.
 */
export async function fetchReferenceDetail({ octokit, owner, repo, number }) {
  // The stack is read beside the detail; a host that cannot answer it leaves
  // the PR's stack unknown (absent), which is not the same as in none (null).
  const [response, stack] = await Promise.all([
    octokit.graphql(DETAIL_QUERY, { owner, repo, number }),
    fetchPullStack({ octokit, owner, repo, number }).catch(() => undefined),
  ]);
  const parsed = detailSchema.parse(response);
  const item = parsed.repository?.issueOrPullRequest;
  if (!item) return null;
  const comments = item.comments.nodes.map((comment) => ({
    author: toAuthor(comment.author),
    body: comment.body,
    createdAt: comment.createdAt,
    url: comment.url,
    path: null,
    line: null,
    review: null,
  }));
  if (item.__typename === 'Issue') {
    return { number: item.number, comments, commentTotal: item.comments.totalCount, pull: null };
  }
  for (const review of item.reviews.nodes) {
    const state = REVIEW_STATES[review.state] ?? null;
    // A review with no text is only the container of its line comments,
    // unless it carries a verdict.
    if (review.body.trim() || state === 'approved' || state === 'changes_requested') {
      comments.push({ author: toAuthor(review.author), body: review.body, createdAt: review.createdAt, url: review.url, path: null, line: null, review: state });
    }
  }
  const lineComment = (comment) => ({
    author: toAuthor(comment.author),
    body: comment.body,
    createdAt: comment.createdAt,
    url: comment.url,
    path: comment.path,
    line: comment.line ?? comment.originalLine,
    review: 'commented',
  });
  // A thread reads as its first comment with the answers under it.
  for (const thread of item.reviewThreads.nodes) {
    const [first, ...replies] = thread.comments.nodes;
    if (!first) continue;
    comments.push({
      ...lineComment(first),
      thread: {
        id: thread.id,
        resolved: thread.isResolved,
        canResolve: thread.isResolved ? thread.viewerCanUnresolve : thread.viewerCanResolve,
        canReply: thread.viewerCanReply,
        replies: replies.map(lineComment),
      },
    });
  }
  comments.sort(byCreatedAt);
  const detail = {
    number: item.number,
    comments,
    commentTotal: item.comments.totalCount,
    pull: {
      reviewDecision: item.reviewDecision ? REVIEW_DECISIONS[item.reviewDecision] : null,
      // People asked to review and not done yet; a team request is left out
      // since the board only picks people.
      reviewers: item.reviewRequests.nodes.flatMap(({ requestedReviewer: reviewer }) => (
        reviewer?.__typename === 'User' && reviewer.login
          ? [{ id: reviewer.login, ...toAuthor({ login: reviewer.login, avatarUrl: reviewer.avatarUrl }) }]
          : []
      )),
      // Like the list's statuses: a closed or merged PR's checks are not actionable.
      checks: item.state === 'OPEN'
        ? summarizeCheckContexts(item.headCommit.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [])
        : null,
      additions: item.additions,
      deletions: item.deletions,
      changedFiles: item.changedFiles,
      commits: item.commits.nodes.map(({ commit }) => ({
        sha: commit.oid,
        headline: commit.messageHeadline,
        author: toAuthor(commit.author?.user ?? null),
        authorName: commit.author?.name ?? null,
        committedAt: commit.committedDate,
        url: commit.url,
      })),
      commitTotal: item.commits.totalCount,
    },
  };
  if (stack !== undefined) detail.pull.stack = stack;
  return detail;
}

// One request per listed page of PRs.
const PULL_STATUS_LIMIT = REFERENCE_PAGE_SIZE;

/**
 * The PRs a status request names, `owner/repo#number` joined by commas, as
 * summary refs. A ref may carry `@host` when it lives on a GitHub Enterprise
 * instance; a missing (or `github.com`) host is the default. Null when the list
 * is empty, malformed or longer than a page.
 */
export function readPullStatusRefs(value) {
  const entries = String(value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0 || entries.length > PULL_STATUS_LIMIT) return null;
  const refs = [];
  for (const entry of entries) {
    const match = entry.match(/^([^/#\s]+)\/([^/#\s]+)#(\d+)(?:@([^#@\s]+))?$/);
    if (!match) return null;
    const ref = { owner: match[1], repo: match[2], number: Number(match[3]) };
    // A host the ref names, normalized. github.com is the default either way, so
    // it is left off; only a real enterprise host is carried.
    const host = match[4]?.trim().toLowerCase();
    if (host && host !== 'github.com') {
      ref.host = host;
    }
    refs.push(ref);
  }
  return parseSummaryRefs(refs);
}

const stateSchema = z.enum(['open', 'closed', 'merged', 'all']).catch('open');
const peopleSchema = z.enum(['any', 'assigned', 'created', 'reviewRequested']).catch('any');
const kindSchema = z.enum(['issue', 'pull']).nullable().catch(null);

/** A list's state; anything else reads as `open`. */
export function readReferenceState(value) {
  return stateSchema.parse(value);
}

/** Whose items a list shows; anything else reads as `any`. */
export function readReferencePeople(value) {
  return peopleSchema.parse(value);
}

/** `issue` or `pull`; anything else is null. */
export function readReferenceKind(value) {
  return kindSchema.parse(value ?? null);
}

const searchResultSchema = z.object({
  search: z.object({
    issueCount: z.number().int(),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
    nodes: z.array(z.unknown()),
  }),
});

/**
 * The item a pasted link or number names: a number for every searched repo,
 * a URL only for its own repo. Null when the text is a search.
 */
export function parseReferenceLookup(text, repos) {
  const trimmed = text.trim();
  const hash = trimmed.match(/^#?(\d+)$/);
  if (hash) {
    return { number: Number(hash[1]), repos };
  }
  const url = trimmed.match(/^(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/(\d+)(?:[/?#]\S*)?$/i);
  if (url) {
    const target = repos.filter((entry) => repoKey(entry.owner, entry.repo) === repoKey(url[1], url[2]));
    return { number: Number(url[3]), repos: target };
  }
  return null;
}

/**
 * The GitHub search string for one picker page. The user's text may carry
 * its own qualifiers; state and sort are added only when it does not.
 */
export function buildReferenceSearchQuery({ repos, kind, state, people, text }) {
  const userText = text.trim();
  const parts = repos.map((entry) => `repo:${entry.owner}/${entry.repo}`);
  parts.push(kind === 'pull' ? 'is:pr' : 'is:issue');
  if (!/(^|\s)(is:(open|closed|merged|unmerged)|state:\S+)/i.test(userText)) {
    // An issue is never merged; the nearest list is its closed one.
    const stateQualifier = SEARCH_STATES[kind === 'issue' && state === 'merged' ? 'closed' : state];
    if (stateQualifier) parts.push(stateQualifier);
  }
  if (!/(^|\s)sort:\S+/i.test(userText)) {
    parts.push('sort:updated-desc');
  }
  // Review requests exist for pull requests only.
  const peopleQualifier = kind === 'issue' && people === 'reviewRequested' ? '' : SEARCH_PEOPLE[people];
  if (peopleQualifier) parts.push(peopleQualifier);
  if (userText) parts.push(userText);
  return parts.join(' ');
}

function buildLookupQuery(number, repos) {
  const variables = { number };
  const declarations = ['$number: Int!'];
  const selections = repos.map((entry, index) => {
    variables[`o${index}`] = entry.owner;
    variables[`n${index}`] = entry.repo;
    declarations.push(`$o${index}: String!, $n${index}: String!`);
    return `a${index}: repository(owner: $o${index}, name: $n${index}) {
      issueOrPullRequest(number: $number) { __typename ...IssueReference ...PullReference }
    }`;
  });
  return {
    query: `query ReferenceLookup(${declarations.join(', ')}) {\n${selections.join('\n')}\n}\n${REFERENCE_FRAGMENTS}`,
    variables,
  };
}

// A number one repo does not have is a per-alias NOT_FOUND next to the other
// aliases' data. Keep the data; rethrow only when there is none.
async function runPartialQuery(octokit, query, variables) {
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
 * One page of the picker. `repos` is the project's repo network, origin
 * first. A lookup answers every repo that has the number, both kinds; a
 * search answers one kind, newest activity first.
 */
export async function searchGitHubReferences({ octokit, repos, kind, state, people, text, cursor }) {
  const lookup = parseReferenceLookup(text, repos);
  if (lookup) {
    if (lookup.repos.length === 0) {
      return { items: [], cursor: null, hasMore: false, total: 0 };
    }
    const { query, variables } = buildLookupQuery(lookup.number, lookup.repos);
    const data = await runPartialQuery(octokit, query, variables);
    const items = lookup.repos
      .map((_entry, index) => toReference(data?.[`a${index}`]?.issueOrPullRequest, repos))
      .filter((item) => item !== null);
    return { items, cursor: null, hasMore: false, total: items.length };
  }

  const { search } = searchResultSchema.parse(await octokit.graphql(SEARCH_QUERY, {
    q: buildReferenceSearchQuery({ repos, kind, state, people, text }),
    first: REFERENCE_PAGE_SIZE,
    after: cursor || null,
  }));
  const items = search.nodes
    .map((node) => toReference(node, repos))
    .filter((item) => item !== null && item.kind === kind);
  return {
    items,
    cursor: search.pageInfo.endCursor,
    hasMore: search.pageInfo.hasNextPage,
    total: search.issueCount,
  };
}

const acrossCursorSchema = z.strictObject({
  version: z.literal(2),
  scope: z.string().regex(/^[a-f0-9]{64}$/),
  searches: z.array(z.strictObject({
    // The GitHub page the search resumes on, and how many of its items were already shown.
    cursor: z.string().min(1).max(10_000).nullable(),
    offset: z.number().int().min(0).max(REFERENCE_PAGE_SIZE),
    done: z.boolean(),
    total: z.number().int().nonnegative(),
  })).max(300),
});

const updatedAtOf = (item) => Date.parse(item.updatedAt ?? '') || 0;

function readAcrossCursor(cursor, scope, searchCount) {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 100_000) throw invalidAcrossCursor();
    const decoded = Buffer.from(cursor, 'base64url');
    if (decoded.toString('base64url') !== cursor) throw invalidAcrossCursor();
    const parsed = acrossCursorSchema.parse(JSON.parse(decoded.toString('utf8')));
    if (parsed.scope !== scope || parsed.searches.length !== searchCount || parsed.searches.every((position) => position.done)) {
      throw invalidAcrossCursor();
    }
    return parsed.searches;
  } catch {
    throw invalidAcrossCursor();
  }
}

/**
 * Search each exact-account group in chunks, then merge them newest first.
 * A failed group is reported through onGroupError and contributes no items.
 *
 * Every page is newest first across all searches, later pages included: an
 * item is shown only once no unfinished search can still hold a newer one,
 * that is, when it is at least as new as the oldest item read from every
 * search with more pages. The rest wait for a later page, which reads the
 * same GitHub page again and skips what was shown (`offset`). The composite
 * cursor, even for one search, pins the query and the ordered
 * account/repository authority, so a page is never read against another set.
 */
export async function searchGitHubReferencesAcross({ groups, kind, state, people, text, cursor, onGroupError }) {
  const searches = groups.flatMap((group, groupIndex) => {
    const chunks = [];
    for (let offset = 0; offset < group.repos.length; offset += ACROSS_REPO_CHUNK_SIZE) {
      chunks.push({ group, groupIndex, repos: group.repos.slice(offset, offset + ACROSS_REPO_CHUNK_SIZE) });
    }
    return chunks;
  });
  const lookup = parseReferenceLookup(text, []);
  if (lookup && cursor) throw invalidAcrossCursor();
  const scope = createHash('sha256').update(JSON.stringify({
    kind, state, people, text,
    searches: searches.map(({ group, repos }) => ({ accountId: group.accountId, authority: group.authority,
      repos: repos.map((repo) => ({ key: repoKey(repo.owner, repo.repo), directory: repo.directory })) })),
  })).digest('hex');
  const positions = cursor
    ? readAcrossCursor(cursor, scope, searches.length)
    : searches.map(() => ({ cursor: null, offset: 0, done: false, total: 0 }));
  const pages = await mapReferencesAcross(searches, async ({ group, repos }, index) => {
    const position = positions[index];
    if (position.done) return { done: true, items: [], total: position.total };
    try {
      const page = await searchGitHubReferences({ octokit: group.octokit, repos, kind, state, people, text, cursor: position.cursor });
      if (page.hasMore && !page.cursor) throw new Error('GitHub returned an invalid search cursor');
      const items = page.items.slice(position.offset).map((item) => ({ ...item,
        directory: repos.find((repo) => repoKey(repo.owner, repo.repo) === repoKey(item.sourceRepo.owner, item.sourceRepo.repo)).directory,
      }));
      return { done: false, items, hasMore: page.hasMore, endCursor: page.cursor, total: page.total };
    } catch (error) {
      return { error };
    }
  });
  const failedGroups = new Set();
  for (let index = 0; index < pages.length; index++) {
    if (!pages[index].error || failedGroups.has(searches[index].groupIndex)) continue;
    failedGroups.add(searches[index].groupIndex);
    await onGroupError(searches[index].group, pages[index].error);
  }
  const live = pages.map((page, index) => (failedGroups.has(searches[index].groupIndex) || page.done ? null : page));
  // Anything a search with more pages has not read yet is older than the last item it read.
  const bound = Math.max(-Infinity, ...live
    .filter((page) => page?.hasMore && page.items.length > 0)
    .map((page) => updatedAtOf(page.items[page.items.length - 1])));
  let shown = live.map((page) => {
    if (!page) return 0;
    const count = page.items.findIndex((item) => updatedAtOf(item) < bound);
    return count === -1 ? page.items.length : count;
  });
  // A query with its own `sort:` is not newest first; show what was read rather than stall.
  if (shown.every((count) => count === 0)) shown = live.map((page) => page?.items.length ?? 0);
  const items = live.flatMap((page, index) => page?.items.slice(0, shown[index]) ?? []);
  if (searches.length > 1 || lookup) items.sort((left, right) => updatedAtOf(right) - updatedAtOf(left));
  const nextPositions = pages.map((page, index) => {
    if (failedGroups.has(searches[index].groupIndex)) return { cursor: null, offset: 0, done: true, total: 0 };
    if (page.done) return positions[index];
    if (shown[index] < page.items.length) {
      return { cursor: positions[index].cursor, offset: positions[index].offset + shown[index], done: false, total: page.total };
    }
    return page.hasMore
      ? { cursor: page.endCursor, offset: 0, done: false, total: page.total }
      : { cursor: null, offset: 0, done: true, total: page.total };
  });
  const hasMore = !lookup && nextPositions.some((position) => !position.done);
  return {
    items,
    total: nextPositions.reduce((total, position) => total + position.total, 0),
    hasMore,
    cursor: hasMore ? Buffer.from(JSON.stringify({ version: 2, scope, searches: nextPositions })).toString('base64url') : null,
  };
}
