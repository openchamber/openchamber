import { z } from 'zod';
import { sourceControlProviderIdSchema } from '@/lib/source-control/providers/descriptor';
import type { DiscussionLiveSummary, IssueLiveSummary, ChangeRequestLiveSummary, TrackerLiveSummary } from '@/lib/api/types';
import { trackerProviderIdSchema } from '@/lib/trackers/descriptor';
import { linearStateCategory } from '@/lib/trackers/legacyLinear';
import { joinProjectPath } from '@/lib/source-control/projectPath';

/**
 * A pull request, merge request, issue, discussion or tracker work item whose live state the server follows
 * for this client. The key is the server's: `trackedItemKey` here and in
 * `packages/web/server/lib/tracked-items/items.js` must agree.
 */
/**
 * `accountId` names the account a repository is bound to (a branch's pull
 * request); without it the host's current account reads the item (a link).
 * `provider` is any source-control provider id and `instance` its instance
 * (a host or an origin, as the provider names it).
 */
export type TrackedThreadKind = 'pull' | 'issue' | 'discussion';
export type TrackedThread<Kind extends TrackedThreadKind = TrackedThreadKind> = {
  provider: string;
  instance: string;
  kind: Kind;
  owner: string;
  repo: string;
  number: number;
  accountId?: string;
};
/** A tracker's work item (a Linear issue), named by its tracker id and its human identifier. */
export type TrackedWorkItem = { provider: string; kind: 'work-item'; identifier: string };
export type TrackedItem = TrackedThread<'pull'> | TrackedThread<'issue'> | TrackedThread<'discussion'> | TrackedWorkItem;

export const isTrackedWorkItem = (item: TrackedItem): item is TrackedWorkItem => item.kind === 'work-item';

export const trackedItemKey = (item: TrackedItem): string => {
  if (isTrackedWorkItem(item)) return `${item.provider}|${item.identifier.toUpperCase()}`;
  // The joined project path: `owner/repo` as always, `repo` for a path-style provider's top-level project.
  const thread = `${item.kind}|${joinProjectPath(item.owner, item.repo)}#${item.number}`.toLowerCase();
  // The same owner/repo/number can exist on two instances of one provider;
  // the instance is part of the key so the two never collide or share a slot.
  // Account ids are opaque and case-sensitive; they stay as they are.
  const account = item.accountId ? `@${item.accountId}` : '';
  return `${item.provider}|${item.instance.toLowerCase()}|${thread}${account}`;
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
  base: z.string().optional(),
  mergeable: z.boolean().nullable(),
  mergeableState: z.string().nullable(),
  checks: checksSchema.nullable(),
}) satisfies z.ZodType<ChangeRequestLiveSummary>;

const issueSummarySchema = z.object({
  owner: z.string(),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  state: z.enum(['open', 'completed', 'not_planned']),
}) satisfies z.ZodType<IssueLiveSummary>;

const discussionSummarySchema = z.object({
  owner: z.string(),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  state: z.enum(['open', 'resolved', 'outdated', 'duplicate']),
  answered: z.boolean().nullable(),
}) satisfies z.ZodType<DiscussionLiveSummary>;

const workItemStateSchema = z.object({
  name: z.string(),
  category: z.enum(['triage', 'backlog', 'todo', 'in-progress', 'done', 'canceled']),
});
// Linear's raw `{ name, type }` state, without `category`: what a server before
// trackers sends, and what records stored before then hold.
const legacyLinearStateSchema = z.object({ name: z.string(), type: z.string(), category: z.undefined() });

// The server also sends Linear's raw `state.type` while older phone UIs read it; it is stripped here.
const workItemSummarySchema = z.object({
  identifier: z.string(),
  title: z.string(),
  state: z.preprocess((value) => {
    const legacy = legacyLinearStateSchema.safeParse(value);
    return legacy.success ? { name: legacy.data.name, category: linearStateCategory(legacy.data.type) } : value;
  }, workItemStateSchema),
}) satisfies z.ZodType<TrackerLiveSummary>;

// GitHub threads were the one shape that ever left `instance` out: on the
// wire and in stored records a GitHub thread without one is on github.com, so
// its key reads exactly as it always did.
const legacyGitHubThreadSchema = z.looseObject({ provider: z.literal('github'), instance: z.undefined() });

const trackedThreadSchema = z.object({
  provider: sourceControlProviderIdSchema,
  instance: z.string().min(1),
  // Empty for a path-style provider's top-level project; the server, which knows the provider, refuses it elsewhere.
  owner: z.string(),
  repo: z.string().min(1),
  number: z.number().int().positive(),
  kind: z.enum(['pull', 'issue', 'discussion']),
  accountId: z.string().min(1).optional(),
});
// Records written before trackers had a `kind` are Linear issues: `{ provider: 'linear', identifier }`.
const legacyWorkItemSchema = z.looseObject({ provider: z.literal('linear'), kind: z.undefined(), identifier: z.string() });

const trackedItemSchema = z.union([
  z.preprocess((value) => {
    const legacy = legacyWorkItemSchema.safeParse(value);
    return legacy.success ? { ...legacy.data, kind: 'work-item' } : value;
  }, z.object({ provider: trackerProviderIdSchema, kind: z.literal('work-item'), identifier: z.string().min(1) })),
  z.preprocess((value) => {
    const legacy = legacyGitHubThreadSchema.safeParse(value);
    return legacy.success ? { ...legacy.data, instance: 'github.com' } : value;
  }, trackedThreadSchema),
]) satisfies z.ZodType<TrackedItem>;

/**
 * What the server knows of one item. `state` is null while unknown (never
 * answered, or no longer answered); `fetchedAt` is when it last answered.
 */
export type TrackedItemState =
  | { type: 'pull'; item: TrackedThread<'pull'>; state: ChangeRequestLiveSummary | null; fetchedAt: number }
  | { type: 'issue'; item: TrackedThread<'issue'>; state: IssueLiveSummary | null; fetchedAt: number }
  | { type: 'discussion'; item: TrackedThread<'discussion'>; state: DiscussionLiveSummary | null; fetchedAt: number }
  | { type: 'work-item'; item: TrackedWorkItem; state: TrackerLiveSummary | null; fetchedAt: number };

const recordSchema = z.object({ key: z.string(), item: trackedItemSchema, state: z.unknown(), fetchedAt: z.number() });

type ParsedRecord = { key: string; record: TrackedItemState };

const toRecord = ({ key, item, state, fetchedAt }: z.infer<typeof recordSchema>): ParsedRecord | null => {
  if (key !== trackedItemKey(item)) return null;
  if (isTrackedWorkItem(item)) {
    const summary = state === null ? null : workItemSummarySchema.safeParse(state);
    if (summary && !summary.success) return null;
    return { key, record: { type: 'work-item', item, state: summary ? summary.data : null, fetchedAt } };
  }
  if (item.kind === 'pull') {
    const summary = state === null ? null : pullSummarySchema.safeParse(state);
    if (summary && !summary.success) return null;
    return { key, record: { type: 'pull', item: { ...item, kind: 'pull' as const }, state: summary ? summary.data : null, fetchedAt } };
  }
  if (item.kind === 'discussion') {
    const summary = state === null ? null : discussionSummarySchema.safeParse(state);
    if (summary && !summary.success) return null;
    return { key, record: { type: 'discussion', item: { ...item, kind: 'discussion' as const }, state: summary ? summary.data : null, fetchedAt } };
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
