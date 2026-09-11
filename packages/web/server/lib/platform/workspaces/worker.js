// Runtime worker: claims pending runtime_operations, drives the runtime
// driver, and writes results back under generation + desired-state guards so
// late callbacks from older operations can never overwrite newer generations
// (plan sections 8.1 step 7 and 8.2).
//
// Claim design: pg-mem cannot evaluate UPDATE with a LIMIT subquery or
// SELECT ... FOR UPDATE SKIP LOCKED, so claiming is a plain SELECT of the
// oldest pending row followed by a guarded UPDATE ... WHERE status='pending'
// RETURNING. On real Postgres this stays correct for a small number of
// workers (the status guard makes the claim atomic; losers just claim the
// next row); at higher concurrency it should move to SKIP LOCKED.
// The MVP runs ONE worker process, which the brief targets.

import { writeAuditEvent } from '../audit/audit-writer.js';
import { reconcileRuntime } from './reconciler.js';

const AUDIT_ACTIONS = Object.freeze({
  start: 'platform.workspace.start',
  stop: 'platform.workspace.stop',
  rebuild: 'platform.workspace.rebuild',
});

function driverErrorCode(error) {
  return typeof error?.code === 'string' && error.code !== '' ? error.code : 'runtime_error';
}

function errorMessage(error) {
  return typeof error?.message === 'string' ? error.message : String(error);
}

function toIso(now) {
  return new Date(now).toISOString();
}

// Workspace row joined with the owner's host binding - the driver's
// userBinding comes only from this server-side identity, never from the
// request (plan section 8.1 step 1).
async function loadWorkspaceWithUser(db, workspaceId) {
  const { rows } = await db.query(
    `SELECT w.*, u.linux_uid, u.linux_gid, u.home_path
     FROM workspaces w JOIN users u ON u.id = w.owner_user_id
     WHERE w.id = $1`,
    [workspaceId],
  );
  return rows[0] ?? null;
}

// Claim the oldest pending operation. Returns null when the queue is empty.
export async function claimNextOperation(db, { now = Date.now() } = {}) {
  const { rows: candidates } = await db.query(
    `SELECT id FROM runtime_operations WHERE status = 'pending' ORDER BY requested_at ASC LIMIT 1`,
  );
  if (candidates.length === 0) return null;
  const { rows } = await db.query(
    `UPDATE runtime_operations SET status = 'running', started_at = $1
     WHERE id = $2 AND status = 'pending'
     RETURNING *`,
    [toIso(now), candidates[0].id],
  );
  return rows[0] ?? null;
}

async function writeOperationOutcome(db, { operation, status, errorCode = null, now }) {
  const { rows } = await db.query(
    `UPDATE runtime_operations SET status = $1, finished_at = $2, error_code = $3
     WHERE id = $4
     RETURNING *`,
    [status, toIso(now), errorCode, operation.id],
  );
  return rows[0] ?? null;
}

// Apply a successful driver result to the workspace - only when the
// operation's generation is still current (workspace.generation <=
// operation.generation; strictly-older operations are late callbacks and
// must NOT touch workspace state) AND the desired state still matches the
// operation kind. Returns the updated row, or null when the guard rejected
// the write (the operation result is still recorded on the operation row).
async function applySuccessToWorkspace(db, { operation, workspace, result, now }) {
  const common = `WHERE id = $1 AND generation <= $2 AND desired_state = $3 RETURNING *`;
  if (operation.kind === 'stop') {
    const { rows } = await db.query(
      `UPDATE workspaces
       SET observed_state = 'stopped', runtime_id = NULL, internal_endpoint = NULL,
           last_activity_at = $4, last_error = NULL
       ${common}`,
      [workspace.id, operation.generation, 'stopped', toIso(now)],
    );
    return rows[0] ?? null;
  }
  const { rows } = await db.query(
    `UPDATE workspaces
     SET observed_state = 'running', runtime_id = $4, internal_endpoint = $5,
         last_activity_at = $6, last_error = NULL
     ${common}`,
    [workspace.id, operation.generation, 'started', result.runtimeId, result.endpoint, toIso(now)],
  );
  return rows[0] ?? null;
}

// Apply a driver failure: the operation failed, the workspace lands in
// `error` with a locatable last_error, and capacity is released via a
// best-effort driver stop (never wedges in starting - plan section 8.2).
async function applyFailureToWorkspace(db, { operation, workspace, errorCode, message, now }) {
  const desired = operation.kind === 'stop' ? 'stopped' : 'started';
  const observed = 'error';
  const lastError = `${errorCode}: ${message}`.slice(0, 500);
  const { rows } = await db.query(
    `UPDATE workspaces
     SET observed_state = $2, last_error = $3, last_activity_at = $4,
         runtime_id = CASE WHEN $5 THEN NULL ELSE runtime_id END,
         internal_endpoint = CASE WHEN $5 THEN NULL ELSE internal_endpoint END
     WHERE id = $1 AND generation <= $6 AND desired_state = $7
     RETURNING *`,
    [workspace.id, observed, lastError, toIso(now), operation.kind === 'stop', operation.generation, desired],
  );
  return rows[0] ?? null;
}

async function recordOutcomeAudit(db, { operation, outcome, logger }) {
  try {
    await writeAuditEvent(db, {
      actorUserId: operation.requested_by,
      targetUserId: operation.requested_by,
      workspaceId: operation.workspace_id,
      action: AUDIT_ACTIONS[operation.kind],
      requestId: operation.request_id,
      outcome,
    });
  } catch (error) {
    logger?.warn?.(`[runtime-worker] failed to write audit event: ${error?.message || error}`);
  }
}

// Execute one claimed operation against the driver. Never throws for driver
// or guard failures - it converts them into operation/workspace state.
export async function runOperation(db, { driver, operation, now = Date.now(), logger }) {
  const workspace = await loadWorkspaceWithUser(db, operation.workspace_id);
  if (!workspace) {
    await writeOperationOutcome(db, {
      operation, status: 'failed', errorCode: 'workspace_missing', now,
    });
    return { operation, outcome: 'failed', errorCode: 'workspace_missing', applied: false };
  }

  // Superseded intent: the user changed their mind after this operation was
  // queued (e.g. stop clicked, then start again). Do not even call the
  // driver - a start after a stop must not leak a running runtime.
  const wantsStart = operation.kind !== 'stop';
  if ((wantsStart && workspace.desired_state !== 'started')
    || (!wantsStart && workspace.desired_state !== 'stopped')) {
    const updated = await writeOperationOutcome(db, {
      operation, status: 'failed', errorCode: 'superseded', now,
    });
    await recordOutcomeAudit(db, { operation, outcome: 'failure', logger });
    return { operation: updated, outcome: 'failed', errorCode: 'superseded', applied: false };
  }

  const userBinding = {
    linuxUid: workspace.linux_uid,
    linuxGid: workspace.linux_gid,
    homePath: workspace.home_path,
  };

  try {
    const result = operation.kind === 'stop'
      ? await driver.stopWorkspace({
          workspace, generation: operation.generation, reason: operation.reason,
        })
      : await driver.ensureWorkspace({ workspace, generation: operation.generation, userBinding });
    const updated = await writeOperationOutcome(db, { operation, status: 'succeeded', now });
    const applied = await applySuccessToWorkspace(db, { operation, workspace, result, now });
    await recordOutcomeAudit(db, { operation, outcome: 'success', logger });
    return { operation: updated, outcome: 'succeeded', applied: applied !== null };
  } catch (error) {
    const errorCode = driverErrorCode(error);
    const updated = await writeOperationOutcome(db, {
      operation, status: 'failed', errorCode, now,
    });
    const applied = await applyFailureToWorkspace(db, {
      operation, workspace, errorCode, message: errorMessage(error), now,
    });
    // Best-effort capacity release: a failed ensure may have partially
    // acquired runtime resources depending on the driver.
    try {
      await driver.stopWorkspace({
        workspace, generation: operation.generation, reason: 'operation_failed',
      });
    } catch (stopError) {
      logger?.warn?.(`[runtime-worker] cleanup stop after failure failed: ${stopError?.message || stopError}`);
    }
    await recordOutcomeAudit(db, { operation, outcome: 'failure', logger });
    return { operation: updated, outcome: 'failed', errorCode, applied: applied !== null };
  }
}

// Claim (at most one) and run the next pending operation. Returns the run
// result, or null when nothing was pending.
export async function processNextOperation(db, { driver, now = Date.now(), logger } = {}) {
  const operation = await claimNextOperation(db, { now });
  if (!operation) return null;
  return runOperation(db, { driver, operation, now, logger });
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// Poll loop + periodic reconciliation. Returns { stop } for shutdown; used by
// the standalone worker entry point and by tests with tiny intervals.
export function startRuntimeWorker({ db, driver, env = process.env, logger = console }) {
  const pollMs = positiveInt(env.OPENCHAMBER_RUNTIME_WORKER_POLL_MS, 1000);
  const reconcileMs = positiveInt(env.OPENCHAMBER_RUNTIME_WORKER_RECONCILE_MS, 30000);
  const staleOperationMs = positiveInt(env.OPENCHAMBER_RUNTIME_OP_STALE_MS, 10 * 60 * 1000);
  const startingTimeoutMs = positiveInt(env.OPENCHAMBER_RUNTIME_STARTING_TIMEOUT_MS, 10 * 60 * 1000);

  let stopped = false;
  let polling = false;
  let reconciling = false;

  const poll = async () => {
    if (stopped || polling) return;
    polling = true;
    try {
      // Drain the queue one operation at a time; each claim is atomic.
      while (!stopped) {
        const result = await processNextOperation(db, { driver, logger });
        if (!result) break;
      }
    } catch (error) {
      logger.error?.(`[runtime-worker] poll failed: ${error?.message || error}`);
    } finally {
      polling = false;
    }
  };

  const reconcile = async () => {
    if (stopped || reconciling) return;
    reconciling = true;
    try {
      await reconcileRuntime(db, { driver, logger, staleOperationMs, startingTimeoutMs });
    } catch (error) {
      logger.error?.(`[runtime-worker] reconcile failed: ${error?.message || error}`);
    } finally {
      reconciling = false;
    }
  };

  const pollTimer = setInterval(() => { poll(); }, pollMs);
  const reconcileTimer = setInterval(() => { reconcile(); }, reconcileMs);
  // Reconcile once at startup: the previous worker process may have died
  // mid-operation (plan section 8.1: the scheduler must recover by
  // reconciliation, not by hoping callbacks arrive).
  setImmediate(() => { poll(); reconcile(); });

  return {
    async stop() {
      stopped = true;
      clearInterval(pollTimer);
      clearInterval(reconcileTimer);
    },
  };
}
