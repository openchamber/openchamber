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

import { isGraphqlRateLimitError, parseSummaryRefs } from './pr-summaries.js';

const REFERENCE_PAGE_SIZE = 30;
// The preview shows the description; the attach path reads the full one.
const BODY_PREVIEW_MAX = 20_000;
// Keys match the filter schema below.
const SEARCH_FILTERS = {
  open: '',
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
        reviewDecision
        additions
        deletions
        changedFiles
        comments(last: ${DETAIL_COMMENT_LIMIT}) { totalCount nodes { ...DetailComment } }
        reviews(last: 30) {
          nodes {
            author { login avatarUrl }
            body
            state
            createdAt
            url
            comments(first: 30) {
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
        reviewDecision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullable(),
        additions: z.number().int(),
        deletions: z.number().int(),
        changedFiles: z.number().int(),
        comments: z.object({ totalCount: z.number().int(), nodes: z.array(detailCommentSchema) }),
        reviews: z.object({
          nodes: z.array(z.object({
            author: userSchema,
            body: z.string(),
            state: z.string(),
            createdAt: z.string().nullable(),
            url: z.string(),
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
 * (or its verdict when it has none) and each comment it left on a line.
 * Null when the repo has no such number.
 */
export async function fetchReferenceDetail({ octokit, owner, repo, number }) {
  const parsed = detailSchema.parse(await octokit.graphql(DETAIL_QUERY, { owner, repo, number }));
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
    for (const comment of review.comments.nodes) {
      comments.push({
        author: toAuthor(comment.author),
        body: comment.body,
        createdAt: comment.createdAt,
        url: comment.url,
        path: comment.path,
        line: comment.line ?? comment.originalLine,
        review: 'commented',
      });
    }
  }
  comments.sort(byCreatedAt);
  return {
    number: item.number,
    comments,
    commentTotal: item.comments.totalCount,
    pull: {
      reviewDecision: item.reviewDecision ? REVIEW_DECISIONS[item.reviewDecision] : null,
      additions: item.additions,
      deletions: item.deletions,
      changedFiles: item.changedFiles,
    },
  };
}

// One request per listed page of PRs.
const PULL_STATUS_LIMIT = REFERENCE_PAGE_SIZE;

/**
 * The PRs a status request names, `owner/repo#number` joined by commas, as
 * summary refs. Null when the list is empty, malformed or longer than a page.
 */
export function readPullStatusRefs(value) {
  const entries = String(value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0 || entries.length > PULL_STATUS_LIMIT) return null;
  const refs = [];
  for (const entry of entries) {
    const match = entry.match(/^([^/#\s]+)\/([^/#\s]+)#(\d+)$/);
    if (!match) return null;
    refs.push({ owner: match[1], repo: match[2], number: Number(match[3]) });
  }
  return parseSummaryRefs(refs);
}

const filterSchema = z.enum(['open', 'assigned', 'created', 'reviewRequested']).catch('open');
const kindSchema = z.enum(['issue', 'pull']).nullable().catch(null);

/** The picker's filter values; anything else reads as `open`. */
export function readReferenceFilter(value) {
  return filterSchema.parse(value);
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
export function buildReferenceSearchQuery({ repos, kind, filter, text }) {
  const userText = text.trim();
  const parts = repos.map((entry) => `repo:${entry.owner}/${entry.repo}`);
  parts.push(kind === 'pull' ? 'is:pr' : 'is:issue');
  if (!/(^|\s)(is:(open|closed|merged|unmerged)|state:\S+)/i.test(userText)) {
    parts.push('is:open');
  }
  if (!/(^|\s)sort:\S+/i.test(userText)) {
    parts.push('sort:updated-desc');
  }
  const qualifier = SEARCH_FILTERS[filter];
  if (qualifier) parts.push(qualifier);
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
export async function searchGitHubReferences({ octokit, repos, kind, filter, text, cursor }) {
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
    q: buildReferenceSearchQuery({ repos, kind, filter, text }),
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
