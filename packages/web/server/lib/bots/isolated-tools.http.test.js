import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import express from 'express';
import { afterEach, expect, it } from 'vitest';
import { createSpaceDispatcher } from '../spaces/dispatcher.js';
import { createBotIsolatedStages } from './isolated-stages.js';
import { createBotIsolatedToolInbox, registerBotIsolatedToolRoutes } from './isolated-tools.js';
import { botDefinitionSchema } from './config.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it.each([false, true])('uses the pinned SDK and authenticated dispatcher for isolated tool replies, nested records %s', async (nested) => {
  const root = await fs.mkdtemp('/tmp/opencode/isolated-tool-http-'); cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  process.env.OPENCHAMBER_DATA_DIR = root;
  const { createUiAuth } = await import('../ui-auth/ui-auth.js');
  const auth = createUiAuth({ password: 'child-only-token', readSettingsFromDiskMigrated: async () => ({}) });
  const app = express(); const seen = []; let info; let logins = 0; let notify;
  const notified = new Promise((resolve) => { notify = resolve; });
  const inbox = createBotIsolatedToolInbox({ dataDir: root, onPending: async (event) => notify(event) });
  app.post('/auth/session', express.json(), (req, res) => { logins++; auth.handleSessionCreate(req, res); });
  app.use('/api', auth.requireAuth, express.json(), (req, _res, next) => { seen.push({ method: req.method, path: req.originalUrl, headers: req.headers, body: req.body }); next(); });
  registerBotIsolatedToolRoutes(app, { inbox, isInsideSpace: () => true });
  const record = (value) => nested ? { data: { data: value } } : { data: value };
  app.post('/api/session', (req, res) => { info = req.body; res.json(record(info)); });
  app.get('/api/session/:id', (_req, res) => res.json(record(info)));
  app.patch('/api/session/:id', (_req, res) => res.status(204).end());
  app.post('/api/session/:id/model', (_req, res) => res.status(204).end());
  app.post('/api/session/:id/agent', (_req, res) => res.status(204).end());
  app.post('/api/session/:id/prompt', (req, res) => res.json({ data: { id: req.body.id } }));
  app.put('/api/experimental/session/:id/instructions/entries/:key', (_req, res) => res.status(204).end());
  const server = http.createServer(app); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const port = server.address().port;
  const dispatcher = createSpaceDispatcher({ transport: {
    listSpaceIds: async () => ({ ids: ['abcdef123456'], failure: null }), readToken: async () => 'child-only-token',
    connect: async () => net.connect(port, '127.0.0.1'),
  } });
  cleanups.push(async () => dispatcher.close());
  const directory = '/spaces/abcdef123456/répo'; const executed = [];
  const host = { dispatcher, manager: { verify: async () => [] }, journey: {
    readHostCustomProviders: async () => ({ providers: [] }), readHostLogins: async () => ({ logins: [{ provider: 'chosen', state: 'usable' }] }),
    createBotSpace: async (request, { onAllocated }) => { expect(request.network).toEqual({ mode: 'allowlist', domains: [] }); expect(request.setupCommands).toEqual([]); await onAllocated({ id: 'abcdef123456', directory }); },
    listSpaces: async () => [{ id: 'abcdef123456', state: 'running', access: 'granted', grants: [{ provider: 'chosen' }] }],
  } };
  const adapter = createBotIsolatedStages({ dataDir: root, getSpacesHost: () => host, resolveProject: async () => ({ id: 'p', path: '/host/project' }),
    sessionKnowledgeRuntime: { collect: async () => ({ notes: [{ id: 'n', body: 'Pinned context' }], plans: [], memory: { enabled: false, complete: true, global: [], project: [] } }) },
    handleTool: async (request) => { executed.push(request); return { receipt: { id: 'comment-7' } }; },
  });
  const bot = botDefinitionSchema.parse({ id: 'bugs', name: 'Bugs', mission: 'Fix', isolated: true });
  const request = { projectId: 'p', itemId: 'i', bot, stage: 'fixing', directory: '/host/worktree', prompt: 'Fix the bug', dispatchedAt: 1, afterIdleId: null,
    selection: { providerID: 'chosen', modelID: 'specific', variant: 'high', agent: 'build' } };
  const created = await adapter.create(request, async () => {});
  await adapter.dispatch({ ...request, sessionId: created.sessionId });
  expect(await adapter.reconcile('session.create', request, created.sessionId)).toMatchObject({ state: 'succeeded' });
  expect(seen.find((entry) => entry.path.endsWith('/model')).body).toEqual({ model: { providerID: 'chosen', id: 'specific', variant: 'high' } });
  expect(seen.find((entry) => entry.path === '/api/session').headers['x-opencode-directory']).toBe(encodeURIComponent(directory));
  expect((await fetch(`http://127.0.0.1:${port}/api/openchamber/bots/isolated-tools?sessionId=${created.sessionId}`)).status).toBe(401);
  const tool = { sessionId: created.sessionId, callId: 'call-one', action: 'jira.comment', input: { operationId: 'comment-one', body: 'Evidence' } };
  const waiting = inbox.request(tool); await notified;
  expect(await adapter.forwardTools({ spaceId: 'abcdef123456', sessionId: created.sessionId })).toEqual({ forwarded: 1 });
  expect(await waiting).toEqual({ receipt: { id: 'comment-7' } });
  expect(executed).toEqual([{ sessionId: created.sessionId, action: tool.action, input: tool.input }]);
  expect(seen.filter((entry) => entry.path.includes('isolated-tools')).every((entry) => entry.headers.authorization === undefined)).toBe(true);
  expect(logins).toBe(1);
});
