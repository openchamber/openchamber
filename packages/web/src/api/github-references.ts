/**
 * GitHub reads behind the reference picker and the sidebar's live PR state.
 *
 * They go through the canonical source-control routes like every other
 * provider read: the picker's lists and previews carry the repository's read
 * context, so they are read with the account the repository is bound to, and
 * batched summaries name the account their entries were read with.
 */
import type {
  GitHubPullRequestRef,
  GitHubPullStatusesResult,
  GitHubReferenceDetailResult,
  GitHubReferencesOptions,
  GitHubReferencesResult,
  SourceControlReadContext,
} from '@openchamber/ui/lib/api/types';
import type { RuntimeFetchOptions } from '@openchamber/ui/lib/runtime-fetch';
import { z } from 'zod';

type GitHubFetch = (input: string, init?: RuntimeFetchOptions) => Promise<Response>;

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

const referencesResultSchema = z.discriminatedUnion('connected', [
  z.object({ connected: z.literal(false) }),
  z.object({
    connected: z.literal(true),
    repo: z.object({ owner: z.string(), repo: z.string(), url: z.string() }).nullable(),
    items: z.array(z.discriminatedUnion('kind', [
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
    ])),
    cursor: z.string().nullable(),
    hasMore: z.boolean(),
    total: z.number(),
  }),
]);

const referenceDetailResultSchema = z.discriminatedUnion('connected', [
  z.object({ connected: z.literal(false) }),
  z.object({
    connected: z.literal(true),
    detail: z.object({
      number: z.number(),
      comments: z.array(z.object({
        author: z.object({ login: z.string(), avatarUrl: z.string().optional() }).nullable(),
        body: z.string(),
        createdAt: z.string().nullable(),
        url: z.string(),
        path: z.string().nullable(),
        line: z.number().nullable(),
        review: z.enum(['approved', 'changes_requested', 'commented', 'dismissed']).nullable(),
      })),
      commentTotal: z.number(),
      pull: z.object({
        reviewDecision: z.enum(['approved', 'changes_requested', 'review_required']).nullable(),
        additions: z.number(),
        deletions: z.number(),
        changedFiles: z.number(),
      }).nullable(),
    }).nullable(),
  }),
]);

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

export const fetchGitHubReferences = async (
  fetch: GitHubFetch,
  context: SourceControlReadContext,
  options: GitHubReferencesOptions,
): Promise<GitHubReferencesResult> => {
  const query = readContextQuery(context);
  query.set('kind', options.kind);
  if (options.filter) query.set('filter', options.filter);
  if (options.query?.trim()) query.set('query', options.query.trim());
  if (options.cursor) query.set('cursor', options.cursor);
  const response = await fetch('/api/source-control/github/references', { query, headers: { Accept: 'application/json' } });
  return readPayload(response, referencesResultSchema, 'Failed to load issues and pull requests');
};

export const fetchGitHubReferenceDetail = async (
  fetch: GitHubFetch,
  context: SourceControlReadContext,
  item: GitHubPullRequestRef,
): Promise<GitHubReferenceDetailResult> => {
  const query = readContextQuery(context);
  query.set('owner', item.owner);
  query.set('repo', item.repo);
  query.set('number', String(item.number));
  const response = await fetch('/api/source-control/github/references/detail', { query, headers: { Accept: 'application/json' } });
  return readPayload(response, referenceDetailResultSchema, 'Failed to load issue or pull request detail');
};

export const fetchGitHubPullStatuses = async (
  fetch: GitHubFetch,
  context: SourceControlReadContext,
  pulls: GitHubPullRequestRef[],
): Promise<GitHubPullStatusesResult> => {
  const query = readContextQuery(context);
  query.set('pulls', pulls.map((pull) => `${pull.owner}/${pull.repo}#${pull.number}`).join(','));
  const response = await fetch('/api/source-control/github/references/status', { query, headers: { Accept: 'application/json' } });
  return readPayload(response, pullStatusesResultSchema, 'Failed to load pull request statuses');
};
