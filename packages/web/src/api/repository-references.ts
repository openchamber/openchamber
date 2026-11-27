
import type {
  ChangeRequestListStatusesResult,
  RepositoryItemRef,
  RepositoryReferenceDetailResult,
  RepositoryReferencePage,
  RepositoryReferenceQuery,
  RepositoryReferenceReview,
  RepositoryReferencesAcrossResult,
  SourceControlReadContext,
} from '@openchamber/ui/lib/api/types';
import type { ChangeRequestReviewStateResult } from '@openchamber/ui/lib/source-control/types';
import type { RuntimeFetchOptions } from '@openchamber/ui/lib/runtime-fetch';
import { z } from 'zod';
import { providerPath } from './source-control-providers';
import { parseSourceReferenceLinks } from './source-reference-link';

type ReferencesFetch = (input: string, init?: RuntimeFetchOptions) => Promise<Response>;

const checksSummarySchema = z.object({
  state: z.enum(['success', 'failure', 'pending', 'unknown']),
  total: z.number(),
  success: z.number(),
  failure: z.number(),
  pending: z.number(),
  inProgress: z.number().optional(),
  queued: z.number().optional(),
  startedAt: z.string().optional(),
});


const referenceFields = {
  number: z.number(),
  title: z.string(),
  url: z.string(),
  body: z.string(),
  bodyTruncated: z.boolean(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  author: z.object({ login: z.string(), avatarUrl: z.string().optional() }).nullable(),
  labels: z.array(z.object({ name: z.string(), color: z.string().optional() })),
  commentCount: z.number(),
  sourceRepo: z.object({ owner: z.string(), repo: z.string(), source: z.string() }),
};

const referenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('issue'),
    ...referenceFields,
    state: z.enum(['open', 'completed', 'not_planned']),
  }),
  z.object({
    kind: z.literal('pull'),
    ...referenceFields,
    state: z.enum(['open', 'closed', 'merged']),
    draft: z.boolean(),
    head: z.string(),
    base: z.string(),
    headSha: z.string(),
    headRepo: z.object({
      owner: z.string(),
      repo: z.string(),
      url: z.string(),
      cloneUrl: z.string().optional(),
      sshUrl: z.string().optional(),
    }).nullable(),
  }),
  z.object({
    kind: z.literal('discussion'),
    ...referenceFields,
    state: z.enum(['open', 'resolved', 'outdated', 'duplicate']),
    answered: z.boolean().nullable(),
    upvotes: z.number(),
    locked: z.boolean(),
    category: z.object({ name: z.string(), emoji: z.string().nullable(), answerable: z.boolean() }),
  }),
]);

const referencesResultSchema = z.discriminatedUnion('connected', [
  z.object({ connected: z.literal(false) }),
  z.object({
    connected: z.literal(true),
    repo: z.object({ owner: z.string(), repo: z.string(), url: z.string() }).nullable(),
    items: z.array(referenceSchema),
    cursor: z.string().nullable(),
    hasMore: z.boolean(),
    total: z.number(),
  }),
]);

const referenceCommentFields = {
  author: z.object({ login: z.string(), avatarUrl: z.string().optional() }).nullable(),
  body: z.string(),
  createdAt: z.string().nullable(),
  url: z.string(),

  id: z.string().min(1).optional(),
  canUpdate: z.boolean().optional(),
  canDelete: z.boolean().optional(),
  path: z.string().nullable(),
  line: z.number().nullable(),
  review: z.enum(['approved', 'changes_requested', 'commented', 'dismissed']).nullable(),

  excerpt: z.object({
    startLine: z.number().int().positive(),
    lines: z.array(z.string()).max(200),
  }).optional().catch(undefined),
};

const reviewSummarySchema = z.object({
  id: z.string().min(1),
  state: z.enum(['approved', 'changes_requested', 'commented', 'pending', 'dismissed']),
  author: z.object({ login: z.string(), avatarUrl: z.string().optional() }).nullable(),
  submittedAt: z.string().nullable(),
});

const reviewerStateSchema = z.object({
  id: z.string(),
  login: z.string(),
  avatarUrl: z.string().optional(),
  state: z.enum(['pending', 'approved', 'changes_requested', 'commented', 'dismissed']),
});

export const parseReviewSummaries = (reviews: unknown): RepositoryReferenceReview[] | undefined => {
  if (!Array.isArray(reviews)) return undefined;
  const parsed = reviews.flatMap((review) => {
    const entry = reviewSummarySchema.safeParse(review);
    return entry.success ? [entry.data] : [];
  });
  return parsed.length > 0 || reviews.length === 0 ? parsed : undefined;
};

const referenceDetailResultSchema = z.discriminatedUnion('connected', [
  z.object({ connected: z.literal(false) }),
  z.object({
    connected: z.literal(true),
    detail: z.object({
      number: z.number(),

      body: z.string().optional(),
      viewerCanUpdate: z.boolean().optional(),
      assignees: z.array(z.object({ id: z.string(), login: z.string(), avatarUrl: z.string().optional() })).optional(),
      writeAccess: z.boolean().optional(),
      branchWriteAccess: z.boolean().optional(),
      threadsUnavailable: z.boolean().optional(),

      comments: z.array(z.object({
        ...referenceCommentFields,
        thread: z.object({
          id: z.string().min(1),
          resolved: z.boolean(),
          canResolve: z.boolean(),
          canReply: z.boolean(),
          outdated: z.boolean().optional(),
          replies: z.array(z.object(referenceCommentFields)),
        }).optional(),
        answer: z.object({ chosen: z.boolean(), canChange: z.boolean() }).optional(),
      })),
      commentTotal: z.number(),
      references: z.array(z.unknown()).optional().transform((value) => (value === undefined ? undefined : parseSourceReferenceLinks(value))).catch(undefined),
      pull: z.object({
        reviewDecision: z.enum(['approved', 'changes_requested', 'review_required']).nullable(),
        reviewers: z.array(z.object({ id: z.string(), login: z.string(), avatarUrl: z.string().optional() })).default([]),
        reviews: z.unknown().optional().transform(parseReviewSummaries),
        reviewerStates: z.array(z.unknown()).transform((entries) => {
          const parsed = entries.flatMap((entry) => {
            const state = reviewerStateSchema.safeParse(entry);
            return state.success ? [state.data] : [];
          });
          return parsed.length === 0 && entries.length > 0 ? undefined : parsed;
        }).optional().catch(undefined),
        canDismissReviews: z.boolean().optional().catch(undefined),
        checks: checksSummarySchema.nullable().optional(),
        additions: z.number(),
        deletions: z.number(),
        changedFiles: z.number(),
        commits: z.array(z.object({
          sha: z.string(),
          headline: z.string(),
          author: z.object({ login: z.string(), avatarUrl: z.string().optional() }).nullable(),
          authorName: z.string().nullable(),
          committedAt: z.string().nullable(),
          url: z.string().nullable(),
        })).default([]),
        commitTotal: z.number().nullable().default(null),


        stack: z.object({
          number: z.number().nullable(),
          base: z.string(),
          layers: z.array(z.object({
            number: z.number(),
            title: z.string(),
            url: z.string(),
            state: z.enum(['open', 'closed', 'merged']),
            draft: z.boolean(),
            head: z.string(),
          })),
        }).nullable().optional().catch(undefined),
      }).nullable(),
      discussion: z.object({ canComment: z.boolean(), canClose: z.boolean(), canReopen: z.boolean() }).optional(),
    }).nullable(),
  }),
]);

const referencesAcrossResultSchema = z.strictObject({
  items: z.array(referenceSchema.and(z.object({ directory: z.string().min(1) }))),
  cursor: z.string().nullable(),
  hasMore: z.boolean(),
  total: z.number().int().nonnegative(),
  repositories: z.array(z.union([
    z.strictObject({ directory: z.string().min(1), status: z.literal('included'),
      repo: z.strictObject({ owner: z.string(), repo: z.string(), url: z.string(), host: z.string().optional() }),
    }),
    z.strictObject({ directory: z.string().min(1), status: z.enum(['no-repo', 'disconnected', 'invalid-context', 'error']) }),
  ])),
});

const pullStatusesResultSchema = z.discriminatedUnion('connected', [
  z.object({ connected: z.literal(false) }),
  z.object({
    connected: z.literal(true),
    statuses: z.array(z.object({
      owner: z.string(),
      repo: z.string(),
      number: z.number(),
      checks: checksSummarySchema.nullable(),
      mergeable: z.boolean().nullable(),
      mergeableState: z.string().nullable(),
    })),
  }),
]);

const errorSchema = z.object({ error: z.string() });

const readContextQuery = (context: SourceControlReadContext): URLSearchParams => {
  const query = new URLSearchParams({
    directory: context.directory,
    instance: context.instance,
    repositoryId: context.repositoryId,
    accountId: context.accountId,
    bindingRevision: String(context.bindingRevision),
    primaryRemote: context.primaryRemote,
  });
  if (context.linked) query.set('linked', '1');
  return query;
};


const readPayload = async <TSchema extends z.ZodType>(
  response: Response,
  schema: TSchema,
  fallback: string,
): Promise<z.output<TSchema>> => {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = errorSchema.safeParse(payload);
    throw new Error((failure.success && failure.data.error) || response.statusText || fallback);
  }
  return schema.parse(payload);
};

export const fetchRepositoryReferences = async (
  fetch: ReferencesFetch,
  context: SourceControlReadContext,
  options: RepositoryReferenceQuery,
): Promise<RepositoryReferencePage> => {
  const query = readContextQuery(context);
  query.set('kind', options.kind);
  if (options.state) query.set('state', options.state);
  if (options.people) query.set('people', options.people);
  for (const label of options.labels ?? []) query.append('label', label);
  if (options.query?.trim()) query.set('query', options.query.trim());
  if (options.cursor) query.set('cursor', options.cursor);
  const response = await fetch(providerPath(context, '/references'), { query, headers: { Accept: 'application/json' } });
  const page = await readPayload(response, referencesResultSchema, 'Failed to load issues and pull requests');
  if (!page.connected) return page;
  return { ...page, items: page.items.map((item) => ({ ...item, provider: context.provider })) };
};

export const fetchRepositoryReferenceDetail = async (
  fetch: ReferencesFetch,
  context: SourceControlReadContext,
  item: RepositoryItemRef & { kind?: 'discussion' },
  options: { includeReferences?: boolean } = {},
): Promise<RepositoryReferenceDetailResult> => {
  const query = readContextQuery(context);
  query.set('owner', item.owner);
  query.set('repo', item.repo);
  query.set('number', String(item.number));
  if (item.kind === 'discussion') query.set('kind', 'discussion');
  if (options.includeReferences) query.set('references', '1');
  const host = item.host?.trim();

  if (host && host !== 'github.com') {
    query.set('host', host);
  }
  const response = await fetch(providerPath(context, '/references/detail'), { query, headers: { Accept: 'application/json' } });
  const result = await readPayload(response, referenceDetailResultSchema, 'Failed to load issue or pull request detail');
  if (!result.connected || result.detail === null) return result;
  if (result.detail.pull) {
    for (const key of ['reviews', 'reviewerStates', 'canDismissReviews'] as const) {
      if (result.detail.pull[key] === undefined) delete result.detail.pull[key];
    }
  }
  if (result.detail.references && result.detail.references.length === 0) delete result.detail.references;
  return result;
};

const reviewPersonSchema = z.object({ login: z.string(), avatarUrl: z.string().optional() }).nullable();
const reviewSideSchema = z.enum(['old', 'new']);
const reviewStateResultSchema = z.discriminatedUnion('connected', [
  z.object({ connected: z.literal(false) }),
  z.object({
    connected: z.literal(true),
    viewerIsAuthor: z.boolean(),
    headSha: z.string(),
    draft: z.object({
      id: z.string(),
      body: z.string(),
      comments: z.array(z.object({
        id: z.string(), path: z.string(), side: reviewSideSchema,
        line: z.number().int().nullable(), startLine: z.number().int().nullable(),
        body: z.string(), author: reviewPersonSchema,
      })),
    }).nullable(),
    threads: z.array(z.object({
      id: z.string(), path: z.string(), side: reviewSideSchema,
      line: z.number().int().nullable(), startLine: z.number().int().nullable(),
      resolved: z.boolean(), canReply: z.boolean(), canResolve: z.boolean(), outdated: z.boolean().optional(),
      comments: z.array(z.object({
        id: z.string(), body: z.string(), createdAt: z.string(), url: z.string(), author: reviewPersonSchema,
      })),
    })),
    truncated: z.boolean(),
  }),
]);


export const fetchChangeRequestReviewState = async (
  fetch: ReferencesFetch,
  context: SourceControlReadContext,
  ref: { owner: string; repo: string; number: number },
): Promise<ChangeRequestReviewStateResult> => {
  const query = readContextQuery(context);
  query.set('owner', ref.owner);
  query.set('repo', ref.repo);
  query.set('number', String(ref.number));
  const response = await fetch(providerPath(context, '/pr/review/state'), { query, headers: { Accept: 'application/json' } });
  return readPayload(response, reviewStateResultSchema, 'Failed to load the review');
};


export const fetchRepositoryReferencesAcross = async (
  fetch: ReferencesFetch,
  contexts: SourceControlReadContext[],
  options: RepositoryReferenceQuery,
): Promise<RepositoryReferencesAcrossResult> => {
  const [first] = contexts;
  if (!first || contexts.some((context) => context.provider !== first.provider)) {
    throw new Error('A search across repositories needs contexts of one provider');
  }
  const response = await fetch(providerPath(first, '/references/across'), {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ contexts, ...options, query: options.query?.trim() }),
  });
  const page = await readPayload(response, referencesAcrossResultSchema, 'Failed to load issues and pull requests');
  return { ...page, items: page.items.map((item) => ({ ...item, provider: first.provider })) };
};

export const fetchChangeRequestListStatuses = async (
  fetch: ReferencesFetch,
  context: SourceControlReadContext,
  refs: RepositoryItemRef[],
): Promise<ChangeRequestListStatusesResult> => {
  const query = readContextQuery(context);
  query.set('pulls', refs.map((ref) => {
    const host = ref.host?.trim().toLowerCase();


    return `${ref.owner}/${ref.repo}#${ref.number}${host && host !== 'github.com' ? `@${host}` : ''}`;
  }).join(','));
  const response = await fetch(providerPath(context, '/references/status'), { query, headers: { Accept: 'application/json' } });
  return readPayload(response, pullStatusesResultSchema, 'Failed to load pull request statuses');
};
