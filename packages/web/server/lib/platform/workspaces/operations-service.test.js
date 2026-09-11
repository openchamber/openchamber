// Operations service tests: idempotent registration, generation bookkeeping,
// owner scoping. (RT-01 concurrency lives in routes.test.js at the HTTP
// layer; RT-03/RT-04 driver interaction lives in worker.test.js.)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestPlatformDb } from '../db/test-utils.js';
import { importUser } from '../users/user-import.js';
import {
  WorkspaceServiceError,
  ensureWorkspaceForUser,
  getOperationForUser,
  getWorkspaceById,
  rebuildWorkspace,
  startWorkspace,
  stopWorkspace,
} from './operations-service.js';

const silentLogger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };

let db;
let user;
let counter = 0;

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

const request = (overrides = {}) => startWorkspace(db, {
  user,
  requestId: 'request-1',
  logger: silentLogger,
  ...overrides,
});

describe('workspace record', () => {
  it('lazily creates one stopped workspace per user', async () => {
    const workspace = await ensureWorkspaceForUser(db, { userId: user.id });
    expect(workspace.observed_state).toBe('stopped');
    expect(workspace.generation).toBe(0);
    const again = await ensureWorkspaceForUser(db, { userId: user.id });
    expect(again.id).toBe(workspace.id);
  });
});

describe('startWorkspace idempotency (plan section 8.1)', () => {
  it('registers a new operation and bumps the generation', async () => {
    const result = await request();
    expect(result.status).toBe('accepted');
    expect(result.operation.kind).toBe('start');
    expect(result.operation.status).toBe('pending');
    expect(result.operation.generation).toBe(1);
    expect(result.workspace.generation).toBe(1);
    expect(result.workspace.observedState).toBe('starting');

    const { rows: ops } = await db.query('SELECT * FROM runtime_operations');
    expect(ops).toHaveLength(1);
    expect(ops[0].idempotency_key).toBe(`start:${result.workspace.id}`);
  });

  it('returns the same in-flight operation on repeated start', async () => {
    const first = await request();
    const second = await request();
    expect(second.status).toBe('accepted');
    expect(second.operation.id).toBe(first.operation.id);
    const { rows: ops } = await db.query('SELECT * FROM runtime_operations');
    expect(ops).toHaveLength(1);
  });

  it('returns the existing workspace without an operation when healthy', async () => {
    await request();
    // Simulate the worker completing the start.
    await db.query(
      "UPDATE workspaces SET observed_state = 'running', runtime_id = 'rt-1' WHERE id = $1",
      [await currentWorkspaceId()],
    );
    const result = await request();
    expect(result.status).toBe('healthy');
    expect(result.operation).toBeNull();
    const { rows: ops } = await db.query('SELECT * FROM runtime_operations');
    expect(ops).toHaveLength(1);
  });

  it('writes an attempt audit event with the request id', async () => {
    await request();
    const { rows } = await db.query(
      "SELECT * FROM audit_events WHERE action = 'platform.workspace.start'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('success');
    expect(rows[0].request_id).toBe('request-1');
    expect(rows[0].actor_user_id).toBe(user.id);
  });

  it('creates a fresh operation with a new generation after a terminal failure (RT-03 retry)', async () => {
    const first = await request();
    await db.query(
      "UPDATE runtime_operations SET status = 'failed', finished_at = now(), error_code = 'image_pull_failed' WHERE id = $1",
      [first.operation.id],
    );
    const retry = await request();
    expect(retry.operation.id).not.toBe(first.operation.id);
    expect(retry.operation.generation).toBe(2);
    expect(retry.workspace.generation).toBe(2);
    const { rows: ops } = await db.query('SELECT * FROM runtime_operations ORDER BY requested_at');
    expect(ops).toHaveLength(2);
    expect(ops[1].idempotency_key).not.toBe(ops[0].idempotency_key);
  });

  it('never decreases the generation across retries', async () => {
    await request();
    await db.query(
      "UPDATE runtime_operations SET status = 'failed', error_code = 'x' WHERE workspace_id = (SELECT id FROM workspaces WHERE owner_user_id = $1)",
      [user.id],
    );
    const retry = await request();
    expect(retry.operation.generation).toBe(2);
    expect(await request().then((r) => r.operation.generation)).toBe(2);
  });
});

describe('stopWorkspace (plan sections 8.2 and 8.5)', () => {
  it('requires a reason', async () => {
    await request();
    await expect(stopWorkspace(db, {
      user, workspaceId: await currentWorkspaceId(), requestId: 'r', logger: silentLogger,
    })).rejects.toMatchObject({ code: 'reason_required', status: 400 });
  });

  it('registers a stop at the current generation and records the reason', async () => {
    await request();
    const workspaceId = await currentWorkspaceId();
    const result = await stopWorkspace(db, {
      user, workspaceId, requestId: 'r-stop', reason: 'operator request', logger: silentLogger,
    });
    expect(result.status).toBe('accepted');
    expect(result.operation.kind).toBe('stop');
    expect(result.operation.generation).toBe(1); // stop keeps the generation
    expect(result.operation.reason).toBe('operator request');
    expect(result.workspace.desiredState).toBe('stopped');
    expect(result.workspace.observedState).toBe('stopping');
  });

  it('repeated stop returns the same in-flight operation (RT-04)', async () => {
    await request();
    const workspaceId = await currentWorkspaceId();
    const first = await stopWorkspace(db, {
      user, workspaceId, requestId: 'r1', reason: 'one', logger: silentLogger,
    });
    const second = await stopWorkspace(db, {
      user, workspaceId, requestId: 'r2', reason: 'two', logger: silentLogger,
    });
    expect(second.operation.id).toBe(first.operation.id);
    // The in-flight response must reflect the bump performed by the first
    // stop, not the caller's stale snapshot (RT-01 coherence).
    expect(second.workspace.desiredState).toBe('stopped');
    expect(second.workspace.observedState).toBe('stopping');
  });

  it('stop on an error workspace rejects with 409 and creates no operation row', async () => {
    await request();
    const id = await currentWorkspaceId();
    // Simulate a failed start: the workspace is in error and no runtime runs.
    await db.query(
      "UPDATE workspaces SET observed_state = 'error', last_error = 'image_pull_failed: boom' WHERE id = $1",
      [id],
    );
    await expect(stopWorkspace(db, {
      user, workspaceId: id, requestId: 'r-err', reason: 'cleanup', logger: silentLogger,
    })).rejects.toMatchObject({ code: 'invalid_state_transition', status: 409 });

    // No phantom operation may exist for the rejected stop.
    const { rows: ops } = await db.query("SELECT * FROM runtime_operations WHERE kind = 'stop'");
    expect(ops).toHaveLength(0);
    const { rows: audits } = await db.query(
      "SELECT * FROM audit_events WHERE action = 'platform.workspace.stop'",
    );
    expect(audits).toHaveLength(0);
  });

  it('stop on a stopped workspace returns the current state without an operation', async () => {
    await ensureWorkspaceForUser(db, { userId: user.id });
    const result = await stopWorkspace(db, {
      user, workspaceId: await currentWorkspaceId(), requestId: 'r', reason: 'idle', logger: silentLogger,
    });
    expect(result.status).toBe('already_stopped');
    expect(result.operation).toBeNull();
  });
});

describe('rebuildWorkspace (plan section 8.2)', () => {
  it('registers a rebuild carrying the next generation', async () => {
    await request();
    // Simulate a completed runtime for generation 1.
    await db.query(
      "UPDATE workspaces SET observed_state = 'running', runtime_id = 'rt-1' WHERE id = $1",
      [await currentWorkspaceId()],
    );
    const result = await rebuildWorkspace(db, {
      user, requestId: 'r-rebuild', reason: 'new image', logger: silentLogger,
    });
    expect(result.operation.kind).toBe('rebuild');
    expect(result.operation.generation).toBe(2);
    expect(result.workspace.generation).toBe(2);
    expect(result.workspace.observedState).toBe('starting');
  });
});

describe('getOperationForUser owner scoping (plan section 7.2)', () => {
  it('returns the operation to its owner', async () => {
    const { operation } = await request();
    const read = await getOperationForUser(db, { user, operationId: operation.id });
    expect(read.id).toBe(operation.id);
  });

  it('answers 404 (not 403) for another user', async () => {
    const { operation } = await request();
    const other = await importUser(db, {
      issuer: 'https://idp.example.com',
      subject: `other-${counter}`,
      displayName: 'Other',
      linuxUid: 2000 + counter,
      linuxGid: 2000 + counter,
      homePath: `/home/other${counter}`,
    });
    await expect(
      getOperationForUser(db, { user: other.user, operationId: operation.id }),
    ).rejects.toMatchObject({ code: 'operation_not_found', status: 404 });
  });

  it('lets an admin read any operation', async () => {
    const { operation } = await request();
    const admin = await importUser(db, {
      issuer: 'https://idp.example.com',
      subject: `admin-${counter}`,
      displayName: 'Admin',
      linuxUid: 3000 + counter,
      linuxGid: 3000 + counter,
      homePath: `/home/admin${counter}`,
    });
    await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [admin.user.id]);
    const read = await getOperationForUser(db, { user: { ...admin.user, role: 'admin' }, operationId: operation.id });
    expect(read.id).toBe(operation.id);
  });

  it('answers 404 for an unknown operation id', async () => {
    await expect(
      getOperationForUser(db, { user, operationId: '00000000-0000-0000-0000-000000000000' }),
    ).rejects.toBeInstanceOf(WorkspaceServiceError);
  });
});

async function currentWorkspaceId() {
  const { rows } = await db.query('SELECT id FROM workspaces WHERE owner_user_id = $1', [user.id]);
  return rows[0].id;
}
