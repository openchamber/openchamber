import { z } from 'zod';
import { id, text, time } from './stream-fields.js';

const thread = { provider: id, instance: id.optional(), owner: text, repo: id, number: z.number().int().positive(), accountId: id.optional() };
const summary = { owner: text, repo: id, number: z.number().int().positive(), title: text };
const item = (kind) => z.object({ ...thread, kind: z.literal(kind) });
const record = (itemSchema, state) => z.object({ key: text, item: itemSchema, state: state.nullable(), fetchedAt: time });
const checks = z.object({
  state: z.enum(['success', 'failure', 'pending', 'unknown']), total: time, success: time, failure: time, pending: time,
  inProgress: time.optional(), queued: time.optional(), startedAt: text.optional(),
});
const records = z.union([
  record(item('pull'), z.object({
    ...summary, state: z.enum(['open', 'closed', 'merged']), draft: z.boolean(), headSha: text.optional(), base: text.optional(),
    mergeable: z.boolean().nullable(), mergeableState: text.nullable(), checks: checks.nullable(), isInMergeQueue: z.boolean().optional(),
    mergeQueueEntry: z.object({ state: text, position: z.number().int().nonnegative() }).nullish(),
    autoMergeRequest: z.object({ enabledAt: text, mergeMethod: text }).nullish(),
  })),
  record(item('issue'), z.object({ ...summary, state: z.enum(['open', 'completed', 'not_planned']) })),
  record(item('discussion'), z.object({ ...summary, state: z.enum(['open', 'resolved', 'outdated', 'duplicate']), answered: z.boolean().nullable() })),
  record(z.object({ provider: id, kind: z.literal('work-item'), identifier: id }), z.object({
    identifier: id, title: text,
    state: z.object({ name: text, category: z.enum(['triage', 'backlog', 'todo', 'in-progress', 'done', 'canceled']), type: text.optional() }),
  })),
]);

export const trackedItemEventSchema = z.object({ states: z.array(records).max(300) });
