/**
 * Reference-picker reads: searched lists, an item's detail and listed change
 * requests' statuses, for providers whose descriptor offers them
 * (`features.referenceSearch`, `referenceDetail`, `listStatuses`,
 * `referencesAcross`).
 *
 * They go through the provider's own source-control routes like every other
 * provider read: the picker's lists and previews carry the repository's read
 * context, so they are read with the account the repository is bound to, and
 * batched summaries name the account their entries were read with. Every
 * item is stamped with the provider it was read from.
 */
import type {
  ChangeRequestListStatusesResult,
  RepositoryItemRef,
  RepositoryReferenceDetailResult,
  RepositoryReferencePage,
  RepositoryReferenceQuery,
  RepositoryReferencesAcrossResult,
  SourceControlReadContext,
} from '@openchamber/ui/lib/api/types';
import type { RuntimeFetchOptions } from '@openchamber/ui/lib/runtime-fetch';
import { z } from 'zod';
import { providerPath } from './source-control-providers';

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
  path: z.string().nullable(),
  line: z.number().nullable(),
  review: z.enum(['approved', 'changes_requested', 'commented', 'dismissed']).nullable(),
};

const referenceDetailResultSchema = z.discriminatedUnion('connected', [
  z.object({ connected: z.literal(false) }),
  z.object({
    connected: z.literal(true),
    detail: z.object({
      number: z.number(),
      // A thread's replies are comments without threads of their own.
      comments: z.array(z.object({
        ...referenceCommentFields,
        thread: z.object({
          id: z.string().min(1),
          resolved: z.boolean(),
          canResolve: z.boolean(),
          canReply: z.boolean(),
          replies: z.array(z.object(referenceCommentFields)),
        }).optional(),
      })),
      commentTotal: z.number(),
      pull: z.object({
        reviewDecision: z.enum(['approved', 'changes_requested', 'review_required']).nullable(),
        reviewers: z.array(z.object({ id: z.string(), login: z.string(), avatarUrl: z.string().optional() })).default([]),
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
        // Absent when the host could not say, or said something that does not
        // hold together; null when the PR is in no stack. Never fails the detail.
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
      repo: z.strictObject({ owner: z.string(), repo: z.string(), url: z.string() }),
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

const readContextQuery = (context: SourceControlReadContext): URLSearchParams => new URLSearchParams({
  directory: context.directory,
  instance: context.instance,
  repositoryId: context.repositoryId,
  accountId: context.accountId,
  bindingRevision: String(context.bindingRevision),
  primaryRemote: context.primaryRemote,
});

/** The parsed answer, or the server's own reason when the request failed. */
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
  item: RepositoryItemRef,
): Promise<RepositoryReferenceDetailResult> => {
  const query = readContextQuery(context);
  query.set('owner', item.owner);
  query.set('repo', item.repo);
  query.set('number', String(item.number));
  const host = item.host?.trim();
  // The wire's default host is github.com; a ref on any other host names it.
  if (host && host !== 'github.com') {
    query.set('host', host);
  }
  const response = await fetch(providerPath(context, '/references/detail'), { query, headers: { Accept: 'application/json' } });
  return readPayload(response, referenceDetailResultSchema, 'Failed to load issue or pull request detail');
};

/** One provider per page: every context must name the same provider, whose route serves the search. */
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
    // The server reads `owner/repo#number`, optionally `@host`; a missing or
    // github.com host is the wire's default, so it is left off.
    return `${ref.owner}/${ref.repo}#${ref.number}${host && host !== 'github.com' ? `@${host}` : ''}`;
  }).join(','));
  const response = await fetch(providerPath(context, '/references/status'), { query, headers: { Accept: 'application/json' } });
  return readPayload(response, pullStatusesResultSchema, 'Failed to load pull request statuses');
};
