import { randomUUID } from 'node:crypto';

// Audit event writer (plan sections 7.3 and 11.3). This table is metadata
// only: actor, target, action, request correlation, and outcome. Prompt text,
// message content, and any user data must never be written here.

export async function writeAuditEvent(
  db,
  { actorUserId = null, targetUserId = null, workspaceId = null, action, requestId = null, outcome },
) {
  if (typeof action !== 'string' || action.trim() === '') {
    throw new Error('audit event requires a non-empty action');
  }
  if (typeof outcome !== 'string' || outcome.trim() === '') {
    throw new Error('audit event requires a non-empty outcome');
  }
  const id = randomUUID();
  const { rows } = await db.query(
    `INSERT INTO audit_events (id, actor_user_id, target_user_id, workspace_id, action, request_id, outcome)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING created_at`,
    [id, actorUserId, targetUserId, workspaceId, action, requestId, outcome],
  );
  return {
    id,
    actorUserId,
    targetUserId,
    workspaceId,
    action,
    requestId,
    outcome,
    createdAt: rows[0].created_at,
  };
}
