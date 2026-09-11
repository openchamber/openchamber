// HTTP contract tests for the admin routes (plan sections 7.2 and 9.1):
// role enforcement (404 for non-admins, DB re-check per request), list
// shapes, stop/rebuild via the shared operations pipeline, audit-event
// pagination and the filter allowlist.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createTestPlatformDb } from '../db/test-utils.js';
import { importUser } from '../users/user-import.js';
import { createPlatformSession, SESSION_COOKIE_NAME } from '../auth/sessions.js';
import { ensureWorkspaceForUser, startWorkspace } from '../workspaces/operations-service.js';
import { createFakeRuntimeDriver } from '../workspaces/runtime-driver.js';
import { AUDIT_EVENT_COLUMNS } from './admin-service.js';
import { registerPlatformAdminRoutes } from './routes.js';

const silentLogger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };

let db;
let app;
let user;
let admin;
let userCookie;
let adminCookie;
let counter = 400;

async function makeUser(dbHandle, role, suffix) {
  const imported = await importUser(dbHandle, {
    issuer: 'https://idp.example.com',
    subject: `${suffix}-${counter}`,
    displayName: `User ${suffix} ${counter}`,
    linuxUid: 1000 + counter,
    linuxGid: 1000 + counter,
    homePath: `/home/${suffix}${counter}`,
  });
  counter += 1;
  if (role) {
    await dbHandle.query('UPDATE users SET role = $1 WHERE id = $2', [role, imported.user.id]);
    imported.user.role = role;
  }
  // importUser returns the raw DB row; add the camelCase aliases the tests use.
  imported.user.displayName = imported.user.display_name;
  imported.user.linuxUid = imported.user.linux_uid;
  return imported.user;
}

beforeEach(async () => {
  db = await createTestPlatformDb();
  user = await makeUser(db, null, 'plain');
  admin = await makeUser(db, 'admin', 'admin');
  userCookie = `${SESSION_COOKIE_NAME}=${(await createPlatformSession(db, { userId: user.id })).token}`;
  adminCookie = `${SESSION_COOKIE_NAME}=${(await createPlatformSession(db, { userId: admin.id })).token}`;

  app = express();
  app.use(express.json());
  const result = await registerPlatformAdminRoutes(app, { logger: silentLogger, db });
  expect(result.enabled).toBe(true);
});

afterEach(async () => {
  await db?.end?.();
  db = undefined;
  app = undefined;
});

const ADMIN_ROUTES = [
  ['get', '/api/platform/admin/users'],
  ['get', '/api/platform/admin/workspaces'],
  ['post', '/api/platform/admin/workspaces/00000000-0000-0000-0000-000000000000/stop'],
  ['post', '/api/platform/admin/workspaces/00000000-0000-0000-0000-000000000000/rebuild'],
  ['get', '/api/platform/admin/audit-events'],
];

describe('authorization (plan section 7.2)', () => {
  it('answers 401 without a session on every admin route', async () => {
    for (const [method, path] of ADMIN_ROUTES) {
      const res = await request(app)[method](path).set('X-Requested-With', 'XMLHttpRequest');
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.body.error).toBe('unauthenticated');
    }
  });

  it('answers a consistent 404 for a normal user on every admin route (no enumeration)', async () => {
    for (const [method, path] of ADMIN_ROUTES) {
      const res = await request(app)[method](path)
        .set('Cookie', userCookie)
        .set('X-Requested-With', 'XMLHttpRequest');
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.body.error).toBe('not_found');
    }
  });

  it('re-reads the role from the database on every request (no stale caching)', async () => {
    const before = await request(app).get('/api/platform/admin/users').set('Cookie', adminCookie);
    expect(before.status).toBe(200);
    // Demote the admin mid-session: the very next request must see it.
    await db.query("UPDATE users SET role = 'user' WHERE id = $1", [admin.id]);
    const after = await request(app).get('/api/platform/admin/users').set('Cookie', adminCookie);
    expect(after.status).toBe(404);
  });

  it('requires the CSRF header on admin write routes', async () => {
    const workspace = await ensureWorkspaceForUser(db, { userId: user.id });
    const res = await request(app)
      .post(`/api/platform/admin/workspaces/${workspace.id}/stop`)
      .set('Cookie', adminCookie)
      .send({ reason: 'maintenance' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('csrf_header_required');
  });
});

describe('GET /api/platform/admin/users', () => {
  it('lists users with identity fields only (no uid/gid/home/issuer/subject)', async () => {
    const res = await request(app).get('/api/platform/admin/users').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.users).toHaveLength(2);
    for (const listed of res.body.users) {
      expect(Object.keys(listed).sort()).toEqual(['created_at', 'display_name', 'id', 'role', 'status']);
    }
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(String(user.linuxUid ?? 1000));
    expect(serialized).not.toContain('/home/plain');
    expect(serialized).not.toContain('issuer');
    expect(serialized).not.toContain('subject');
  });

  it('paginates with limit and offset', async () => {
    const first = await request(app)
      .get('/api/platform/admin/users?limit=1&offset=0')
      .set('Cookie', adminCookie);
    expect(first.status).toBe(200);
    expect(first.body.users).toHaveLength(1);
    expect(first.body.total).toBe(2);
    const second = await request(app)
      .get('/api/platform/admin/users?limit=1&offset=1')
      .set('Cookie', adminCookie);
    expect(second.body.users).toHaveLength(1);
    expect(second.body.users[0].id).not.toBe(first.body.users[0].id);
  });

  it('rejects invalid pagination', async () => {
    const res = await request(app)
      .get('/api/platform/admin/users?limit=0')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_pagination');
  });
});

describe('GET /api/platform/admin/workspaces', () => {
  it('lists workspaces with owner display names and null resources without a driver', async () => {
    await ensureWorkspaceForUser(db, { userId: user.id });
    const res = await request(app).get('/api/platform/admin/workspaces').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.workspaces).toHaveLength(1);
    const listed = res.body.workspaces[0];
    expect(listed.ownerUserId).toBe(user.id);
    expect(listed.owner_display_name).toBe(user.displayName);
    expect(listed.resources).toBeNull();
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('runtime_id');
    expect(serialized).not.toContain('internal_endpoint');
    expect(serialized).not.toContain('credential');
  });

  it('reports driver inspection honestly and maps failures to null', async () => {
    await ensureWorkspaceForUser(db, { userId: user.id });
    const healthy = express();
    healthy.use(express.json());
    await registerPlatformAdminRoutes(healthy, {
      logger: silentLogger,
      db,
      driver: createFakeRuntimeDriver({ hooks: { inspect: async () => ({ state: 'running', activeTasks: 3 }) } }),
    });
    const res = await request(healthy).get('/api/platform/admin/workspaces').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.workspaces[0].resources).toEqual({ state: 'running', active_tasks: 3 });

    const broken = express();
    broken.use(express.json());
    await registerPlatformAdminRoutes(broken, {
      logger: silentLogger,
      db,
      driver: createFakeRuntimeDriver({ hooks: { inspect: async () => { throw new Error('inspect failed'); } } }),
    });
    const res2 = await request(broken).get('/api/platform/admin/workspaces').set('Cookie', adminCookie);
    expect(res2.body.workspaces[0].resources).toBeNull();
  });
});

describe('POST /api/platform/admin/workspaces/:id/stop', () => {
  it('parses the JSON body without a global parser (production wiring)', async () => {
    // Boot the router the way production does: NO app-level express.json().
    // The route must carry its own parser or the reason never reaches
    // requireReason and every stop answers 400 reason_required.
    const bareApp = express();
    const result = await registerPlatformAdminRoutes(bareApp, { logger: silentLogger, db });
    expect(result.enabled).toBe(true);

    await ensureWorkspaceForUser(db, { userId: user.id });
    await startWorkspace(db, { user, requestId: 'seed-start' });
    const { rows: [workspace] } = await db.query('SELECT id FROM workspaces');

    const res = await request(bareApp)
      .post(`/api/platform/admin/workspaces/${workspace.id}/stop`)
      .set('Cookie', adminCookie)
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ reason: 'maintenance window' });
    expect(res.status).toBe(202);
    const { rows: ops } = await db.query("SELECT reason FROM runtime_operations WHERE kind = 'stop'");
    expect(ops).toHaveLength(1);
    expect(ops[0].reason).toBe('maintenance window');
  });

  it('requires a reason (400 reason_required, failure audited)', async () => {
    const workspace = await ensureWorkspaceForUser(db, { userId: user.id });
    for (const body of [{}, { reason: '' }, { reason: '   ' }]) {
      const res = await request(app)
        .post(`/api/platform/admin/workspaces/${workspace.id}/stop`)
        .set('Cookie', adminCookie)
        .set('X-Requested-With', 'XMLHttpRequest')
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('reason_required');
    }
    const { rows: audits } = await db.query(
      "SELECT * FROM audit_events WHERE action = 'platform.admin.workspaces.stop'",
    );
    expect(audits).toHaveLength(3);
    expect(audits.every((row) => row.outcome === 'failure')).toBe(true);
    expect(audits.every((row) => row.request_id)).toBe(true);
    // Nothing was registered.
    const { rows: ops } = await db.query('SELECT * FROM runtime_operations');
    expect(ops).toHaveLength(0);
  });

  it('answers 404 for an unknown workspace', async () => {
    const res = await request(app)
      .post('/api/platform/admin/workspaces/00000000-0000-0000-0000-000000000000/stop')
      .set('Cookie', adminCookie)
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ reason: 'maintenance' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('workspace_not_found');
  });

  it('stops via the shared operations pipeline: 202, admin as requested_by, reason persisted', async () => {
    const workspace = await ensureWorkspaceForUser(db, { userId: user.id });
    await startWorkspace(db, { user, requestId: 'seed-start' });
    const res = await request(app)
      .post(`/api/platform/admin/workspaces/${workspace.id}/stop`)
      .set('Cookie', adminCookie)
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ reason: 'scheduled maintenance' });
    expect(res.status).toBe(202);
    expect(res.body.operation.kind).toBe('stop');
    expect(res.body.workspace.observedState).toBe('stopping');
    expect(res.body.active_tasks).toBeNull();

    const { rows: stopOps } = await db.query(
      "SELECT * FROM runtime_operations WHERE kind = 'stop'",
    );
    expect(stopOps).toHaveLength(1);
    expect(stopOps[0].requested_by).toBe(admin.id);
    expect(stopOps[0].reason).toBe('scheduled maintenance');
    expect(stopOps[0].generation).toBe(res.body.operation.generation);

    const { rows: audits } = await db.query(
      "SELECT * FROM audit_events WHERE action = 'platform.admin.workspaces.stop'",
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].outcome).toBe('success');
    expect(audits[0].actor_user_id).toBe(admin.id);
    expect(audits[0].target_user_id).toBe(user.id);
    expect(audits[0].workspace_id).toBe(workspace.id);
    expect(audits[0].request_id).toBe(res.body.request_id);
  });

  it('is idempotent: a repeated stop returns the same in-flight operation', async () => {
    const workspace = await ensureWorkspaceForUser(db, { userId: user.id });
    await startWorkspace(db, { user, requestId: 'seed-start' });
    const first = await request(app)
      .post(`/api/platform/admin/workspaces/${workspace.id}/stop`)
      .set('Cookie', adminCookie)
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ reason: 'first' });
    const second = await request(app)
      .post(`/api/platform/admin/workspaces/${workspace.id}/stop`)
      .set('Cookie', adminCookie)
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ reason: 'second' });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.operation.id).toBe(first.body.operation.id);
    const { rows: stopOps } = await db.query(
      "SELECT * FROM runtime_operations WHERE kind = 'stop'",
    );
    expect(stopOps).toHaveLength(1);
  });

  it('safely returns the current state when the workspace is already stopped', async () => {
    const workspace = await ensureWorkspaceForUser(db, { userId: user.id });
    const res = await request(app)
      .post(`/api/platform/admin/workspaces/${workspace.id}/stop`)
      .set('Cookie', adminCookie)
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ reason: 'nothing to do' });
    expect(res.status).toBe(200);
    expect(res.body.operation).toBeNull();
    expect(res.body.workspace.observedState).toBe('stopped');
  });

  it('surfaces the active-task count from driver.inspectWorkspace', async () => {
    const workspace = await ensureWorkspaceForUser(db, { userId: user.id });
    await startWorkspace(db, { user, requestId: 'seed-start' });
    const driverApp = express();
    driverApp.use(express.json());
    await registerPlatformAdminRoutes(driverApp, {
      logger: silentLogger,
      db,
      driver: createFakeRuntimeDriver({ hooks: { inspect: async () => ({ state: 'running', activeTasks: 4 }) } }),
    });
    const res = await request(driverApp)
      .post(`/api/platform/admin/workspaces/${workspace.id}/stop`)
      .set('Cookie', adminCookie)
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ reason: 'tasks first' });
    expect(res.status).toBe(202);
    expect(res.body.active_tasks).toBe(4);
  });
});

describe('POST /api/platform/admin/workspaces/:id/rebuild', () => {
  it('rebuilds via the shared pipeline: 202 with a bumped generation and persisted reason', async () => {
    const workspace = await ensureWorkspaceForUser(db, { userId: user.id });
    const res = await request(app)
      .post(`/api/platform/admin/workspaces/${workspace.id}/rebuild`)
      .set('Cookie', adminCookie)
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ reason: 'refresh base image' });
    expect(res.status).toBe(202);
    expect(res.body.operation.kind).toBe('rebuild');
    expect(res.body.operation.generation).toBe(workspace.generation + 1);
    expect(res.body.workspace.generation).toBe(workspace.generation + 1);

    const { rows: ops } = await db.query('SELECT * FROM runtime_operations');
    expect(ops[0].requested_by).toBe(admin.id);
    expect(ops[0].reason).toBe('refresh base image');

    const { rows: audits } = await db.query(
      "SELECT * FROM audit_events WHERE action = 'platform.admin.workspaces.rebuild'",
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].outcome).toBe('success');
    expect(audits[0].workspace_id).toBe(workspace.id);
  });

  it('requires a reason', async () => {
    const workspace = await ensureWorkspaceForUser(db, { userId: user.id });
    const res = await request(app)
      .post(`/api/platform/admin/workspaces/${workspace.id}/rebuild`)
      .set('Cookie', adminCookie)
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('reason_required');
  });

  it('rejects a stale expected_generation with 409 generation_conflict', async () => {
    const workspace = await ensureWorkspaceForUser(db, { userId: user.id });
    const res = await request(app)
      .post(`/api/platform/admin/workspaces/${workspace.id}/rebuild`)
      .set('Cookie', adminCookie)
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ reason: 'stale view', expected_generation: workspace.generation + 7 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('generation_conflict');
    const { rows: ops } = await db.query('SELECT * FROM runtime_operations');
    expect(ops).toHaveLength(0);
  });

  it('accepts a matching expected_generation', async () => {
    const workspace = await ensureWorkspaceForUser(db, { userId: user.id });
    const res = await request(app)
      .post(`/api/platform/admin/workspaces/${workspace.id}/rebuild`)
      .set('Cookie', adminCookie)
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ reason: 'consistent', expected_generation: workspace.generation });
    expect(res.status).toBe(202);
  });

  it('answers 404 for an unknown workspace', async () => {
    const res = await request(app)
      .post('/api/platform/admin/workspaces/00000000-0000-0000-0000-000000000000/rebuild')
      .set('Cookie', adminCookie)
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ reason: 'missing' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('workspace_not_found');
  });
});

describe('GET /api/platform/admin/audit-events', () => {
  // NOTE: reading the audit log is itself audited, so every unfiltered read
  // appends one platform.admin.audit.read row. Assertions therefore pin the
  // stable seed action (platform.admin.workspaces.stop), which later reads do
  // not add to.
  const SEED_ACTION = 'platform.admin.workspaces.stop';

  beforeEach(async () => {
    const workspace = await ensureWorkspaceForUser(db, { userId: user.id });
    const res = await request(app)
      .post(`/api/platform/admin/workspaces/${workspace.id}/stop`)
      .set('Cookie', adminCookie)
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ reason: 'seed event' });
    expect(res.status).toBe(200);
  });

  it('returns metadata-only events with exactly the allowed columns', async () => {
    const res = await request(app).get('/api/platform/admin/audit-events').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.events.length).toBeGreaterThan(0);
    for (const event of res.body.events) {
      expect(Object.keys(event).sort()).toEqual([...AUDIT_EVENT_COLUMNS].sort());
    }
  });

  it('paginates with limit and offset and reports the total of the filtered set', async () => {
    const all = await request(app)
      .get(`/api/platform/admin/audit-events?action=${SEED_ACTION}`)
      .set('Cookie', adminCookie);
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(1);
    expect(all.body.events).toHaveLength(1);

    const page = await request(app)
      .get(`/api/platform/admin/audit-events?action=${SEED_ACTION}&limit=1&offset=0`)
      .set('Cookie', adminCookie);
    expect(page.body.events).toHaveLength(1);
    expect(page.body.total).toBe(1);

    const rest = await request(app)
      .get(`/api/platform/admin/audit-events?action=${SEED_ACTION}&limit=50&offset=1`)
      .set('Cookie', adminCookie);
    expect(rest.body.events).toHaveLength(0);
    expect(rest.body.total).toBe(1);
  });

  it('rejects invalid pagination', async () => {
    const res = await request(app)
      .get('/api/platform/admin/audit-events?limit=999')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_pagination');
  });

  it('filters by the allowlist fields only', async () => {
    const byAction = await request(app)
      .get(`/api/platform/admin/audit-events?action=${SEED_ACTION}`)
      .set('Cookie', adminCookie);
    expect(byAction.status).toBe(200);
    expect(byAction.body.events).toHaveLength(1);
    expect(byAction.body.events[0].action).toBe(SEED_ACTION);

    const byOutcome = await request(app)
      .get('/api/platform/admin/audit-events?outcome=success')
      .set('Cookie', adminCookie);
    expect(byOutcome.status).toBe(200);
    expect(byOutcome.body.events.length).toBeGreaterThan(0);
    expect(byOutcome.body.events.every((e) => e.outcome === 'success')).toBe(true);

    const byActor = await request(app)
      .get(`/api/platform/admin/audit-events?actor_user_id=${admin.id}`)
      .set('Cookie', adminCookie);
    expect(byActor.status).toBe(200);
    expect(byActor.body.events.length).toBeGreaterThan(0);
    expect(byActor.body.events.every((e) => e.actor_user_id === admin.id)).toBe(true);

    // Unknown filters are ignored, not applied.
    const unknown = await request(app)
      .get(`/api/platform/admin/audit-events?action=${SEED_ACTION}&whatever=nope`)
      .set('Cookie', adminCookie);
    expect(unknown.status).toBe(200);
    expect(unknown.body.total).toBe(1);
  });

  it('filters by created range and validates filter values', async () => {
    const all = await request(app)
      .get(`/api/platform/admin/audit-events?action=${SEED_ACTION}`)
      .set('Cookie', adminCookie);
    const first = all.body.events[0];
    const from = await request(app)
      .get(`/api/platform/admin/audit-events?action=${SEED_ACTION}&created_from=${encodeURIComponent(first.created_at)}`)
      .set('Cookie', adminCookie);
    expect(from.body.total).toBe(1);

    const future = await request(app)
      .get(`/api/platform/admin/audit-events?action=${SEED_ACTION}&created_from=${encodeURIComponent('2999-01-01T00:00:00.000Z')}`)
      .set('Cookie', adminCookie);
    expect(future.body.total).toBe(0);

    const before = await request(app)
      .get(`/api/platform/admin/audit-events?action=${SEED_ACTION}&created_to=${encodeURIComponent('2000-01-01T00:00:00.000Z')}`)
      .set('Cookie', adminCookie);
    expect(before.body.total).toBe(0);

    const badUuid = await request(app)
      .get('/api/platform/admin/audit-events?actor_user_id=not-a-uuid')
      .set('Cookie', adminCookie);
    expect(badUuid.status).toBe(400);
    expect(badUuid.body.error).toBe('invalid_filter');
  });
});

describe('registration contract', () => {
  it('is a no-op when the platform is disabled', async () => {
    const bareApp = express();
    const result = await registerPlatformAdminRoutes(bareApp, { logger: silentLogger });
    expect(result.enabled).toBe(false);
    const res = await request(bareApp).get('/api/platform/admin/users');
    expect(res.status).toBe(404);
  });
});
