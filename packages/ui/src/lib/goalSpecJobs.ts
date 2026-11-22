import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';
import { takenItemSchema, toServerItemInput, type QueuedMessageInput, type QueuedMessageSendConfig } from '@/stores/messageQueueStore';
import type { SessionGoalWriterSendMode } from '@/stores/useUIStore';

// "Send when ready" on the server (`/api/goals/spec-jobs`, see
// packages/web/server/lib/session-goal/spec-jobs.js): the server writes the
// spec and queues the held message with it, whether or not a window is open.
// This module is the wire: it creates, lists, cancels and takes back jobs.

const goalSpecJobSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  directory: z.string().min(1),
  status: z.enum(['writing', 'enqueuing', 'failed']),
  error: z.string().nullable(),
  cancelled: z.boolean(),
  content: z.string(),
  attachmentCount: z.number().int().nonnegative(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type GoalSpecJob = z.infer<typeof goalSpecJobSchema>;

const goalSpecJobRemovedSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  directory: z.string().min(1),
  outcome: z.enum(['queued', 'taken', 'session-deleted']),
});

export type GoalSpecJobRemoved = z.infer<typeof goalSpecJobRemovedSchema>;

/** `openchamber:goal-spec-job.updated`: a job changed, or left the server. */
export const goalSpecJobEventSchema = z.union([
  z.object({ job: goalSpecJobSchema }),
  z.object({ removed: goalSpecJobRemovedSchema }),
]);

const listResponseSchema = z.object({ jobs: z.array(goalSpecJobSchema) });
const createResponseSchema = z.object({ job: goalSpecJobSchema });
const takeResponseSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  directory: z.string().min(1),
  item: takenItemSchema,
  error: z.string().nullable(),
});

const errorSchema = z.object({ error: z.string().min(1) });

/** The writer's input, as `POST /api/goals/spec` takes it. */
export interface GoalSpecJobWriterInput {
  request: string;
  conversation?: string;
  openItems?: string;
  providerID?: string;
  modelID?: string;
  writerProviderID?: string;
  writerModelID?: string;
  writerVariant?: string;
  section?: string;
  currentSpec?: string;
  ignoreLimit?: boolean;
}

const requestJob = async <T,>(schema: z.ZodType<T>, path: string, init: RequestInit & { directory?: string | null }): Promise<T> => {
  const response = await runtimeFetch(path, init);
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = errorSchema.safeParse(payload);
    throw new Error(parsed.success ? parsed.data.error : `HTTP ${response.status}`);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new Error('Invalid goal job response');
  return parsed.data;
};

const post: RequestInit = { method: 'POST' };

/** Starts a job. Rejects when the server did not save it: the message is then still the caller's. */
export const createGoalSpecJob = (input: {
  sessionId: string;
  directory: string;
  sendMode: SessionGoalWriterSendMode;
  tokenBudget: number | null;
  writer: GoalSpecJobWriterInput;
  message: QueuedMessageInput;
  sendConfig: QueuedMessageSendConfig;
}): Promise<GoalSpecJob> => requestJob(createResponseSchema, '/api/goals/spec-jobs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    sessionId: input.sessionId,
    directory: input.directory,
    sendMode: input.sendMode,
    tokenBudget: input.tokenBudget,
    writer: input.writer,
    item: toServerItemInput(input.message, input.sendConfig),
  }),
  // A session in an isolated space is queued by the server inside it.
  directory: input.directory,
}).then((response) => response.job);

/** Every job on the server; a failed read rejects, never answers "none". */
export const listGoalSpecJobs = (): Promise<GoalSpecJob[]> => requestJob(listResponseSchema, '/api/goals/spec-jobs', { method: 'GET' })
  .then((response) => response.jobs);

/** Stops a job being written; its message stays on the server for its composer. */
export const cancelGoalSpecJob = (job: Pick<GoalSpecJob, 'id' | 'directory'>): Promise<GoalSpecJob> => requestJob(
  createResponseSchema,
  `/api/goals/spec-jobs/${encodeURIComponent(job.id)}/cancel`,
  { ...post, directory: job.directory },
).then((response) => response.job);

/** Takes a job's message back, payloads included; the job leaves the server. */
export const takeGoalSpecJob = (job: Pick<GoalSpecJob, 'id' | 'directory'>): Promise<z.infer<typeof takeResponseSchema>> => requestJob(
  takeResponseSchema,
  `/api/goals/spec-jobs/${encodeURIComponent(job.id)}/take`,
  { ...post, directory: job.directory },
);
