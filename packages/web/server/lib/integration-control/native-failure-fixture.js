// Shared by Vitest and the adjacent Hermes protocol test. Only OpenCode is a
// local HTTP fixture; authorization, lifecycle, control and wire routes are real.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import supertest from 'supertest';
import { createOpenChamberSessionService } from '../openchamber-sessions/routes.js';
import { createOpenChamberControlService } from '../openchamber-control/service.js';
import { registerIntegrationControlRoutes } from './routes.js';
import { hashIntegrationToken } from './auth.js';
import { ACTIONS } from './contract.js';

export const createNativeFailureFixture = async ({ dispatchStatus = 503 } = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-native-failure-'));
  const policyPath = path.join(root, 'policy.json');
  const previous = process.env.OPENCHAMBER_INTEGRATION_POLICY_FILE;
  process.env.OPENCHAMBER_INTEGRATION_POLICY_FILE = policyPath;
  const token = `oc_integration_${'synthetic_'.repeat(5)}`;
  const policy = { schemaVersion: 1, domainId: 'alpha', credentials: [{
    id: 'fixture', domain: 'alpha', tokenHash: hashIntegrationToken(token),
    projectIds: ['alpha'], actions: [...ACTIONS], enabled: true, expiresAt: '2999-01-01T00:00:00Z',
  }] };
  const savePolicy = () => fs.writeFile(policyPath, JSON.stringify(policy));
  await savePolicy();
  const calls = { creates: 0, dispatches: 0 };
  const requests = [];
  const sessions = [{ id: 'human', title: 'Human', location: { directory: root }, model: { providerID: 'fixture', id: 'echo' }, agent: 'build' }];
  const upstream = express();
  upstream.use(express.json());
  upstream.use((req, _res, next) => {
    requests.push({ method: req.method, path: req.path, directory: req.headers['x-opencode-directory'], body: req.body });
    next();
  });
  upstream.get('/api/model', (_req, res) => res.json({ data: [{ providerID: 'fixture', id: 'echo', modelID: 'echo' }] }));
  upstream.get('/api/config', (_req, res) => res.json({ data: [{ info: { model: 'fixture/echo' } }] }));
  upstream.get('/api/agent', (_req, res) => res.json({ data: [{ id: 'build', name: 'Build', mode: 'primary' }] }));
  upstream.get('/api/session', (_req, res) => res.json({ data: sessions }));
  upstream.get('/api/session/active', (_req, res) => res.json({ data: { human: { type: 'running' } } }));
  upstream.get('/api/session/:id', (req, res) => {
    const session = sessions.find(({ id }) => id === req.params.id);
    if (!session) return res.status(404).json({ error: { _tag: 'SessionNotFoundError' } });
    res.json({ data: session });
  });
  upstream.get('/api/session/:id/message', (_req, res) => res.json({ data: [
    { id: 'reply', type: 'assistant', time: { created: 2 }, content: [{ type: 'reasoning', text: 'private-reasoning' }, { type: 'text', text: 'Answer' }] },
    { id: 'question', type: 'user', time: { created: 1 }, text: 'Question' },
  ] }));
  upstream.post('/api/session', (req, res) => {
    calls.creates += 1;
    const session = { id: 'created', location: req.body.location, title: req.body.title };
    sessions.push(session);
    res.json({ data: session });
  });
  upstream.post('/api/session/:id/fork', (req, res) => {
    calls.creates += 1;
    const source = sessions.find(({ id }) => id === req.params.id);
    const session = { ...source, id: 'forked' };
    sessions.push(session);
    res.json({ data: session });
  });
  upstream.post(['/api/session/:id/model', '/api/session/:id/agent'], (_req, res) => res.sendStatus(204));
  upstream.post('/api/session/:id/prompt', (_req, res) => {
    calls.dispatches += 1;
    if (dispatchStatus !== 200) return res.status(dispatchStatus).send('private-upstream-conversation');
    res.json({ data: { id: 'queued' } });
  });
  const server = await new Promise((resolve) => {
    const listening = upstream.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const dependencies = {
    dataDir: root,
    readSettingsFromDiskMigrated: async () => ({ projects: [{ id: 'alpha', path: root }] }),
    sanitizeProjects: (projects) => projects,
    validateDirectoryPath: async (directory) => ({ ok: true, directory }),
    buildOpenCodeUrl: (route) => `http://127.0.0.1:${server.address().port}${route}`,
    getOpenCodeAuthHeaders: () => ({}),
  };
  const sessionService = createOpenChamberSessionService(dependencies);
  const controlService = createOpenChamberControlService({ ...dependencies, sessionService });
  const app = express();
  registerIntegrationControlRoutes(app, { ...dependencies, controlService });
  return {
    request: supertest(app), token, calls, policy, savePolicy, requests, root,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(root, { recursive: true, force: true });
      if (previous === undefined) delete process.env.OPENCHAMBER_INTEGRATION_POLICY_FILE;
      else process.env.OPENCHAMBER_INTEGRATION_POLICY_FILE = previous;
    },
  };
};
