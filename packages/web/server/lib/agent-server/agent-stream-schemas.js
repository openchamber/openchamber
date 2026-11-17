import { z } from 'zod';
import { browserControlActionSchema } from '@openchamber/sdk/schemas';

import { automationEventSchemas } from './automation-event-schemas.js';
import { browserRequestSchema } from './browser-request-schema.js';
import { fixLoopEventSchema } from './fix-loop-event-schema.js';
import { sessionEventSchemas, notificationEventSchemas } from './session-event-schemas.js';
import { trackedItemEventSchema } from './tracked-item-event-schema.js';
import { directory, id, sessionId, text, time, stripProvenance } from './stream-fields.js';

const controlSchemas = {
  ...automationEventSchemas, ...sessionEventSchemas,
  'openchamber:browser-control-request': browserRequestSchema,
  'openchamber:pr-fix-loop.updated': fixLoopEventSchema,
  'openchamber:tracked-items.changed': trackedItemEventSchema,
  'openchamber:file-open-request': z.object({ path: directory, directory: directory.nullable(), sessionId: sessionId.nullable() }),
  'openchamber:plan-open-request': z.object({ projectId: id, planId: id, title: text, directory: directory.nullable(), sessionId: sessionId.nullable() }),
  'openchamber:browser-agent-activity': z.object({ guestId: id, action: browserControlActionSchema, directory: directory.nullable(), sessionId: sessionId.nullable() }),
  'openchamber:scheduled-task-ran': z.object({ projectId: id, taskId: id, ranAt: time, status: z.enum(['running', 'sent', 'success', 'error']), sessionId: sessionId.optional() }),
  'openchamber:worktree-changed': z.object({ directories: z.array(directory).min(1).max(10_000), at: time.optional() }),
  'openchamber:agent-memory-changed': z.object({ scope: z.enum(['global', 'project']), projectId: id.optional() }),
  'openchamber:project-context-changed': z.object({ projectId: id }),
  'openchamber:suggested-tasks-changed': z.object({ projectId: id }),
  'openchamber:session-folders-changed': z.object({ updatedAt: time }),
  'openchamber:session-drafts-changed': z.object({ updatedAt: time }),
  'openchamber:source-control.activity': z.object({ directory }),
  'openchamber:guest-files-changed': z.object({ guestId: id, watchId: id, paths: z.array(directory).max(16) }),
  'openchamber:terminal-sessions-changed': z.object({}),
  'openchamber:source-control-providers-changed': z.object({}),
  'openchamber:tracker-providers-changed': z.object({}),
  'openchamber:guests-changed': z.object({}),
  'openchamber:limit-failover': z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('account'), sessionId, providerId: id, fromAccount: text.nullable(), toAccount: id }),
    z.object({ kind: z.literal('model'), sessionId, providerId: id, modelId: id, toProviderId: id, toModelId: id }),
  ]),
  'openchamber:routing.updated': z.object({ available: z.boolean(), autoReady: z.boolean(), jevAvailable: z.boolean().optional(), tokenPresent: z.boolean(), jevSource: z.enum(['typesafe', 'zen-free']) }),
  'openchamber:routing.decision': z.object({
    sessionId, at: time, category: text.nullable(), confidence: time,
    reason: z.enum(['routed', 'low-confidence', 'unknown-category', 'error', 'not-ready']),
    providerID: id.optional(), modelID: id.optional(), variant: text.nullable().optional(), agent: text.nullable().optional(), error: text.optional(),
  }),
  'openchamber:routing.permission-held': z.object({ permissionId: id, sessionId, directory: directory.nullable(), score: time, kind: text.nullable() }),
  'openchamber:routing.safety-skipped': z.object({ permissionId: id, sessionId, directory: directory.nullable(), error: text }),
};
const envelopeSchema = z.object({ type: z.string().min(1).max(128), properties: z.unknown() });
// The type a refused event is logged under.
const loggedTypeSchema = z.string().catch('invalid');
const internalTypes = new Set(['openchamber:event-stream-ready', 'openchamber:notification-stream-ready', 'openchamber:heartbeat']);

/** One owner stream per type avoids duplicate delivery of shared SSE events. */
export function parseAgentStreamEvent(payload, source, logger) {
  const envelope = envelopeSchema.safeParse(payload);
  const type = envelope.success ? envelope.data.type : loggedTypeSchema.parse(payload?.type);
  if (internalTypes.has(type)) return null;
  const schemas = source === 'control' ? controlSchemas : notificationEventSchemas;
  const schema = Object.hasOwn(schemas, type) ? schemas[type] : null;
  // Notification and permission broadcasts appear on both streams in the agent.
  if (source === 'control' && Object.hasOwn(notificationEventSchemas, type)) return null;
  const properties = envelope.success && schema ? schema.safeParse(envelope.data.properties) : null;
  if (!properties?.success) {
    logger.warn?.(`[agent-streams] dropped ${type.slice(0, 128).replace(/[^a-zA-Z0-9:._-]/g, '_')}`);
    return null;
  }
  const cleaned = stripProvenance(properties.data);
  if (type === 'openchamber:notification') {
    cleaned.desktopNotificationDelivered = false;
    cleaned.desktopStdoutActive = false;
  }
  return { type, origin: 'agent', spaceId: null, properties: { ...cleaned, origin: 'agent', spaceId: null } };
}
