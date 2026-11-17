import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';
import express from 'express';
import { afterEach, expect, it } from 'vitest';
import { createBotsHost } from './host.js';
import { createBotExecutionServices } from './agent-execution.js';
import { createOwnerBotConfig } from './owner-config.js';
import { createAgentBotServices } from '../agent-server/bot-services.js';
import { createAgentUpstream } from '../agent-server/agent-upstream.js';
import { botEffectInputDigest } from '../agent-server/bot-service-contract.js';
import { registerBotServiceRoutes } from '../agent-server/bot-service-routes.js';
import { createBotStore } from './store.js';

const BASE = 'a'.repeat(40); const TEST = 'b'.repeat(40); const HEAD = 'c'.repeat(40);
const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

// Real coordinator, disk journals, typed HTTP, execution owners, host stages and
// isolated SDK transport. Only provider, checkout and model/process peers are
// controlled. Real bundle/Git adoption is covered in bot-space-transfer.test.js.
async function fixture(isolated, loseOpen = false, enableIsolationWhileFixing = false) {
  const root = await fs.mkdtemp('/tmp/opencode/bot-separated-composition-');
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const project = { id: 'project', path: path.join(root, 'agent-project') };
  await fs.mkdir(path.join(project.path, '.agents/areas'), { recursive: true });
  await fs.writeFile(path.join(project.path, '.agents/areas/core.md'), '---\nname: Core\npaths: [src/**]\nlevel: judgment\nowners: []\n---\nReview\n');
  const dataDir = path.join(root, 'owner');
  const resolveProject = async () => project; const listProjects = async () => [project];
  const config = createOwnerBotConfig({ projectsDirPath: path.join(dataDir, 'projects'), resolveProject });
  const sessions = new Map(); const messages = new Map(); const owned = new Map();
  const calls = { stages: [], writes: [], proof: [], spaces: [], removed: [], watches: [], adoptions: [], failures: [], operations: [] };
  const target = { repositoryId: 'repo-id', owner: 'fixture', repo: 'repository' };
  const identity = { id: 'selected', revision: 1, kind: 'github-app', appId: '123', installationId: '456', configured: true, label: 'Controlled' };
  const binding = { identityId: identity.id, identityRevision: 1, target };
  const snapshot = () => ({ headSha: HEAD, baseSha: BASE, baseBranch: 'main', remoteSha: remote,
    changes: [{ newPath: 'src/fix.js' }], diff: 'Controlled diff', testSha: TEST, fixSha: HEAD, testFiles: ['regression.test.js'] });
  let remote = null; let lost = loseOpen; let resultForOpen;
  const authority = { service: 'github', identityId: identity.id, identityRevision: 1, origin: 'https://api.github.com',
    credentialId: identity.id, credentialRevision: 1, providerAccountId: 'github.com#123' };
  const services = {
    prepare: async (input) => {
      const result = { key: input.key, operation: input.operation, botId: input.botId, itemId: input.itemId,
        authority, target: input.target };
      if (input.publicationBranch) result.publicationBranch = input.publicationBranch;
      return { ...result, inputDigest: botEffectInputDigest(result, input.input) };
    },
    preflight: async () => {},
    execute: async (effect, input) => {
      const item = (await createBotStore({ projectsDirPath: path.join(dataDir, 'projects') }).read(project.id)).items.find((entry) => entry.id === effect.itemId);
      expect(item.effects.find((entry) => entry.key === effect.key).state).toBe('dispatching');
      calls.writes.push({ key: effect.key, operation: effect.operation });
      if (effect.operation === 'git.push') remote = input.headSha;
      const result = effect.operation === 'git.push' ? { headSha: HEAD, sourceHeadSha: HEAD }
        : { number: 42, head: input.branch, base: 'main', headSha: HEAD };
      if (effect.operation === 'pr.open') {
        resultForOpen = result;
        if (lost) { lost = false; throw Object.assign(new Error('Lost admitted result'), { code: 'BOT_CONTROLLED_LOST_RESPONSE', state: 'outcome-unknown' }); }
      }
      return { status: 'succeeded', authority, target, operation: effect.operation, result, replayed: false };
    },
    reconcile: async () => ({ state: 'succeeded', result: resultForOpen }),
    read: async ({ operation, input }) => {
      if (operation === 'github.branch-rules') return [];
      if (operation === 'github.pull') return { number: input.number, state: 'open', headSha: HEAD, baseSha: BASE, base: 'main', merged: false };
      if (operation === 'github.authorization') return { number: input.number, headSha: HEAD, baseSha: BASE, merged: false, autoMerge: false, queued: false };
      throw new Error(`Unexpected controlled read ${operation}`);
    },
  };
  const worktrees = {
    create: async ({ item }) => { const directory = path.join(root, 'agent-checkouts', item.id); await fs.mkdir(directory, { recursive: true });
      const result = { directory, branch: `bot/${item.id}`, baseBranch: 'main', baseSha: BASE }; owned.set(item.id, result); return result; },
    resolveTransferSource: async (source) => owned.get(source.itemId).directory,
    inspect: async () => snapshot(),
    bindPublication: async ({ branch }) => ({ publicationBranch: branch }),
    readPublication: async ({ itemId }) => ({ ...owned.get(itemId), localBranch: `bot/${itemId}`, publicationBranch: `bot/${itemId}`,
      identityId: identity.id, identityRevision: identity.revision }),
    adoptIsolated: async (input) => { calls.adoptions.push(input); return { headSha: input.resultSha }; },
    acceptPublished: async ({ result }) => ({ headSha: result.headSha }),
    remove: async ({ item }) => { calls.removed.push(item.id); owned.delete(item.id); return { id: item.id }; },
    reconcile: async () => ({ state: 'outcome-unknown' }),
  };
  const output = (stage) => stage === 'investigation' ? { summary: 'Verified', plan: 'Test then fix', evidence: [], questions: [] }
    : stage === 'fixing' ? { summary: 'Fixed', evidence: [] } : { decision: 'review', reason: 'Maintainer review', reviewers: [], questions: [] };
  const complete = (id) => {
    const info = sessions.get(id); const stage = info.metadata.openchamber.automation.stage;
    calls.stages.push({ stage, isolated: info.location.directory.startsWith('/spaces/') });
    messages.set(id, [{ id: `idle_${id}`, type: 'idle', outcome: 'succeeded', time: { created: Date.now() + 2 } },
      { id: `reply_${id}`, type: 'assistant', content: [{ type: 'text', text: JSON.stringify(output(stage)) }],
        time: { created: Date.now() + 1, completed: Date.now() + 1 }, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }]);
  };
  const sessionService = {
    create: async (input, options) => { const id = `ses_host${sessions.size}`;
      sessions.set(id, { id, location: { directory: input.directory }, metadata: options.metadata }); messages.set(id, []);
      await options.onSessionCreated({ sessionId: id, directory: input.directory }); return { sessionId: id, directory: input.directory }; },
    send: async (id) => {
      if (enableIsolationWhileFixing && sessions.get(id).metadata.openchamber.automation.stage === 'fixing') {
        await config.updateBotsSection(project.id, (current) => ({ ...current,
          definitions: current.definitions.map((bot) => ({ ...bot, isolated: true })) }));
      }
      complete(id); return { promptDispatched: true };
    },
  };
  const clientFor = () => ({ session: { get: async ({ sessionID }) => ({ data: sessions.get(sessionID) }),
    update: async () => {}, interrupt: async () => {}, synthetic: async () => {} },
  message: { list: async ({ sessionID }) => ({ data: messages.get(sessionID) ?? [] }) } });
  const knowledge = { collect: async () => ({ notes: [], plans: [], memory: { enabled: false, complete: true, global: [], project: [] },
    linking: false, naming: false, rendering: false, secrets: false, workflows: false, directTools: false, readAloud: false, checkout: null }), sync: async () => {} };
  const proofResult = (input) => ({ status: 'passed', testSha: input.testSha, fixSha: input.fixSha, command: input.command,
    args: input.args, testExitCode: 1, fixExitCode: 0 });
  const execution = createBotExecutionServices({ agentServer: true, dataDir: path.join(root, 'agent'),
    readSettings: async () => ({ projects: [project] }), listProjects, clientFor, sessionService, sessionKnowledgeRuntime: knowledge,
    readSessionDefaults: async () => ({ providerID: 'controlled', modelID: 'model' }),
    readTokens: async () => 2, activity: { fetchActiveSessionStatuses: async () => ({}), hasWorkingChildren: async () => false, hasWorkingDescendants: async () => false },
    permissionAutoAcceptRuntime: { setSessionPolicy: async () => {} }, services, worktrees, identities: { list: async () => [identity] },
    context: { repository: async () => ({ target, remote: 'origin' }), github: async () => ({ binding }), serviceContext: async () => ({ github: binding }) },
    proof: { run: async (input) => { calls.proof.push(input); return proofResult(input); } },
    pullRequests: { botWatch: { getOctokit: async () => ({}), authorizeApp: async () => false },
      pullRequests: { read: async () => ({ headSha: HEAD, baseSha: BASE, merged: false, approved: false, mergeMode: 'auto-merge' }) } },
  });
  cleanups.push(() => execution.stop());
  const app = express();
  app.post('/auth/session', express.json(), (_req, res) => res.set('Set-Cookie', 'oc_ui_session=controlled; Max-Age=3600; Path=/').json({ ok: true }));
  app.use('/api', (req, res, next) => req.headers.cookie === 'oc_ui_session=controlled' ? next() : res.sendStatus(401));
  registerBotServiceRoutes(app, { agentServer: true, services: { ...execution, execute: async (...args) => {
    calls.operations.push(args[0]);
    try { return await execution.execute(...args); }
    catch (error) { calls.failures.push({ operation: args[0], message: error.stack }); throw error; }
  } } });
  const server = http.createServer(app); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const upstream = createAgentUpstream({ url: `http://127.0.0.1:${server.address().port}`, token: 'controlled' });
  cleanups.push(() => upstream.close());
  let removed = false; let stopped = false; let source;
  const spaces = { journey: {
    createBotSpace: async (_request, options) => { source = options.source; calls.spaces.push(source);
      await options.onAllocated({ id: 'abcdef123456', directory: '/spaces/abcdef123456/controlled' }); },
    listSpaces: async () => removed ? [] : [{ id: 'abcdef123456', state: stopped ? 'exited' : 'running', access: 'granted', grants: [{ provider: 'controlled' }], damaged: false }],
    previewApply: async () => ({ result: HEAD }),
    stopSpace: async () => { stopped = true; }, removeSpace: async () => { removed = true; return { removed: true, failures: [] }; },
  }, manager: { verify: async () => [], listAllSpaces: async () => ({ spaces: await spaces.journey.listSpaces(), unavailable: [] }),
    exec: async (_id, _args, options) => { const input = JSON.parse(options.stdin); calls.proof.push(input); return { code: 0, stdout: JSON.stringify(proofResult(input)) }; } },
  dispatcher: { requestInside: async (_spaceId, request) => {
    const url = new URL(request.path, 'http://controlled.invalid'); let body = {};
    if (request.path === '/api/session' && request.method === 'POST') { body = JSON.parse(String(request.body)); sessions.set(body.id, body); messages.set(body.id, []); }
    else if (request.path === '/api/session/active') body = {};
    else if (url.pathname.endsWith('/message')) body = messages.get(url.pathname.split('/')[3]) ?? [];
    else if (url.pathname.endsWith('/prompt')) complete(url.pathname.split('/')[3]);
    else if (url.pathname === '/api/openchamber/bots/isolated-tools') body = { requests: [] };
    else if (url.pathname.startsWith('/api/session/') && request.method === 'GET') body = sessions.get(url.pathname.split('/').at(-1));
    const page = url.pathname === '/api/session' && request.method === 'GET' ? { data: [], cursor: {} }
      : url.pathname.endsWith('/message') ? { data: body, cursor: {} }
        : url.pathname.includes('isolated-tools') ? body : { data: body };
    const response = Readable.from([Buffer.from(JSON.stringify(page))]);
    response.statusCode = request.method === 'PATCH' || /\/(?:model|agent)$/.test(url.pathname) || url.pathname.includes('/instructions/entry/') ? 204 : 200;
    response.complete = true; return response;
  } } };
  const buildHost = () => createBotsHost({ dataDir, projectsDir: path.join(dataDir, 'projects'), projectConfigRuntime: config,
    scheduledTasksRuntime: { syncProject: async () => {} }, resolveProject, listProjects, executionServices: createAgentBotServices(upstream),
    buildOpenCodeUrl: () => { throw new Error('Owner project HTTP fallback'); }, getOpenCodeAuthHeaders: () => ({}),
    getSpacesHost: () => spaces, notificationCenter: { upsertBot: async () => ({ changed: true }), resolveBot: async () => ({ changed: true }) }, notify: async () => {}, broadcast: () => {},
    getFixLoopRuntime: () => ({ createBotWatch: async (input) => { calls.watches.push(input); }, stopBotWatch: async () => {} }),
    logger: { warn() {} } });
  const hosts = []; const build = () => { const host = buildHost(); hosts.push(host); return host; };
  cleanups.push(async () => { for (const host of hosts) await host.stop(); });
  const host = build(); await host.start();
  const definition = { id: 'bot', name: 'Controlled Bot', mission: 'Fix a verified bug', isolated,
    identity: { github: { kind: 'app', identityId: identity.id } }, proof: { command: 'node', args: ['--test', '{files}'] },
  };
  if (isolated) definition.space = { grants: [{ kind: 'custom', provider: 'controlled' }] };
  await host.runtime.saveConfig(project.id, { definitions: [definition] });
  const policy = await host.runtime.getPolicy(project.id);
  await host.runtime.approvePolicy(project.id, { file: policy.areas[0].file, fingerprint: policy.areas[0].fingerprint });
  return { host, build, calls, project, source: () => source };
}

it.each([false, true])('composes normal publication and restart for isolated=%s without owner project execution', async (isolated) => {
  const f = await fixture(isolated);
  const admitted = await f.host.runtime.admit(f.project.id, 'bot', { source: { kind: 'manual', id: 'normal' }, title: 'Controlled defect' });
  await f.host.runtime.pump(f.project.id);
  const item = (await f.host.runtime.detail(f.project.id, admitted.id)).item;
  expect(item.state, JSON.stringify({ wait: item.wait, failures: f.calls.failures, operations: f.calls.operations })).toBe('in-review');
  expect(item.pr.number).toBe(42);
  expect(f.calls.stages).toEqual(['investigation', 'fixing', 'judge'].map((stage) => ({ stage, isolated })));
  expect(f.calls.writes.map((entry) => entry.operation)).toEqual(['git.push', 'pr.open']);
  expect(f.calls.proof.length).toBeGreaterThan(0);
  if (isolated) {
    expect(f.source()).toEqual({ kind: 'bot-checkout', projectDirectory: f.project.path, projectId: f.project.id,
      botId: 'bot', itemId: item.id, checkoutKey: `${item.id}:worktree` });
    expect(f.calls.adoptions.every((entry) => entry.spaceId === 'abcdef123456')).toBe(true);
  } else expect(f.calls.spaces).toEqual([]);
  await f.host.stop(); const fresh = f.build(); await fresh.start();
  expect((await fresh.runtime.detail(f.project.id, item.id)).item.pr.number).toBe(42);
  expect(f.calls.writes).toHaveLength(2);
  await fresh.runtime.stopItem(f.project.id, item.id);
  expect(f.calls.removed).toEqual([item.id]);
});

it('reconciles a lost remote publication result through a fresh owner without repeating its write', async () => {
  const f = await fixture(false, true);
  const admitted = await f.host.runtime.admit(f.project.id, 'bot', { source: { kind: 'manual', id: 'lost' }, title: 'Controlled uncertainty' });
  await f.host.runtime.pump(f.project.id);
  const item = (await f.host.runtime.detail(f.project.id, admitted.id)).item;
  expect(item.state).toBe('needs-you');
  expect(item.effects.find((effect) => effect.key === `${item.id}:pr`).state).toBe('outcome-unknown');
  await f.host.stop(); const fresh = f.build(); await fresh.start();
  await fresh.runtime.resume(f.project.id, item.id);
  const recovered = (await fresh.runtime.detail(f.project.id, item.id)).item;
  expect(recovered.state, recovered.wait?.reason).toBe('in-review');
  expect(recovered.pr.number).toBe(42);
  expect(f.calls.writes.filter((entry) => entry.operation === 'pr.open')).toEqual([{ key: `${item.id}:pr`, operation: 'pr.open' }]);
});

it('keeps delegated proof on the captured host placement after isolation is enabled during fixing', async () => {
  const f = await fixture(false, false, true);
  const admitted = await f.host.runtime.admit(f.project.id, 'bot', { source: { kind: 'manual', id: 'placement' }, title: 'Captured host proof' });
  await f.host.runtime.pump(f.project.id);
  const item = (await f.host.runtime.detail(f.project.id, admitted.id)).item;
  expect(item.state, item.wait?.reason).toBe('in-review');
  expect(f.calls.proof).toHaveLength(1);
  expect(f.calls.proof[0].isolated).toBe(false);
  expect(f.calls.spaces).toEqual([]);
});
