import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import express from 'express';
import { createSpaceDispatcher } from '../spaces/dispatcher.js';
import { createBotStageSessions } from './stage-sessions.js';
import { createBotIsolatedStages } from './isolated-stages.js';
import { createBotIsolatedToolInbox, registerBotIsolatedToolRoutes } from './isolated-tools.js';
import { createBotDiscovery } from './discovery.js';
import { botDefinitionSchema } from './config.js';
import { createBotProviderRuntime } from './provider-runtime.js';
import { createBotIdentityStore } from './identities.js';
import { createBotServices } from './services.js';
import { createBotDriver } from './runtime-test-support.js';
import { controlledUpstream, disconnectedPolicy, issueResponse } from './services/http.test-support.js';

await fs.mkdir('/tmp/opencode', { recursive: true });
const root = await fs.mkdtemp('/tmp/opencode/bot-adapters-driver-');
process.env.OPENCHAMBER_DATA_DIR = root;
const { createUiAuth } = await import('../ui-auth/ui-auth.js');
const auth = createUiAuth({ password: 'driver-space-token', readSettingsFromDiskMigrated: async () => ({}) });
const app = express();
let logins = 0; let prompts = 0; let busy = true; let info;
const sessions = new Map(); const hostTools = [];
let announce;
const pending = new Promise((resolve) => { announce = resolve; });
const inbox = createBotIsolatedToolInbox({ dataDir: path.join(root, 'child'), onPending: async (event) => announce(event) });
app.post('/auth/session', express.json(), (req, res) => { logins++; auth.handleSessionCreate(req, res); });
app.use('/api', auth.requireAuth, express.json(), (req, _res, next) => { assert.equal(req.headers.authorization, undefined); next(); });
registerBotIsolatedToolRoutes(app, { inbox, isInsideSpace: () => true });
app.post('/api/session', async (req, res) => {
  info = req.body; sessions.set(info.id, info);
  const files = await fs.readdir(path.join(root, 'bots/isolated-stages'));
  const binding = JSON.parse(await fs.readFile(path.join(root, 'bots/isolated-stages', files.find((file) => file.endsWith('.json'))), 'utf8'));
  assert.ok(Object.values(binding.sessions).some((session) => session.id === info.id));
  res.json({ data: { data: info } });
});
app.patch('/api/session/:id', (_req, res) => res.status(204).end());
app.put('/api/experimental/session/:id/instructions/entries/:key', (_req, res) => res.status(204).end());
app.put('/api/permission-auto-accept/sessions/:id', (_req, res) => res.json({}));
app.post('/api/session/:id/model', (req, res) => { assert.equal(req.body.model.id, 'investigate'); res.status(204).end(); });
app.post('/api/session/:id/prompt', async (req, res) => {
  const files = await fs.readdir(path.join(root, 'bots/discovery'));
  const record = JSON.parse(await fs.readFile(path.join(root, 'bots/discovery', files.find((file) => file.endsWith('.json'))), 'utf8'));
  assert.equal(record.run.sessionId, req.params.id); assert.equal(record.state, 'dispatching');
  prompts++; res.json({ data: { id: req.body.id } });
});
app.get('/api/session/active', (_req, res) => res.json({ data: busy ? { [info.id]: { type: 'busy' } } : {} }));
app.get('/api/session/:id', (req, res) => res.json({ data: { data: sessions.get(req.params.id) } }));
app.get('/api/session/:id/message', (_req, res) => res.json({ data: [
  { id: 'idle_end', type: 'idle', outcome: 'succeeded', time: { created: 2 } },
  { id: 'msg_reply', type: 'assistant', time: { created: 1, completed: 2 },
    tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
    content: [{ type: 'text', text: JSON.stringify([{ source: { kind: 'investigation', id: 'stable' }, title: 'A verified candidate' }]) }] },
], cursor: { next: null, previous: null } }));
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const dispatcher = createSpaceDispatcher({ transport: { listSpaceIds: async () => ({ ids: ['abcdef123456'], failure: null }),
  readToken: async () => 'driver-space-token', connect: async () => net.connect(server.address().port, '127.0.0.1'),
} });
let providers; let upstream;
try {
  const host = { dispatcher, manager: { verify: async () => [] }, journey: {
    readHostCustomProviders: async (directory) => { assert.equal(directory, root); return { providers: [] }; },
    readHostLogins: async () => ({ logins: [{ provider: 'unselected', state: 'usable' }, { provider: 'fixture', state: 'usable' }] }),
    createBotSpace: async (request, { onAllocated }) => {
      assert.deepEqual(request.grants, [{ kind: 'login', provider: 'fixture' }]);
      assert.deepEqual(request.network, { mode: 'allowlist', domains: [] }); assert.deepEqual(request.setupCommands, []);
      return onAllocated({ id: 'abcdef123456', directory: '/spaces/abcdef123456/project' });
    },
    listSpaces: async () => [{ id: 'abcdef123456', state: 'running', access: 'granted', grants: [{ provider: 'fixture' }] }],
  } };
  const isolated = createBotIsolatedStages({ dataDir: root, getSpacesHost: () => host,
    resolveProject: async () => ({ id: 'p', path: root }),
    sessionKnowledgeRuntime: { collect: async () => ({ notes: [], plans: [], memory: { enabled: true, complete: true, global: [], project: [] } }) },
    handleTool: async (request) => { hostTools.push(request); return { receipt: { id: 'driver-tool-receipt' } }; },
  });
  const noHost = () => { throw new Error('A host session was attempted'); };
  const stages = createBotStageSessions({ sessionService: { create: noHost, send: noHost }, clientFor: noHost,
    permissionAutoAcceptRuntime: { setSessionPolicy: noHost }, sessionKnowledgeRuntime: { sync: noHost },
    activityProbe: { fetchActiveSessionStatuses: noHost, hasWorkingChildren: noHost }, readSessionDefaults: noHost, readTokenSnapshot: noHost, isolated,
  });
  const bot = botDefinitionSchema.parse({ id: 'discovery', name: 'Discovery', mission: 'Find a verified defect', isolated: true,
    source: { kind: 'investigation', prompt: 'Inspect', maxItems: 3 }, models: { investigation: { useDefaults: false, providerID: 'fixture', modelID: 'investigate' } },
  });
  const request = { project: { id: 'p', path: root }, bot, occurrence: 'driver-occurrence', maxItems: 3 };
  let wakes = 0; let at = Date.parse('2026-10-22T23:59:00Z');
  const discoveryOptions = { dataDir: root, stages, onReady: async () => { wakes++; }, onAttention: async () => {}, now: () => at };
  const initial = createBotDiscovery(discoveryOptions);
  await assert.rejects(() => initial.discover(request), { code: 'BOT_DISCOVERY_PENDING' });
  await initial.recordUsage({ sessionId: info.id, total: 6 });
  await initial.recordUsage({ sessionId: info.id, total: 4 });
  busy = false;
  at = Date.parse('2026-10-23T00:01:00Z');
  const resumed = createBotDiscovery(discoveryOptions);
  await resumed.start();
  assert.equal((await resumed.discover(request)).length, 1);
  assert.equal(prompts, 1); assert.equal(logins, 1); assert.equal(wakes, 1);
  const binding = await isolated.bindingFor({ sessionId: info.id });
  const outcome = await isolated.outcome({ projectId: 'p', itemId: binding.itemId, sessionId: info.id, dispatchedAt: 0, afterIdleId: null });
  assert.equal(outcome.tokens, 15);
  const usage = await createBotDiscovery(discoveryOptions).usage({ projectId: 'p', botId: bot.id });
  assert.deepEqual(usage, { total: 15, byDay: { '2026-10-22': 6, '2026-10-23': 9 }, day: '2026-10-23', dailyTotal: 9, complete: true });

  const fixing = await isolated.create({ projectId: 'p', itemId: binding.itemId, directory: root, bot, stage: 'fixing', prompt: 'Fix the candidate',
    selection: { providerID: 'fixture', modelID: 'investigate' }, dispatchedAt: at, afterIdleId: null }, async () => {});
  const tool = { sessionId: fixing.sessionId, callId: 'driver-call', action: 'jira.comment', input: { operationId: 'driver-comment', body: 'Evidence' } };
  const waiting = inbox.request(tool); await pending;
  await assert.rejects(() => isolated.forwardTools({ spaceId: '000000000000', sessionId: fixing.sessionId }), { code: 'BOT_ISOLATED_TOOL_SESSION_REQUIRED' });
  assert.equal(hostTools.length, 0);
  assert.deepEqual(await isolated.forwardTools({ spaceId: 'abcdef123456', sessionId: fixing.sessionId }), { forwarded: 1 });
  assert.deepEqual(await waiting, { receipt: { id: 'driver-tool-receipt' } });
  assert.deepEqual(hostTools, [{ sessionId: fixing.sessionId, action: tool.action, input: tool.input }]);
  assert.equal(logins, 1);

  const identities = createBotIdentityStore({ dataDir: root });
  const jira = await identities.create({ kind: 'jira-account', label: 'Driver Jira', site: 'https://driver.atlassian.net', email: 'driver@example.test', apiToken: 'disposable-driver-token' });
  let authorized = true; let comment = '7';
  upstream = await controlledUpstream((req) => {
    if (!authorized) return { status: 401 };
    if (req.path === '/rest/api/3/myself') return { body: { accountId: 'driver', active: true } };
    if (req.path.includes('/comment?')) return { body: { startAt: 0, total: 1, comments: [{ id: comment, author: { accountId: 'person', accountType: 'atlassian' },
      created: comment === '7' ? '2026-10-22T00:00:00Z' : '2026-10-23T00:00:00Z', updated: '2026-10-23T00:00:00Z', body: { type: 'doc', content: [{ type: 'text', text: 'More evidence' }] } }] } };
    return { body: issueResponse() };
  });
  const services = createBotServices({ identities, dataDir: root, fetchImpl: upstream.fetchImpl, policyOptions: disconnectedPolicy });
  const driver = await createBotDriver(path.join(root, 'engine'), { held: ['investigation'], bot: { identity: { jira: { identityId: jira.id } } } });
  await driver.admit({ kind: 'jira', id: 'TEST-7' });
  const needsYou = [];
  providers = createBotProviderRuntime({ dataDir: root, config: driver.config, store: driver.store, runtime: driver.runtime, identities, services,
    listProjects: async () => [driver.project], resolveProject: async () => driver.project,
    serviceContext: async () => ({ jira: { identityId: jira.id, identityRevision: jira.revision, target: { projectKey: 'TEST', issueKey: 'TEST-7' } } }),
    onNeedsYou: async (value) => needsYou.push(value),
  });
  assert.deepEqual(await providers.resolveJiraContext({ bot: (await driver.config.read(driver.project.id)).definitions[0] }), {
    identityId: jira.id, identityRevision: jira.revision, site: 'https://driver.atlassian.net',
  });
  await providers.start(); await providers.tick();
  assert.equal(driver.calls.notices.length, 1);
  authorized = false; await providers.tick();
  assert.equal(needsYou[0].state, 'needs-you');
  assert.equal(needsYou[0].reason, 'BOT_SERVICE_AUTH_REQUIRED');
  authorized = true; comment = '8'; await providers.reconfigure(); await providers.tick();
  assert.equal(driver.calls.notices.length, 2);
  assert.ok(upstream.requests.every((req) => req.method === 'GET'));
  console.log(JSON.stringify({ discovery: { prompts, wakes, sdkAndAuthenticatedDispatcher: true, cacheInclusiveTokens: outcome.tokens, usage },
    isolatedTools: { forwarded: hostTools.length, wrongSpaceRejected: true, childSettlement: true, hostCredentialForwarded: false, selectedProviderOnly: true },
    jira: { deliveries: driver.calls.notices.length, authorizationFailure: needsYou[0].reason, providerWrites: 0 },
    limits: ['Loopback fixture, not real OpenCode/provider', 'No Docker container or remote Discord login was exercised'] }));
} finally {
  await providers?.stop(); await upstream?.close(); dispatcher.close();
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
