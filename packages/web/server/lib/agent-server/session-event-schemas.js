import { z } from 'zod';
import { directory, id, sessionId, text, time } from './stream-fields.js';

const optional = (schema) => schema.nullable().optional();
const goal = z.object({
  id, objective: text, objectiveFile: z.boolean().optional(),
  status: z.enum(['active', 'paused', 'blocked', 'budgetLimited', 'complete']),
  tokenBudget: optional(time), tokensUsed: time.optional(), turnsUsed: time.optional(), blockedStreak: time.optional(),
  note: text.optional(), statusReason: text.optional(), lastAccountedMessageID: text.optional(),
  evaluationProviderID: text.optional(), evaluationModelID: text.optional(), createdAt: time, updatedAt: time,
  driver: optional(id),
});
const metadata = z.object({ openchamber: z.object({
  kind: text.optional(), originalSessionID: optional(sessionId), reviewSessionID: optional(sessionId),
  btwSessionID: optional(sessionId), btwBoundaryMessageID: optional(id), btwPromoted: z.boolean().optional(),
  multirun: optional(z.object({
    version: z.literal(1), sessionID: sessionId.nullable(),
    group: z.discriminatedUnion('kind', [z.object({ kind: z.literal('id'), id: z.uuid() }), z.object({ kind: z.literal('legacy'), scope: directory })]),
    groupSlug: id, runGroup: id.optional(), providerID: id, modelID: id, index: z.number().int().positive().optional(),
    role: z.enum(['run', 'fusion']), title: text.optional(),
    autoFusion: z.object({ providerID: id, modelID: id, variant: id.optional(), agent: id.optional(), launcherId: id }).optional(),
  })),
  goal: optional(goal),
  assist: optional(z.object({ recap: text, suggestion: text, forMessageID: id, generatedAt: time })),
  work: optional(z.object({ state: z.enum(['open', 'done']), openedAt: time.optional(), openedBy: z.enum(['auto', 'jev', 'user']).optional(), doneAt: time.optional(), suggestDoneAt: time.optional() })),
  reviewOffer: optional(z.object({ at: time })), priority: optional(z.object({ at: time })),
  pinned: optional(z.object({ at: time, list: id.optional() })),
  workTitle: optional(z.object({ title: text, by: z.enum(['user', 'agent']) })),
  turn: optional(z.object({ endedAt: time, durationMs: time })),
  pendingQuestion: optional(z.object({ messageID: id, callID: id, title: text, cause: z.enum(['opencode-restart', 'inactivity']), at: time })),
  restartCutTurn: optional(z.object({ messageID: id, at: time, callID: optional(id), toolName: optional(text) })),
  interruption: optional(z.object({
    reason: text, at: time, cause: text.optional(),
    tool: optional(z.object({ name: id, input: optional(text), callID: optional(id) })),
    resume: optional(z.object({ state: z.enum(['waiting', 'sent', 'manual']), at: time, reason: text.optional() })),
  })),
  context_obligatory_messages: z.array(z.object({ id, createdAt: time, role: z.enum(['user', 'assistant']) })).optional(),
  context_obligatory_last_compaction_message_id: optional(id),
}).optional() });

export const sessionEventSchemas = {
  'openchamber:session-metadata': z.object({ sessionID: sessionId, metadata }),
  'openchamber:session-assist': z.object({ sessionID: sessionId, directory: directory.nullable(), pending: z.boolean() }),
  'openchamber:session-archived': z.object({ sessionID: sessionId, archivedAt: time.nullable() }),
  'openchamber:session-created': z.object({
    sessionId, directory, createdAt: time, promptDispatched: z.boolean(), dispatchedAsCommand: z.boolean(),
    projectId: id.optional(), title: text.optional(),
  }),
  'openchamber:page-waiting': z.object({ sessionID: sessionId, directory: directory.nullable(), page: z.object({ id, title: text }) }),
  'openchamber:page-settled': z.object({ sessionID: sessionId, pageID: id }),
};

export const notificationEventSchemas = {
  'openchamber:notification': z.object({
    title: text.optional(), body: text.optional(), tag: id.optional(),
    kind: z.enum(['ready', 'error', 'question', 'permission', 'goal', 'review', 'plugin', 'browser-help', 'pull-request']).optional(),
    sessionId: optional(sessionId), directory: optional(directory), guestId: optional(id),
    requireHidden: z.boolean().optional(), showWhenFocused: z.boolean().optional(),
  }),
  'openchamber:permission-auto-accept.updated': z.object({
    revision: time, sessions: z.record(sessionId, z.boolean()).optional(), modes: z.record(sessionId, z.enum(['ask', 'safety', 'auto'])),
  }),
  'openchamber:permission-auto-accept.left-for-user': z.object({ permissionId: id, sessionId, directory: directory.nullable() }),
  'openchamber:session-status': z.object({
    sessionID: sessionId, status: z.enum(['busy', 'idle', 'retry']), timestamp: time, turnStartedAt: time.optional(),
    metadata: z.object({ attempt: time.optional(), message: text.optional(), next: time.optional() }).optional(),
  }),
  'openchamber:session-activity': z.object({ sessionId, phase: z.enum(['busy', 'cooldown', 'idle']) }),
};
