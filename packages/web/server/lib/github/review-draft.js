import { z } from 'zod';

/**
 * A pull request's review as the diff draws it: the viewer's pending review
 * and the published threads with where each sits. GitHub keeps the pending
 * review, so one started on another device, on github.com or by an agent
 * through `gh` reads the same as one started here.
 */

const THREAD_PAGE = 100;
const THREAD_PAGE_LIMIT = 10;
const THREAD_COMMENT_LIMIT = 50;
const PENDING_COMMENT_LIMIT = 100;

const author = z.object({ login: z.string(), avatarUrl: z.string().nullish() }).nullish();
const threadSchema = z.object({
  id: z.string(),
  path: z.string(),
  line: z.number().int().nullish(),
  startLine: z.number().int().nullish(),
  diffSide: z.enum(['LEFT', 'RIGHT']),
  subjectType: z.enum(['LINE', 'FILE']),
  isOutdated: z.boolean(),
  isResolved: z.boolean(),
  viewerCanReply: z.boolean(),
  viewerCanResolve: z.boolean(),
  viewerCanUnresolve: z.boolean(),
  comments: z.object({
    nodes: z.array(z.object({
      id: z.string(),
      state: z.string(),
      body: z.string(),
      createdAt: z.string(),
      url: z.string(),
      author,
    }).nullable()),
  }),
});
const pendingSchema = z.object({
  id: z.string(),
  viewerDidAuthor: z.boolean(),
  body: z.string(),
  comments: z.object({
    nodes: z.array(z.object({
      id: z.string(),
      body: z.string(),
      path: z.string(),
      line: z.number().int().nullish(),
      startLine: z.number().int().nullish(),
      subjectType: z.enum(['LINE', 'FILE']).nullish(),
      author,
    }).nullable()),
  }),
});
const pullSchema = z.object({
  viewerDidAuthor: z.boolean(),
  headRefOid: z.string(),
  reviews: z.object({ nodes: z.array(pendingSchema.nullable()) }),
  reviewThreads: z.object({
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() }),
    nodes: z.array(threadSchema.nullable()),
  }),
});

const PENDING_REVIEWS = `reviews(states: [PENDING], first: 5) {
  nodes {
    id viewerDidAuthor body
    comments(first: ${PENDING_COMMENT_LIMIT}) {
      nodes { id body path line startLine subjectType author { login avatarUrl } }
    }
  }
}`;

const REVIEW_STATE_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      viewerDidAuthor
      headRefOid
      ${PENDING_REVIEWS}
      reviewThreads(first: ${THREAD_PAGE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id path line startLine diffSide subjectType
          isOutdated isResolved viewerCanReply viewerCanResolve viewerCanUnresolve
          comments(first: ${THREAD_COMMENT_LIMIT}) {
            nodes { id state body createdAt url author { login avatarUrl } }
          }
        }
      }
    }
  }
}`;

const PENDING_REVIEW_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) { reviews(states: [PENDING], first: 5) { nodes { id viewerDidAuthor commit { oid } } } }
  }
}`;

const toAuthor = (value) => (value ? { login: value.login, avatarUrl: value.avatarUrl ?? undefined } : null);
const toSide = (diffSide) => (diffSide === 'LEFT' ? 'old' : 'new');

const toThread = (thread) => {
  const comments = thread.comments.nodes
    .filter((comment) => comment && comment.state !== 'PENDING')
    .map(({ id, body, createdAt, url, author: writer }) => ({ id, body, createdAt, url, author: toAuthor(writer) }));
  return {
    id: thread.id,
    path: thread.path,
    side: toSide(thread.diffSide),
    line: thread.subjectType === 'FILE' ? null : thread.line ?? null,
    startLine: thread.startLine ?? null,
    resolved: thread.isResolved,
    canReply: thread.viewerCanReply,
    canResolve: thread.isResolved ? thread.viewerCanUnresolve : thread.viewerCanResolve,
    comments,
  };
};

/**
 * The side lives on the thread, the pending text on the review, so a draft
 * comment takes its side from the thread that holds it.
 */
const toDraft = (pending, sides) => (pending ? {
  id: pending.id,
  body: pending.body,
  comments: pending.comments.nodes.filter(Boolean).map((comment) => ({
    id: comment.id,
    path: comment.path,
    side: sides.get(comment.id) ?? 'new',
    line: comment.subjectType === 'FILE' ? null : comment.line ?? null,
    startLine: comment.startLine ?? null,
    body: comment.body,
    author: toAuthor(comment.author),
  })),
} : null);

/** The review state of one pull request; a thread GitHub calls outdated has no line left here and stays on the board. */
export async function fetchReviewState({ octokit, owner, repo, number }) {
  const threads = [];
  let first = null;
  let after = null;
  let truncated = false;
  for (let page = 0; page < THREAD_PAGE_LIMIT; page += 1) {
    const data = await octokit.graphql(REVIEW_STATE_QUERY, { owner, repo, number, after });
    const value = data?.repository?.pullRequest;
    if (!value) throw Object.assign(new Error('GitHub pull request was not found'), { status: 404 });
    const pull = pullSchema.parse(value);
    first ??= pull;
    threads.push(...pull.reviewThreads.nodes.filter(Boolean));
    if (!pull.reviewThreads.pageInfo.hasNextPage) break;
    after = pull.reviewThreads.pageInfo.endCursor ?? null;
    truncated = page === THREAD_PAGE_LIMIT - 1;
  }
  const pending = first.reviews.nodes.find((review) => review?.viewerDidAuthor) ?? null;
  const sides = new Map(threads.flatMap((thread) => (
    thread.comments.nodes.filter(Boolean).map((comment) => [comment.id, toSide(thread.diffSide)])
  )));
  return {
    connected: true,
    viewerIsAuthor: first.viewerDidAuthor,
    headSha: first.headRefOid,
    draft: toDraft(pending, sides),
    threads: threads.filter((thread) => !thread.isOutdated).map(toThread).filter((thread) => thread.comments.length > 0),
    truncated,
  };
}

/** The viewer's pending review and the commit it was started on, null without one. GitHub keeps one per person per pull request. */
export async function readPendingReview({ octokit, owner, repo, number }) {
  const data = await octokit.graphql(PENDING_REVIEW_QUERY, { owner, repo, number });
  const reviews = data?.repository?.pullRequest?.reviews?.nodes;
  if (!Array.isArray(reviews)) return null;
  const review = reviews.find((entry) => entry?.viewerDidAuthor === true);
  return review ? { id: review.id, commit: review.commit?.oid ?? null } : null;
}
