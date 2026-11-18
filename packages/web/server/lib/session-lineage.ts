import { z } from 'zod';

const DEFAULT_LIMIT = 5000;

interface SessionRecord {
  parentID?: unknown;
  metadata?: unknown;
}

interface SessionEvent {
  type?: unknown;
  properties?: unknown;
}

interface SessionMetadata {
  openchamber?: unknown;
}

export const OPERATOR_CHILD_KIND = 'operator-child';

const linkedSessionSchema = z.object({
  metadata: z.object({ openchamber: z.object({ kind: z.enum(['workflow-agent', OPERATOR_CHILD_KIND]), parentID: z.string().min(1) }) }),
});

const hasParentId = (record: unknown): record is { parentID: string } =>
  record != null && typeof record === 'object' && 'parentID' in record && typeof record.parentID === 'string';

export const sessionParentId = (record: SessionRecord | readonly unknown[] | null | undefined) => {
  if (hasParentId(record) && record.parentID) return record.parentID;
  const link = linkedSessionSchema.safeParse(record);
  return link.success ? link.data.metadata.openchamber.parentID : null;
};

export const isOperatorChildSession = (record: SessionRecord | null | undefined) => linkedSessionSchema.safeParse(record).data?.metadata.openchamber.kind === OPERATOR_CHILD_KIND;

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

export function createSessionLineage({ limit = DEFAULT_LIMIT }: { limit?: number } = {}) {
  const isChildById = new Map<string, boolean>();

  const remember = (sessionId: string, parentId: string | null) => {
    if (!sessionId) return;
    isChildById.delete(sessionId);
    isChildById.set(sessionId, Boolean(parentId));
    while (isChildById.size > limit) {
      const oldest = isChildById.keys().next();
      if (!oldest.done) isChildById.delete(oldest.value);
    }
  };

  const observe = (payload: SessionEvent | null | undefined) => {
    const created = createdSchema.safeParse(payload);
    if (created.success) {
      remember(created.data.properties.sessionID, created.data.properties.info?.parentID ?? null);
      return;
    }
    const deleted = deletedSchema.safeParse(payload);
    if (deleted.success) isChildById.delete(deleted.data.properties.sessionID);
  };

  const isChild = (sessionId: string) => isChildById.get(sessionId);

  const noteMetadata = (sessionId: string, metadata: SessionMetadata | null | undefined) => {
    const parentId = sessionParentId({ metadata });
    if (parentId) {
      remember(sessionId, parentId);
      return false;
    }
    return isChildById.get(sessionId) === true && isChildById.delete(sessionId);
  };

  return { observe, remember, isChild, noteMetadata };
}
