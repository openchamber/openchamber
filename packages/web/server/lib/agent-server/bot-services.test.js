import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { afterEach, expect, test, vi } from 'vitest';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { botDefinitionSchema } from '../bots/config.js';
import { createBotExecutionServices } from '../bots/agent-execution.js';
import { createAgentUpstream, readBoundedBody } from './agent-upstream.js';
import { createAgentBotServices } from './bot-services.js';
import { registerBotServiceRoutes } from './bot-service-routes.js';
import { BOT_PROVIDER_READS, BOT_SERVICE_OPERATIONS, BOT_SERVICE_ROUTE, botEffectInputDigest, botRequestAssociation } from './bot-service-contract.js';
import { botNoticeIds } from '../message-queue/bot-notice.js';
import { createBotAgentGatewayTransport } from '../bots/agent-gateway-transport.js';
import { createOwnerBotGateway } from './bot-owner-gateway.js';
import { createBotServices } from '../bots/services.js';
import { createBotItem } from '../bots/schema.js';
import { botToolReplySchema } from './bot-service-contract.js';

const HEAD = 'a'.repeat(40); const BASE = 'b'.repeat(40);
const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const responseOf = (body, statusCode = 200) => Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { statusCode });
async function fixture() {
  const root = await fs.mkdtemp('/tmp/opencode/bot-execution-');
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'project'); await fs.mkdir(directory);
  const worktree = path.join(root, 'owned'); await fs.mkdir(worktree);
  const project = { id: 'project', path: directory };
  const bot = botDefinitionSchema.parse({ id: 'bot', name: 'Bot', mission: 'Fix verified defects', identity: { github: { kind: 'app', identityId: 'identity' } },
    proof: { command: 'node', args: ['test.js'] } });
  const item = { id: 'item', botId: 'bot', source: { kind: 'manual', id: 'item' }, worktree, branch: 'bot/item', sessions: { fixing: 'ses_fix' }, effects: [] };
  const scope = { project, bot, item, checkoutKey: 'item:worktree' };
  const binding = { identityId: 'identity', identityRevision: 2, target: { repositoryId: 'repository', owner: 'org', repo: 'repo' } };
  const effect = { key: 'item:push', operation: 'git.push', botId: bot.id, itemId: item.id,
    authority: { ...binding, target: undefined, service: 'github', origin: 'https://api.github.com', credentialId: 'identity', credentialRevision: 2, providerAccountId: 'github.com#123' },
    target: binding.target, inputDigest: '1'.repeat(64) };
  delete effect.authority.target;
  const push = { directory: worktree, branch: 'bot/item', headSha: HEAD, baseSha: BASE, expectedRemoteSha: null, base: 'main' };
  effect.inputDigest = botEffectInputDigest(effect, push);
  const checkout = { directory: worktree, branch: 'bot/item', baseBranch: 'main', baseSha: BASE };
  const snapshot = { headSha: HEAD, baseSha: BASE, baseBranch: 'main', remoteSha: null, changes: [{ oldPath: 'test.js', newPath: 'test.js' }], diff: 'diff', testSha: BASE, fixSha: HEAD, testFiles: ['test.js'] };
  const info = { id: 'ses_fix', location: { directory: worktree }, metadata: { openchamber: { automation: { source: 'bot',
    projectId: project.id, botId: bot.id, itemId: item.id, stage: 'fixing' } } } };
  const session = { get: vi.fn(async () => ({ data: info })), interrupt: vi.fn(async () => ({})), synthetic: vi.fn(async () => ({})) };
  const message = { list: vi.fn(async () => ({ data: [] })) };
  const provider = { prepare: vi.fn(async () => effect), preflight: vi.fn(async () => undefined),
    execute: vi.fn(async () => ({ status: 'succeeded', operation: 'git.push', authority: effect.authority, target: effect.target,
      result: { headSha: HEAD, sourceHeadSha: HEAD }, replayed: false })), reconcile: vi.fn(async () => ({ state: 'outcome-unknown' })),
    read: vi.fn(async () => ({ headSha: HEAD })) };
  const publicIdentity = { id: 'identity', revision: 2, label: 'Selected', kind: 'github-app', configured: true, appId: '123', installationId: '456' };
  const identities = { list: vi.fn(async () => [publicIdentity]), create: vi.fn(async () => ({ ...publicIdentity, revision: 1, privateKey: 'private' })),
    update: vi.fn(async () => ({ ...publicIdentity, revision: 3, botToken: 'private' })), remove: vi.fn(async () => ({ removed: true })) };
  const worktrees = { create: vi.fn(async () => checkout), reconcile: vi.fn(async () => ({ state: 'succeeded', result: checkout })),
    resolveTransferSource: vi.fn(async () => worktree),
    inspect: vi.fn(async () => snapshot), remove: vi.fn(async () => ({ id: item.id })), bindPublication: vi.fn(async () => ({ publicationBranch: 'fix/item' })),
    readPublication: vi.fn(async () => null), adoptIsolated: vi.fn(async (input) => ({ headSha: input.resultSha })),
    acceptPublished: vi.fn(async (input) => ({ headSha: input.result.headSha })) };
  const stages = { create: vi.fn(async (request, created) => { await created({ sessionId: 'ses_new', directory: request.directory }); return { sessionId: 'ses_new', directory: request.directory }; }),
    dispatch: vi.fn(async (request) => ({ id: request.sessionId, sessionId: request.sessionId })),
    reconcile: vi.fn(async () => ({ state: 'outcome-unknown' })), outcome: vi.fn(async () => ({ state: 'completed', text: 'Done', errorMessage: '', tokens: 30 })) };
  const deps = { agentServer: true, dataDir: root, readSettings: vi.fn(async () => ({ projects: [project] })), identities, services: provider, worktrees, stages,
    context: { repository: vi.fn(async () => ({ target: binding.target, remote: 'origin', credential: 'private' })),
      github: vi.fn(async () => ({ binding, credential: { token: 'private' } })),
      serviceContext: vi.fn(async () => ({ github: { ...binding, token: 'private' }, secret: 'private' })) },
    activity: { fetchActiveSessionStatuses: vi.fn(async () => ({})), hasWorkingDescendants: vi.fn(async () => false) },
    clientFor: vi.fn(() => ({ session, message })), readTokens: vi.fn(async () => 123),
    readSessionDefaults: vi.fn(async () => ({ providerID: 'test', modelID: 'model' })),
    sessionKnowledgeRuntime: { sync: vi.fn(async () => undefined), collect: vi.fn() },
    proof: { run: vi.fn(async (input) => ({ status: 'passed', testSha: input.testSha, fixSha: input.fixSha, command: input.command,
      args: input.args, testExitCode: 1, fixExitCode: 0 })) },
    readPolicyFiles: vi.fn(async () => ({ directory: 'unreadable', files: [{ file: '.openchamber/people.json', status: 'missing' }] })),
    pullRequests: { botWatch: { getOctokit: vi.fn(async (authority) => ({ selected: authority.identityId })), authorizeApp: vi.fn(async () => true) },
      pullRequests: { read: vi.fn(async () => ({ headSha: HEAD, baseSha: BASE, merged: false, approved: true, mergeMode: 'queue' })) } },
    readAuthorPermission: vi.fn(async () => true), readFailedChecks: vi.fn(async () => []),
    updateMetadata: vi.fn(async () => undefined) };
  const execution = createBotExecutionServices(deps);
  const app = express();
  app.post('/auth/session', express.json(), (_req, res) => res.set('Set-Cookie', 'oc_ui_session=disposable; Max-Age=3600; Path=/').json({ ok: true }));
  app.use('/api', (req, res, next) => req.headers.cookie === 'oc_ui_session=disposable' ? next() : res.status(401).end());
  registerBotServiceRoutes(app, { services: execution });
  const server = http.createServer(app); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const upstream = createAgentUpstream({ url: origin, token: 'disposable' }); cleanups.push(() => upstream.close());
  const client = createAgentBotServices(upstream, { dataDir: root, resolveProject: async (id) => id === project.id ? project : null,
    listProjects: async () => [project], readItem: async (projectId, id) => projectId === project.id && id === item.id ? item : null,
    readBot: async () => bot });
  const send = async (operation, input, query = '') => {
    const response = await upstream.request({ path: `${BOT_SERVICE_ROUTE}/${operation}${query}`, method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    return { status: response.statusCode, body: JSON.parse(await readBoundedBody(response, 5 * 1024 * 1024)) };
  };
  return { ...deps, root, origin, project, bot, item, scope, binding, effect, push, checkout, snapshot, info,
    session, message, provider, execution, client, send, upstream };
}

test('private operations require authentication and explicitly separated agent composition', async () => {
  const f = await fixture();
  expect((await fetch(`${f.origin}${BOT_SERVICE_ROUTE}/identity-list`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
  expect(await f.client.identities.list()).toHaveLength(1);
  const publicReply = await f.upstream.request({ path: '/api/projects/project/bots/items', method: 'GET' });
  expect(publicReply.statusCode).toBe(403);
  expect(JSON.parse(await readBoundedBody(publicReply, 1024))).toEqual({ code: 'BOT_OWNER_REQUIRED' });
  expect(() => createBotExecutionServices({ ...f, agentServer: false })).toThrow(/separated/);
  expect(() => registerBotServiceRoutes(express(), { services: {} })).toThrow(/agent execution/);
});

test('Discord agent transport retains credentials, bounds frames, and repeats unacknowledged pages without reconnect timers', async () => {
  const f = await fixture(); const socket = new EventEmitter();
  socket.sent = []; socket.send = (value, done) => { socket.sent.push(JSON.parse(value)); done(); };
  socket.terminate = vi.fn(() => socket.emit('close', 1006));
  const credential = { authority: { providerAccountId: '123456' }, definition: { applicationId: '234567', botToken: 'disposable-fixture-token' },
    assertCurrent: vi.fn(async () => undefined), request: vi.fn(async () => ({ url: 'wss://gateway.discord.gg/', session_start_limit: { remaining: 1 } })) };
  const createSocket = vi.fn(() => socket);
  const transport = createBotAgentGatewayTransport({ identities: f.identities, resolveCredential: async () => credential, createSocket });
  cleanups.push(() => transport.stop());
  const scope = { ...f.scope, bot: { ...f.bot, identity: { discord: { identityId: 'discord' } } } };
  const input = { scope, connectionId: 'connection', identityId: 'discord', identityRevision: 2, cursor: null };
  expect(await transport.open(input)).toEqual({ connectionId: 'connection', botUserId: '123456', applicationId: '234567' });
  socket.emit('open');
  await transport.send({ scope, connectionId: input.connectionId, frame: { kind: 'identify' } });
  expect(socket.sent[0]).toMatchObject({ op: 2, d: { token: 'disposable-fixture-token', intents: 512 | 4096 } });
  socket.emit('message', Buffer.from(JSON.stringify({ op: 0, s: 1, t: 'READY', d: { session_id: 'session', resume_gateway_url: 'wss://gateway.discord.gg/',
    user: { id: '123456', bot: true }, application: { id: '234567' }, token: 'private-extra' } })));
  const page = await transport.pull({ scope, connectionId: input.connectionId, after: 0 });
  expect(JSON.stringify(page)).not.toMatch(/private-extra|disposable-fixture-token/);
  expect(await transport.pull({ scope, connectionId: input.connectionId, after: 0 })).toEqual(page);
  socket.emit('close', 1006);
  expect((await transport.pull({ scope, connectionId: input.connectionId, after: 1 })).frames).toEqual([]);
  expect(createSocket).toHaveBeenCalledOnce();
  expect(createSocket.mock.calls[0]).toEqual(['wss://gateway.discord.gg/?v=10&encoding=json', {
    followRedirects: false, maxPayload: 128 * 1024, handshakeTimeout: 15_000 }]);
  expect(() => transport.close({ scope: { ...scope, item: { ...scope.item, id: 'other' } }, connectionId: input.connectionId })).toThrow('BOT_DISCORD_GATEWAY_CHANGED');
  expect(BOT_SERVICE_OPERATIONS['gateway-send'].input.safeParse({ scope, connectionId: input.connectionId,
    frame: { kind: 'identify', token: 'forged' } }).success).toBe(false);
});

test('Discord protocol lifecycle and event admission stay on the owner', async () => {
  const f = await fixture(); const calls = []; let cursor = null; let pending = [];
  let delivered; const delivery = new Promise((resolve) => { delivered = resolve; });
  const eventStore = { read: async () => ({ cursor }), record: async (_scope, page) => {
    expect(page.expectedCursor).toEqual(cursor); cursor = page.cursor; pending.push(...page.events);
  }, drain: async (_scope, deliver) => { for (const event of pending.splice(0)) await deliver(event); } };
  let page = 0;
  const call = async (operation, input, { signal } = {}) => {
    calls.push({ operation, input });
    if (operation === 'gateway-open') return { connectionId: input.connectionId, botUserId: '123456', applicationId: '234567' };
    if (operation !== 'gateway-pull') return { ok: true };
    if (page++ === 0) return { connectionId: input.connectionId, state: 'open', closeCode: null, frames: [
      { id: 1, frame: { op: 10, d: { heartbeat_interval: 120_000 } } },
      { id: 2, frame: { op: 0, s: 1, t: 'READY', d: { session_id: 'ready', resume_gateway_url: 'wss://gateway.discord.gg/',
        user: { id: '123456', bot: true }, application: { id: '234567' } } } },
      { id: 3, frame: { op: 0, s: 2, t: 'MESSAGE_CREATE', d: { id: '345678', channel_id: '456789', guild_id: '567890',
        author: { id: '678901', bot: false }, content: 'Help', mentions: [{ id: '123456' }] } } },
    ] };
    return new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  const gateway = createOwnerBotGateway({ call, scope: f.scope, identityId: 'discord', identityRevision: 2,
    channels: [{ guildId: '567890', channelId: '456789' }], people: [], eventStore, random: () => 1,
    deliver: async (event) => { expect(cursor.sequence).toBe(2); delivered(event); }, onError: (error) => { throw error; } });
  await gateway.start();
  expect(await delivery).toMatchObject({ id: 'discord:345678', body: 'Help', identityId: 'discord', authorId: '678901' });
  await gateway.stop();
  expect(calls.some((entry) => entry.operation === 'gateway-send' && entry.input.frame.kind === 'identify')).toBe(true);
  expect(calls.some((entry) => entry.operation === 'gateway-close')).toBe(true);
  expect(JSON.stringify(calls)).not.toContain('token');
});

test('agent Gateway shutdown prevents a pending credential read from opening a later socket', async () => {
  const f = await fixture(); let release; const held = new Promise((resolve) => { release = resolve; });
  const createSocket = vi.fn();
  const transport = createBotAgentGatewayTransport({ identities: f.identities, createSocket,
    resolveCredential: async () => { await held; return { authority: { providerAccountId: '123456' },
      definition: { applicationId: '234567', botToken: 'fixture-only' },
      request: async () => ({ url: 'wss://gateway.discord.gg/', session_start_limit: { remaining: 1 } }) }; } });
  const opening = transport.open({ scope: { ...f.scope, bot: { ...f.bot, identity: { discord: { identityId: 'discord' } } } },
    connectionId: 'pending', identityId: 'discord', identityRevision: 1, cursor: null });
  transport.stop(); release();
  await expect(opening).rejects.toMatchObject({ code: 'BOT_EXECUTION_STOPPED' });
  expect(createSocket).not.toHaveBeenCalled();
});

test('public identity mutations preserve revision checks and reconstruct secret-free results', async () => {
  const f = await fixture();
  const definition = { kind: 'discord-app', label: 'Bot', applicationId: '123456', botToken: 'fixture-only' };
  expect(await f.client.identities.create(definition)).not.toHaveProperty('privateKey');
  expect(await f.client.identities.update('identity', 2, definition)).toMatchObject({ id: 'identity', revision: 3 });
  expect(f.identities.update).toHaveBeenCalledExactlyOnceWith('identity', 2, definition);
  expect(await f.client.identities.remove('identity', 2)).toEqual({ removed: true });
  f.identities.update.mockResolvedValue({ ...(await f.identities.list())[0], revision: 4 });
  await expect(f.client.identities.update('identity', 2, definition)).rejects.toMatchObject({ code: 'BOT_EXECUTION_UNRELATED_REPLY' });
});

test('registered project and service contexts never disclose the credential owner', async () => {
  const f = await fixture();
  expect(await f.client.context.repository(f.project)).toEqual({ target: f.binding.target, remote: 'origin' });
  expect(await f.client.context.github({ project: f.project, bot: f.bot })).toEqual({ binding: f.binding });
  expect(await f.client.context.serviceContext({ project: f.project, bot: f.bot, item: f.item, service: 'github', operation: 'github.checkout' })).toEqual({ github: f.binding });
  const child = path.join(f.project.path, 'child'); await fs.mkdir(child);
  const refused = await f.send('repository', { project: { ...f.project, path: child } });
  expect(refused).toMatchObject({ status: 403, body: { code: 'agent_project_unregistered' } });
  expect(f.context.repository).toHaveBeenCalledTimes(3);
});

test('checkout and session requests resolve the captured create key and reject unrelated directories', async () => {
  const f = await fixture();
  expect(await f.client.worktrees.inspect({ project: f.project, bot: f.bot, item: f.item })).toEqual(f.snapshot);
  expect(f.worktrees.resolveTransferSource.mock.calls[0][0]).toEqual({ kind: 'bot-checkout', projectDirectory: f.project.path,
    projectId: f.project.id, botId: f.bot.id, itemId: f.item.id, checkoutKey: 'item:worktree' });
  await expect(f.client.worktrees.inspect({ project: f.project, bot: f.bot, item: { ...f.item, worktree: f.project.path } }))
    .rejects.toMatchObject({ code: 'BOT_EXECUTION_CHECKOUT_MISMATCH' });
  const session = await f.client.hostSessions.readSession({ projectId: f.project.id, itemId: f.item.id, botId: f.bot.id,
    directory: f.item.worktree, stage: 'fixing', sessionId: 'ses_fix' });
  expect(session).toMatchObject({ id: 'ses_fix', directory: f.item.worktree, isolated: false });
  f.info.metadata.openchamber.automation.itemId = 'another';
  await expect(f.client.readSession({ project: f.project, bot: f.bot, item: f.item, sessionId: 'ses_fix' }))
    .rejects.toMatchObject({ code: 'BOT_EXECUTION_SESSION_MISMATCH' });
});

test('host activity checks descendants and unfinished tails; unreadable activity remains unknown', async () => {
  const f = await fixture();
  const entry = { projectId: f.project.id, itemId: f.item.id, botId: f.bot.id, directory: f.item.worktree, stage: 'fixing', sessionId: 'ses_fix' };
  expect(await f.client.hostSessions.isWorking(entry)).toBe(false);
  f.activity.hasWorkingDescendants.mockResolvedValue(true);
  expect(await f.client.hostSessions.isWorking(entry)).toBe(true);
  f.activity.hasWorkingDescendants.mockResolvedValue(false);
  f.message.list.mockResolvedValue({ data: [{ type: 'assistant', time: { created: 1 } }] });
  expect(await f.client.hostSessions.isWorking(entry)).toBe(true);
  f.activity.fetchActiveSessionStatuses.mockResolvedValue(null);
  expect(await f.client.hostSessions.isWorking(entry)).toBe(null);
  expect(await f.client.hostSessions.readTokens(entry, { since: 12 })).toBe(123);
  expect(f.readTokens).toHaveBeenCalledWith('ses_fix', f.item.worktree, { since: 12 });
});

test('raw policy preserves explicit missing and unreadable states without agent approval authority', async () => {
  const f = await fixture();
  expect(await f.client.readPolicyFiles(f.project, { files: ['.agents/areas/api.md'] })).toEqual({ directory: 'unreadable',
    files: [{ file: '.openchamber/people.json', status: 'missing' }] });
  expect(f.readPolicyFiles).toHaveBeenCalledWith(f.project.path, { files: ['.agents/areas/api.md'] });
  expect((await f.send('policy-files', { project: f.project, files: ['../../secret'] })).status).toBe(400);
});

test('service execution preflights before local revalidation and durable dispatch; callbacks never serialize', async () => {
  const f = await fixture(); const order = [];
  f.provider.preflight.mockImplementation(async () => { order.push('preflight'); });
  f.provider.execute.mockImplementation(async (...args) => { order.push('execute'); expect(args).toHaveLength(2);
    return { status: 'succeeded', operation: 'git.push', authority: f.effect.authority, target: f.effect.target,
      result: { headSha: HEAD, sourceHeadSha: HEAD }, replayed: false }; });
  const result = await f.client.services.execute(f.effect, f.push, {
    beforeAdmission: async () => { order.push('owner revalidation'); },
    beforeDispatch: async () => { order.push('claim dispatch'); f.push.headSha = BASE; },
  });
  expect(order).toEqual(['preflight', 'owner revalidation', 'claim dispatch', 'execute']);
  expect(f.provider.execute.mock.calls[0][1].headSha).toBe(HEAD);
  expect(result.result.sourceHeadSha).toBe(HEAD);
});

test('failed preflight or owner admission performs no provider write and preserves the descriptor', async () => {
  const f = await fixture(); const dispatch = vi.fn();
  f.provider.preflight.mockRejectedValue(Object.assign(new Error('private upstream body'), { code: 'BOT_IDENTITY_CHANGED', status: 409 }));
  await expect(f.client.services.execute(f.effect, f.push, { beforeDispatch: dispatch })).rejects.toMatchObject({ code: 'BOT_IDENTITY_CHANGED' });
  expect(dispatch).not.toHaveBeenCalled(); expect(f.provider.execute).not.toHaveBeenCalled();
  f.provider.preflight.mockResolvedValue(undefined);
  await expect(f.client.services.execute(f.effect, f.push, { beforeAdmission: async () => { throw new Error('owner refused'); }, beforeDispatch: dispatch })).rejects.toThrow('owner refused');
  expect(dispatch).not.toHaveBeenCalled(); expect(f.provider.execute).not.toHaveBeenCalled();
});

test('provider reads are enumerated, selected-identity scoped and reconstruct replies', async () => {
  const f = await fixture();
  const request = { ...f.binding, operation: 'github.branch', input: { branch: 'main' }, scope: f.scope };
  f.provider.read.mockResolvedValue({ headSha: HEAD, accessToken: 'private', request: 'forged' });
  expect(await f.client.services.read(request)).toEqual({ headSha: HEAD });
  expect(f.provider.read.mock.calls[0][0]).not.toHaveProperty('scope');
  await expect(f.client.services.read({ ...request, identityId: 'other' })).rejects.toMatchObject({ code: 'BOT_IDENTITY_CHANGED' });
  await expect(f.client.services.read({ ...request, operation: 'github.request', input: { path: '/user' } }))
    .rejects.toMatchObject({ code: 'BOT_EXECUTION_INVALID_REQUEST' });
  expect(Object.keys(BOT_PROVIDER_READS)).toContain('jira.search');
});

test('PR feedback helpers retain the selected Bot handle without requiring an unrelated PR number for failed checks', async () => {
  const f = await fixture();
  const authority = { project: f.project, botId: f.bot.id, itemId: f.item.id, ...f.binding };
  const octokit = await f.client.pullRequests.getOctokit(authority);
  expect(octokit).toEqual({ botAuthority: authority }); expect(octokit).not.toHaveProperty('graphql');
  expect(await f.client.readAuthorPermission({ octokit, owner: 'org', repo: 'repo', username: 'maintainer' })).toBe(true);
  expect(await f.client.readFailedChecks({ octokit, owner: 'org', repo: 'repo', contexts: [] })).toEqual([]);
  expect(f.readFailedChecks.mock.calls[0][0]).toMatchObject({ octokit: { selected: 'identity' }, owner: 'org', repo: 'repo', contexts: [] });
  await expect(f.client.readFailedChecks({ octokit, owner: 'other', repo: 'repo', contexts: [] })).rejects.toThrow('BOT_GITHUB_PULL_CHANGED');
  f.item.pr = { number: 1, url: 'https://github.com/org/repo/pull/1', headSha: HEAD };
  f.provider.read.mockResolvedValue({ number: 1, headSha: HEAD, head: 'bot/item', base: 'main', state: 'open' });
  expect(await f.client.pullRequests.readStatus({ project: f.project, bot: f.bot, item: f.item, authority })).toMatchObject({ open: true, status: { headSha: HEAD } });
  f.context.github.mockResolvedValue({ binding: f.binding, credential: { request: async ({ path: requestPath }) => requestPath.startsWith('/apps/')
    ? { id: 777, slug: 'review' } : { id: 888, login: 'review[bot]', type: 'Bot' } } });
  expect(await f.client.pullRequests.authorizeApp(authority, { login: 'review[bot]', bot: true }, { slug: 'review', appId: 777 })).toBe(true);
});

test('removing the checkout reply ownership guard admits the substituted path in a disposable module copy', async () => {
  const f = await fixture();
  const input = { scope: { ...f.scope, item: { ...f.item, worktree: f.project.path } } };
  await expect(f.execution.execute('worktree-inspect', input)).rejects.toMatchObject({ code: 'BOT_EXECUTION_CHECKOUT_MISMATCH' });
  const original = new URL('../bots/agent-execution.js', import.meta.url);
  const source = await fs.readFile(original, 'utf8');
  const guard = 'scope.item.worktree && directory !== scope.item.worktree';
  expect(source.split(guard)).toHaveLength(2);
  const mutated = source.replace(guard, 'false').replace(/from '([^']+)'/g, (_match, specifier) => {
    const resolved = specifier.startsWith('.') ? new URL(specifier, original).href
      : specifier.startsWith('node:') ? specifier : import.meta.resolve(specifier);
    return `from '${resolved}'`;
  });
  const copy = path.join(f.root, 'ownership-mutation.mjs'); await fs.writeFile(copy, mutated);
  const { createBotExecutionServices: createMutated } = await import(pathToFileURL(copy).href);
  const changed = createMutated(f);
  expect(await changed.execute('worktree-inspect', input)).toEqual(f.snapshot);
  await changed.stop();
  await expect(f.execution.execute('worktree-inspect', input)).rejects.toMatchObject({ code: 'BOT_EXECUTION_CHECKOUT_MISMATCH' });
});

test('owner rejects substituted reply associations and exact-head receipts', async () => {
  const f = await fixture();
  const upstream = { request: vi.fn(async (request) => {
    const operation = request.path.split('/').at(-1); const input = JSON.parse(request.body);
    return responseOf({ association: { ...botRequestAssociation(operation, input), digest: 'f'.repeat(64) }, result: [] });
  }) };
  const client = createAgentBotServices(upstream, { listProjects: async () => [f.project], resolveProject: async () => f.project });
  await expect(client.identities.list()).rejects.toMatchObject({ code: 'BOT_EXECUTION_INVALID_RESPONSE' });
  f.provider.execute.mockResolvedValue({ status: 'succeeded', operation: 'git.push', authority: f.effect.authority,
    target: f.effect.target, result: { headSha: BASE, sourceHeadSha: BASE }, replayed: false });
  await expect(f.client.services.execute(f.effect, f.push)).rejects.toMatchObject({ code: 'BOT_EXECUTION_UNRELATED_REPLY' });
});

test('stage allocations persist before configuration and replay without allocating another session', async () => {
  const f = await fixture();
  const request = { projectId: f.project.id, itemId: f.item.id, bot: f.bot, stage: 'fixing', directory: f.item.worktree,
    selection: { providerID: 'test', modelID: 'model' }, prompt: 'Fix', dispatchedAt: 1, afterIdleId: null };
  const created = vi.fn(async () => undefined);
  expect(await f.client.stages.create(request, created)).toEqual({ sessionId: 'ses_new', directory: f.item.worktree });
  expect(await f.client.stages.create(request, created)).toEqual({ sessionId: 'ses_new', directory: f.item.worktree });
  expect(f.stages.create).toHaveBeenCalledOnce(); expect(created).toHaveBeenCalledTimes(2);
  await expect(f.client.stages.create({ ...request, prompt: 'Changed' }, created)).rejects.toMatchObject({ code: 'BOT_EXECUTION_STAGE_CHANGED' });
});

test('legacy captured allocation reconciles into execution ownership before its first prompt', async () => {
  const f = await fixture();
  const request = { projectId: f.project.id, itemId: f.item.id, bot: f.bot, stage: 'fixing', directory: f.item.worktree,
    selection: { providerID: 'test', modelID: 'model' }, prompt: 'Recovered', dispatchedAt: 2, afterIdleId: null };
  expect(await f.client.stages.reconcile('session.create', request, 'ses_fix')).toMatchObject({ state: 'succeeded', result: { sessionId: 'ses_fix' } });
  expect(await f.client.stages.dispatch({ ...request, sessionId: 'ses_fix' })).toEqual({ id: 'ses_fix', sessionId: 'ses_fix' });
  expect(f.stages.create).not.toHaveBeenCalled(); expect(f.stages.dispatch).toHaveBeenCalledOnce();
});

test('failed stage outcomes cross the agent boundary without fabricated token usage', async () => {
  const f = await fixture();
  const request = { projectId: f.project.id, itemId: f.item.id, bot: f.bot, stage: 'fixing', directory: f.item.worktree,
    selection: { providerID: 'test', modelID: 'model' }, prompt: 'Recovered', dispatchedAt: 2, afterIdleId: null };
  await f.client.stages.reconcile('session.create', request, 'ses_fix');
  const failed = { state: 'error', text: '', errorMessage: 'Provider limit reached' };
  f.stages.outcome.mockResolvedValue(failed);
  expect(await f.client.stages.outcome({ ...request, sessionId: 'ses_fix' })).toEqual(failed);
  const reply = BOT_SERVICE_OPERATIONS['stage-outcome'].reply;
  expect(reply.safeParse({ state: 'completed', text: 'Done' }).success).toBe(false);
  expect(reply.safeParse({ state: 'completed', text: 'Done', tokens: 7 }).success).toBe(true);
});

test('proof uses the captured Bot command and propagates HTTP cancellation into the runner', async () => {
  const f = await fixture();
  const input = { project: f.project, bot: f.bot, item: f.item, directory: f.item.worktree,
    testSha: BASE, fixSha: HEAD, command: 'node', args: ['test.js'] };
  expect(await f.client.runProof(input)).toMatchObject({ status: 'passed', testSha: BASE, fixSha: HEAD });
  await expect(f.client.runProof({ ...input, command: 'sh' })).rejects.toMatchObject({ code: 'BOT_EXECUTION_PROOF_MISMATCH' });
  let started; const ready = new Promise((resolve) => { started = resolve; });
  let stopped; const aborted = new Promise((resolve) => { stopped = resolve; });
  f.proof.run.mockImplementation(async (_input, { signal }) => { started(); await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    stopped(); return { status: 'inconclusive', testSha: BASE, fixSha: HEAD, command: 'node', args: ['test.js'], testExitCode: null, fixExitCode: null }; });
  const controller = new AbortController(); const running = f.client.runProof(input, { signal: controller.signal });
  await ready; controller.abort();
  expect(await running).toMatchObject({ status: 'inconclusive', reason: 'Proof was interrupted.' });
  await aborted;
});

test('host tool inbox wakes through metadata and the owner pulls and settles the exact call', async () => {
  const f = await fixture();
  const entry = { projectId: f.project.id, botId: f.bot.id, itemId: f.item.id, directory: f.item.worktree, stage: 'fixing', sessionId: 'ses_fix' };
  let wake; const pending = new Promise((resolve) => { wake = resolve; }); f.updateMetadata.mockImplementation(async () => wake());
  const running = f.execution.handleTool({ sessionId: 'ses_fix', callId: 'call-1', action: 'pr.comment', input: { operationId: 'once', body: 'Fixed' } });
  await pending;
  const page = await f.client.hostSessions.pullTools(entry);
  expect(page.requests).toHaveLength(1);
  expect(await f.client.hostSessions.settleTool(entry, { ...page.requests[0], reply: { ok: true, result: { receipt: { id: 'receipt' } } } })).toEqual({ settled: true });
  expect(await running).toEqual({ receipt: { id: 'receipt' } });
  expect(await f.client.hostSessions.pullTools(entry)).toEqual({ requests: [] });
});

test('synthetic delivery is bounded to the exact Bot session and deterministic notice ID', async () => {
  const f = await fixture();
  const notice = { source: 'openchamber-notice', kind: 'bot', projectId: f.project.id, itemId: f.item.id, eventId: 'event' };
  const id = botNoticeIds(notice).messageId;
  const entry = { projectId: f.project.id, botId: f.bot.id, itemId: f.item.id, directory: f.item.worktree, stage: 'fixing', sessionId: 'ses_fix', notice, id, text: 'Feedback' };
  expect(await f.client.hostSessions.deliverNotice(entry)).toEqual({ messageId: id, sessionId: 'ses_fix' });
  expect(f.session.synthetic.mock.calls[0][0]).toMatchObject({ id, sessionID: 'ses_fix', metadata: notice, delivery: 'steer', resume: true });
  await expect(f.client.hostSessions.deliverNotice({ ...entry, id: 'msg_12345678901234567890123456' })).rejects.toMatchObject({ code: 'BOT_NOTICE_TARGET_CHANGED' });
  expect(f.session.synthetic).toHaveBeenCalledOnce();
});

test('strict private requests reject generic path, URL, argv, callbacks and query authority', async () => {
  const f = await fixture();
  const input = { scope: f.scope };
  expect((await f.send('worktree-inspect', input)).status).toBe(200);
  for (const extra of [{ path: '/etc/passwd' }, { url: 'http://owner' }, { argv: ['sh'] }, { beforeDispatch: 'callback' }]) {
    expect((await f.send('worktree-inspect', { ...input, ...extra })).status).toBe(400);
  }
  expect((await f.send('worktree-inspect', input, '?directory=/other')).status).toBe(400);
  expect((await f.send('http', { path: '/user' })).status).toBe(400);
  expect(Object.keys(BOT_SERVICE_OPERATIONS)).not.toContain('request');
});

test('all identity operations require a registered project ID as well as its canonical path', async () => {
  const f = await fixture();
  const valid = await f.send('identity-list', { project: f.project }); expect(valid.status).toBe(200);
  const before = f.identities.list.mock.calls.length;
  expect((await f.send('identity-list', {})).status).toBe(400);
  expect((await f.send('identity-list', { project: { ...f.project, id: 'unregistered-id' } })).status).toBe(403);
  expect((await f.send('defaults', { project: { ...f.project, id: 'unregistered-id' } })).status).toBe(403);
  expect((await f.send('worktree-inspect', { scope: { ...f.scope, project: { ...f.project, id: 'unregistered-id' } } })).status).toBe(403);
  expect(f.identities.list).toHaveBeenCalledTimes(before); expect(f.readSessionDefaults).not.toHaveBeenCalled();
});

test('owner migration authority comes from its local copy and travels outside every immutable descriptor and watch authority', async () => {
  const f = await fixture();
  const ownerData = path.join(f.root, 'owner'); await fs.mkdir(path.join(ownerData, 'bots'), { recursive: true });
  const migration = { projectId: f.project.id, itemId: f.item.id, directory: f.item.worktree,
    directoryIdentity: '1:2', gitDirectory: path.join(f.root, 'retained-git'), gitIdentity: '3:4' };
  await fs.writeFile(path.join(ownerData, 'bots/migration-paths.json'), JSON.stringify({ version: 1, entries: [migration] }));
  await fs.mkdir(path.join(f.root, 'bot-worktrees'), { recursive: true });
  await fs.writeFile(path.join(f.root, 'bot-worktrees/migration-paths.json'), JSON.stringify({ version: 1, entries: [{ ...migration, directory: '/forged' }] }));
  f.client.bindOwner({ dataDir: ownerData, listProjects: async () => [f.project], resolveProject: async () => f.project,
    store: { read: async () => ({ items: [f.item] }) }, config: { read: async () => ({ definitions: [f.bot] }) } });
  const send = vi.spyOn(f.upstream, 'request');
  await f.client.worktrees.inspect({ project: f.project, bot: f.bot, item: f.item });
  expect(f.worktrees.resolveTransferSource.mock.calls.at(-1)[1]).toEqual({ trustedMigrationPath: migration });
  await f.client.worktrees.adoptIsolated({ project: f.project, bot: { ...f.bot, isolated: true }, item: f.item, resultSha: HEAD, spaceId: 'abcdef123456' });
  expect(f.worktrees.adoptIsolated.mock.calls.at(-1)[0]).toMatchObject({ trustedMigrationPath: migration, spaceId: 'abcdef123456', item: { worktree: migration.directory } });
  await f.client.worktrees.readPublication({ repositoryId: 'repository', botId: f.bot.id, itemId: f.item.id });
  expect(f.worktrees.readPublication.mock.calls.at(-1)[0]).toEqual({ repositoryId: 'repository', botId: f.bot.id, itemId: f.item.id, trustedMigrationPath: migration });
  const effect = structuredClone(f.effect); const authority = { project: f.project, botId: f.bot.id, itemId: f.item.id, ...f.binding };
  await f.client.services.execute(effect, f.push);
  const serviceRequest = JSON.parse(send.mock.calls.find(([request]) => request.path.endsWith('/service-execute'))[0].body);
  expect(serviceRequest.scope.trustedMigrationPath).toEqual(migration); expect(serviceRequest.effect).toEqual(f.effect); expect(effect).toEqual(f.effect);
  const octokit = await f.client.botWatch.getOctokit(authority);
  await f.client.readAuthorPermission({ octokit, username: 'maintainer' });
  const watchRequest = JSON.parse(send.mock.calls.find(([request]) => request.path.endsWith('/pull-author-permission'))[0].body);
  expect(watchRequest.authority).toEqual(authority); expect(watchRequest.trustedMigrationPath).toEqual(migration);
  expect(octokit).toEqual({ botAuthority: authority });
  const run = { projectId: f.project.id, itemId: f.item.id, bot: f.bot, stage: 'fixing', directory: migration.directory,
    selection: { providerID: 'test', modelID: 'model' }, prompt: 'Original captured prompt', dispatchedAt: 77, afterIdleId: null };
  await f.client.stages.create(run, async () => undefined);
  expect(f.stages.create.mock.calls.at(-1)[0]).toEqual(run);
  const source = { kind: 'bot-checkout', projectDirectory: f.project.path, projectId: f.project.id, botId: f.bot.id, itemId: f.item.id, checkoutKey: 'item:worktree' };
  expect(await f.execution.worktrees.resolveTransferSource(source, { trustedMigrationPath: migration })).toBe(migration.directory);
  expect(f.worktrees.resolveTransferSource.mock.calls.at(-1)).toEqual([source, { trustedMigrationPath: migration }]);
  await expect(f.client.worktrees.inspect({ scope: { ...f.scope, trustedMigrationPath: { ...migration, gitIdentity: '9:9' } } }))
    .rejects.toMatchObject({ code: 'BOT_MIGRATION_PATH_AUTHORITY_MISMATCH' });
});

test('concurrent publication callbacks retain their own immutable migration mappings', async () => {
  const f = await fixture(); const second = { ...f.item, id: 'other', worktree: path.join(f.root, 'other-checkout'), branch: 'bot/other' };
  const migration = (item, index) => ({ projectId: f.project.id, itemId: item.id, directory: item.worktree,
    directoryIdentity: `${index}:2`, gitDirectory: path.join(f.root, `git-${index}`), gitIdentity: `${index}:4` });
  const firstPath = migration(f.item, 1); const secondPath = migration(second, 2);
  let release; const held = new Promise((resolve) => { release = resolve; }); const callbacks = [];
  const createServices = vi.fn(({ resolvePublication, ...options }) => {
    expect(options.dataDir).toBe(f.root); expect(options.ownerAuthorityChecked).toBe(true);
    return { ...f.provider, preflight: async (effect) => {
      callbacks.push(effect.itemId); if (effect.itemId === f.item.id) await held;
      await resolvePublication({ repositoryId: 'repository', botId: f.bot.id, itemId: effect.itemId });
    } };
  });
  const execution = createBotExecutionServices({ ...f, services: null, createServices });
  const operation = 'pr.comment'; const input = { number: 1, headSha: HEAD, body: 'Fixed' };
  const requestFor = (item, trustedMigrationPath) => {
    const effect = { ...f.effect, operation, key: `${item.id}:comment`, itemId: item.id };
    effect.inputDigest = botEffectInputDigest(effect, input);
    return { scope: { ...f.scope, item, checkoutKey: `${item.id}:worktree`, trustedMigrationPath }, effect, operation, input };
  };
  const first = execution.execute('service-preflight', requestFor(f.item, firstPath));
  await execution.execute('service-preflight', requestFor(second, secondPath)); release(); await first;
  expect(new Set(callbacks)).toEqual(new Set([f.item.id, second.id]));
  expect(f.worktrees.readPublication.mock.calls.map(([query]) => [query.itemId, query.trustedMigrationPath]))
    .toEqual([[second.id, secondPath], [f.item.id, firstPath]]);
  const identities = createServices.mock.calls.map(([options]) => options.runtimeIdentity);
  expect(identities.every((identity) => identity === identities[0])).toBe(true);
  await execution.stop();
});

test('watch publication validation captures migration authority without changing BotAuthority', async () => {
  const f = await fixture();
  const trustedMigrationPath = { projectId: f.project.id, itemId: f.item.id, directory: f.item.worktree,
    directoryIdentity: '1:2', gitDirectory: path.join(f.root, 'retained-git'), gitIdentity: '3:4' };
  const authority = { project: f.project, botId: f.bot.id, itemId: f.item.id, ...f.binding, publicationBranch: 'fix/item' };
  const createPullRequests = ({ resolvePublication }) => ({ botWatch: { getOctokit: async (captured) => {
    expect(captured).toEqual(authority);
    await resolvePublication({ repositoryId: captured.target.repositoryId, botId: captured.botId, itemId: captured.itemId });
    return { selected: captured.identityId };
  } } });
  const execution = createBotExecutionServices({ ...f, pullRequests: null, createPullRequests });
  await execution.execute('pull-author-permission', { authority, trustedMigrationPath, expectedDirectory: f.item.worktree, username: 'maintainer' });
  expect(f.worktrees.readPublication).toHaveBeenCalledExactlyOnceWith({ repositoryId: 'repository', botId: f.bot.id,
    itemId: f.item.id, trustedMigrationPath });
  expect(authority).not.toHaveProperty('trustedMigrationPath');
  await execution.stop();
});

test('owner verifies the prepared input digest before preflight and callbacks', async () => {
  const f = await fixture(); const callback = vi.fn();
  await expect(f.client.services.execute({ ...f.effect, inputDigest: 'f'.repeat(64) }, f.push,
    { beforeAdmission: callback, beforeDispatch: callback })).rejects.toMatchObject({ code: 'BOT_EFFECT_CHANGED' });
  expect(f.provider.preflight).not.toHaveBeenCalled(); expect(callback).not.toHaveBeenCalled();
  f.provider.prepare.mockResolvedValue({ ...f.effect, inputDigest: 'f'.repeat(64) });
  await expect(f.client.services.prepare({ key: f.effect.key, botId: f.bot.id, itemId: f.item.id, operation: f.effect.operation,
    ...f.binding, input: f.push })).rejects.toMatchObject({ code: 'BOT_EFFECT_CHANGED' });
});

test('reconciliation keeps the descriptor identity after the Bot selection changes', async () => {
  const f = await fixture();
  f.bot.identity.github = { kind: 'app', identityId: 'new-default' };
  const descriptor = structuredClone(f.effect);
  expect(await f.client.services.reconcile(descriptor, f.push)).toEqual({ state: 'outcome-unknown' });
  expect(f.provider.reconcile).toHaveBeenCalledExactlyOnceWith(descriptor, f.push);
  expect(descriptor).toEqual(f.effect);
});

test('account context captures exact selected account revision and rejects unrelated service or target replies', async () => {
  const f = await fixture();
  const account = { id: 'identity', revision: 2, label: 'Selected', kind: 'github-account', configured: true, accountId: 'account', credentialRevision: 7 };
  f.bot.identity.github = { kind: 'account', accountId: 'account' }; f.identities.list.mockResolvedValue([account]);
  expect(await f.client.context.github({ project: f.project, bot: f.bot })).toEqual({ binding: f.binding });
  expect(await f.client.context.serviceContext({ project: f.project, bot: f.bot, item: f.item, service: 'github', operation: 'github.checkout' }))
    .toEqual({ github: f.binding });
  const realRequest = f.upstream.request;
  let replacement;
  vi.spyOn(f.upstream, 'request').mockImplementation(async (request) => {
    if (!request.path.endsWith('/context')) return realRequest(request);
    const input = JSON.parse(request.body);
    return responseOf({ association: botRequestAssociation('context', BOT_SERVICE_OPERATIONS.context.input.parse(input)), result: replacement });
  });
  for (const result of [
    { github: { ...f.binding, accountId: 'account', credentialRevision: 8 } },
    { github: { ...f.binding, accountId: 'account', credentialRevision: 7, target: { ...f.binding.target, repo: 'other' } } },
    { github: { ...f.binding, accountId: 'account', credentialRevision: 7 }, discord: { identityId: 'identity', identityRevision: 2, target: { guildId: '123456', channelId: '234567' } } },
  ]) {
    replacement = result;
    await expect(f.client.context.serviceContext({ project: f.project, bot: f.bot, item: f.item, service: 'github', operation: 'github.checkout' }))
      .rejects.toMatchObject({ code: 'BOT_EXECUTION_UNRELATED_REPLY' });
  }
});

test('agent shutdown cancels running proof and waits for its cleanup before resolving', async () => {
  const f = await fixture(); let started; const ready = new Promise((resolve) => { started = resolve; });
  let release; const cleanup = new Promise((resolve) => { release = resolve; }); let canceled;
  const interrupted = new Promise((resolve) => { canceled = resolve; });
  f.proof.run.mockImplementation(async (input, { signal }) => {
    started(); await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })); canceled(); await cleanup;
    return { status: 'inconclusive', testSha: input.testSha, fixSha: input.fixSha, command: input.command, args: input.args,
      testExitCode: null, fixExitCode: null, reason: 'Proof was interrupted.' };
  });
  const running = f.execution.execute('proof', { scope: f.scope, testSha: BASE, fixSha: HEAD }); await ready;
  let stopped = false; const stop = f.execution.stop().then(() => { stopped = true; });
  await interrupted; expect(stopped).toBe(false);
  await expect(f.execution.execute('tokens', { scope: f.scope, sessionId: 'ses_fix' })).rejects.toMatchObject({ code: 'BOT_EXECUTION_STOPPED' });
  release(); await stop; expect(await running).toMatchObject({ status: 'inconclusive' }); expect(stopped).toBe(true);
});

test('agent shutdown reports a bounded cleanup timeout while retaining the active proof promise', async () => {
  const f = await fixture(); let started; const ready = new Promise((resolve) => { started = resolve; });
  let release; const cleanup = new Promise((resolve) => { release = resolve; });
  f.proof.run.mockImplementation(async (input, { signal }) => {
    started(); await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })); await cleanup;
    return { status: 'inconclusive', testSha: input.testSha, fixSha: input.fixSha, command: input.command,
      args: input.args, testExitCode: null, fixExitCode: null };
  });
  const execution = createBotExecutionServices({ ...f, proofCleanupTimeoutMs: 10 });
  const running = execution.execute('proof', { scope: f.scope, testSha: BASE, fixSha: HEAD }); await ready;
  try { await expect(execution.stop()).rejects.toMatchObject({ code: 'BOT_PROOF_CLEANUP_TIMEOUT' }); }
  finally { release(); await running; }
});

test('actual local service descriptors and receipts round-trip through the typed wire', async () => {
  const f = await fixture(); const definition = { kind: 'discord-app', label: 'Fixture', applicationId: '234567', botToken: 'fixture-only' };
  const identities = { resolve: async () => ({ id: 'discord', revision: 1, definition }) };
  const fetchImpl = async (url) => new Response(JSON.stringify(String(url).endsWith('/oauth2/applications/@me')
    ? { id: '234567', bot: { id: '123456', bot: true } }
    : String(url).endsWith('/messages') ? { id: '345678', channel_id: '456789' }
      : { id: '456789', guild_id: '567890', type: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
  const services = createBotServices({ dataDir: path.join(f.root, 'native'), identities, fetchImpl, ownerAuthorityChecked: true });
  const request = { key: 'item:discord', operation: 'discord.send', botId: f.bot.id, itemId: f.item.id, identityId: 'discord', identityRevision: 1,
    target: { guildId: '567890', channelId: '456789' }, input: { body: 'Fixture message' } };
  const descriptor = await services.prepare(request);
  expect(descriptor.inputDigest).toBe(botEffectInputDigest(descriptor, request.input));
  expect(BOT_SERVICE_OPERATIONS['service-prepare'].reply.parse(descriptor)).toEqual(descriptor);
  const receipt = await services.execute(descriptor, request.input);
  expect(BOT_SERVICE_OPERATIONS['service-execute'].reply.parse(receipt)).toEqual(receipt);
  const github = createBotServices({ dataDir: path.join(f.root, 'native-github'), ownerAuthorityChecked: true,
    identities: { resolve: async () => ({ id: 'github', revision: 2,
      definition: { kind: 'github-account', accountId: 'account', credentialRevision: 7, label: 'Fixture' } }),
    readGitHubAccount: async () => ({ credentialId: 'account', credentialRevision: 7, status: 'valid', accessToken: 'fixture-only', providerUserId: 'github.com#123' }) },
    fetchImpl: async () => new Response(JSON.stringify({ id: 123, login: 'fixture' }), { headers: { 'content-type': 'application/json' } }) });
  const opening = { key: 'item:pr', operation: 'pr.open', botId: f.bot.id, itemId: f.item.id, identityId: 'github', identityRevision: 2,
    target: f.binding.target, input: { branch: 'bot/item', base: 'main', headSha: HEAD, title: 'Fixture', body: 'Fixture pull request' } };
  const prepared = await github.prepare(opening);
  expect(prepared.inputDigest).toBe(botEffectInputDigest(prepared, opening.input));
  expect(BOT_SERVICE_OPERATIONS['service-prepare'].reply.parse(prepared)).toEqual(prepared);
});

test('actual Bot tool item replies preserve allowed long descriptions without a generic JSON fallback', () => {
  const item = createBotItem({ id: 'item', botId: 'bot', source: { kind: 'manual', id: 'manual' }, title: 'Item', description: 'x'.repeat(10_000), now: 1 });
  expect(botToolReplySchema.parse({ ok: true, result: { item } })).toEqual({ ok: true, result: { item } });
  expect(botToolReplySchema.safeParse({ ok: true, result: { arbitraryProviderPayload: { token: 'fixture' } } }).success).toBe(false);
});
