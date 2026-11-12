import { z } from 'zod';
import { directory, id, sessionId, text, time } from './stream-fields.js';

const sendConfig = z.object({ providerID: id.optional(), modelID: id.optional(), agent: text.optional(), variant: text.optional() });
const attachment = z.object({
  id, filename: text, mimeType: id, size: z.number().nonnegative(), source: z.enum(['local', 'server', 'vscode']),
  serverPath: directory.optional(), agentPath: directory.optional(),
});
const queueItem = z.object({
  id, content: text, text, createdAt: time, agentMention: text.optional(), attachments: z.array(attachment).max(100),
  contextPreview: text.optional(), sendConfig,
  goal: z.object({ objective: text.optional(), tokenBudget: z.number().int().positive().nullable() }).optional(),
  scheduledTask: z.object({ projectId: id, taskId: id }).optional(),
  origin: z.object({ kind: z.enum(['pr-fix-loop', 'pr-stack']), id }).optional(),
});
const autoReview = z.object({
  originalSessionID: sessionId, reviewSessionID: sessionId, directory,
  status: z.enum(['running', 'clean', 'disputed', 'limit', 'failed', 'stopped']),
  step: z.enum(['handoff', 'review', 'implement']), round: z.number().int().nonnegative(),
  maxRounds: z.number().int().positive(), startedAt: time, updatedAt: time,
  error: text.optional(), dispute: text.optional(),
});
const watch = z.object({
  sessionID: sessionId, directory, url: text, number: z.number(), title: text,
  status: z.enum(['unknown', 'pending', 'passed', 'failed', 'open', 'waking']), startedAt: time,
});
const workflow = z.object({
  id, parentSessionId: sessionId, directory, name: text, description: text,
  state: z.enum(['awaiting-approval', 'running', 'completed', 'failed', 'stopped', 'declined']),
  attempt: z.number().int().nonnegative(), createdAt: time, startedAt: time.optional(), endedAt: time.optional(),
  currentPhase: text.nullable(), phases: z.array(text).max(100),
  agents: z.array(z.object({
    key: id, label: text, phase: text.nullable(), state: z.enum(['queued', 'running', 'completed', 'failed', 'stopped']),
    sessionId: sessionId.optional(), replayed: z.boolean().optional(), startedAt: time.optional(), endedAt: time.optional(),
    model: text.optional(), error: text.optional(), preview: text.optional(),
    usage: z.object({ cost: time, input: time, output: time, reasoning: time, cacheRead: time, cacheWrite: time }).optional(),
  })).max(1000),
  logs: z.array(z.object({ at: time, message: text })).max(20), error: text.optional(), resultPreview: text.optional(),
});

export const automationEventSchemas = {
  'openchamber:message-queue.updated': z.object({
    revision: time, session: z.object({ sessionId, directory, items: z.array(queueItem).max(20), sendingId: id.nullable() }),
  }),
  'openchamber:auto-review.updated': z.object({ revision: time, originalSessionID: sessionId, directory, run: autoReview.nullable() }),
  'openchamber:pr-watch.updated': z.object({ revision: time, sessionID: sessionId, watch: watch.nullable() }),
  'openchamber:workflow-run': z.object({ run: workflow }),
  'openchamber:workflow-run-removed': z.object({ runId: id, parentSessionId: sessionId }),
  'openchamber:session-warming': z.object({
    revision: time, enabled: z.boolean(), minutes: time,
    sessions: z.array(z.object({ sessionId, warmUntil: time.nullable() })).max(10000),
  }),
  'openchamber:pr-stack.restack': z.object({ run: z.object({
    id, directory, sessionId: sessionId.nullable(), remote: text, trunk: text,
    status: z.enum(['running', 'paused', 'waitingForSession', 'done', 'failed', 'aborted']), conflictMode: z.enum(['pause', 'agent']),
    steps: z.array(z.object({
      branch: text, onto: text, status: z.enum(['pending', 'done', 'unchanged', 'conflict', 'failed', 'skipped']),
      error: text.optional(), conflictFiles: z.array(text).optional(), worktree: directory.optional(), before: text.optional(), after: text.optional(),
    })).max(1000), createdAt: time, updatedAt: time,
  }) }),
};
