// HTTP contract tests for the workspace routes (plan section 9.1): RT-01
// concurrent idempotent start, authn/authz, parameter rejection, CSRF.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createTestPlatformDb } from '../db/test-utils.js';
import { importUser } from '../users/user-import.js';
import { createPlatformSession, SESSION_COOKIE_NAME } from '../auth/sessions.js';
import { registerPlatformWorkspaceRoutes } from './routes.js';
import { startRuntimeWorker } from './worker.js';
import { createFakeRuntimeDriver } from './runtime-driver.js';

const silentLogger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };

let db;
let app;
let user;
let cookie;
let counter = 200;

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
  const { token } = await createPlatformSession(db, { userId: user.id });
  cookie = `${SESSION_COOKIE_NAME}=${token}`;

  app = express();
  app.use(express.json());
  const result = await registerPlatformWorkspaceRoutes(app, { logger: silentLogger, db });
  expect(result.enabled).toBe(true);
});

afterEach(async () => {
  await db?.end?.();
  db = undefined;
  app = undefined;
});

describe('GET /api/platform/workspace', () => {
  it('answers 401 without a session', async () => {
    const res = await request(app).get('/api/platform/workspace');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthenticated');
    expect(res.body.request_id).toBeTruthy();
  });

  it('returns the current user stopped workspace without internal fields', async () => {
    const res = await request(app).get('/api/platform/workspace').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.workspace.ownerUserId).toBe(user.id);
    expect(res.body.workspace).toMatchObject({
      desiredState: 'stopped',
      observedState: 'stopped',
      generation: 0,
    });
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('runtime_id');
    expect(serialized).not.toContain('internal_endpoint');
    expect(serialized).not.toContain('credential');
  });
});

describe('POST /api/platform/workspace/start', () => {
  it('answers 401 without a session', async () => {
    const res = await request(app)
      .post('/api/platform/workspace/start')
      .set('X-Requested-With', 'XMLHttpRequest');
    expect(res.status).toBe(401);
  });

  it('requires the CSRF header', async () => {
    const res = await request(app).post('/api/platform/workspace/start').set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('csrf_header_required');
  });

  it('rejects arbitrary container parameters with 400 (plan section 8.1)', async () => {
    for (const body of [
      { image: 'alpine:latest' },
      { mounts: ['/etc:/etc'] },
      { host: 'docker.example.com' },
      { uid: 0 },
    ]) {
      const res = await request(app)
        .post('/api/platform/workspace/start')
        .set('Cookie', cookie)
        .set('X-Requested-With', 'XMLHttpRequest')
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('unsupported_parameter');
    }
    // Nothing was registered.
    const { rows: ops } = await db.query('SELECT * FROM runtime_operations');
    expect(ops).toHaveLength(0);
  });

  it('parses the JSON body without a global parser (production wiring)', async () => {
    // Boot the router the way production does: NO app-level express.json().
    // The route must carry its own parser, otherwise the forbidden-parameter
    // defense below never sees the body and the start would be accepted.
    const bareApp = express();
    const result = await registerPlatformWorkspaceRoutes(bareApp, { logger: silentLogger, db });
    expect(result.enabled).toBe(true);

    const rejected = await request(bareApp)
      .post('/api/platform/workspace/start')
      .set('Cookie', cookie)
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ image: 'alpine:latest' });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toBe('unsupported_parameter');

    const accepted = await request(bareApp)
      .post('/api/platform/workspace/start')
      .set('Cookie', cookie)
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({});
    expect(accepted.status).toBe(202);
  });

  it('accepts a start and returns 202 with the operation id', async () => {
    const res = await request(app)
      .post('/api/platform/workspace/start')
      .set('Cookie', cookie)
      .set('X-Requested-With', 'XMLHttpRequest');
    expect(res.status).toBe(202);
    expect(res.body.operation.kind).toBe('start');
    expect(res.body.operation.id).toBeTruthy();
    expect(res.body.workspace.observedState).toBe('starting');
    expect(res.body.request_id).toBeTruthy();
  });

  it('RT-01: 10 concurrent starts produce one operation and one generation', async () => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => request(app)
        .post('/api/platform/workspace/start')
        .set('Cookie', cookie)
        .set('X-Requested-With', 'XMLHttpRequest')),
    );
    for (const res of responses) expect(res.status).toBe(202);
    const operationIds = new Set(responses.map((res) => res.body.operation.id));
    expect(operationIds.size).toBe(1);
    const generations = new Set(responses.map((res) => res.body.workspace.generation));
    expect(generations.size).toBe(1);

    const { rows: ops } = await db.query('SELECT * FROM runtime_operations');
    expect(ops).toHaveLength(1);
    const { rows: workspaces } = await db.query('SELECT * FROM workspaces');
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].generation).toBe(1);
  });

  it('returns 200 with no operation when the workspace is already healthy', async () => {
    const driver = createFakeRuntimeDriver();
    const worker = startRuntimeWorker({
      db, driver, env: { OPENCHAMBER_RUNTIME_WORKER_POLL_MS: 50, OPENCHAMBER_RUNTIME_WORKER_RECONCILE_MS: 3600000 }, logger: silentLogger,
    });
    try {
      const first = await request(app)
        .post('/api/platform/workspace/start')
        .set('Cookie', cookie)
        .set('X-Requested-With', 'XMLHttpRequest');
      expect(first.status).toBe(202);
      await vi.waitFor(async () => {
        const { rows } = await db.query('SELECT observed_state FROM workspaces');
        expect(rows[0].observed_state).toBe('running');
      }, { timeout: 3000, interval: 50 });

      const second = await request(app)
        .post('/api/platform/workspace/start')
        .set('Cookie', cookie)
        .set('X-Requested-With', 'XMLHttpRequest');
      expect(second.status).toBe(200);
      expect(second.body.operation).toBeNull();
      expect(second.body.workspace.observedState).toBe('running');
    } finally {
      await worker.stop();
    }
  });
});

describe('GET /api/platform/operations/:id', () => {
  it('answers 401 without a session', async () => {
    const res = await request(app).get('/api/platform/operations/anything');
    expect(res.status).toBe(401);
  });

  it('returns the operation to its owner', async () => {
    const start = await request(app)
      .post('/api/platform/workspace/start')
      .set('Cookie', cookie)
      .set('X-Requested-With', 'XMLHttpRequest');
    const res = await request(app)
      .get(`/api/platform/operations/${start.body.operation.id}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.operation.id).toBe(start.body.operation.id);
    expect(res.body.operation.status).toBe('pending');
  });

  it('answers 404 (never 403) for another user operation (plan section 7.2)', async () => {
    const start = await request(app)
      .post('/api/platform/workspace/start')
      .set('Cookie', cookie)
      .set('X-Requested-With', 'XMLHttpRequest');
    const other = await importUser(db, {
      issuer: 'https://idp.example.com',
      subject: `other-${counter}`,
      displayName: 'Other',
      linuxUid: 2000 + counter,
      linuxGid: 2000 + counter,
      homePath: `/home/other${counter}`,
    });
    const { token } = await createPlatformSession(db, { userId: other.user.id });
    const res = await request(app)
      .get(`/api/platform/operations/${start.body.operation.id}`)
      .set('Cookie', `${SESSION_COOKIE_NAME}=${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('operation_not_found');
  });

  it('lets an admin read any operation', async () => {
    const start = await request(app)
      .post('/api/platform/workspace/start')
      .set('Cookie', cookie)
      .set('X-Requested-With', 'XMLHttpRequest');
    const admin = await importUser(db, {
      issuer: 'https://idp.example.com',
      subject: `admin-${counter}`,
      displayName: 'Admin',
      linuxUid: 3000 + counter,
      linuxGid: 3000 + counter,
      homePath: `/home/admin${counter}`,
    });
    await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [admin.user.id]);
    const { token } = await createPlatformSession(db, { userId: admin.user.id });
    const res = await request(app)
      .get(`/api/platform/operations/${start.body.operation.id}`)
      .set('Cookie', `${SESSION_COOKIE_NAME}=${token}`);
    expect(res.status).toBe(200);
  });

  it('answers 404 for an unknown operation', async () => {
    const res = await request(app)
      .get('/api/platform/operations/00000000-0000-0000-0000-000000000000')
      .set('Cookie', cookie);
    expect(res.status).toBe(404);
  });
});

describe('registration contract', () => {
  it('is a no-op when the platform is disabled', async () => {
    // No db override and OPENCHAMBER_PLATFORM_DATABASE_URL unset (the vitest
    // environment has none): registration must register nothing at all.
    const bareApp = express();
    const result = await registerPlatformWorkspaceRoutes(bareApp, { logger: silentLogger });
    expect(result.enabled).toBe(false);
    const res = await request(bareApp).get('/api/platform/workspace');
    expect(res.status).toBe(404);
  });
});
