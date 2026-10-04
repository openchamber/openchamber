import { z } from 'zod';
import type { GitHubIssueLiveSummary, GitHubPullRequestLiveSummary, LinearIssueLiveSummary } from '@/lib/api/types';

/**
 * A pull request, merge request or issue whose live state the server follows
 * for this client. The key is the server's: `trackedItemKey` here and in
 * `packages/web/server/lib/tracked-items/items.js` must agree.
 */
/**
 * `accountId` names the account a repository is bound to (a branch's pull
 * request); without it the host's current account reads the item (a link).
 */
export type TrackedThread<Kind extends 'pull' | 'issue' = 'pull' | 'issue'> =
  | { provider: 'github'; kind: Kind; owner: string; repo: string; number: number; accountId?: string }
  | { provider: 'gitlab'; instance: string; kind: Kind; owner: string; repo: string; number: number; accountId?: string };
export type TrackedLinearIssue = { provider: 'linear'; identifier: string };
export type TrackedItem = TrackedThread<'pull'> | TrackedThread<'issue'> | TrackedLinearIssue;

export const trackedItemKey = (item: TrackedItem): string => {
  if (item.provider === 'linear') return `linear|${item.identifier.toUpperCase()}`;
  const thread = `${item.kind}|${item.owner}/${item.repo}#${item.number}`.toLowerCase();
  // Account ids are opaque and case-sensitive; they stay as they are.
  const account = item.accountId ? `@${item.accountId}` : '';
  return item.provider === 'gitlab' ? `gitlab|${item.instance.toLowerCase()}|${thread}${account}` : `github|${thread}${account}`;
};

const checksSchema = z.object({
  state: z.enum(['success', 'failure', 'pending', 'unknown']),
  total: z.number(),
  success: z.number(),
  failure: z.number(),
  pending: z.number(),
  inProgress: z.number().optional(),
  queued: z.number().optional(),
  startedAt: z.string().optional(),
});

const pullSummarySchema = z.object({
  owner: z.string(),
  repo: z.string(),
  number: z.number(),
  state: z.enum(['open', 'closed', 'merged']),
  draft: z.boolean(),
  title: z.string(),
  headSha: z.string().optional(),
  mergeable: z.boolean().nullable(),
  mergeableState: z.string().nullable(),
  checks: checksSchema.nullable(),
}) satisfies z.ZodType<GitHubPullRequestLiveSummary>;

const issueSummarySchema = z.object({
  owner: z.string(),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  state: z.enum(['open', 'completed', 'not_planned']),
}) satisfies z.ZodType<GitHubIssueLiveSummary>;

const linearSummarySchema = z.object({
  identifier: z.string(),
  title: z.string(),
  state: z.object({ name: z.string(), type: z.enum(['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled']) }),
}) satisfies z.ZodType<LinearIssueLiveSummary>;

const threadFields = { owner: z.string().min(1), repo: z.string().min(1), number: z.number().int().positive(), kind: z.enum(['pull', 'issue']), accountId: z.string().min(1).optional() };
const trackedItemSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('github'), ...threadFields }),
  z.object({ provider: z.literal('gitlab'), instance: z.string().min(1), ...threadFields }),
  z.object({ provider: z.literal('linear'), identifier: z.string().min(1) }),
]) satisfies z.ZodType<TrackedItem>;

/**
 * What the server knows of one item. `state` is null while unknown (never
 * answered, or no longer answered); `fetchedAt` is when it last answered.
 */
export type TrackedItemState =
  | { type: 'pull'; item: TrackedThread<'pull'>; state: GitHubPullRequestLiveSummary | null; fetchedAt: number }
  | { type: 'issue'; item: TrackedThread<'issue'>; state: GitHubIssueLiveSummary | null; fetchedAt: number }
  | { type: 'linear'; item: TrackedLinearIssue; state: LinearIssueLiveSummary | null; fetchedAt: number };

const recordSchema = z.object({ key: z.string(), item: trackedItemSchema, state: z.unknown(), fetchedAt: z.number() });

type ParsedRecord = { key: string; record: TrackedItemState };

const toRecord = ({ key, item, state, fetchedAt }: z.infer<typeof recordSchema>): ParsedRecord | null => {
  if (key !== trackedItemKey(item)) return null;
  if (item.provider === 'linear') {
    const summary = state === null ? null : linearSummarySchema.safeParse(state);
    if (summary && !summary.success) return null;
    return { key, record: { type: 'linear', item, state: summary ? summary.data : null, fetchedAt } };
  }
  if (item.kind === 'pull') {
    const summary = state === null ? null : pullSummarySchema.safeParse(state);
    if (summary && !summary.success) return null;
    return { key, record: { type: 'pull', item: { ...item, kind: 'pull' as const }, state: summary ? summary.data : null, fetchedAt } };
  }
  const summary = state === null ? null : issueSummarySchema.safeParse(state);
  if (summary && !summary.success) return null;
  return { key, record: { type: 'issue', item: { ...item, kind: 'issue' as const }, state: summary ? summary.data : null, fetchedAt } };
};

/**
 * One record as it arrives over HTTP, the event stream or storage; null when
 * it does not hold together (its key must name its item, its state must fit
 * its kind).
 */
export const trackedItemRecordSchema = recordSchema.transform(toRecord).nullable().catch(null);

/** Every record that holds together; malformed ones are dropped, never guessed. */
export const trackedItemRecordsSchema = z.array(z.unknown()).catch([]).transform((values) => values.flatMap((value) => {
  const parsed = trackedItemRecordSchema.parse(value);
  return parsed ? [parsed] : [];
}));
