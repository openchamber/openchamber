// Runtime worker tests (RT-03, RT-04 and reconciliation, plan sections
// 8.1/8.2): driver interaction, generation guards, late-callback protection,
// capacity release, and the reconciler's stale/wedged recovery.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestPlatformDb } from '../db/test-utils.js';
import { importUser } from '../users/user-import.js';
import { createFakeRuntimeDriver } from './runtime-driver.js';
import {
  rebuildWorkspace,
  startWorkspace,
  stopWorkspace,
} from './operations-service.js';
import {
  claimNextOperation,
  processNextOperation,
  runOperation,
} from './worker.js';
import { reconcileRuntime } from './reconciler.js';

const silentLogger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };

let db;
let user;
let counter = 100;

beforeEach(async () => {
  db = await createTestPlatformDb();
  counter += 1;
  const imported = await importUser(db, {
    issuer: 'https://idp.example.com',
    subject: `subject-${counter}`,
    displayName: `User ${counter}`,
    linuxUid: 1000 + counter,
    linuxGid: 1000 + counter,
    homePath: `/home/user${counter}`,
  });
  user = imported.user;
});

afterEach(async () => {
  await db?.end?.();
  db = undefined;
});

async function workspaceRow() {
  const { rows } = await db.query('SELECT * FROM workspaces WHERE owner_user_id = $1', [user.id]);
  return rows[0];
}

async function operationRow(id) {
  const { rows } = await db.query('SELECT * FROM runtime_operations WHERE id = $1', [id]);
  return rows[0];
}

async function requestStart(overrides = {}) {
  return startWorkspace(db, { user, requestId: 'req-start', logger: silentLogger, ...overrides });
}

describe('fake runtime driver', () => {
  it('enforces the max-concurrent capacity and releases it on stop', async () => {
    const driver = createFakeRuntimeDriver({ maxConcurrent: 2 });
    const ws = { id: 'ws-1' };
    await driver.ensureWorkspace({ workspace: ws, generation: 1 });
    await driver.ensureWorkspace({ workspace: { id: 'ws-2' }, generation: 1 });
    expect(driver.activeCount()).toBe(2);
    await expect(
      driver.ensureWorkspace({ workspace: { id: 'ws-3' }, generation: 1 }),
    ).rejects.toMatchObject({ code: 'capacity_exhausted' });
    await driver.stopWorkspace({ workspace: ws, generation: 1, reason: 'test' });
    expect(driver.activeCount()).toBe(1);
    await driver.ensureWorkspace({ workspace: { id: 'ws-3' }, generation: 1 });
  });

  it('is idempotent per generation and replaces older generations (rebuild)', async () => {
    const driver = createFakeRuntimeDriver();
    const workspace = { id: 'ws-1' };
    const first = await driver.ensureWorkspace({ workspace, generation: 1 });
    const again = await driver.ensureWorkspace({ workspace, generation: 1 });
    expect(again.runtimeId).toBe(first.runtimeId);
    expect(driver.activeCount()).toBe(1);
    const rebuilt = await driver.ensureWorkspace({ workspace, generation: 2 });
    expect(rebuilt.runtimeId).not.toBe(first.runtimeId);
    expect(driver.activeCount()).toBe(1);
  });
});

describe('worker happy path', () => {
  it('drives a start operation to running and writes the audit trail', async () => {
    const driver = createFakeRuntimeDriver();
    const { operation } = await requestStart();

    const result = await processNextOperation(db, { driver, logger: silentLogger });
    expect(result.outcome).toBe('succeeded');
    expect(result.applied).toBe(true);

    const workspace = await workspaceRow();
    expect(workspace.observed_state).toBe('running');
    expect(workspace.runtime_id).toBeTruthy();
    expect(workspace.internal_endpoint).toContain('fake://');
    expect(workspace.generation).toBe(1);

    const op = await operationRow(operation.id);
    expect(op.status).toBe('succeeded');
    expect(op.finished_at).toBeTruthy();

    const { rows: audits } = await db.query(
      "SELECT * FROM audit_events WHERE action = 'platform.workspace.start' ORDER BY created_at",
    );
    expect(audits).toHaveLength(2);
    expect(audits.map((a) => a.outcome)).toEqual(['success', 'success']);
  });

  it('passes the server-side user binding to the driver', async () => {
    const seen = [];
    const driver = createFakeRuntimeDriver({
      hooks: {
        beforeEnsure: ({ workspace, generation }) => {
          seen.push({ workspace, generation });
        },
      },
    });
    await requestStart();
    await processNextOperation(db, { driver, logger: silentLogger });
    expect(seen).toHaveLength(1);
    expect(seen[0].workspace.linux_uid).toBe(user.linux_uid);
    expect(seen[0].workspace.home_path).toBe(user.home_path);
  });

  it('drives a stop operation to stopped and clears the runtime', async () => {
    const driver = createFakeRuntimeDriver();
    const { operation: startOp } = await requestStart();
    await processNextOperation(db, { driver, logger: silentLogger });
    const workspace = await workspaceRow();
    expect(driver.activeCount()).toBe(1);

    await stopWorkspace(db, {
      user, workspaceId: workspace.id, requestId: 'req-stop', reason: 'done', logger: silentLogger,
    });
    const result = await processNextOperation(db, { driver, logger: silentLogger });
    expect(result.outcome).toBe('succeeded');

    const stopped = await workspaceRow();
    expect(stopped.observed_state).toBe('stopped');
    expect(stopped.runtime_id).toBeNull();
    expect(stopped.internal_endpoint).toBeNull();
    expect(driver.activeCount()).toBe(0);

    const { rows: audits } = await db.query(
      "SELECT * FROM audit_events WHERE action = 'platform.workspace.stop'",
    );
    expect(audits.map((a) => a.outcome)).toEqual(['success', 'success']);
    void startOp;
  });

  it('returns null when the queue is empty', async () => {
    const driver = createFakeRuntimeDriver();
    expect(await processNextOperation(db, { driver, logger: silentLogger })).toBeNull();
  });

  it('claim is atomic: two concurrent claims never take the same operation', async () => {
    const driver = createFakeRuntimeDriver();
    const { operation } = await requestStart();
    const [a, b] = await Promise.all([
      claimNextOperation(db, {}),
      claimNextOperation(db, {}),
    ]);
    const ids = [a?.id ?? null, b?.id ?? null].filter(Boolean);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toBe(operation.id);
    // Second claim drained the queue.
    expect(await claimNextOperation(db, {})).toBeNull();
  });
});

describe('driver failure (RT-03)', () => {
  it('records error_code, lands the workspace in error, releases capacity, retry succeeds', async () => {
    let fail = true;
    const driver = createFakeRuntimeDriver({
      hooks: {
        beforeEnsure: () => {
          if (fail) {
            const error = new Error('image pull failed for digest sha256:dead');
            error.code = 'image_pull_failed';
            throw error;
          }
        },
      },
    });
    const first = await requestStart();
    const failed = await processNextOperation(db, { driver, logger: silentLogger });
    expect(failed.outcome).toBe('failed');
    expect(failed.errorCode).toBe('image_pull_failed');

    const op = await operationRow(first.operation.id);
    expect(op.status).toBe('failed');
    expect(op.error_code).toBe('image_pull_failed');
    expect(op.finished_at).toBeTruthy();

    const workspace = await workspaceRow();
    expect(workspace.observed_state).toBe('error');
    expect(workspace.last_error).toContain('image_pull_failed');
    expect(workspace.generation).toBe(1); // locatable: the failing generation is known
    expect(driver.activeCount()).toBe(0); // capacity released

    // Retry produces a NEW operation (RT-03) at the next generation.
    fail = false;
    const retry = await requestStart();
    expect(retry.operation.id).not.toBe(first.operation.id);
    expect(retry.operation.generation).toBe(2);
    const succeeded = await processNextOperation(db, { driver, logger: silentLogger });
    expect(succeeded.outcome).toBe('succeeded');
    expect((await workspaceRow()).observed_state).toBe('running');
  });

  it('reports capacity_exhausted without consuming capacity', async () => {
    const driver = createFakeRuntimeDriver({ maxConcurrent: 1 });
    await driver.ensureWorkspace({ workspace: { id: 'other-ws' }, generation: 1 });
    const { operation } = await requestStart();
    const result = await processNextOperation(db, { driver, logger: silentLogger });
    expect(result.errorCode).toBe('capacity_exhausted');
    expect((await operationRow(operation.id)).error_code).toBe('capacity_exhausted');
    expect((await workspaceRow()).observed_state).toBe('error');
    expect(driver.activeCount()).toBe(1); // only the pre-existing runtime holds the slot
  });
});

describe('generation guards and racing operations (RT-04)', () => {
  it('a late success from an older generation never overwrites the newer one', async () => {
    const driver = createFakeRuntimeDriver();
    const old = await requestStart(); // generation 1
    const newer = await rebuildWorkspace(db, {
      user, requestId: 'req-rebuild', reason: 'replace', logger: silentLogger,
    }); // generation 2
    expect(newer.operation.generation).toBe(2);

    // The generation-1 operation finishes late (driver succeeds).
    const late = await runOperation(db, {
      driver, operation: await operationRow(old.operation.id), logger: silentLogger,
    });
    expect(late.outcome).toBe('succeeded');
    expect(late.applied).toBe(false); // late callback recorded but NOT applied

    let workspace = await workspaceRow();
    expect(workspace.observed_state).toBe('starting'); // generation-2 bump stands
    expect(workspace.generation).toBe(2);

    // Now the current operation completes and applies.
    const current = await processNextOperation(db, { driver, logger: silentLogger });
    expect(current.outcome).toBe('succeeded');
    expect(current.applied).toBe(true);
    workspace = await workspaceRow();
    expect(workspace.observed_state).toBe('running');
    expect(workspace.generation).toBe(2);
  });

  it('repeated stop returns the current state without duplicate operations', async () => {
    const driver = createFakeRuntimeDriver();
    await requestStart();
    await processNextOperation(db, { driver, logger: silentLogger });
    const workspace = await workspaceRow();

    const first = await stopWorkspace(db, {
      user, workspaceId: workspace.id, requestId: 'r1', reason: 'one', logger: silentLogger,
    });
    const second = await stopWorkspace(db, {
      user, workspaceId: workspace.id, requestId: 'r2', reason: 'two', logger: silentLogger,
    });
    expect(second.operation.id).toBe(first.operation.id);
    const { rows: ops } = await db.query("SELECT * FROM runtime_operations WHERE kind = 'stop'");
    expect(ops).toHaveLength(1);
  });

  it('a stop requested after a start supersedes the queued start without leaking a runtime', async () => {
    const driver = createFakeRuntimeDriver();
    const { operation: startOp } = await requestStart();
    const workspace = await workspaceRow();
    await stopWorkspace(db, {
      user, workspaceId: workspace.id, requestId: 'r-stop', reason: 'changed my mind', logger: silentLogger,
    });

    // FIFO: the start operation runs first, but its intent was superseded.
    const startResult = await processNextOperation(db, { driver, logger: silentLogger });
    expect(startResult.errorCode).toBe('superseded');
    expect(startResult.applied).toBe(false);
    expect(driver.activeCount()).toBe(0); // no runtime leaked

    const stopResult = await processNextOperation(db, { driver, logger: silentLogger });
    expect(stopResult.outcome).toBe('succeeded');
    expect((await workspaceRow()).observed_state).toBe('stopped');

    const op = await operationRow(startOp.id);
    expect(op.status).toBe('failed');
    expect(op.error_code).toBe('superseded');
  });

  it('generation stays monotonic across a start/stop/rebuild sequence', async () => {
    const driver = createFakeRuntimeDriver();
    const { operation: op1 } = await requestStart();
    await processNextOperation(db, { driver, logger: silentLogger });
    const ws1 = await workspaceRow();
    await stopWorkspace(db, {
      user, workspaceId: ws1.id, requestId: 'r', reason: 'cycle', logger: silentLogger,
    });
    await processNextOperation(db, { driver, logger: silentLogger });
    const { operation: op3 } = await rebuildWorkspace(db, {
      user, requestId: 'r2', reason: 'cycle', logger: silentLogger,
    });
    await processNextOperation(db, { driver, logger: silentLogger });

    expect(op1.generation).toBe(1);
    expect(op3.generation).toBe(2); // stop kept generation 1; rebuild bumped to 2
    const { rows } = await db.query(
      'SELECT generation FROM runtime_operations ORDER BY requested_at',
    );
    expect(rows.map((r) => r.generation)).toEqual([1, 1, 2]);
    expect((await workspaceRow()).observed_state).toBe('running');
  });
});

describe('reconciliation (plan sections 8.1 and 8.2)', () => {
  it('fails operations stuck running beyond the stale timeout and errors the workspace', async () => {
    const driver = createFakeRuntimeDriver();
    const { operation } = await requestStart();
    // Simulate a worker that claimed the operation and died.
    await db.query(
      "UPDATE runtime_operations SET status = 'running', started_at = $1 WHERE id = $2",
      [new Date(Date.now() - 30 * 60 * 1000).toISOString(), operation.id],
    );

    const summary = await reconcileRuntime(db, {
      driver, logger: silentLogger, staleOperationMs: 10 * 60 * 1000, startingTimeoutMs: 10 * 60 * 1000,
    });
    expect(summary.staleOperations).toBe(1);

    const op = await operationRow(operation.id);
    expect(op.status).toBe('failed');
    expect(op.error_code).toBe('operation_stale');
    const workspace = await workspaceRow();
    expect(workspace.observed_state).toBe('error');
    expect(workspace.last_error).toContain('operation_stale');
  });

  it('never leaves a workspace wedged in starting: no operation at all for the generation', async () => {
    const driver = createFakeRuntimeDriver();
    const { operation } = await requestStart();
    // Simulate a crash between operation insert and any worker pick-up by
    // backdating the pending operation far into the past.
    await db.query(
      'UPDATE runtime_operations SET requested_at = $1 WHERE id = $2',
      [new Date(Date.now() - 60 * 60 * 1000).toISOString(), operation.id],
    );

    const summary = await reconcileRuntime(db, {
      driver, logger: silentLogger, staleOperationMs: 10 * 60 * 1000, startingTimeoutMs: 10 * 60 * 1000,
    });
    expect(summary.wedgedWorkspaces).toBe(1);

    const workspace = await workspaceRow();
    expect(workspace.observed_state).toBe('error');
    expect(workspace.last_error).toContain('workspace_start_timeout');
    const { rows: ops } = await db.query('SELECT * FROM runtime_operations');
    expect(ops[0].status).toBe('failed');
    expect(ops[0].error_code).toBe('workspace_start_timeout');
  });

  it('settles a desired-stopped workspace that has nothing left driving it', async () => {
    const driver = createFakeRuntimeDriver();
    await requestStart();
    const workspace = await workspaceRow();
    await stopWorkspace(db, {
      user, workspaceId: workspace.id, requestId: 'r', reason: 'x', logger: silentLogger,
    });
    // Both operations complete; then something resets observed to starting
    // with no operation left (simulates a crash after the stop bump).
    await processNextOperation(db, { driver, logger: silentLogger }); // start (superseded)
    await processNextOperation(db, { driver, logger: silentLogger }); // stop -> stopped
    await db.query(
      "UPDATE workspaces SET observed_state = 'starting' WHERE id = $1",
      [workspace.id],
    );

    const summary = await reconcileRuntime(db, {
      driver, logger: silentLogger, staleOperationMs: 10 * 60 * 1000, startingTimeoutMs: 10 * 60 * 1000,
    });
    expect(summary.settledWorkspaces).toBe(1);
    expect((await workspaceRow()).observed_state).toBe('stopped');
  });

  it('settles a desired-stopped workspace stuck in error after a failed stop (error -> stopped, plan section 8.2)', async () => {
    // Start succeeds.
    const okDriver = createFakeRuntimeDriver();
    await requestStart();
    await processNextOperation(db, { driver: okDriver, logger: silentLogger });

    // The stop then fails at the driver level (stop on a workspace that was
    // still settling leaves desired=stopped / observed=error).
    let failStops = true;
    const failingDriver = createFakeRuntimeDriver({
      hooks: {
        beforeStop: () => {
          if (failStops) {
            const error = new Error('graceful stop timed out');
            error.code = 'stop_timeout';
            throw error;
          }
        },
      },
    });
    const workspace = await workspaceRow();
    const { operation: stopOp } = await stopWorkspace(db, {
      user, workspaceId: workspace.id, requestId: 'req-stop', reason: 'cleanup', logger: silentLogger,
    });
    const stopResult = await processNextOperation(db, { driver: failingDriver, logger: silentLogger });
    expect(stopResult.errorCode).toBe('stop_timeout');
    let settled = await workspaceRow();
    expect(settled.observed_state).toBe('error');
    expect(settled.desired_state).toBe('stopped');
    expect(settled.last_error).toContain('stop_timeout');
    expect((await operationRow(stopOp.id)).status).toBe('failed');
    failStops = false;

    // Reconciliation performs the diagram's "error -> stopped: cleanup
    // completed" arc: settle without retrying, keep the error locatable.
    const summary = await reconcileRuntime(db, {
      driver: okDriver, logger: silentLogger, staleOperationMs: 600000, startingTimeoutMs: 600000,
    });
    expect(summary.cleanedWorkspaces).toBe(1);
    settled = await workspaceRow();
    expect(settled.observed_state).toBe('stopped');
    expect(settled.last_error).toContain('stop_timeout'); // failure stays locatable

    const { rows: audits } = await db.query(
      "SELECT * FROM audit_events WHERE action = 'platform.workspace.cleanup'",
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].outcome).toBe('success');
    expect(audits[0].workspace_id).toBe(workspace.id);
  });

  it('does not clean up an errored workspace while a non-terminal operation exists', async () => {
    const driver = createFakeRuntimeDriver();
    await requestStart();
    await processNextOperation(db, { driver, logger: silentLogger });
    const workspace = await workspaceRow();
    // A stop is registered but not yet processed; the workspace is somehow
    // already in error (crash window). Reconciliation must NOT settle it.
    await stopWorkspace(db, {
      user, workspaceId: workspace.id, requestId: 'r', reason: 'x', logger: silentLogger,
    });
    await db.query("UPDATE workspaces SET observed_state = 'error' WHERE id = $1", [workspace.id]);

    const summary = await reconcileRuntime(db, {
      driver, logger: silentLogger, staleOperationMs: 600000, startingTimeoutMs: 600000,
    });
    expect(summary.cleanedWorkspaces).toBe(0);
    expect((await workspaceRow()).observed_state).toBe('error');
  });

  it('leaves fresh, healthy operations and workspaces untouched', async () => {
    const driver = createFakeRuntimeDriver();
    await requestStart();
    const summary = await reconcileRuntime(db, {
      driver, logger: silentLogger, staleOperationMs: 10 * 60 * 1000, startingTimeoutMs: 10 * 60 * 1000,
    });
    expect(summary).toEqual({ staleOperations: 0, wedgedWorkspaces: 0, settledWorkspaces: 0, cleanedWorkspaces: 0 });
    expect((await workspaceRow()).observed_state).toBe('starting');
  });
});
