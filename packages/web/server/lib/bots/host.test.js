import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import express from 'express';
import request from 'supertest';
import { createHostFixture } from './host-test-support.js';
import { createBotChildServer } from './host.js';
import { createBotStore } from './store.js';
import { createBotItem } from './schema.js';
import { digestMutationInput } from '../source-control/mutation-executor.js';
import { translateWireEvent } from '../event-stream/translate-v2.js';
import { createBotExecutionStore } from './execution-store.js';
import { createProductionBotWorktrees } from './production-worktrees.js';
import { createBotIsolatedStages } from './isolated-stages.js';
import { botGit } from './production-git.js';
import { resolveRepositoryIdentity } from '../source-control/repository-identity.js';
import { botDefinitionSchema } from './config.js';
import { readBotSpaceOptions } from './space-options.js';

const definition = { id: 'bugs', name: 'Bug bot', mission: 'Fix verified bugs.' };
const fixtures = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
const fixture = async (options) => { const value = await createHostFixture(options); fixtures.push(value); return value; };

// Spaces calls use controlled peers. Host composition, durable effects,
// binding ownership and checkout removal use their production implementations.
const isolatedLifecycle = async () => {
  let removed = false; let stopped = false; let granted = true;
  const calls = []; const sessions = new Map();
  const spaces = { journey: {
    createBotSpace: async (_request, options) => { calls.push('create'); await options.onAllocated({ id: 'abcdef123456', directory: '/spaces/abcdef123456/worktree' }); },
    listSpaces: async () => removed ? [] : [{ id: 'abcdef123456', state: stopped ? 'exited' : 'running', access: granted ? 'granted' : 'needs_access', grants: [{ provider: 'controlled' }], damaged: false }],
    stopSpace: async () => { calls.push('stop'); if (removed) throw Object.assign(new Error('Removed'), { code: 'space_not_found' }); stopped = true; granted = false; },
    startSpace: async (id) => { calls.push(['start', id]); stopped = false; return { networkRestored: true }; },
    grantAccess: async (id, grant) => { calls.push(['grant', id, grant]); granted = true; },
    removeSpace: async () => { calls.push('remove'); removed = true; return { removed: true, failures: [] }; },
  }, manager: { verify: async () => [], listAllSpaces: async () => ({ spaces: await spaces.journey.listSpaces(), unavailable: [] }) },
  dispatcher: { requestInside: async (_id, input) => {
    calls.push(input.path);
    let result = {};
    if (input.path === '/api/session' && input.method === 'POST') { result = JSON.parse(String(input.body)); sessions.set(result.id, result); }
    else if (input.path === '/api/session/active') result = {};
    else if (input.path.startsWith('/api/session/') && input.method === 'GET') result = sessions.get(input.path.split('/').at(-1)) ?? [];
    else if (input.path.includes('/isolated-tools?')) result = { requests: [] };
    const response = Readable.from([Buffer.from(JSON.stringify(input.path.includes('/isolated-tools') ? result : { data: result }))]); response.complete = true;
    response.statusCode = input.method === 'PATCH' || /\/(?:model|agent)$/.test(input.path) || input.path.includes('/instructions/entry/') ? 204 : 200;
    return response;
  } } };
  const f = await fixture({ getSpacesHost: () => spaces });
  const bot = botDefinitionSchema.parse({ ...definition, isolated: true, limits: { dailyTokens: 5 }, space: { grants: [{ kind: 'custom', provider: 'controlled' }] } });
  await f.projectConfigRuntime.updateBotsSection('project', () => ({ definitions: [bot] }));
  const store = createBotStore({ projectsDirPath: path.join(f.dataDir, 'projects') });
  const item = createBotItem({ id: 'isolated-cleanup', botId: bot.id, source: { kind: 'manual', id: 'cleanup' }, title: 'Cleanup' });
  await store.update('project', (snapshot) => ({ snapshot: { ...snapshot, items: [item] } }));
  const baseSha = (await botGit(f.project.path, ['rev-parse', 'HEAD'])).trim();
  const { repositoryId } = await resolveRepositoryIdentity(f.project.path);
  const worktrees = createProductionBotWorktrees({ dataDir: f.dataDir, readItem: async () => (await store.read('project')).items[0], context: {
    github: async () => ({ binding: { identityId: 'controlled', identityRevision: 1, target: { repositoryId } }, credential: {
      request: async ({ path: route }) => route.endsWith('/git/ref/heads/main') ? { ref: 'refs/heads/main', object: { sha: baseSha } } : { default_branch: 'main' },
    } }), author: async () => ({ name: 'Controlled fixture', email: 'controlled@example.test' }),
  } });
  const checkout = await worktrees.create({ project: f.project, bot, item, key: `${item.id}:worktree` });
  const buildIsolated = () => createBotIsolatedStages({ dataDir: f.dataDir, getSpacesHost: () => spaces, resolveProject: async () => f.project,
    resolveSpaceOptions: ({ bot, selection }) => readBotSpaceOptions(bot.space, selection),
    sessionKnowledgeRuntime: { collect: async () => ({ notes: [], plans: [], memory: { enabled: false, complete: true, global: [], project: [] } }) } });
  const isolated = buildIsolated();
  const run = { projectId: 'project', itemId: item.id, directory: checkout.directory, bot, stage: 'fixing', dispatchedAt: 1, prompt: 'Fix', selection: { providerID: 'controlled', modelID: 'model' }, tokenBaseline: item.tokens };
  const { sessionId } = await isolated.create(run, async () => {});
  await store.update('project', (snapshot) => ({ snapshot: { ...snapshot, items: [{ ...snapshot.items[0], worktree: checkout.directory, branch: checkout.branch,
    sessions: { fixing: sessionId }, state: 'needs-you', wait: { reason: 'BOT_DAILY_TOKEN_BUDGET', since: Date.now(), channel: 'ui', people: [] } }] } }));
  await createBotExecutionStore({ store }).update('project', item.id, (entry) => ({ ...entry, data: { ...entry.data, checkout, resumeState: 'fixing', runs: { 'fixing:0': run } } }));
  return { ...f, isolated, buildIsolated, spaces, spaceCalls: calls, store, checkout, run, itemId: item.id, sessionId };
};

describe('production bot host composition', () => {
  it('resumes a budget-interrupted item in its captured space through a fresh production host', async () => {
    const f = await isolatedLifecycle(); await f.host.start();
    await f.host.runtime.recordUsage({ sessionId: f.sessionId, total: 5 });
    expect((await f.isolated.readBinding(f.run)).state).toBe('stopped');
    await f.host.stop();
    await f.projectConfigRuntime.updateBotsSection('project', (settings) => ({ ...settings, definitions: settings.definitions.map((bot) => ({ ...bot, isolated: false,
      models: { ...bot.models, fixing: { useDefaults: false, providerID: 'controlled', modelID: 'model' } }, limits: { ...bot.limits, dailyTokens: 10 } })) }));
    const fresh = f.buildHost();
    try {
      await fresh.start();
      const isolated = f.buildIsolated();
      await expect(isolated.dispatch({ ...f.run, sessionId: f.sessionId })).rejects.toMatchObject({ code: 'BOT_ISOLATED_CREATE_UNKNOWN' });
      expect(f.spaceCalls.filter((call) => Array.isArray(call) && call[0] === 'start')).toEqual([]);
      const result = await fresh.runtime.resume('project', f.itemId);
      expect(result.item.state, result.item.wait?.reason).toBe('fixing');
      expect(result.item.sessions.fixing).not.toBe(f.sessionId);
      expect(await fresh.isSessionWorking(result.item.sessions.fixing)).toBe(false);
      expect(await fresh.isSessionWorking(f.sessionId)).toBeUndefined();
      expect((await fresh.runtime.detail('project', f.itemId)).sessionDirectories).toEqual({ [result.item.sessions.fixing]: '/spaces/abcdef123456/worktree' });
      expect((await isolated.readBinding(f.run)).spaceId).toBe('abcdef123456');
      expect(Object.values((await isolated.readBinding(f.run)).sessions).map((session) => session.id)).toContain(f.sessionId);
      expect(f.spaceCalls.filter((call) => Array.isArray(call) && call[0] === 'start')).toEqual([['start', 'abcdef123456']]);
      expect(f.spaceCalls.filter((call) => Array.isArray(call) && call[0] === 'grant')).toEqual([['grant', 'abcdef123456', { kind: 'custom', provider: 'controlled' }]]);
      expect(f.spaceCalls.filter((call) => call === 'create')).toHaveLength(1);
      expect(f.calls.http).toHaveLength(0);
    } finally { await fresh.stop(); }
  });

  it('recovers isolated Stop after a host checkout refusal across a fresh production composition', async () => {
    const f = await isolatedLifecycle(); await f.host.start();
    const retained = path.join(f.checkout.directory, 'retained-user-file'); await fs.writeFile(retained, 'Keep this file');
    await expect(f.host.runtime.stopItem('project', f.itemId)).rejects.toThrow();
    expect((await f.isolated.readBinding({ projectId: 'project', itemId: f.itemId })).state).toBe('removed');
    expect(await fs.readFile(retained, 'utf8')).toBe('Keep this file');
    await f.host.stop(); await fs.rm(retained);
    const fresh = f.buildHost();
    try {
      await fresh.start();
      expect((await fresh.runtime.stopItem('project', f.itemId)).item.state).toBe('stopped');
      await expect(fs.stat(f.checkout.directory)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(f.spaceCalls.filter((call) => call === 'remove')).toHaveLength(1);
      expect(f.spaceCalls.filter((call) => call === 'stop')).toHaveLength(1);
      expect(f.spaceCalls.filter((call) => call === 'create')).toHaveLength(1);
      expect(f.calls.http).toHaveLength(0);
    } finally { await fresh.stop(); }
  });

  it('recovers Stop when the space disappeared before its binding receipt could persist', async () => {
    const f = await isolatedLifecycle(); await f.host.start();
    const file = path.join(f.dataDir, 'bots/isolated-stages', `${digestMutationInput({ projectId: 'project', itemId: f.itemId })}.json`);
    const remove = f.spaces.journey.removeSpace;
    f.spaces.journey.removeSpace = async (id) => {
      const result = await remove(id);
      await fs.rename(file, `${file}.saved`); await fs.mkdir(file);
      return result;
    };
    await expect(f.host.runtime.stopItem('project', f.itemId)).rejects.toThrow();
    await fs.rmdir(file); await fs.rename(`${file}.saved`, file);
    expect((await f.isolated.readBinding({ projectId: 'project', itemId: f.itemId })).state).toBe('removing');
    await expect(fs.stat(f.checkout.directory)).resolves.toBeDefined();
    await f.host.stop();
    const fresh = f.buildHost();
    try {
      await fresh.start();
      expect((await fresh.runtime.stopItem('project', f.itemId)).item.state).toBe('stopped');
      await expect(fs.stat(f.checkout.directory)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await f.isolated.readBinding({ projectId: 'project', itemId: f.itemId })).state).toBe('removed');
      expect(f.spaceCalls.filter((call) => call === 'remove')).toHaveLength(1);
      expect(f.spaceCalls.filter((call) => call === 'stop')).toHaveLength(1);
      expect(f.spaceCalls.filter((call) => call === 'create')).toHaveLength(1);
      expect(f.calls.http).toHaveLength(0);
    } finally { await fresh.stop(); }
  });

  it('constructs all production owners, gates dispatch until ready, and persists missing identity attention', async () => {
    const f = await fixture();
    expect((await f.request('/config', 'PUT', { config: { definitions: [definition] } })).status).toBe(503);
    await f.host.start();
    expect((await f.request('/config', 'PUT', { config: { definitions: [definition] } })).status).toBe(200);
    const admitted = await f.request('/items', 'POST', { botId: 'bugs', source: { kind: 'manual', id: 'first' }, title: 'A real issue' });
    expect(admitted.status).toBe(200);
    expect(admitted.body.item).toMatchObject({ state: 'needs-you', wait: { reason: 'BOT_IDENTITY_REQUIRED' } });
    const notifications = await f.center.list({ allKinds: true });
    expect(notifications).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'bot', requestId: admitted.body.item.id,
      action: { type: 'bots', projectId: 'project', itemId: admitted.body.item.id } })]));
    expect(f.calls.alerts).toHaveLength(1);
    expect(f.calls.events).toContainEqual({ type: 'openchamber:bots-changed', properties: { projectId: 'project' } });
    expect(await f.projectConfigRuntime.listScheduledTasks('project')).toEqual(expect.arrayContaining([expect.objectContaining({ botId: 'bugs', botManaged: true })]));
    expect((await f.request('/identities')).body).toEqual({ identities: [] });
    await expect(f.host.handleTool({ sessionId: 'ses_foreign', action: 'item.report', input: { evidence: [] } })).rejects.toMatchObject({ code: 'BOT_SESSION_REQUIRED' });
    expect(f.calls.http).toHaveLength(0);
  });

  it('returns source discovery as 202, resumes the same occurrence, counts caches once, and skips normal token events', async () => {
    const f = await fixture(); await f.host.start();
    await f.request('/config', 'PUT', { config: { definitions: [{ ...definition, source: { kind: 'investigation', prompt: 'Inspect the code', maxItems: 2 }, limits: { dailyTokens: 15 } }] } });
    const pending = await f.request('/bugs/run', 'POST', { occurrence: 'same-occurrence' });
    expect(pending.status).toBe(202);
    expect(pending.body).toMatchObject({ pending: true, occurrence: 'same-occurrence' });
    const sessionId = pending.body.sessionId;
    expect(f.records.size).toBe(1);
    const before = f.calls.http.length;
    for (let index = 0; index < 100; index++) await f.host.processPayload({ type: 'message.part.delta', properties: { sessionID: 'ses_normal' } });
    for (let index = 0; index < 100; index++) await f.host.processPayload({ type: 'message.part.delta', properties: { sessionID: sessionId } });
    expect(f.calls.http).toHaveLength(before);
    stateComplete(f);
    await f.host.processPayload({ type: 'message.updated', properties: { sessionID: sessionId, info: { role: 'assistant', time: { completed: Date.now() } } } });
    // Final discovery tokens meet the configured budget, so admission must stop.
    const budget = await f.request('/bugs/run', 'POST', { occurrence: 'new-occurrence' });
    expect(budget.status).toBe(409);
    expect(budget.body.code).toBe('BOT_DAILY_TOKEN_BUDGET');
    expect(f.records.size).toBe(1);
    const rows = (await f.request('/items')).body.items;
    expect(rows.some((item) => item.wait?.reason === 'BOT_DAILY_TOKEN_BUDGET')).toBe(true);
  });

  it('lets a missing-identity item resume or stop without admitting an uncertain checkout', async () => {
    const f = await fixture();
    await f.host.start();
    await f.request('/config', 'PUT', { config: { definitions: [definition] } });
    const admitted = await f.request('/items', 'POST', { botId: 'bugs', source: { kind: 'manual', id: 'missing-identity-stop' }, title: 'Missing identity' });
    const itemId = admitted.body.item.id;
    const resumed = await f.request(`/items/${itemId}/resume`, 'POST', {});
    expect(resumed.body.item).toMatchObject({ state: 'needs-you', wait: { reason: 'BOT_IDENTITY_REQUIRED' }, effects: [], sessions: {} });
    const stopped = await f.request(`/items/${itemId}/stop`, 'POST', {});
    expect(stopped.status).toBe(200);
    expect(stopped.body.item).toMatchObject({ state: 'stopped', effects: [], sessions: {} });
    expect(f.calls.http).toHaveLength(0);
    expect(await fs.readdir(path.join(f.dataDir, 'bot-worktrees')).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })).toEqual([]);
  });

  it('keeps a pending scheduler occurrence admitted without creating an ordinary scheduled session', async () => {
    const f = await fixture(); await f.host.start();
    await f.request('/config', 'PUT', { config: { definitions: [{ ...definition, source: { kind: 'investigation', prompt: 'Inspect', maxItems: 1 } }] } });
    const first = await f.host.runScheduled('project', 'bugs', 'scheduled:1');
    expect(first).toMatchObject({ items: [], skipped: false, pending: { occurrence: 'scheduled:1' } });
    const sessionId = first.pending.sessionId;
    stateComplete(f);
    await f.host.processPayload({ type: 'session.idle', properties: { sessionID: sessionId } });
    const resumed = await f.host.runScheduled('project', 'bugs', 'scheduled:1');
    expect(resumed).toMatchObject({ items: [], skipped: true });
    expect(f.records.size).toBe(1);
  });

  it('preserves suggestion files and evidence on the stable admitted source', async () => {
    const f = await fixture(); await f.host.start();
    await f.request('/config', 'PUT', { config: { definitions: [definition] } });
    const input = { projectId: 'project', botId: 'bugs', suggestion: { id: 'suggestion-1', title: 'Fix it', body: 'Observed wrong result',
      files: [{ path: 'src/a.js', startLine: 4, endLine: 9 }], evidence: [{ source: 'BUG-1', summary: 'Reproduced' }] } };
    const first = await f.host.deliverSuggestion(input);
    expect(await f.host.deliverSuggestion(input)).toEqual(first);
    const item = (await f.request(`/items/${first.itemId}`)).body.item;
    expect(item.description).toContain('Observed wrong result'); expect(item.description).toContain('src/a.js:4-9'); expect(item.evidence).toEqual(input.suggestion.evidence);
  });

  it('retains recorded isolation after config changes and refuses a stopped space without querying the host', async () => {
    const f = await fixture();
    await f.projectConfigRuntime.updateBotsSection('project', () => ({ definitions: [definition] }));
    const store = createBotStore({ projectsDirPath: path.join(f.dataDir, 'projects') });
    const item = createBotItem({ id: 'recorded', botId: 'bugs', source: { kind: 'manual', id: 'old-isolated' }, title: 'Recorded isolated work' });
    await store.update('project', (snapshot) => ({ snapshot: { ...snapshot, items: [item] } }));
    await store.update('project', (snapshot) => ({ snapshot: { ...snapshot, items: snapshot.items.map((current) => ({ ...current,
      state: 'needs-you', worktree: '/owned/worktree', sessions: { fixing: 'ses_recorded_fixing' },
      wait: { reason: 'BOT_DAILY_TOKEN_BUDGET', since: Date.now(), channel: 'ui', people: [] } })) } }));
    const key = { projectId: 'project', itemId: item.id };
    const directory = path.join(f.dataDir, 'bots', 'isolated-stages');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, `${digestMutationInput(key)}.json`), JSON.stringify({ version: 1, ...key, botId: 'bugs',
      hostDirectory: '/owned/worktree', state: 'stopped', spaceId: 'abcdef123456', directory: '/spaces/abcdef123456/worktree',
      sessions: { fixing: { id: 'ses_recorded_fixing', stage: 'fixing', directory: '/spaces/abcdef123456/worktree' } } }));
    await f.host.start();
    expect((await f.host.runtime.detail('project', item.id)).sessionDirectories).toEqual({ ses_recorded_fixing: '/spaces/abcdef123456/worktree' });
    await expect(f.host.isSessionWorking('ses_recorded_fixing')).rejects.toMatchObject({ code: 'BOT_ISOLATED_CREATE_UNKNOWN' });
    await expect(f.host.runtime.stopItem('project', item.id)).rejects.toMatchObject({ code: 'BOT_ISOLATION_UNAVAILABLE' });
    expect(f.calls.http).toHaveLength(0);
  });

  it('restores host placement after isolation is enabled and keeps notices and links on that host session', async () => {
    const f = await fixture();
    await f.projectConfigRuntime.updateBotsSection('project', () => ({ definitions: [{ ...definition, isolated: true }] }));
    const store = createBotStore({ projectsDirPath: path.join(f.dataDir, 'projects') });
    const item = createBotItem({ id: 'host-recorded', botId: 'bugs', source: { kind: 'manual', id: 'old-host' }, title: 'Recorded host work' });
    await store.update('project', (snapshot) => ({ snapshot: { ...snapshot, items: [item] } }));
    await store.update('project', (snapshot) => ({ snapshot: { ...snapshot, items: snapshot.items.map((current) => ({ ...current,
      state: 'needs-you', worktree: '/owned/host', sessions: { fixing: 'ses_host_fixing' },
      wait: { reason: 'BOT_DAILY_TOKEN_BUDGET', since: Date.now(), channel: 'ui', people: [] } })) } }));
    await createBotExecutionStore({ store }).update('project', item.id, (entry) => ({ ...entry, data: { runs: {
      'fixing:0': { projectId: 'project', itemId: item.id, directory: '/owned/host', stage: 'fixing', dispatchedAt: 1, bot: { id: 'bugs', isolated: false } },
    } } }));
    f.records.set('ses_host_fixing', { id: 'ses_host_fixing', location: { directory: '/owned/host' },
      metadata: { openchamber: { automation: { source: 'bot', projectId: 'project', botId: 'bugs', itemId: item.id, stage: 'fixing' } } } });
    await f.host.start();
    expect(await f.host.isSessionWorking('ses_host_fixing')).toBeUndefined();
    expect((await f.host.runtime.detail('project', item.id)).sessionDirectories).toEqual({ ses_host_fixing: '/owned/host' });
    await expect(f.host.assertDispatch({ sessionId: 'ses_host_fixing', directory: '/owned/host',
      origin: { kind: 'bot', id: item.id }, isolated: false,
      notice: { source: 'openchamber-notice', kind: 'bot', projectId: 'project', itemId: item.id, eventId: 'review:1' },
    })).resolves.toEqual({ includeMemorySaveRule: true });
  });

  it('persists one source attention item when Jira identity is missing', async () => {
    const f = await fixture(); await f.host.start();
    await f.request('/config', 'PUT', { config: { definitions: [{ ...definition, source: { kind: 'jira', jql: 'status = Open ORDER BY created DESC', maxItems: 3 } }] } });
    for (let index = 0; index < 2; index++) {
      const result = await f.request('/bugs/run', 'POST', { occurrence: 'jira:one' });
      expect(result.status).toBe(409); expect(result.body.code).toBe('BOT_IDENTITY_REQUIRED');
    }
    const items = (await f.request('/items')).body.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ state: 'needs-you', wait: { reason: 'BOT_IDENTITY_REQUIRED' }, sessions: {} });
    expect(f.calls.http).toHaveLength(0);
  });

  it('turns a settled bot PR watch failure into item attention without awaiting the originating loop', async () => {
    const f = await fixture(); await f.host.start();
    await f.request('/config', 'PUT', { config: { definitions: [definition] } });
    const admitted = (await f.request('/items', 'POST', { botId: 'bugs', title: 'Bug', source: { kind: 'manual', id: 'watch' } })).body.item;
    const store = createBotStore({ projectsDirPath: path.join(f.dataDir, 'projects') });
    await store.update('project', (snapshot) => ({ snapshot: { ...snapshot, items: snapshot.items.map((item) => ({ ...item,
      sessions: { fixing: 'ses_watched' }, pr: { number: 7, url: 'https://github.com/fixture/repository/pull/7', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) } })) } }));
    expect(f.host.onPullRequestSettled({ botAuthority: { project: { id: 'project' }, botId: 'bugs', itemId: admitted.id },
      sessionId: 'ses_watched', number: 7, status: 'error' })).toBeUndefined();
    await f.host.stop();
    expect((await store.read('project')).items[0].wait.reason).toBe('BOT_PULL_REQUEST_WATCH_STOPPED');
  });
});

function stateComplete(f) { f.state.active = {}; f.state.output = []; }

it('child composition persists call context, wakes through translated metadata and has no host routes or identities', async () => {
  const root = await fs.mkdtemp('/tmp/opencode/bots-child-');
  try {
    const wakes = [];
    let wakeComplete;
    const woke = new Promise((resolve) => { wakeComplete = resolve; });
    const child = createBotChildServer({ dataDir: root, updateMetadata: async (sessionID, patch) => {
      wakes.push(...translateWireEvent({ type: 'session.metadata.updated', data: { sessionID, metadata: patch }, id: 'event_pending', time: { created: Date.now() } }));
      wakeComplete();
    } });
    const app = express();
    app.use((_req, res, next) => { if (!_req.headers.authorization) return res.sendStatus(401); next(); });
    child.registerRoutes(app);
    const controller = new AbortController();
    const pending = child.handleTool({ sessionId: 'ses_child', callId: 'call_trusted', action: 'item.report', input: { evidence: [] } }, { signal: controller.signal });
    const pendingError = pending.catch((error) => error);
    // The durable callback is the synchronization edge, not a timed poll.
    await woke;
    expect(wakes[0]).toMatchObject({ type: 'session.updated', properties: { sessionID: 'ses_child', info: { metadata: { openchamber: { botToolPending: expect.any(String) } } } } });
    expect((await request(app).get('/api/openchamber/bots/isolated-tools?sessionId=ses_child')).status).toBe(401);
    const page = await request(app).get('/api/openchamber/bots/isolated-tools?sessionId=ses_child').set('authorization', 'fixture');
    expect(page.body.requests).toHaveLength(1);
    const settle = await request(app).post('/api/openchamber/bots/isolated-tools/settle').set('authorization', 'fixture')
      .send({ ...page.body.requests[0], reply: { ok: true, result: { accepted: true } } });
    expect(settle.status).toBe(200); expect(await pendingError).toEqual({ accepted: true });
    expect((await request(app).get('/api/projects/project/bots').set('authorization', 'fixture')).status).toBe(501);
    await expect(fs.stat(path.join(root, 'bot-identities.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
