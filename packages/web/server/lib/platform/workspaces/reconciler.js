// Reconciliation (plan sections 8.1 and 8.2): the worker process can die
// mid-operation, and runtimes can wedge. This pass makes the database
// converge to a truthful, locatable state without relying on callbacks:
//
//   1. Operations stuck in `running` longer than staleOperationMs (default
//      10 min) are marked failed (error_code 'operation_stale'); their
//      workspace - when it still matches the operation's generation and
//      intent - lands in `error` with a locatable last_error, and the
//      driver is asked (best effort) to release the runtime/capacity.
//   2. Workspaces stuck in observed_state='starting' whose generation has
//      no progressing matching operation beyond startingTimeoutMs are moved
//      to `error` with last_error 'workspace_start_timeout' - a workspace
//      must never wedge in `starting` (plan section 8.2).
//   3. Workspaces with desired_state='stopped' but observed_state='starting'
//      and no non-terminal operation left to drive them are settled back to
//      'stopped' (nothing is or will be starting them).
//   4. Workspaces with desired_state='stopped' but observed_state='error'
//      and no non-terminal operation left are settled to 'stopped'
//      (plan section 8.2 "error -> stopped: cleanup completed"): the user
//      asked for stop, it failed, the record is settled without retrying.
//
// Timeouts are injected (now / ms values) so tests can use short windows.

import { writeAuditEvent } from '../audit/audit-writer.js';

const AUDIT_ACTIONS = Object.freeze({
  start: 'platform.workspace.start',
  stop: 'platform.workspace.stop',
  rebuild: 'platform.workspace.rebuild',
});

function toIso(now) {
  return new Date(now).toISOString();
}

// node-postgres and pg-mem both hand back timestamptz as a JS Date, but never
// compare against strings implicitly - normalize to milliseconds first.
function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') return Date.parse(value);
  if (typeof value === 'number') return value;
  return Number.NaN;
}

async function failStaleOperation(db, { operation, now, logger }) {
  const { rows } = await db.query(
    `UPDATE runtime_operations SET status = 'failed', finished_at = $1, error_code = 'operation_stale'
     WHERE id = $2 AND status = 'running'
     RETURNING *`,
    [toIso(now), operation.id],
  );
  const updated = rows[0];
  if (!updated) return null; // completed between detection and write

  const desired = operation.kind === 'stop' ? 'stopped' : 'started';
  await db.query(
    `UPDATE workspaces
     SET observed_state = 'error', last_error = $1, last_activity_at = $2
     WHERE id = $3 AND generation <= $4 AND desired_state = $5
       AND observed_state IN ('starting', 'stopping')`,
    [`operation_stale: operation ${operation.id} exceeded the running timeout`,
      toIso(now), operation.workspace_id, operation.generation, desired],
  );
  try {
    await writeAuditEvent(db, {
      actorUserId: operation.requested_by,
      targetUserId: operation.requested_by,
      workspaceId: operation.workspace_id,
      action: AUDIT_ACTIONS[operation.kind],
      requestId: operation.request_id,
      outcome: 'failure',
    });
  } catch (error) {
    logger?.warn?.(`[runtime-worker] failed to write audit event: ${error?.message || error}`);
  }
  return updated;
}

async function releaseRuntimeBestEffort(db, driver, workspaceId, logger) {
  const { rows } = await db.query('SELECT * FROM workspaces WHERE id = $1', [workspaceId]);
  const workspace = rows[0];
  if (!workspace) return;
  try {
    await driver.stopWorkspace({
      workspace, generation: workspace.generation, reason: 'reconcile_stale',
    });
  } catch (error) {
    logger?.warn?.(`[runtime-worker] reconcile cleanup stop failed: ${error?.message || error}`);
  }
}

export async function reconcileRuntime(
  db,
  { driver, now = Date.now(), staleOperationMs = 10 * 60 * 1000, startingTimeoutMs = 10 * 60 * 1000, logger } = {},
) {
  const staleCutoff = toIso(now - staleOperationMs);
  const startingCutoffMs = now - startingTimeoutMs;
  const summary = { staleOperations: 0, wedgedWorkspaces: 0, settledWorkspaces: 0, cleanedWorkspaces: 0 };

  // 1. Stale running operations.
  const { rows: staleOps } = await db.query(
    `SELECT * FROM runtime_operations
     WHERE status = 'running' AND started_at IS NOT NULL AND started_at < $1`,
    [staleCutoff],
  );
  for (const operation of staleOps) {
    const failed = await failStaleOperation(db, { operation, now, logger });
    if (failed) {
      summary.staleOperations += 1;
      await releaseRuntimeBestEffort(db, driver, operation.workspace_id, logger);
    }
  }

  // 2. Workspaces wedged in starting: their generation has no progressing
  //    (or no) matching start-like operation within the timeout.
  const { rows: starting } = await db.query(
    `SELECT * FROM workspaces WHERE observed_state = 'starting'`,
  );
  for (const workspace of starting) {
    const { rows: ops } = await db.query(
      `SELECT * FROM runtime_operations
       WHERE workspace_id = $1 AND generation = $2 AND kind IN ('start', 'rebuild')
       ORDER BY requested_at DESC LIMIT 1`,
      [workspace.id, workspace.generation],
    );
    const op = ops[0];
    const opGone = !op;
    const opStuck = op && (op.status === 'pending' || op.status === 'running')
      && toMs(op.requested_at) < startingCutoffMs;
    if (!opGone && !opStuck) continue;

    if (op && (op.status === 'pending' || op.status === 'running')) {
      await db.query(
        `UPDATE runtime_operations SET status = 'failed', finished_at = $1, error_code = 'workspace_start_timeout'
         WHERE id = $2 AND status IN ('pending', 'running')`,
        [toIso(now), op.id],
      );
      try {
        await writeAuditEvent(db, {
          actorUserId: op.requested_by,
          targetUserId: op.requested_by,
          workspaceId: workspace.id,
          action: AUDIT_ACTIONS[op.kind],
          requestId: op.request_id,
          outcome: 'failure',
        });
      } catch (error) {
        logger?.warn?.(`[runtime-worker] failed to write audit event: ${error?.message || error}`);
      }
    }
    await db.query(
      `UPDATE workspaces
       SET observed_state = 'error', last_error = $1, last_activity_at = $2
       WHERE id = $3 AND observed_state = 'starting'`,
      [`workspace_start_timeout: generation ${workspace.generation} has no successful operation within the starting timeout`,
        toIso(now), workspace.id],
    );
    summary.wedgedWorkspaces += 1;
    await releaseRuntimeBestEffort(db, driver, workspace.id, logger);
  }

  // 3. Desired stopped, observed starting, nothing left to drive it.
  //    (Uncorrelated NOT IN: pg-mem cannot resolve outer-table references
  //    inside NOT EXISTS subqueries; the unqualified outer id is unambiguous
  //    here because runtime_operations has no id-only conflict in the
  //    subquery projection.)
  const { rows: orphans } = await db.query(
    `SELECT id FROM workspaces
     WHERE desired_state = 'stopped' AND observed_state = 'starting'
       AND id NOT IN (
         SELECT workspace_id FROM runtime_operations WHERE status IN ('pending', 'running')
       )`,
  );
  for (const orphan of orphans) {
    await db.query(
      `UPDATE workspaces SET observed_state = 'stopped', last_activity_at = $1
       WHERE id = $2 AND desired_state = 'stopped' AND observed_state = 'starting'`,
      [toIso(now), orphan.id],
    );
    await releaseRuntimeBestEffort(db, driver, orphan.id, logger);
    summary.settledWorkspaces += 1;
  }

  // 4. error --> stopped: cleanup completed (plan section 8.2). The user
  //    asked for stop, the operation failed (e.g. the driver's stop threw
  //    for a workspace that was still starting) and nothing non-terminal
  //    remains: settle the record to stopped WITHOUT retrying the stop.
  //    last_error is kept so the original failure stays locatable.
  const { rows: errored } = await db.query(
    `SELECT id FROM workspaces
     WHERE desired_state = 'stopped' AND observed_state = 'error'
       AND id NOT IN (
         SELECT workspace_id FROM runtime_operations WHERE status IN ('pending', 'running')
       )`,
  );
  for (const erroredWorkspace of errored) {
    // Note: no RETURNING - UPDATE result rows are empty on every backend;
    // the SELECT above already established the row under these conditions.
    await db.query(
      `UPDATE workspaces SET observed_state = 'stopped', last_activity_at = $1
       WHERE id = $2 AND desired_state = 'stopped' AND observed_state = 'error'`,
      [toIso(now), erroredWorkspace.id],
    );
    try {
      await writeAuditEvent(db, {
        actorUserId: null,
        targetUserId: null,
        workspaceId: erroredWorkspace.id,
        action: 'platform.workspace.cleanup',
        requestId: null,
        outcome: 'success',
      });
    } catch (error) {
      logger?.warn?.(`[runtime-worker] failed to write audit event: ${error?.message || error}`);
    }
    summary.cleanedWorkspaces += 1;
  }

  return summary;
}
