import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerLinearRoutes } from './routes.js';
import { createLinearIntegrationRuntime } from './runtime.js';
import { LinearIntegrationStore } from './store.js';
import { LinearLinkStore } from './link-store.js';

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linear-routes-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function createApp({ client = {}, sessionService = null, connected = false } = {}) {
  const store = new LinearIntegrationStore({ filePath: path.join(tmpDir, 'integration.json') });
  if (connected) {
    store.setAuth({ apiKey: 'lin_api_secret', viewer: { id: 'u1', name: 'Ada' } });
    store.updateSettings({ defaultProjectId: 'proj-1' });
  }
  const runtime = createLinearIntegrationRuntime({
    store,
    linkStore: new LinearLinkStore({ filePath: path.join(tmpDir, 'links.json') }),
    client: {
      fetchViewer: vi.fn(async () => ({
        viewer: { id: 'u1', name: 'Ada' },
        organization: { id: 'org-1', name: 'Acme', urlKey: 'acme' },
      })),
      listTeams: vi.fn(async () => []),
      fetchIssue: vi.fn(async () => null),
      listTriggerIssues: vi.fn(async () => []),
      createComment: vi.fn(async () => ({ id: 'c1' })),
      createAttachment: vi.fn(async () => ({ id: 'a1' })),
      ...client,
    },
    sessionService:
      sessionService ??
      { create: vi.fn(async () => ({ sessionId: 'ses_abc', directory: '/repo', promptDispatched: true })) },
    getAppBaseUrl: () => 'http://127.0.0.1:9384',
    logger: { log: () => {}, warn: () => {} },
  });
  const app = express();
  registerLinearRoutes(app, { runtime });
  return app;
}

describe('/api/linear routes', () => {
  it('GET /status reports connection state without exposing the API key', async () => {
    const res = await request(createApp({ connected: true })).get('/api/linear/status');
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.viewer.name).toBe('Ada');
    expect(JSON.stringify(res.body)).not.toContain('lin_api_secret');
  });

  it('POST /connect validates and persists the key', async () => {
    const app = createApp();
    const res = await request(app).post('/api/linear/connect').send({ apiKey: 'lin_api_new' });
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.organization.name).toBe('Acme');

    const status = await request(app).get('/api/linear/status');
    expect(status.body.connected).toBe(true);
  });

  it('POST /connect rejects a missing key with 400', async () => {
    const res = await request(createApp()).post('/api/linear/connect').send({});
    expect(res.status).toBe(400);
  });

  it('POST /connect surfaces a rejected key as 401', async () => {
    const authError = new Error('Linear rejected the API key');
    authError.authFailed = true;
    const res = await request(
      createApp({ client: { fetchViewer: vi.fn(async () => { throw authError; }) } }),
    )
      .post('/api/linear/connect')
      .send({ apiKey: 'lin_api_bad' });
    expect(res.status).toBe(401);
  });

  it('POST /disconnect clears the connection', async () => {
    const app = createApp({ connected: true });
    const res = await request(app).post('/api/linear/disconnect');
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(false);
  });

  it('PUT /settings merges and returns normalized settings', async () => {
    const res = await request(createApp({ connected: true }))
      .put('/api/linear/settings')
      .send({ triggerLabel: 'agent', autoStartEnabled: true });
    expect(res.status).toBe(200);
    expect(res.body.settings.triggerLabel).toBe('agent');
    expect(res.body.settings.autoStartEnabled).toBe(true);
    expect(res.body.settings.defaultProjectId).toBe('proj-1');
  });

  it('POST /issues/start creates and links a session', async () => {
    const issue = {
      id: 'issue-1',
      identifier: 'ENG-42',
      title: 'Fix login',
      url: 'https://linear.app/acme/issue/ENG-42/fix-login',
      team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
    };
    const app = createApp({ connected: true, client: { fetchIssue: vi.fn(async () => issue) } });
    const res = await request(app).post('/api/linear/issues/start').send({ issue: 'ENG-42' });
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe('ses_abc');
    expect(res.body.sessionUrl).toContain('session=ses_abc');

    const links = await request(app).get('/api/linear/links');
    expect(links.body.links).toHaveLength(1);
    expect(links.body.links[0].issueIdentifier).toBe('ENG-42');

    // Starting again is a conflict, not a duplicate session.
    const again = await request(app).post('/api/linear/issues/start').send({ issue: 'ENG-42' });
    expect(again.status).toBe(409);
  });

  it('POST /issues/start maps an unknown issue to 404', async () => {
    const res = await request(createApp({ connected: true }))
      .post('/api/linear/issues/start')
      .send({ issue: 'ENG-999' });
    expect(res.status).toBe(404);
  });

  it('DELETE /links/:issueId removes a link', async () => {
    const issue = {
      id: 'issue-1',
      identifier: 'ENG-42',
      title: 'Fix login',
      url: 'https://linear.app/acme/issue/ENG-42/x',
      team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
    };
    const app = createApp({ connected: true, client: { fetchIssue: vi.fn(async () => issue) } });
    await request(app).post('/api/linear/issues/start').send({ issue: 'ENG-42' });

    const removed = await request(app).delete('/api/linear/links/issue-1');
    expect(removed.status).toBe(200);
    const missing = await request(app).delete('/api/linear/links/issue-1');
    expect(missing.status).toBe(404);
  });
});
