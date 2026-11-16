/**
 * Which sessions are subsessions, remembered so per-turn work can skip them
 * without asking OpenCode. A parent changes only when the user takes over an
 * operator's child session, a metadata write `noteMetadata` hears; it is
 * learned from `session.created` events (the translated event names the
 * parent) and from any session record a runtime read anyway. Bounded: the
 * oldest entries go first, and a forgotten session is simply unknown again.
 */
import { z } from 'zod';

const DEFAULT_LIMIT = 5000;

export const OPERATOR_CHILD_KIND = 'operator-child';

const linkedSessionSchema = z.object({
  metadata: z.object({ openchamber: z.object({ kind: z.enum(['workflow-agent', OPERATOR_CHILD_KIND]), parentID: z.string().min(1) }) }),
});

export const sessionParentId = (record) => {
  if (typeof record?.parentID === 'string' && record.parentID) return record.parentID;
  const link = linkedSessionSchema.safeParse(record);
  return link.success ? link.data.metadata.openchamber.parentID : null;
};

export const isOperatorChildSession = (record) => linkedSessionSchema.safeParse(record).data?.metadata.openchamber.kind === OPERATOR_CHILD_KIND;

const createdSchema = z.object({
  type: z.literal('session.created'),
  properties: z.object({
    sessionID: z.string().min(1),
    info: z.object({ parentID: z.string().min(1).optional() }).optional(),
  }),
});

const deletedSchema = z.object({
  type: z.literal('session.deleted'),
  properties: z.object({ sessionID: z.string().min(1) }),
});

export function createSessionLineage({ limit = DEFAULT_LIMIT } = {}) {
  // sessionID → true for a subsession, false for a top-level session.
  const isChildById = new Map();

  const remember = (sessionId, parentId) => {
    if (!sessionId) return;
    isChildById.delete(sessionId);
    isChildById.set(sessionId, Boolean(parentId));
    while (isChildById.size > limit) isChildById.delete(isChildById.keys().next().value);
  };

  /** Learns from the server's translated event stream. */
  const observe = (payload) => {
    const created = createdSchema.safeParse(payload);
    if (created.success) {
      remember(created.data.properties.sessionID, created.data.properties.info?.parentID ?? null);
      return;
    }
    const deleted = deletedSchema.safeParse(payload);
    if (deleted.success) isChildById.delete(deleted.data.properties.sessionID);
  };

  /** True for a known subsession, false for a known top-level session, undefined when unknown. */
  const isChild = (sessionId) => isChildById.get(sessionId);

  const noteMetadata = (sessionId, metadata) => {
    const parentId = sessionParentId({ metadata });
    if (parentId) {
      remember(sessionId, parentId);
      return false;
    }
    return isChildById.get(sessionId) === true && isChildById.delete(sessionId);
  };

  return { observe, remember, isChild, noteMetadata };
}
