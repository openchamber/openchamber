import { z } from 'zod';

import type { CISummary } from '../source-control/types';

const checksSchema = z.object({
  state: z.enum(['success', 'failure', 'pending', 'unknown']),
  total: z.number(), success: z.number(), failure: z.number(), pending: z.number(),
  inProgress: z.number().optional(), queued: z.number().optional(), startedAt: z.string().optional(),
}) satisfies z.ZodType<CISummary>;

const pullStackMemberSchema = z.object({
  number: z.number().int().positive(), title: z.string(), url: z.string().url(),
  state: z.enum(['open', 'closed', 'merged']), draft: z.boolean(),
  head: z.string(), base: z.string(), headSha: z.string(),
  checks: checksSchema.nullable(), mergeable: z.boolean().nullable(), mergeableState: z.string().nullable(),
  summary: z.enum(['ok', 'unknown']), behindBase: z.number().int().nonnegative().nullable(),
  retargetTo: z.string().nullable(),
  /** The merged PR this one sat on; a restack moves only the commits after its head. */
  mergedParent: z.object({ number: z.number().int().positive(), head: z.string(), headSha: z.string() }).nullable(),
});

const pullStackSchema = z.object({
  source: z.enum(['native', 'inferred']), nativeNumber: z.number().int().positive().nullable(),
  trunk: z.string(), members: z.array(pullStackMemberSchema), current: z.number().int().positive(),
  branches: z.array(z.object({ number: z.number().int().positive(), base: z.string(), title: z.string() })),
  nativeUnavailable: z.boolean(),
});

export const pullStackResultSchema = z.discriminatedUnion('connected', [
  z.object({ connected: z.literal(false) }),
  z.object({ connected: z.literal(true), stack: pullStackSchema.nullable() }),
]);

export const restackRunSchema = z.object({
  id: z.string().min(1), directory: z.string().min(1), sessionId: z.string().nullable(),
  remote: z.string(), trunk: z.string(),
  status: z.enum(['running', 'paused', 'waitingForSession', 'done', 'failed', 'aborted']),
  conflictMode: z.enum(['pause', 'agent']),
  steps: z.array(z.object({
    branch: z.string(), onto: z.string(),
    status: z.enum(['pending', 'done', 'unchanged', 'conflict', 'failed', 'skipped']),
    error: z.string().optional(), conflictFiles: z.array(z.string()).optional(), worktree: z.string().optional(),
    before: z.string().optional(), after: z.string().optional(),
  })),
  createdAt: z.number(), updatedAt: z.number(),
});

export const restackEventSchema = z.object({
  type: z.literal('openchamber:pr-stack.restack'),
  properties: z.object({ run: restackRunSchema }),
});

export const stackRegistrationSchema = z.object({
  ok: z.literal(true), registered: z.boolean(), nativeNumber: z.number().nullable(), reason: z.string().optional(),
});
export const stackRetargetSchema = z.object({ ok: z.literal(true) });
export const stackMergeSchema = z.discriminatedUnion('status', [
  z.object({ ok: z.literal(true), status: z.literal('merged'), merged: z.literal(true), retargeted: z.number().nullable() }),
  z.object({ ok: z.literal(true), status: z.enum(['enqueued', 'pending']), merged: z.literal(false), retargeted: z.null() }),
]);

const stackParentPullSchema = z.object({
  number: z.number().int().positive(), head: z.string().min(1), title: z.string(), url: z.string(),
});

/** Which open PR a local branch sits on, for the create form. `ambiguous` never preselects. */
export const stackParentResultSchema = z.discriminatedUnion('connected', [
  z.object({ connected: z.literal(false) }),
  z.object({
    connected: z.literal(true),
    result: z.discriminatedUnion('status', [
      z.object({ status: z.literal('found'), via: z.enum(['ancestry', 'created-from']), parent: stackParentPullSchema }),
      z.object({ status: z.literal('ambiguous'), candidates: z.array(stackParentPullSchema).min(2) }),
      z.object({ status: z.enum(['none', 'incomplete', 'unavailable']) }),
    ]),
  }),
]);

/** Per PR number: in a stack, not in one, or unknown (`null`, never read as "not stacked"). */
export const stackMembershipResultSchema = z.discriminatedUnion('connected', [
  z.object({ connected: z.literal(false) }),
  z.object({ connected: z.literal(true), members: z.record(z.string().regex(/^\d+$/), z.boolean().nullable()) }),
]);

export type PullStackMember = z.infer<typeof pullStackMemberSchema>;
export type StackMembershipResult = z.infer<typeof stackMembershipResultSchema>;
export type StackParentResult = z.infer<typeof stackParentResultSchema>;
export type PullStack = z.infer<typeof pullStackSchema>;
export type PullStackResult = z.infer<typeof pullStackResultSchema>;
export type RestackRun = z.infer<typeof restackRunSchema>;
export type RestackEvent = z.infer<typeof restackEventSchema>;
export type PullStackRegistration = z.infer<typeof stackRegistrationSchema>;
export type PullStackMerge = z.infer<typeof stackMergeSchema>;
export type RestackInput = {
  readonly directory: string;
  readonly sessionId: string | null;
  readonly remote: string;
  readonly trunk: string;
  readonly branches: string[];
  readonly oldBase?: string;
};
