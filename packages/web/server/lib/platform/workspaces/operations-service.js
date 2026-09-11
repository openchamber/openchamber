// Idempotent workspace operations service (plan sections 8.1, 8.2, 8.5).
//
// Owns: the per-user workspace record, registration of start/stop/rebuild
// operations, and the generation bookkeeping that protects the workspace row
// from late callbacks of older operations.
//
// Idempotency design (the DB unique constraint is (workspace_id,
// idempotency_key) - stricter than per-kind, so the kind is embedded in the
// key): each workspace+kind pair has ONE deterministic key
// (`<kind>:<workspaceId>`) that is "unique while non-terminal" in effect:
//   - concurrent same-kind requests all attempt the same key; exactly one
//     INSERT wins, the others hit the unique constraint and return the
//     winner's still-running operation (plan section 8.1 step 2);
//   - once that operation is terminal, a retry generates a fresh random
//     suffix (`<kind>:<workspaceId>:<uuid>`) so a genuinely new attempt gets a
//     new operation (RT-03: retry after failure produces a new operation).
//
// Generation rules: start/rebuild register a NEW generation (new incarnation
// of the runtime); stop keeps the current generation. The workspace
// generation bump happens AFTER the operation insert in a separate guarded
// UPDATE so a crash between them can never bump without a locatable
// operation, and concurrent requests can never bump twice for one operation.

import { randomUUID } from 'node:crypto';

import { writeAuditEvent } from '../audit/audit-writer.js';
import { WORKSPACE_STATES, canReachObservedState } from './state-machine.js';

export const OPERATION_KINDS = Object.freeze(['start', 'stop', 'rebuild']);
export const NON_TERMINAL_STATUSES = Object.freeze(['pending', 'running']);

// Domain error with a stable machine-readable code and HTTP-ish status the
// route layer maps onto the plan section 9.1 error semantics.
export class WorkspaceServiceError extends Error {
  constructor(code, { status = 409, message } = {}) {
    super(message ?? code);
    this.code = code;
    this.status = status;
  }
}

const AUDIT_ACTIONS = Object.freeze({
  start: 'platform.workspace.start',
  stop: 'platform.workspace.stop',
  rebuild: 'platform.workspace.rebuild',
});

function isUniqueViolation(error) {
  return error?.code === '23505';
}

function toOperation(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    generation: row.generation,
    kind: row.kind,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    errorCode: row.error_code ?? null,
    reason: row.reason ?? null,
    requestId: row.request_id ?? null,
  };
}

function toWorkspace(row) {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    desiredState: row.desired_state,
    observedState: row.observed_state,
    generation: row.generation,
    lastActivityAt: row.last_activity_at ?? null,
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
  };
}

// Public workspace view (route responses): never exposes runtime_id,
// internal_endpoint or credential_ref - they are internal-only (plan 7.3).
export function toWorkspaceView(row) {
  return toWorkspace(row);
}

function isHealthy(row) {
  return row.desired_state === 'started'
    && row.observed_state === WORKSPACE_STATES.RUNNING
    && row.runtime_id !== null;
}

async function recordAttempt(db, { userId, workspaceId, kind, requestId, outcome, logger }) {
  try {
    await writeAuditEvent(db, {
      actorUserId: userId,
      targetUserId: userId,
      workspaceId,
      action: AUDIT_ACTIONS[kind],
      requestId,
      outcome,
    });
  } catch (error) {
    logger?.warn?.(`[platform-workspaces] failed to write audit event: ${error?.message || error}`);
  }
}

// One stable workspace record per user (plan section 7.3). Created lazily on
// first access; owner_user_id UNIQUE makes concurrent creation safe via the
// 23505 path (pg-mem cannot run ON CONFLICT, so catch + reselect).
export async function ensureWorkspaceForUser(db, { userId }) {
  try {
    await db.query('INSERT INTO workspaces (id, owner_user_id) VALUES ($1, $2)', [
      randomUUID(),
      userId,
    ]);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  return getWorkspaceForUser(db, { userId });
}

export async function getWorkspaceForUser(db, { userId }) {
  const { rows } = await db.query('SELECT * FROM workspaces WHERE owner_user_id = $1', [userId]);
  return rows[0] ?? null;
}

export async function getWorkspaceById(db, { workspaceId }) {
  const { rows } = await db.query('SELECT * FROM workspaces WHERE id = $1', [workspaceId]);
  return rows[0] ?? null;
}

async function findInFlightOperation(db, { workspaceId, kind }) {
  const { rows } = await db.query(
    `SELECT * FROM runtime_operations
     WHERE workspace_id = $1 AND kind = $2 AND status = ANY($3)
     ORDER BY requested_at DESC LIMIT 1`,
    [workspaceId, kind, NON_TERMINAL_STATUSES],
  );
  return rows[0] ?? null;
}

// Insert the operation row, folding constraint conflicts into the idempotent
// "return the in-flight operation" behaviour. Returns null when the
// deterministic key is held by a TERMINAL operation and the caller must retry
// with a fresh random key.
async function insertOperation(db, { workspace, kind, generation, userId, requestId, reason }) {
  const keys = [`${kind}:${workspace.id}`, `${kind}:${workspace.id}:${randomUUID()}`];
  for (const idempotencyKey of keys) {
    try {
      const { rows } = await db.query(
        `INSERT INTO runtime_operations
           (id, workspace_id, generation, kind, status, idempotency_key, requested_by, request_id, reason)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8)
         RETURNING *`,
        [randomUUID(), workspace.id, generation, kind, idempotencyKey, userId, requestId, reason],
      );
      return { operation: rows[0] };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = (
        await db.query(
          'SELECT * FROM runtime_operations WHERE workspace_id = $1 AND idempotency_key = $2',
          [workspace.id, idempotencyKey],
        )
      ).rows[0];
      if (existing && NON_TERMINAL_STATUSES.includes(existing.status)) {
        return { operation: existing };
      }
      // Terminal row holds the deterministic key: fall through to the
      // random-suffixed key for a genuinely new attempt.
    }
  }
  return { operation: null };
}

// start / rebuild (plan section 8.1 steps 1-3).
// When `workspaceId` is supplied the operation targets THAT workspace instead
// of the caller's own (admin stop/rebuild of another user's environment,
// plan section 7.2) - the pipeline is identical either way.
async function requestStartLike(db, { kind, user, requestId, reason, logger, workspaceId = null }) {
  const workspace = workspaceId
    ? await getWorkspaceById(db, { workspaceId })
    : await ensureWorkspaceForUser(db, { userId: user.id });
  if (!workspace) {
    throw new WorkspaceServiceError('workspace_not_found', { status: 404 });
  }
  workspaceId = workspace.id;

  // Step 3a: an already-healthy workspace answers start with the existing
  // workspace and no operation (plan section 8.1 step 3). Rebuild is never
  // short-circuited: replacing a healthy environment is its whole purpose.
  if (kind === 'start' && isHealthy(workspace)) {
    const fresh = await getWorkspaceById(db, { workspaceId });
    return { status: 'healthy', workspace: toWorkspace(fresh), operation: null };
  }

  // Step 2: an in-flight operation of this kind -> return that same operation.
  // Re-read the workspace: the winner of the race has since bumped the
  // generation, and returning the handler-start snapshot would answer an
  // incoherent view (RT-01).
  const inFlight = await findInFlightOperation(db, { workspaceId, kind });
  if (inFlight) {
    const fresh = await getWorkspaceById(db, { workspaceId });
    return { status: 'accepted', workspace: toWorkspace(fresh), operation: toOperation(inFlight) };
  }

  // Step 3b: register a new operation carrying the next generation.
  const generation = workspace.generation + 1;
  const { operation } = await insertOperation(db, {
    workspace, kind, generation, userId: user.id, requestId, reason,
  });
  if (!operation) {
    throw new WorkspaceServiceError('operation_create_failed', { status: 500 });
  }

  // Only the request that actually created the operation bumps the
  // generation; idempotent followers returned above never reach this.
  // A racing operation of another kind may have bumped first - that is fine,
  // the driver calls are generation-idempotent and the worker's write guards
  // settle the final state.
  const fresh = (
    await db.query(
      `UPDATE workspaces
       SET generation = $2, desired_state = 'started', observed_state = 'starting', last_error = NULL
       WHERE id = $1 AND generation < $2
       RETURNING *`,
      [workspaceId, generation],
    )
  ).rows[0] ?? (await getWorkspaceById(db, { workspaceId }));

  await recordAttempt(db, {
    userId: user.id, workspaceId, kind, requestId, outcome: 'success', logger,
  });
  return { status: 'accepted', workspace: toWorkspace(fresh), operation: toOperation(operation) };
}

export async function startWorkspace(db, { user, requestId, logger } = {}) {
  return requestStartLike(db, { kind: 'start', user, requestId, logger });
}

// Rebuild = stop old generation, keep data, start new generation (plan
// section 8.2). Modeled as ONE operation carrying the new generation; the
// driver replaces the older-generation runtime inside ensureWorkspace.
export async function rebuildWorkspace(db, { user, requestId, reason, logger, workspaceId } = {}) {
  return requestStartLike(db, { kind: 'rebuild', user, requestId, reason, logger, workspaceId });
}

// stop (plan sections 8.2 and 8.5). Repeated stop safely returns the current
// state (no duplicate operations); reason is recorded on the operation.
export async function stopWorkspace(db, { user, workspaceId, requestId, reason, logger } = {}) {
  const workspace = await getWorkspaceById(db, { workspaceId });
  if (!workspace) {
    throw new WorkspaceServiceError('workspace_not_found', { status: 404 });
  }

  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new WorkspaceServiceError('reason_required', { status: 400 });
  }

  const inFlight = await findInFlightOperation(db, { workspaceId, kind: 'stop' });
  if (inFlight) {
    // Re-read as in requestStartLike: the in-flight stop bumped the row
    // (desired/observed) after our snapshot was taken.
    const fresh = await getWorkspaceById(db, { workspaceId });
    return { status: 'accepted', workspace: toWorkspace(fresh), operation: toOperation(inFlight) };
  }

  const alreadyStopped = workspace.desired_state === 'stopped'
    && workspace.observed_state === WORKSPACE_STATES.STOPPED
    && workspace.runtime_id === null;
  if (alreadyStopped) {
    return { status: 'already_stopped', workspace: toWorkspace(workspace), operation: null };
  }

  // Validate the transition BEFORE creating any row: an invalid transition
  // must not leave a phantom pending operation behind (the worker would
  // later fail it as superseded with a spurious failure audit).
  if (!canReachObservedState(workspace.observed_state, WORKSPACE_STATES.STOPPING)) {
    throw new WorkspaceServiceError('invalid_state_transition', {
      status: 409,
      message: `cannot stop workspace in observed_state=${workspace.observed_state}`,
    });
  }

  const { operation } = await insertOperation(db, {
    workspace, kind: 'stop', generation: workspace.generation, userId: user?.id ?? null,
    requestId, reason,
  });
  if (!operation) {
    throw new WorkspaceServiceError('operation_create_failed', { status: 500 });
  }

  const fresh = (
    await db.query(
      `UPDATE workspaces SET desired_state = 'stopped', observed_state = 'stopping'
       WHERE id = $1 RETURNING *`,
      [workspaceId],
    )
  ).rows[0];

  await recordAttempt(db, {
    userId: user?.id ?? null, workspaceId, kind: 'stop', requestId, outcome: 'success', logger,
  });
  return { status: 'accepted', workspace: toWorkspace(fresh), operation: toOperation(operation) };
}

// Owner-scoped operation read (plan sections 7.2 and 9.1): a user may only
// read operations of their own workspace; admins may read any. Unauthorized
// access is indistinguishable from a missing resource -> 404, never 403.
export async function getOperationForUser(db, { user, operationId }) {
  const { rows } = await db.query(
    `SELECT o.*, w.owner_user_id AS ws_owner_user_id
     FROM runtime_operations o JOIN workspaces w ON w.id = o.workspace_id
     WHERE o.id = $1`,
    [operationId],
  );
  const row = rows[0];
  if (!row) {
    throw new WorkspaceServiceError('operation_not_found', { status: 404 });
  }
  if (row.ws_owner_user_id !== user.id && user.role !== 'admin') {
    throw new WorkspaceServiceError('operation_not_found', { status: 404 });
  }
  return toOperation(row);
}
