import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { SourceControlJson } from '@openchamber/sdk';
import { checkContextSchema, isGraphqlRateLimitError, parseSummaryRefs, summarizeCheckContexts, toDiscussionState } from './pr-summaries.js';
import { graphqlAliasesSchema, hasProperty, retainedEntry, referenceDirectory, livePage, referenceNodeAt } from './contracts.js';
import type { Octokit, PullRequestQuery, GitHubEnvelope, SummaryRef, AcrossContext, ReferenceRepo, Reference, DetailLineComment, DetailEntry, StatusDictionary, SearchInput, AcrossGroup, AcrossPosition, CommentPermissions, EditableText, ReferenceDetail, LookupVariables, AcrossPage, AcrossSearchInput } from './contracts.js';

const REFERENCE_PAGE_SIZE = 30;
const ACROSS_REPO_CHUNK_SIZE = 40;
const ACROSS_CONCURRENCY = 4;

export const acrossContextSchema = z.strictObject({
  directory: z.string().trim().min(1),
  repositoryId: z.string().min(1),
  provider: z.literal('github'),
  instance: z.string().min(1),
  accountId: z.string().min(1),
  bindingRevision: z.number().int().nonnegative(),
  primaryRemote: z.string().min(1),
});
export const acrossRequestSchema = z.strictObject({
  contexts: z.array(acrossContextSchema),
  kind: z.enum(['issue', 'pull', 'discussion']),
  state: z.enum(['open', 'closed', 'merged', 'all', 'unanswered']).optional(),
  people: z.enum(['any', 'assigned', 'created', 'reviewRequested']).optional(),
  labels: z.array(z.string()).optional(),
  query: z.string().optional(),
  cursor: z.string().max(100_000).nullable().optional(),
});

const invalidAcrossCursor = () => Object.assign(new Error('Invalid references cursor'), { status: 400, code: 'INVALID_REFERENCES_CURSOR' });

export function readReferencesAcrossRequest(body: SourceControlJson) {
  const parsed = acrossRequestSchema.safeParse(body);
  if (!parsed.success) return null;
  const folders = new Map<string, AcrossContext>();
  for (const context of parsed.data.contexts) {
    if (!folders.has(context.directory)) folders.set(context.directory, context);
  }
  const labels = [...new Set((parsed.data.labels ?? []).map((label) => label.trim()).filter((label) => label.length > 0 && label.length <= 256))].slice(0, 20);
  return folders.size > 100 ? null : { ...parsed.data, labels, contexts: [...folders.values()], directories: parsed.data.contexts.map((context) => context.directory) };
}

export async function mapReferencesAcross<Entry extends object, Result>(entries: Entry[], operation: (entry: Entry, index: number) => Promise<Result>) {
  const results = new Array<Result>(entries.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(ACROSS_CONCURRENCY, entries.length) }, async () => {
    while (next < entries.length) {
      const index = next++;
      results[index] = await operation(retainedEntry(entries, index), index);
    }
  }));
  return results;
}
const BODY_PREVIEW_MAX = 20_000;
const SEARCH_STATES = {
  open: 'is:open',
  closed: 'is:closed',
  merged: 'is:merged',
  all: '',
  unanswered: 'is:open is:unanswered',
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

const DISCUSSION_FRAGMENT = `
fragment DiscussionReference on Discussion {
  ${COMMON_FIELDS}
  closed
  stateReason
  isAnswered
  locked
  upvoteCount
  category { name emojiHTML isAnswerable }
}
`;

const DETAIL_COMMENT_LIMIT = 50;
const DETAIL_COMMIT_LIMIT = 50;
const DETAIL_THREAD_LIMIT = 50;
const DETAIL_THREAD_COMMENT_LIMIT = 50;

const DETAIL_QUERY = `
query ReferenceDetail($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue {
        number
        body
        viewerCanUpdate
        comments(last: ${DETAIL_COMMENT_LIMIT}) { totalCount nodes { ...DetailComment } }
      }
      ... on PullRequest {
        number
        body
        viewerCanUpdate
        state
        reviewDecision
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
        reviewThreads(last: ${DETAIL_THREAD_LIMIT}) {
          nodes {
            id
            isResolved
            viewerCanResolve
            viewerCanUnresolve
            viewerCanReply
            comments(first: ${DETAIL_THREAD_COMMENT_LIMIT}) {
              nodes { author { login avatarUrl } body createdAt url path line originalLine startLine originalStartLine diffHunk }
            }
          }
        }
      }
    }
  }
}
fragment DetailComment on IssueComment { databaseId author { login avatarUrl } body createdAt url viewerCanUpdate viewerCanDelete }
`;

const DISCUSSION_DETAIL_QUERY = `
query DiscussionDetail($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    discussion(number: $number) {
      number
      body
      locked
      viewerCanUpdate
      viewerCanClose
      viewerCanReopen
      category { isAnswerable }
      comments(last: ${DETAIL_COMMENT_LIMIT}) {
        totalCount
        nodes {
          id
          author { login avatarUrl }
          body
          createdAt
          url
          isAnswer
          viewerCanMarkAsAnswer
          viewerCanUnmarkAsAnswer
          viewerCanUpdate
          viewerCanDelete
          replies(first: ${DETAIL_THREAD_COMMENT_LIMIT}) {
            nodes { id author { login avatarUrl } body createdAt url viewerCanUpdate viewerCanDelete }
          }
        }
      }
    }
  }
}
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

const DISCUSSION_SEARCH_QUERY = `
query DiscussionSearch($q: String!, $first: Int!, $after: String) {
  search(type: DISCUSSION, query: $q, first: $first, after: $after) {
    discussionCount
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ...DiscussionReference
    }
  }
}
${DISCUSSION_FRAGMENT}
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

const discussionNodeSchema = z.object({
  __typename: z.literal('Discussion'),
  ...commonSchema,
  closed: z.boolean(),
  stateReason: z.string().nullable(),
  isAnswered: z.boolean().nullable(),
  locked: z.boolean(),
  upvoteCount: z.number().int(),
  category: z.object({ name: z.string(), emojiHTML: z.string().nullable().optional(), isAnswerable: z.boolean() }),
});

export const detailCommentSchema = z.object({
  databaseId: z.number().int().nullable().optional(),
  author: userSchema,
  body: z.string(),
  createdAt: z.string().nullable(),
  url: z.string(),
  viewerCanUpdate: z.boolean().optional(),
  viewerCanDelete: z.boolean().optional(),
});

const discussionDetailSchema = z.object({
  repository: z.object({
    discussion: z.object({
      number: z.number().int(),
      body: z.string().optional(),
      locked: z.boolean(),
      viewerCanUpdate: z.boolean(),
      viewerCanClose: z.boolean(),
      viewerCanReopen: z.boolean(),
      category: z.object({ isAnswerable: z.boolean() }),
      comments: z.object({
        totalCount: z.number().int(),
        nodes: z.array(detailCommentSchema.extend({
          id: z.string().min(1),
          isAnswer: z.boolean(),
          viewerCanMarkAsAnswer: z.boolean(),
          viewerCanUnmarkAsAnswer: z.boolean(),
          replies: z.object({ nodes: z.array(detailCommentSchema.extend({ id: z.string().min(1) })) }),
        })),
      }),
    }).nullable(),
  }).nullable(),
});

const detailSchema = z.object({
  repository: z.object({
    issueOrPullRequest: z.discriminatedUnion('__typename', [
      z.object({
        __typename: z.literal('Issue'),
        number: z.number().int(),
        body: z.string().optional(),
        viewerCanUpdate: z.boolean().optional(),
        comments: z.object({ totalCount: z.number().int(), nodes: z.array(detailCommentSchema) }),
      }),
      z.object({
        __typename: z.literal('PullRequest'),
        number: z.number().int(),
        body: z.string().optional(),
        viewerCanUpdate: z.boolean().optional(),
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
                startLine: z.number().int().nullable().optional(),
                originalStartLine: z.number().int().nullable().optional(),
                diffHunk: z.string().nullable().optional(),
              })),
            }),
          })),
        }),
      }),
    ]).nullable(),
  }).nullable(),
});

const EXCERPT_LINE_LIMIT = 200;

export const reviewCommentExcerpt = (comment: Pick<DetailLineComment, 'line' | 'originalLine' | 'startLine' | 'originalStartLine' | 'diffHunk'>) => {
  const current = comment.line !== null && comment.line !== undefined;
  const end = current ? comment.line : comment.originalLine;
  const start = (current ? comment.startLine : comment.originalStartLine) ?? end;
  if (!comment.diffHunk || end == null || start == null || !Number.isSafeInteger(end) || !Number.isSafeInteger(start) || start < 1 || start > end) return undefined;
  const count = end - start + 1;
  if (count > EXCERPT_LINE_LIMIT) return undefined;
  const [header, ...body] = comment.diffHunk.replace(/\r\n/g, '\n').split('\n');
  if (!header?.startsWith('@@')) return undefined;
  const newSide = body.filter((line) => line.startsWith(' ') || line.startsWith('+')).map((line) => line.slice(1));
  if (newSide.length < count) return undefined;
  return { startLine: start, lines: newSide.slice(-count) };
};

const STACK_LAYER_LIMIT = 50;

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

export async function fetchPullStack({ octokit, owner, repo, number }: PullRequestQuery) {
  const parsed = stackSchema.parse(await octokit.graphql(STACK_QUERY, { owner, repo, number }));
  const stack = parsed.repository?.issueOrPullRequest?.stack;
  if (!stack) return null;
  const layers = stack.entries.nodes
    .filter((entry): entry is typeof entry & { pullRequest: NonNullable<typeof entry.pullRequest> } => entry.pullRequest !== null)
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

const referenceNodeSchema = z.discriminatedUnion('__typename', [issueNodeSchema, pullNodeSchema, discussionNodeSchema]);

const REVIEW_DECISIONS = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested', REVIEW_REQUIRED: 'review_required' };
const PULL_STATES = { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' };

const repoKey = (owner: string, repo: string) => `${owner.toLowerCase()}/${repo.toLowerCase()}`;

const categoryEmoji = (html: string | null | undefined) => {
  const text = String(html ?? '').replace(/<[^>]*>/g, '').trim();
  return text && text.length <= 16 && !/[<>&]/.test(text) ? text : null;
};

const previewBody = (body: string | null) => {
  const text = body ?? '';
  return text.length > BODY_PREVIEW_MAX
    ? { body: text.slice(0, BODY_PREVIEW_MAX), bodyTruncated: true }
    : { body: text, bodyTruncated: false };
};

export function toReference(value: GitHubEnvelope['data'], repos: ReferenceRepo[]) {
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
  if (node.__typename === 'Discussion') {
    return {
      kind: 'discussion',
      ...common,
      state: toDiscussionState(node),
      answered: node.category.isAnswerable ? node.isAnswered === true : null,
      upvotes: node.upvoteCount,
      locked: node.locked,
      category: { name: node.category.name, emoji: categoryEmoji(node.category.emojiHTML), answerable: node.category.isAnswerable },
    };
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
          cloneUrl: `${node.headRepository.url}.git`,
          sshUrl: node.headRepository.sshUrl ?? undefined,
        }
      : null,
  };
}

const REVIEW_STATES: StatusDictionary = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested', COMMENTED: 'commented', DISMISSED: 'dismissed' };

const toAuthor = (author: z.infer<typeof userSchema> | undefined) => (author ? { login: author.login, avatarUrl: author.avatarUrl ?? undefined } : null);

const commentPermissions = (comment: Pick<z.infer<typeof detailCommentSchema>, 'viewerCanUpdate' | 'viewerCanDelete'>) => {
  const permissions: CommentPermissions = {};
  if (comment.viewerCanUpdate !== undefined) permissions.canUpdate = comment.viewerCanUpdate;
  if (comment.viewerCanDelete !== undefined) permissions.canDelete = comment.viewerCanDelete;
  return permissions;
};

const byCreatedAt = (left: Pick<DetailEntry, 'createdAt'>, right: Pick<DetailEntry, 'createdAt'>) => (Date.parse(left.createdAt ?? '') || 0) - (Date.parse(right.createdAt ?? '') || 0);

const editableText = (item: { body?: string | undefined; viewerCanUpdate?: boolean | undefined }) => {
  const text: EditableText = {};
  if (item.body !== undefined) text.body = item.body;
  if (item.viewerCanUpdate !== undefined) text.viewerCanUpdate = item.viewerCanUpdate;
  return text;
};

export async function fetchReferenceDetail({ octokit, owner, repo, number }: PullRequestQuery) {
  const [response, stack] = await Promise.all([
    octokit.graphql(DETAIL_QUERY, { owner, repo, number }),
    fetchPullStack({ octokit, owner, repo, number }).catch(() => undefined),
  ]);
  const parsed = detailSchema.parse(response);
  const item = parsed.repository?.issueOrPullRequest;
  if (!item) return null;
  const comments: DetailEntry[] = item.comments.nodes.map((comment) => {
    const entry: DetailEntry = {
      author: toAuthor(comment.author),
      body: comment.body,
      createdAt: comment.createdAt,
      url: comment.url,
      path: null,
      line: null,
      review: null,
      ...commentPermissions(comment),
    };
    if (Number.isSafeInteger(comment.databaseId)) entry.id = String(comment.databaseId);
    return entry;
  });
  if (item.__typename === 'Issue') {
    return { number: item.number, ...editableText(item), comments, commentTotal: item.comments.totalCount, pull: null };
  }
  for (const review of item.reviews.nodes) {
    const state = REVIEW_STATES[review.state] ?? null;
    if (review.body.trim() || state === 'approved' || state === 'changes_requested') {
      comments.push({ author: toAuthor(review.author), body: review.body, createdAt: review.createdAt, url: review.url, path: null, line: null, review: state });
    }
  }
  const lineComment = (comment: DetailLineComment) => {
    const result: DetailEntry = {
      author: toAuthor(comment.author),
      body: comment.body,
      createdAt: comment.createdAt,
      url: comment.url,
      path: comment.path,
      line: comment.line ?? comment.originalLine,
      review: 'commented',
    };
    const excerpt = reviewCommentExcerpt(comment);
    if (excerpt) result.excerpt = excerpt;
    return result;
  };
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
  const detail: ReferenceDetail = {
    number: item.number,
    ...editableText(item),
    comments,
    commentTotal: item.comments.totalCount,
    pull: {
      reviewDecision: item.reviewDecision ? REVIEW_DECISIONS[item.reviewDecision] : null,
      reviewers: item.reviewRequests.nodes.flatMap(({ requestedReviewer: reviewer }) => (
        reviewer?.__typename === 'User' && reviewer.login
          ? [{ id: reviewer.login, ...toAuthor({ login: reviewer.login, avatarUrl: reviewer.avatarUrl }) }]
          : []
      )),
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

export async function fetchDiscussionDetail({ octokit, owner, repo, number }: PullRequestQuery) {
  const parsed = discussionDetailSchema.parse(await octokit.graphql(DISCUSSION_DETAIL_QUERY, { owner, repo, number }));
  const discussion = parsed.repository?.discussion;
  if (!discussion) return null;
  const answerable = discussion.category.isAnswerable;
  const canReply = !discussion.locked || discussion.viewerCanUpdate;
  const plain = (comment: z.infer<typeof detailCommentSchema> & { id: string }) => {
    const entry: DetailEntry = {
      author: toAuthor(comment.author),
      body: comment.body,
      createdAt: comment.createdAt,
      url: comment.url,
      path: null,
      line: null,
      review: null,
      ...commentPermissions(comment),
    };
    if (comment.id !== undefined) entry.id = comment.id;
    return entry;
  };
  const commentOf = (comment: NonNullable<NonNullable<z.infer<typeof discussionDetailSchema>['repository']>['discussion']>['comments']['nodes'][number]) => {
    const entry: DetailEntry = {
      ...plain(comment),
      thread: { id: comment.id, resolved: false, canResolve: false, canReply, replies: comment.replies.nodes.map(plain) },
    };
    if (answerable) {
      entry.answer = { chosen: comment.isAnswer, canChange: comment.isAnswer ? comment.viewerCanUnmarkAsAnswer : comment.viewerCanMarkAsAnswer };
    }
    return entry;
  };
  return {
    number: discussion.number,
    ...editableText(discussion),
    comments: discussion.comments.nodes.map(commentOf),
    commentTotal: discussion.comments.totalCount,
    pull: null,
    discussion: { canComment: canReply, canClose: discussion.viewerCanClose, canReopen: discussion.viewerCanReopen },
  };
}

const PULL_STATUS_LIMIT = REFERENCE_PAGE_SIZE;

export function readPullStatusRefs(value: string | null | undefined) {
  const entries = String(value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0 || entries.length > PULL_STATUS_LIMIT) return null;
  const refs = [];
  for (const entry of entries) {
    const match = entry.match(/^([^/#\s]+)\/([^/#\s]+)#(\d+)(?:@([^#@\s]+))?$/);
    if (!match) return null;
    const ref: SummaryRef = { owner: match[1] ?? '', repo: match[2] ?? '', number: Number(match[3]) };
    const host = match[4]?.trim().toLowerCase();
    if (host && host !== 'github.com') {
      ref.host = host;
    }
    refs.push(ref);
  }
  return parseSummaryRefs(refs);
}

export const stateSchema = z.enum(['open', 'closed', 'merged', 'all', 'unanswered']).catch('open');
export const peopleSchema = z.enum(['any', 'assigned', 'created', 'reviewRequested']).catch('any');

export function readReferenceState(value: string | undefined) {
  return stateSchema.parse(value);
}
export function readReferencePeople(value: string | undefined) {
  return peopleSchema.parse(value);
}

const searchPageSchema = z.object({
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
  nodes: z.array(z.unknown()),
});
const searchResultSchema = z.object({ search: searchPageSchema.extend({ issueCount: z.number().int() }) });
const discussionSearchResultSchema = z.object({ search: searchPageSchema.extend({ discussionCount: z.number().int() }) });

export function parseReferenceLookup(text: string, repos: ReferenceRepo[], kind = 'issue') {
  const trimmed = text.trim();
  const family = kind === 'discussion' ? 'discussion' : 'item';
  const hash = trimmed.match(/^#?(\d+)$/);
  if (hash) {
    return { number: Number(hash[1]), repos, family };
  }
  const url = trimmed.match(/^(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/\s]+)\/(issues|pull|discussions)\/(\d+)(?:[/?#]\S*)?$/i);
  if (url && (url[3]?.toLowerCase() === 'discussions') === (family === 'discussion')) {
    const target = repos.filter((entry) => repoKey(entry.owner, entry.repo) === repoKey(url[1] ?? '', url[2] ?? ''));
    return { number: Number(url[4]), repos: target, family };
  }
  return null;
}

export function parseReferenceLink(text: string, host: string) {
  const url = text.trim().match(/^https?:\/\/(?:www\.)?([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull|discussions)\/(\d+)(?:[/?#]\S*)?$/i);
  if (!url || url[1]?.toLowerCase() !== String(host).toLowerCase()) return null;
  return { owner: url[2], repo: url[3], number: Number(url[4]) };
}

const USER_LABEL_QUALIFIERS = /(?:^|\s)labels?:("(?:[^"\\]|\\.)*"|\S+)/gi;
const USER_PEOPLE_QUALIFIERS = /(?:^|\s)(?:assignee|author|mentions|review-requested|reviewed-by):\S+/i;

export function labelSearchQualifiers(labels: string[] = [], text = '') {
  const named = new Set([...String(text).matchAll(USER_LABEL_QUALIFIERS)]
    .map((match) => (match[1] ?? '').replace(/^"|"$/g, '').replace(/\\(.)/g, '$1').toLowerCase()));
  const names: string[] = [];
  for (const label of labels) {
    const name = String(label).trim();
    if (name && !named.has(name.toLowerCase()) && !names.some((seen) => seen.toLowerCase() === name.toLowerCase())) names.push(name);
  }
  return names.map((name) => `label:"${name.replace(/["\\]/g, '\\$&')}"`);
}

export function buildReferenceSearchQuery({ repos, kind, state, people, text, labels = [] }: Omit<SearchInput, 'octokit' | 'cursor'>) {
  const userText = text.trim();
  const parts = repos.map((entry) => `repo:${entry.owner}/${entry.repo}`);
  if (kind !== 'discussion') parts.push(kind === 'pull' ? 'is:pr' : 'is:issue');
  if (!/(^|\s)(is:(open|closed|merged|unmerged|answered|unanswered)|state:\S+)/i.test(userText)) {
    const shown = kind !== 'pull' && state === 'merged' ? 'closed' : kind !== 'discussion' && state === 'unanswered' ? 'open' : state;
    const stateQualifier = SEARCH_STATES[shown];
    if (stateQualifier) parts.push(stateQualifier);
  }
  if (!/(^|\s)sort:\S+/i.test(userText)) {
    parts.push('sort:updated-desc');
  }
  if (!USER_PEOPLE_QUALIFIERS.test(userText)) {
    const peopleQualifier = (kind !== 'pull' && people === 'reviewRequested') || (kind === 'discussion' && people === 'assigned')
      ? ''
      : SEARCH_PEOPLE[people];
    if (peopleQualifier) parts.push(peopleQualifier);
  }
  if (kind !== 'discussion') parts.push(...labelSearchQualifiers(labels, userText));
  if (userText) parts.push(userText);
  return parts.join(' ');
}

function buildLookupQuery(number: number, repos: ReferenceRepo[], family: string) {
  const variables: LookupVariables = { number };
  const declarations = ['$number: Int!'];
  const field = family === 'discussion'
    ? 'discussion(number: $number) { __typename ...DiscussionReference }'
    : 'issueOrPullRequest(number: $number) { __typename ...IssueReference ...PullReference }';
  const selections = repos.map((entry, index) => {
    variables[`o${index}`] = entry.owner;
    variables[`n${index}`] = entry.repo;
    declarations.push(`$o${index}: String!, $n${index}: String!`);
    return `a${index}: repository(owner: $o${index}, name: $n${index}) {\n      ${field}\n    }`;
  });
  const fragments = family === 'discussion' ? DISCUSSION_FRAGMENT : REFERENCE_FRAGMENTS;
  return {
    query: `query ReferenceLookup(${declarations.join(', ')}) {\n${selections.join('\n')}\n}\n${fragments}`,
    variables,
  };
}

async function runPartialQuery(octokit: Octokit, query: string, variables: Record<string, string | number>) {
  try {
    return graphqlAliasesSchema.parse(await octokit.graphql<unknown>(query, variables));
  } catch (error) {
    if (!isGraphqlRateLimitError(error) && hasProperty(error, 'data') && error.data) {
      return graphqlAliasesSchema.parse(error.data);
    }
    throw error;
  }
}

export async function searchGitHubReferences({ octokit, repos, kind, state, people, text, labels = [], cursor }: SearchInput) {
  const lookup = parseReferenceLookup(text, repos, kind);
  if (lookup) {
    if (lookup.repos.length === 0) {
      return { items: [], cursor: null, hasMore: false, total: 0 };
    }
    const { query, variables } = buildLookupQuery(lookup.number, lookup.repos, lookup.family);
    const data = await runPartialQuery(octokit, query, variables);
    const field = lookup.family === 'discussion' ? 'discussion' : 'issueOrPullRequest';
    const items = lookup.repos
      .map((_entry, index) => toReference(referenceNodeAt(data, index, field), repos))
      .filter((item) => item !== null);
    return { items, cursor: null, hasMore: false, total: items.length };
  }

  const variables = {
    q: buildReferenceSearchQuery({ repos, kind, state, people, text, labels }),
    first: REFERENCE_PAGE_SIZE,
    after: cursor || null,
  };
  const search = kind === 'discussion'
    ? discussionSearchResultSchema.parse(await octokit.graphql(DISCUSSION_SEARCH_QUERY, variables)).search
    : searchResultSchema.parse(await octokit.graphql(SEARCH_QUERY, variables)).search;
  const items = search.nodes
    .map((node) => toReference(node, repos))
    .filter((item): item is Reference => item !== null && item.kind === kind);
  return {
    items,
    cursor: search.pageInfo.endCursor,
    hasMore: search.pageInfo.hasNextPage,
    total: 'discussionCount' in search ? search.discussionCount : search.issueCount,
  };
}

const acrossCursorSchema = z.strictObject({
  version: z.literal(2),
  scope: z.string().regex(/^[a-f0-9]{64}$/),
  searches: z.array(z.strictObject({
    cursor: z.string().min(1).max(10_000).nullable(),
    offset: z.number().int().min(0).max(REFERENCE_PAGE_SIZE),
    done: z.boolean(),
    total: z.number().int().nonnegative(),
  })).max(300),
});

const updatedAtOf = (item: Pick<Reference, 'updatedAt'>) => Date.parse(item.updatedAt ?? '') || 0;

function readAcrossCursor(cursor: string, scope: string, searchCount: number) {
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

export async function searchGitHubReferencesAcross<Group extends AcrossGroup>({ groups, kind, state, people, text, labels = [], cursor, onGroupError }: AcrossSearchInput<Group>) {
  const searches = groups.flatMap((group, groupIndex) => {
    const chunks = [];
    for (let offset = 0; offset < group.repos.length; offset += ACROSS_REPO_CHUNK_SIZE) {
      chunks.push({ group, groupIndex, repos: group.repos.slice(offset, offset + ACROSS_REPO_CHUNK_SIZE) });
    }
    return chunks;
  });
  const lookup = parseReferenceLookup(text, [], kind);
  if (lookup && cursor) throw invalidAcrossCursor();
  const scope = createHash('sha256').update(JSON.stringify({
    kind, state, people, labels, text,
    searches: searches.map(({ group, repos }) => ({ accountId: group.accountId, authority: group.authority,
      repos: repos.map((repo) => ({ key: repoKey(repo.owner, repo.repo), directory: repo.directory })) })),
  })).digest('hex');
  const positions: AcrossPosition[] = cursor
    ? readAcrossCursor(cursor, scope, searches.length)
    : searches.map(() => ({ cursor: null, offset: 0, done: false, total: 0 }));
  const pages = await mapReferencesAcross(searches, async ({ group, repos }, index): Promise<AcrossPage> => {
    const position = retainedEntry(positions, index);
    if (position.done) return { done: true, items: [], total: position.total };
    try {
      const page = await searchGitHubReferences({ octokit: group.octokit, repos, kind, state, people, text, labels, cursor: position.cursor });
      if (page.hasMore && !page.cursor) throw new Error('GitHub returned an invalid search cursor');
      const items = page.items.slice(position.offset).map((item) => ({ ...item,
        directory: referenceDirectory(repos, item, repoKey),
      }));
      return { done: false, items, hasMore: page.hasMore, endCursor: page.cursor, total: page.total };
    } catch (error) {
      return { error };
    }
  });
  const failedGroups = new Set();
  for (let index = 0; index < pages.length; index++) {
    const page = retainedEntry(pages, index), search = retainedEntry(searches, index);
    if (!page.error || failedGroups.has(search.groupIndex)) continue;
    failedGroups.add(search.groupIndex);
    await onGroupError(search.group, page.error);
  }
  const live = pages.map((page, index) => (failedGroups.has(retainedEntry(searches, index).groupIndex) || page.done ? null : livePage(page)));
  const bound = Math.max(-Infinity, ...live
    .filter((page): page is Extract<AcrossPage, { done: false }> => Boolean(page?.hasMore && page.items.length > 0))
    .map((page) => updatedAtOf(retainedEntry(page.items, page.items.length - 1))));
  let shown = live.map((page) => {
    if (!page) return 0;
    const count = page.items.findIndex((item) => updatedAtOf(item) < bound);
    return count === -1 ? page.items.length : count;
  });
  if (shown.every((count) => count === 0)) shown = live.map((page) => page?.items.length ?? 0);
  const items = live.flatMap((page, index) => page?.items.slice(0, shown[index]) ?? []);
  if (searches.length > 1 || lookup) items.sort((left, right) => updatedAtOf(right) - updatedAtOf(left));
  const nextPositions = pages.map((page, index) => {
    if (failedGroups.has(retainedEntry(searches, index).groupIndex)) return { cursor: null, offset: 0, done: true, total: 0 };
    if (page.done) return retainedEntry(positions, index);
    const current = livePage(page);
    const position = retainedEntry(positions, index), count = retainedEntry(shown, index);
    if (count < current.items.length) {
      return { cursor: position.cursor, offset: position.offset + count, done: false, total: current.total };
    }
    return current.hasMore
      ? { cursor: current.endCursor, offset: 0, done: false, total: current.total }
      : { cursor: null, offset: 0, done: true, total: current.total };
  });
  const hasMore = !lookup && nextPositions.some((position) => !position.done);
  return {
    items,
    total: nextPositions.reduce((total, position) => total + position.total, 0),
    hasMore,
    cursor: hasMore ? Buffer.from(JSON.stringify({ version: 2, scope, searches: nextPositions })).toString('base64url') : null,
  };
}
