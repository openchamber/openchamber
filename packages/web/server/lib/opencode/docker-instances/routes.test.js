import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeDockerRuntime } from '../../docker/fake-runtime.js';
import { registerCommonRequestMiddleware } from '../core-routes.js';
import { createDockerInstanceLifecycleManager } from './lifecycle-manager.js';
import { createDockerInstanceStore } from './store.js';
import { registerDockerInstanceRoutes } from './routes.js';

const PATHS = {
  openCodeConfigDir: 'C:\\Users\\me\\.config\\opencode',
  skillDir: 'C:\\Users\\me\\.config\\opencode\\skills',
  authFile: 'C:\\Users\\me\\.local\\share\\opencode\\auth.json',
};

const createHarness = async ({ enabled = true } = {}) => {
  const runtime = createFakeDockerRuntime();
  const dir = await mkdtemp(join(tmpdir(), 'oc-docker-routes-'));
  const fsPromises = await import('node:fs/promises');
  const store = createDockerInstanceStore({ filePath: join(dir, 'docker-instances.json'), fsPromises });
  const manager = createDockerInstanceLifecycleManager({
    runtime,
    store,
    platform: 'win32',
    getFreePort: async () => 4599,
    readinessIntervalMs: 1,
    readinessTimeoutMs: 250,
    probeHealth: async () => true,
  });
  const app = express();
  app.use(express.json());
  const isFeatureEnabled = vi.fn(async () => enabled);
  registerDockerInstanceRoutes(app, {
    manager,
    isFeatureEnabled,
    fsPromises,
    paths: PATHS,
    defaultImageName: 'opencode-instance:local',
    dockerRuntime: runtime,
    dockerFilePath: 'C:\\repo\\docker\\opencode-instance\\Dockerfile',
    dockerContextPath: 'C:\\repo\\docker\\opencode-instance',
  });
  return { app, manager, runtime, isFeatureEnabled, fsPromises, dir };
};

describe('docker instance routes', () => {
  let harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  it('list reports the feature disabled without exposing instances', async () => {
    const disabled = await createHarness({ enabled: false });
    const response = await request(disabled.app).get('/api/docker-instances');
    expect(response.status).toBe(200);
    expect(response.body.enabled).toBe(false);
    expect(response.body.instances).toEqual([]);
    expect(response.body.activeInstanceId).toBeNull();
    expect(response.body.sharedSkillsHostPath).toBeNull();
  });

  it('mutating routes refuse with 403 while the feature is disabled', async () => {
    const disabled = await createHarness({ enabled: false });
    const createResponse = await request(disabled.app)
      .post('/api/docker-instances')
      .send({ workspaceHostPath: 'C:\\proj\\a' });
    expect(createResponse.status).toBe(403);
    expect(createResponse.body.code).toBe('FEATURE_DISABLED');

    const actionResponse = await request(disabled.app).post('/api/docker-instances/x/stop');
    expect(actionResponse.status).toBe(403);
  });

  it('creates an instance end to end and lists it', async () => {
    const workspace = join(harness.dir, 'workspace-a');
    await harness.fsPromises.mkdir(workspace, { recursive: true });
    const response = await request(harness.app)
      .post('/api/docker-instances')
      .send({ label: 'A', workspaceHostPath: workspace, sharing: { config: true } });
    expect(response.status).toBe(201);
    expect(response.body.lifecycleState).toBe('running');
    expect(response.body.containerId).toMatch(/^fake-container-/);

    const list = await request(harness.app).get('/api/docker-instances');
    expect(list.body.instances).toHaveLength(1);
    expect(list.body.enabled).toBe(true);
  });

  it('rejects creation for a workspace that does not exist', async () => {
    const response = await request(harness.app)
      .post('/api/docker-instances')
      .send({ workspaceHostPath: 'C:\\definitely\\missing\\path' });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_WORKSPACE');
  });

  it('parses JSON bodies through the shared conditional request middleware', async () => {
    // Regression: the shared middleware parses JSON only for allowlisted
    // /api prefixes; a missing allowlist entry silently strips the body.
    const runtime = createFakeDockerRuntime();
    const dir = harness.dir;
    const fsPromises = harness.fsPromises;
    const store = createDockerInstanceStore({ filePath: join(dir, 'docker-instances-mw.json'), fsPromises });
    const manager = createDockerInstanceLifecycleManager({
      runtime,
      store,
      platform: 'win32',
      getFreePort: async () => 4601,
      readinessIntervalMs: 1,
      readinessTimeoutMs: 250,
      probeHealth: async () => true,
    });
    const app = express();
    registerCommonRequestMiddleware(app, { express, verboseRequestLogs: false });
    registerDockerInstanceRoutes(app, {
      manager,
      isFeatureEnabled: async () => true,
      fsPromises,
      paths: PATHS,
    });
    const workspace = join(dir, 'workspace-mw');
    await fsPromises.mkdir(workspace, { recursive: true });
    const response = await request(app)
      .post('/api/docker-instances')
      .set('Content-Type', 'application/json')
      .send({ workspaceHostPath: workspace });
    expect(response.status).toBe(201);
    expect(response.body.lifecycleState).toBe('running');
  });

  it('activate on a stopped instance returns 409 with canStart, then start enables activation', async () => {
    const workspace = join(harness.dir, 'workspace-b');
    await harness.fsPromises.mkdir(workspace, { recursive: true });
    const created = await request(harness.app)
      .post('/api/docker-instances')
      .send({ workspaceHostPath: workspace });

    await request(harness.app).post(`/api/docker-instances/${created.body.id}/stop`);
    const stopped = await request(harness.app).post(`/api/docker-instances/${created.body.id}/activate`);
    expect(stopped.status).toBe(409);
    expect(stopped.body.currentState).toBe('stopped');
    expect(stopped.body.canStart).toBe(true);

    await request(harness.app).post(`/api/docker-instances/${created.body.id}/start`);
    const activated = await request(harness.app).post(`/api/docker-instances/${created.body.id}/activate`);
    expect(activated.status).toBe(200);
    expect(activated.body.active.instanceId).toBe(created.body.id);
    expect(harness.manager.getActiveUpstream()?.origin).toBe('http://127.0.0.1:4599');
  });

  it('remove deletes the instance and deactivate returns to the default upstream', async () => {
    const workspace = join(harness.dir, 'workspace-c');
    await harness.fsPromises.mkdir(workspace, { recursive: true });
    const created = await request(harness.app)
      .post('/api/docker-instances')
      .send({ workspaceHostPath: workspace });
    const id = created.body.id;
    await request(harness.app).post(`/api/docker-instances/${id}/activate`);

    const removed = await request(harness.app).post(`/api/docker-instances/${id}/remove`);
    expect(removed.status).toBe(200);
    expect(harness.manager.getActiveUpstream()).toBeNull();

    const status = await request(harness.app).get(`/api/docker-instances/${id}`);
    expect(status.status).toBe(404);
  });

  it('unknown actions return 404', async () => {
    const response = await request(harness.app).post('/api/docker-instances/x/restart');
    expect(response.status).toBe(404);
  });

  it('image build requires the feature toggle and registers the built image', async () => {
    const disabled = await createHarness({ enabled: false });
    const forbidden = await request(disabled.app)
      .post('/api/docker-instances/image/build')
      .send({ imageName: 'opencode-instance:local' });
    expect(forbidden.status).toBe(403);

    const built = await request(harness.app)
      .post('/api/docker-instances/image/build')
      .send({ imageName: 'opencode-instance:local' });
    expect(built.status).toBe(200);
    expect(built.body.ok).toBe(true);
    expect(harness.runtime.images.has('opencode-instance:local')).toBe(true);
  });

  it('image pull registers a pulled image explicitly', async () => {
    const pulled = await request(harness.app)
      .post('/api/docker-instances/image/pull')
      .send({ imageName: 'ghcr.io/openchamber/opencode-instance:latest' });
    expect(pulled.status).toBe(200);
    expect(pulled.body.ok).toBe(true);
    expect(harness.runtime.images.has('ghcr.io/openchamber/opencode-instance:latest')).toBe(true);
  });
});
