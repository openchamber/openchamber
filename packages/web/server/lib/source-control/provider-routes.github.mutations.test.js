import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMutationExecutor, digestMutationInput } from './mutation-executor.js';
import { createBindingService } from './binding-service.js';
import { createMutationStore } from './mutation-storage.js';

let auth;
let registerGitHubRoutes;

const makeStore = (initial = []) => {
  const records = new Map(initial.map((record) => [record.key, record]));
  return {
    records,
    withExecutionLock: async (_key, operation) => operation(),
    async read(key) {
      return records.get(key) ?? null;
    },
    async claim(record) {
      const existing = records.get(record.key);
      if (existing) return existing.inputDigest === record.inputDigest
        ? { status: 'existing', record: existing }
        : { status: 'conflict', record: existing };
      const running = { ...record, state: 'running' };
      records.set(record.key, running);
      return { status: 'claimed', record: running };
    },
    async complete(key, inputDigest, completion) {
      const existing = records.get(key);
      if (!existing || existing.inputDigest !== inputDigest || existing.state !== 'running') throw new Error('conflict');
      const completed = { ...existing, ...completion };
      records.set(key, completed);
      return completed;
    },
  };
};

const pullRequest = (overrides = {}) => ({
  number: 7,
  title: 'Title',
  html_url: 'https://github.com/acme/app/pull/7',
  state: 'open',
  draft: true,
  merged: false,
  merged_at: null,
  node_id: 'PR_node',
  user: { id: 1, login: 'author' },
  base: {
    ref: 'main',
    repo: {
      owner: { login: 'acme' },
      name: 'app',
      html_url: 'https://github.com/acme/app',
    },
  },
  head: {
    ref: 'feature',
    sha: 'abc123',
    repo: {
      owner: { login: 'acme' },
      name: 'app',
      html_url: 'https://github.com/acme/app',
      clone_url: 'https://github.com/acme/app.git',
      ssh_url: 'git@github.com:acme/app.git',
    },
  },
  ...overrides,
});

const context = (accountId, overrides = {}) => ({
  provider: 'github',
  instance: 'github.com',
  directory: '/repo',
  repositoryId: 'repo-one',
  accountId,
  bindingRevision: 3,
  primaryRemote: 'origin',
  idempotencyKey: 'request-one',
  target: { project: { owner: 'acme', name: 'app' }, head: 'feature', base: 'main' },
  ...overrides,
});
const credentialFor = (account) => ({
  accountId: account.accountId,
  credentialRevision: account.credentialRevision,
});

const jsonResponse = (value, status = 200) => Response.json(value, { status });

const stackPayload = (accountId, kind, overrides = {}) => {
  const number = kind === 'register' ? 8 : 7;
  return {
    ...context(accountId, { target: { project: { owner: 'acme', name: 'app' }, number,
      head: number === 8 ? 'top' : 'feature', base: number === 8 ? 'feature' : 'main',
      headSha: number === 8 ? 'top-sha' : 'abc123' } }),
    base: 'trunk', method: 'squash', ...overrides,
  };
};

const serveStackProvider = ({ native = false, mergeStatus = 'merged', changedListHead = false, onWrite, failFollowUp = false } = {}) => {
  const bottom = pullRequest();
  bottom.head.repo.full_name = 'acme/app';
  bottom.base.repo.full_name = 'acme/app';
  bottom.base.repo.default_branch = 'main';
  const top = pullRequest({ number: 8,
    head: { ...bottom.head, ref: 'top', sha: 'top-sha' }, base: { ...bottom.base, ref: 'feature' } });
  const writes = [];
  const fetch = vi.fn(async (input, init) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    if (method !== 'GET' && url.pathname !== '/graphql') {
      writes.push({ path: url.pathname, method, body });
      await onWrite?.(url, init);
      if (url.pathname.endsWith('/stacks')) return jsonResponse({ number: 90 });
      if (url.pathname.endsWith('/merge-async')) return jsonResponse({ status: mergeStatus });
      if (url.pathname.endsWith('/merge')) return jsonResponse({ merged: true });
      if (failFollowUp && url.pathname.endsWith('/pulls/8')) return jsonResponse({ message: 'Retarget forbidden' }, 403);
      const pr = url.pathname.endsWith('/8') ? top : bottom;
      return jsonResponse({ ...pr, base: { ...pr.base, ref: body.base } });
    }
    if (url.pathname === '/repos/acme/app/pulls/7') return jsonResponse(bottom);
    if (url.pathname === '/repos/acme/app/pulls/8') return jsonResponse(top);
    if (url.pathname === '/repos/acme/app/pulls') return jsonResponse((url.searchParams.get('state') === 'open'
      ? [changedListHead ? { ...bottom, head: { ...bottom.head, sha: 'new-head' } } : bottom, top] : [])
      .map(({ merged: _merged, ...listed }) => listed));
    if (url.pathname === '/repos/acme/app/stacks') return jsonResponse(native
      ? [{ number: 90, open: true, pull_requests: [bottom, top] }] : []);
    if (url.pathname.startsWith('/repos/acme/app/compare/')) return jsonResponse({ behind_by: 0, commits: [] });
    if (url.pathname === '/graphql') return jsonResponse({ data: {} });
    throw new Error(`Unexpected fixture request ${method} ${url.pathname}`);
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, writes };
};

const makeApp = ({ store = makeStore(), validateReadContext, validateMutationContext, resolveRepo, resolveNetwork, resolveStatus, git, modules } = {}) => {
  const app = express();
  app.use(express.json());
  const routeOptions = {
    validateReadContext: validateReadContext ?? (async (input) => input),
    validateMutationContext: validateMutationContext ?? (async (body) => ({ ...body, target: { ...body.target, project: { ...body.target.project } } })),
    mutationExecutor: createMutationExecutor({ store }),
    resolveGitHubRepoFromDirectory: resolveRepo ?? (async (_directory, remote) => ({
      repo: remote === 'upstream' ? { owner: 'upstream', repo: 'app' } : { owner: 'acme', repo: 'app' },
    })),
    resolveRepoNetwork: resolveNetwork ?? (async () => null),
  };
  if (resolveStatus) routeOptions.resolveGitHubPrStatus = resolveStatus;
  if (git) Object.assign(routeOptions, git);
  if (modules) routeOptions.modules = modules;
  const service = registerGitHubRoutes(app, routeOptions);
  return { app, store, service };
};

let directory;
let previousDataDirectory;

beforeEach(async () => {
  // The auth store resolves its directory at import, so the isolated data
  // directory must be in place before the module loads — otherwise fixture
  // accounts land in the person's real store.
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-github-mutations-'));
  previousDataDirectory = process.env.OPENCHAMBER_DATA_DIR;
  process.env.OPENCHAMBER_DATA_DIR = directory;
  vi.resetModules();
  auth = await import('../github/auth.js');
  ({ registerGitHubRoutes } = await import('./provider-routes.github.test-support.js'));
});

afterEach(async () => {
  if (previousDataDirectory === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = previousDataDirectory;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('canonical GitHub mutations', () => {
  it.each(['register', 'retarget', 'merge'])('accepts the real web adapter through the stack %s route and replays its exact result', async (kind) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const provider = serveStackProvider();
    const { app } = makeApp();
    const { createWebPullStackAPI } = await import('../../../src/api/pull-stacks.ts');
    const api = createWebPullStackAPI(async (endpoint, options) => {
      const response = await request(app).post(endpoint).send(JSON.parse(options.body));
      return Response.json(response.body, { status: response.status });
    });
    const payload = stackPayload(account.accountId, kind);
    const pull = { owner: payload.owner, repo: payload.repo, number: payload.number };
    const execute = () => kind === 'register' ? api.githubPullStackRegister(payload, pull)
      : kind === 'retarget' ? api.githubPullStackRetarget(payload, { ...pull, base: payload.base })
        : api.githubPullStackMerge(payload, { ...pull, method: payload.method });
    const first = await execute();
    if (kind === 'register') expect(first).toEqual({ ok: true, registered: true, nativeNumber: 90 });
    if (kind === 'retarget') expect(first).toEqual({ ok: true });
    if (kind === 'merge') expect(first).toEqual({ ok: true, merged: true, status: 'merged', retargeted: 8 });
    provider.fetch.mockClear();
    expect(await execute()).toEqual(first);
    expect(provider.fetch).not.toHaveBeenCalled();
  });

  it('keeps stack GET read-authorized without mutation admission or durable execution', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const provider = serveStackProvider();
    const validateMutationContext = vi.fn(async () => { throw new Error('Write admission must not run'); });
    const { app, store } = makeApp({ validateMutationContext });
    const { target: _target, idempotencyKey: _key, ...readContext } = context(account.accountId);
    const response = await request(app).get('/api/source-control/github/pulls/stack')
      .query({ ...readContext, owner: 'acme', repo: 'app', number: 7 }).expect(200);
    expect(response.body.stack.members.map((member) => member.number)).toEqual([7, 8]);
    expect(validateMutationContext).not.toHaveBeenCalled();
    expect(store.records.size).toBe(0);
    expect(provider.writes).toEqual([]);
  });

  it('finds the stack parent of a local branch from the open PR heads and its own commits', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    serveStackProvider();
    const runGitCommand = vi.fn(async (_directory, args) => (args[0] === 'rev-list'
      ? { success: true, stdout: 'own\ntop-sha\nabc123\n' }
      : { success: true, stdout: 'sha\n' }));
    const { app, store } = makeApp({ git: {
      runGitCommand, getBranchBase: async () => ({ base: 'top' }), listGitRemotes: async () => [{ name: 'origin' }],
    } });
    const { target: _target, idempotencyKey: _key, ...readContext } = context(account.accountId);
    const response = await request(app).get('/api/source-control/github/pulls/stack/parent')
      .query({ ...readContext, owner: 'acme', repo: 'app', branch: 'next' }).expect(200);
    expect(response.body).toEqual({ connected: true, result: {
      status: 'found', via: 'ancestry', parent: { number: 8, head: 'top', title: 'Title', url: 'https://github.com/acme/app/pull/7' },
    } });
    expect(runGitCommand).toHaveBeenCalledWith('/repo', ['rev-list', '--topo-order', '--max-count=1001', 'refs/heads/next', '--not', 'refs/remotes/origin/main']);
    expect(store.records.size).toBe(0);
  });

  it('answers stack membership of several PRs through the real web adapter', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    serveStackProvider();
    const { app } = makeApp();
    const { createWebPullStackAPI } = await import('../../../src/api/pull-stacks.ts');
    const api = createWebPullStackAPI(async (endpoint, options) => {
      const response = await request(app).get(endpoint).query(Object.fromEntries(options.query));
      return Response.json(response.body, { status: response.status });
    });
    const { target: _target, idempotencyKey: _key, ...readContext } = context(account.accountId);
    expect(await api.githubPullStackMembership(readContext, { owner: 'acme', repo: 'app', numbers: [7, 8, 99] }))
      .toEqual({ connected: true, members: { 7: true, 8: true, 99: null } });
    await request(app).get('/api/source-control/github/pulls/stack/membership').query({ ...readContext, owner: 'acme', repo: 'app', numbers: 'x' }).expect(400);
  });

  it('fails the stack parent read instead of answering none when GitHub cannot list the PRs', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'unavailable' }, 502)));
    const { app } = makeApp({ git: { runGitCommand: vi.fn(), getBranchBase: vi.fn(), listGitRemotes: async () => [] } });
    const { target: _target, idempotencyKey: _key, ...readContext } = context(account.accountId);
    const response = await request(app).get('/api/source-control/github/pulls/stack/parent')
      .query({ ...readContext, owner: 'acme', repo: 'app', branch: 'next' });
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.body.result).toBeUndefined();
  });

  it('rejects a stack parent read without a safe branch or outside the fork network', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const provider = serveStackProvider();
    const { app } = makeApp();
    const { target: _target, idempotencyKey: _key, ...readContext } = context(account.accountId);
    await request(app).get('/api/source-control/github/pulls/stack/parent').query({ ...readContext, owner: 'acme', repo: 'app' }).expect(400);
    await request(app).get('/api/source-control/github/pulls/stack/parent').query({ ...readContext, owner: 'acme', repo: 'app', branch: '--all' }).expect(400);
    await request(app).get('/api/source-control/github/pulls/stack/parent').query({ ...readContext, owner: 'outside', repo: 'app', branch: 'next' }).expect(400);
    expect(provider.fetch).not.toHaveBeenCalled();
  });

  it.each(['register', 'retarget', 'merge'])('rejects out-of-network stack %s before provider work', async (kind) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const provider = serveStackProvider();
    const { app } = makeApp();
    const payload = stackPayload(account.accountId, kind);
    payload.target.project.owner = 'outside';
    const response = await request(app).post(`/api/source-control/github/pulls/stack/${kind}`).send(payload).expect(409);
    expect(response.body.code).toBe('SOURCE_CONTROL_MUTATION_TARGET_INVALID');
    expect(provider.fetch).not.toHaveBeenCalled();
  });

  it.each(['register', 'retarget', 'merge'])('rejects alternate stack %s selectors and missing exact credentials', async (kind) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const provider = serveStackProvider();
    const { app } = makeApp();
    const route = `/api/source-control/github/pulls/stack/${kind}`;
    for (const selector of [{ owner: 'outside' }, { repo: 'other' }, { number: 99 }]) {
      const response = await request(app).post(route).send(stackPayload(account.accountId, kind, selector)).expect(409);
      expect(response.body.code).toBe('SOURCE_CONTROL_MUTATION_TARGET_INVALID');
    }
    await request(app).post(route).send(stackPayload('missing-credential', kind)).expect(401);
    expect(provider.fetch).not.toHaveBeenCalled();
  });

  it.each(['register', 'retarget', 'merge'])('joins simultaneous stack %s requests under one durable key', async (kind) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const provider = serveStackProvider();
    const { app } = makeApp();
    const payload = stackPayload(account.accountId, kind);
    const route = `/api/source-control/github/pulls/stack/${kind}`;
    const responses = await Promise.all([request(app).post(route).send(payload), request(app).post(route).send(payload)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses.map((response) => response.body.replayed).sort()).toEqual([false, true]);
    expect(provider.writes).toHaveLength(kind === 'merge' ? 2 : 1);
  });

  it.each(['register', 'merge'])('never dispatches a recovered running stack %s record', async (kind) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const provider = serveStackProvider();
    const store = makeStore();
    const { app } = makeApp({ store });
    const payload = stackPayload(account.accountId, kind);
    const route = `/api/source-control/github/pulls/stack/${kind}`;
    await request(app).post(route).send(payload).expect(200);
    const completed = store.records.get('request-one');
    const { result: _result, ...record } = completed;
    store.records.set('request-one', { ...record, state: 'running' });
    provider.fetch.mockClear();
    const restarted = makeApp({ store });
    const response = await request(restarted.app).post(route).send(payload).expect(409);
    expect(response.body.code).toBe('SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN');
    expect(provider.fetch).not.toHaveBeenCalled();
    expect(store.records.get('request-one').state).toBe('outcome-unknown');
  });

  it('distinguishes stack operations and changed input sharing an idempotency key', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const provider = serveStackProvider();
    const { app } = makeApp();
    const payload = stackPayload(account.accountId, 'retarget');
    await request(app).post('/api/source-control/github/pulls/stack/retarget').send(payload).expect(200);
    provider.fetch.mockClear();
    for (const [route, body] of [
      ['pulls/stack/retarget', { ...payload, base: 'different' }],
      ['pulls/stack/register', payload],
      ['pr/update', { ...payload, title: 'Title' }],
      ['pulls/stack/merge', payload],
    ]) {
      const response = await request(app).post(`/api/source-control/github/${route}`).send(body).expect(409);
      expect(response.body.code).toBe('SOURCE_CONTROL_MUTATION_CONFLICT');
    }
    expect(provider.fetch).not.toHaveBeenCalled();
  });

  it.each(['register', 'retarget', 'merge'])('durably executes stack %s once and replays without provider preflight', async (kind) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    await auth.setGitHubAuth({ accessToken: 'token-two', user: { id: 2, login: 'ambient' } });
    const store = createMutationStore({ filePath: path.join(directory, 'stack-mutations.json') });
    const provider = serveStackProvider({ onWrite: async (_url, init) => {
      expect(init.headers.authorization).toBe('token token-one');
      expect(await store.read('request-one')).toMatchObject({ state: 'running', target: { headSha: kind === 'register' ? 'top-sha' : 'abc123' } });
    } });
    const { app } = makeApp({ store });
    const route = `/api/source-control/github/pulls/stack/${kind}`;
    const payload = stackPayload(account.accountId, kind);

    const first = await request(app).post(route).send(payload).expect(200);
    expect(first.body).toMatchObject({ status: 'succeeded', replayed: false,
      actor: { providerAccountId: account.providerUserId }, target: { number: payload.target.number, headSha: payload.target.headSha } });
    const record = await store.read('request-one');
    expect(record).toMatchObject({ state: 'succeeded', kind: kind === 'merge' ? 'change-request-merge' : 'change-request-update' });
    // Records written by the fork before the provider migration retain their exact digest.
    const fields = kind === 'retarget' ? { base: payload.base } : kind === 'merge' ? { method: payload.method } : {};
    expect(record.inputDigest).toBe(digestMutationInput({ kind: `stack-${kind}`,
      actor: { provider: 'github', instance: 'github.com', accountId: account.accountId }, credential: credentialFor(account),
      target: { repositoryId: payload.repositoryId, bindingRevision: payload.bindingRevision, primaryRemote: payload.primaryRemote,
        ...payload.target, project: { id: 'acme/app', ...payload.target.project } }, ...fields }));
    expect(provider.writes.length).toBe(kind === 'merge' ? 2 : 1);
    if (kind === 'merge') expect(provider.writes[0].body.sha).toBe('abc123');
    provider.fetch.mockClear();

    // A fresh executor and store exercise persisted replay after restart.
    const restarted = makeApp({ store: createMutationStore({ filePath: path.join(directory, 'stack-mutations.json') }),
      resolveRepo: async () => { throw new Error('Replay must not preflight'); } });
    const replay = await request(restarted.app).post(route).send(payload).expect(200);
    expect(replay.body).toMatchObject({ ...first.body, replayed: true });
    expect(provider.fetch).not.toHaveBeenCalled();
  });

  it.each(['register', 'retarget', 'merge'])('requires canonical dependencies and an exact head for stack %s', async (kind) => {
    const app = express();
    app.use(express.json());
    registerGitHubRoutes(app, {});
    const route = `/api/source-control/github/pulls/stack/${kind}`;
    const missing = await request(app).post(route).send({}).expect(501);
    expect(missing.body.code).toBe('SOURCE_CONTROL_MUTATIONS_UNAVAILABLE');
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const provider = serveStackProvider();
    const bound = makeApp();
    const payload = stackPayload(account.accountId, kind);
    delete payload.target.headSha;
    await request(bound.app).post(route).send(payload).expect(400);
    expect(provider.fetch).not.toHaveBeenCalled();
  });

  it.each(['register', 'retarget', 'merge'])('rejects changed stack %s targets before any write', async (kind) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const provider = serveStackProvider();
    const { app } = makeApp();
    const payload = stackPayload(account.accountId, kind);
    payload.target.headSha = 'stale-head';
    const response = await request(app).post(`/api/source-control/github/pulls/stack/${kind}`).send(payload).expect(409);
    expect(response.body.code).toBe('SOURCE_CONTROL_MUTATION_TARGET_CHANGED');
    expect(provider.writes).toEqual([]);
  });

  it.each(['register', 'retarget', 'merge'])('keeps ambiguous stack %s writes sticky across retries', async (kind) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const provider = serveStackProvider({ onWrite: () => { throw new Error('Response lost'); } });
    const { app, store } = makeApp();
    const route = `/api/source-control/github/pulls/stack/${kind}`;
    const payload = stackPayload(account.accountId, kind);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await request(app).post(route).send(payload).expect(409);
      expect(response.body.code).toBe('SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN');
    }
    expect(provider.writes).toHaveLength(1);
    expect(store.records.get('request-one').state).toBe('outcome-unknown');
  });

  it('does not repeat a merge after its follow-up retarget fails with a definite provider rejection', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const provider = serveStackProvider({ failFollowUp: true });
    const { app, store } = makeApp();
    const payload = stackPayload(account.accountId, 'merge');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await request(app).post('/api/source-control/github/pulls/stack/merge').send(payload).expect(409);
      expect(response.body.code).toBe('SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN');
    }
    expect(provider.writes.map((write) => write.path)).toEqual(['/repos/acme/app/pulls/7/merge', '/repos/acme/app/pulls/8']);
    expect(store.records.get('request-one').state).toBe('outcome-unknown');
  });

  it('refuses a newer stack snapshot before dispatching a merge', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const provider = serveStackProvider({ changedListHead: true });
    const { app } = makeApp();
    const response = await request(app).post('/api/source-control/github/pulls/stack/merge')
      .send(stackPayload(account.accountId, 'merge')).expect(409);
    expect(response.body.code).toBe('SOURCE_CONTROL_MUTATION_TARGET_CHANGED');
    expect(provider.writes).toEqual([]);
  });

  it.each(['merged', 'enqueued', 'pending'])('pins native stack merge dispatch and records %s without resubmitting', async (status) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const provider = serveStackProvider({ native: true, mergeStatus: status });
    const { app } = makeApp();
    const payload = stackPayload(account.accountId, 'merge');
    const route = '/api/source-control/github/pulls/stack/merge';
    const first = await request(app).post(route).send(payload).expect(200);
    expect(first.body.result).toEqual({ ok: true, merged: status === 'merged', status, retargeted: null });
    await request(app).post(route).send(payload).expect(200);
    expect(provider.writes).toEqual([{ path: '/repos/acme/app/pulls/7/merge-async', method: 'PUT',
      body: { merge_method: 'squash', sha: 'abc123', merge_action: 'default' } }]);
  });

  it.each(['register', 'retarget', 'merge'])('refuses stack %s when a granted transport changed, while read authority remains valid', async (kind) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const fetchEndpoint = { displayUrl: 'https://github.com/acme/app.git', fingerprint: 'fetch' };
    const pushEndpoint = { displayUrl: 'git@github.com:acme/app.git', fingerprint: 'push' };
    const binding = {
      repositoryId: 'repo-one', revision: 3, configRevision: 'original', state: 'bound', auxiliary: [],
      providers: [{ provider: 'github', instance: 'github.com', accountId: account.accountId,
        primaryRemote: 'origin', readiness: 'ready', endpoint: fetchEndpoint }],
      remotes: [{ name: 'origin', fetch: fetchEndpoint, push: pushEndpoint, mode: 'system', readiness: 'ready' }],
    };
    const bindings = createBindingService({
      store: { read: async () => ({ revision: 3, binding }), compareAndSwap: vi.fn() },
      resolveRepository: async () => ({ supported: true, directory: '/repo', repositoryId: 'repo-one',
        configRevision: 'changed', bare: false, remotes: [{ name: 'origin', fetch: fetchEndpoint,
          push: { displayUrl: 'git@github.com:other/app.git', fingerprint: 'changed' } }] }),
    });
    const { target: _target, idempotencyKey: _key, ...readContext } = context(account.accountId);
    await expect(bindings.validateReadContext(readContext)).resolves.toMatchObject(readContext);
    const validateMutationContext = vi.fn(bindings.validateMutationContext);
    const fetch = vi.fn(async () => jsonResponse(pullRequest()));
    vi.stubGlobal('fetch', fetch);
    const resolveRepo = vi.fn(async () => ({ repo: { owner: 'acme', repo: 'app' } }));
    const { app, store } = makeApp({ validateReadContext: bindings.validateReadContext, validateMutationContext, resolveRepo });

    const response = await request(app).post(`/api/source-control/github/pulls/stack/${kind}`).query(readContext)
      .send({ ...context(account.accountId, { target: { project: { owner: 'acme', name: 'app' }, number: 7, headSha: 'abc123' } }),
        owner: 'acme', repo: 'app', number: 7, base: 'main', method: 'squash' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('SOURCE_CONTROL_BINDING_STALE');
    expect(validateMutationContext).toHaveBeenCalledOnce();
    expect(resolveRepo).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(store.records.size).toBe(0);
  });

  it('fails closed without canonical mutation dependencies', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const app = express();
    app.use(express.json());
    registerGitHubRoutes(app, {
      resolveGitHubRepoFromDirectory: async () => ({ repo: { owner: 'acme', repo: 'app' } }),
    });

    const canonical = await request(app).post('/api/source-control/github/pr/create')
      .send({ ...context(account.accountId), title: 'Title' }).expect(501);
    expect(canonical.body.code).toBe('SOURCE_CONTROL_MUTATIONS_UNAVAILABLE');
  });

  it.each([
    ['busy lock', Object.assign(new Error('Stop all writers before stale-lock cleanup'), { status: 503, code: 'SOURCE_CONTROL_LOCK_BUSY' })],
    ['failed lock', Object.assign(new Error('Stop all writers before stale-lock cleanup'), { status: 500, code: 'SOURCE_CONTROL_LOCK_FAILED' })],
    ['missing account', Object.assign(new Error('accountId is required'), { status: 400, code: 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT' })],
    ['stale binding', Object.assign(new Error('Source control repository binding changed'), {
      status: 409,
      code: 'SOURCE_CONTROL_BINDING_STALE',
      current: { repositoryId: 'repo-two', bindingRevision: 4 },
    })],
  ])('rejects %s before credentials, repository resolution, or provider work', async (_label, validationError) => {
    const resolveRepo = vi.fn();
    const resolveNetwork = vi.fn();
    const validateMutationContext = vi.fn(async () => { throw validationError; });
    const { app } = makeApp({ validateMutationContext, resolveRepo, resolveNetwork });
    const response = await request(app).post('/api/source-control/github/pr/create').send({ title: 'private' });

    expect(response.status).toBe(validationError.status);
    expect(response.body.code).toBe(validationError.code);
    expect(response.body.error).toBe(validationError.message);
    if (validationError.current) expect(response.body.current).toEqual(validationError.current);
    expect(resolveRepo).not.toHaveBeenCalled();
    expect(resolveNetwork).not.toHaveBeenCalled();
  });

  it('rejects targets outside the strict fork network before mutation', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const resolveNetwork = vi.fn(async () => [
      { owner: 'acme', repo: 'app', url: 'https://github.com/acme/app', source: 'origin' },
      { owner: 'upstream', repo: 'app', url: 'https://github.com/upstream/app', source: 'upstream' },
    ]);
    const { app } = makeApp({ resolveNetwork });
    const payload = context(account.accountId, { target: { project: { owner: 'other', name: 'app' }, head: 'feature', base: 'main' } });

    const response = await request(app).post('/api/source-control/github/pr/create').send({ ...payload, title: 'Title' }).expect(409);
    expect(response.body.code).toBe('SOURCE_CONTROL_MUTATION_TARGET_INVALID');
    expect(fetch).not.toHaveBeenCalled();
    expect(resolveNetwork).toHaveBeenCalledOnce();
  });

  it('fails once on ambiguous fork metadata without provider mutation retry', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const resolveNetwork = vi.fn(async () => [
      { owner: 'upstream', repo: 'app', url: 'https://github.com/upstream/app', source: 'upstream' },
    ]);
    const { app } = makeApp({ resolveNetwork });

    const response = await request(app).post('/api/source-control/github/pr/create')
      .send({ ...context(account.accountId), title: 'Title' }).expect(500);
    expect(response.body.code).toBe('MALFORMED_PROVIDER_RESPONSE');
    expect(resolveNetwork).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a changed explicit remote and an arbitrary source remote', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    vi.stubGlobal('fetch', vi.fn());
    const resolveRepo = async (_directory, remote) => ({
      repo: remote === 'changed' ? { owner: 'other', repo: 'app' }
        : remote === 'source' ? { owner: 'attacker', repo: 'app' }
          : { owner: 'acme', repo: 'app' },
    });
    const { app } = makeApp({ resolveRepo });
    const payload = { ...context(account.accountId), title: 'Title' };

    await request(app).post('/api/source-control/github/pr/create').send({ ...payload, remote: 'changed' }).expect(409);
    await request(app).post('/api/source-control/github/pr/create').send({ ...payload, idempotencyKey: 'two', headRemote: 'source' }).expect(409);
  });

  it('uses the validated actor even after another account becomes active', async () => {
    const acting = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    await auth.setGitHubAuth({ accessToken: 'token-two', user: { id: 2, login: 'active' } });
    const fetch = vi.fn(async (_url, options) => {
      expect(options.headers.authorization).toBe('token token-one');
      return jsonResponse(pullRequest());
    });
    vi.stubGlobal('fetch', fetch);
    const { app } = makeApp();

    const response = await request(app).post('/api/source-control/github/pr/create')
      .send({ ...context(acting.accountId), title: 'Title' }).expect(200);
    expect(response.body).toEqual({
      status: 'succeeded',
      actor: { provider: 'github', instance: 'github.com', providerAccountId: acting.providerUserId },
      target: {
        repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
        project: { id: 'acme/app', owner: 'acme', name: 'app' }, head: 'feature', base: 'main', number: 7,
      },
      replayed: false,
      result: {},
    });
  });

  it('refuses a created pull request whose base repository lives on another host', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const foreign = pullRequest();
    foreign.base = { ...foreign.base, repo: { ...foreign.base.repo, html_url: 'https://gitlab.com/acme/app' } };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(foreign)));
    const { app, store } = makeApp();

    const response = await request(app).post('/api/source-control/github/pr/create')
      .send({ ...context(account.accountId), title: 'Title' });
    expect(response.status).not.toBe(200);
    expect(store.records.get('request-one')?.result?.number).toBeUndefined();
  });

  it('records the created pull request number and names it in replayed receipts', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(pullRequest())));
    const { app, store } = makeApp();
    const payload = { ...context(account.accountId), title: 'Title' };

    const created = await request(app).post('/api/source-control/github/pr/create').send(payload).expect(200);
    expect(created.body).toMatchObject({ target: { number: 7 }, result: {} });
    expect(store.records.get('request-one')).toMatchObject({ state: 'succeeded', result: { number: 7 } });

    const replay = await request(app).post('/api/source-control/github/pr/create').send(payload).expect(200);
    expect(replay.body).toMatchObject({ replayed: true, target: { number: 7 }, result: {} });
  });

  it('keeps credential authority in replay input while deriving one provider actor for sibling credentials', async () => {
    const first = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const second = await auth.setGitHubAuth({ accessToken: 'token-two', user: { id: 1, login: 'renamed' } });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(pullRequest())));
    const { app, store } = makeApp();

    const firstResponse = await request(app).post('/api/source-control/github/pr/create').send({
      ...context(first.accountId), idempotencyKey: 'first', title: 'Title', providerUserId: 'github.com#999',
    }).expect(200);
    const secondResponse = await request(app).post('/api/source-control/github/pr/create').send({
      ...context(second.accountId), idempotencyKey: 'second', title: 'Title', providerUserId: 'github.com#999',
    }).expect(200);

    expect(firstResponse.body.actor).toEqual({ provider: 'github', instance: 'github.com', providerAccountId: 'github.com#1' });
    expect(secondResponse.body.actor).toEqual(firstResponse.body.actor);
    expect(store.records.get('first').actor.accountId).toBe(first.accountId);
    expect(store.records.get('second').actor.accountId).toBe(second.accountId);
    expect(store.records.get('first').inputDigest).not.toBe(store.records.get('second').inputDigest);
  });

  it('joins duplicate keys, replays completion, and conflicts on changed normalized input', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const fetch = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return jsonResponse(pullRequest());
    });
    vi.stubGlobal('fetch', fetch);
    const { app } = makeApp();
    const payload = { ...context(account.accountId), title: 'Title' };
    // The create itself, never the reads around it (the stack lookup after it).
    const creates = () => fetch.mock.calls.filter(([, options]) => options?.method === 'POST').length;

    const [owner, duplicate] = await Promise.all([
      request(app).post('/api/source-control/github/pr/create').send(payload),
      request(app).post('/api/source-control/github/pr/create').send(payload),
    ]);
    expect([owner.body.replayed, duplicate.body.replayed].sort()).toEqual([false, true]);
    expect(creates()).toBe(1);

    const replay = await request(app).post('/api/source-control/github/pr/create').send(payload).expect(200);
    expect(replay.body.replayed).toBe(true);
    expect(creates()).toBe(1);

    const conflict = await request(app).post('/api/source-control/github/pr/create')
      .send({ ...payload, title: 'Changed' }).expect(409);
    expect(conflict.body.code).toBe('SOURCE_CONTROL_MUTATION_CONFLICT');
    expect(creates()).toBe(1);
  });

  it.each([500, 502, 504])('records a provider %i after dispatch as outcome-unknown and never repeats it', async (status) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const fetch = vi.fn(async () => jsonResponse({ message: 'provider unavailable' }, status));
    vi.stubGlobal('fetch', fetch);
    const resolveRepo = vi.fn(async () => ({ repo: { owner: 'acme', repo: 'app' } }));
    const resolveNetwork = vi.fn(async () => null);
    const { app, store } = makeApp({ resolveRepo, resolveNetwork });
    const payload = { ...context(account.accountId), title: 'Title' };

    const initial = await request(app).post('/api/source-control/github/pr/create').send(payload).expect(409);
    expect(initial.body.code).toBe('SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN');
    expect(store.records.get('request-one')).toMatchObject({ state: 'outcome-unknown' });

    await request(app).post('/api/source-control/github/pr/create').send(payload).expect(409);
    expect(fetch).toHaveBeenCalledOnce();
    expect(resolveRepo).toHaveBeenCalledTimes(2);
    expect(resolveNetwork).toHaveBeenCalledOnce();
  });

  it('records a statusless socket failure after dispatch as outcome-unknown', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const fetch = vi.fn(async () => { throw Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }); });
    vi.stubGlobal('fetch', fetch);
    const { app, store } = makeApp();
    const payload = { ...context(account.accountId), title: 'Title' };

    await request(app).post('/api/source-control/github/pr/create').send(payload).expect(409);
    await request(app).post('/api/source-control/github/pr/create').send(payload).expect(409);
    expect(store.records.get('request-one')).toMatchObject({ state: 'outcome-unknown' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ['succeeded', {}, 200, 'succeeded'],
    ['failed', { failureStatus: 422, failureCode: 'GITHUB_MUTATION_REJECTED' }, 422, 'GITHUB_MUTATION_REJECTED'],
    ['outcome-unknown', undefined, 409, 'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN'],
  ])('replays a terminal %s record without repository, fork-network, PR, or provider access', async (state, result, status, expected) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const target = {
      repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
      project: { id: 'acme/app', owner: 'acme', name: 'app' }, head: 'feature', base: 'main',
    };
    const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
    const input = { kind: 'create', actor, credential: credentialFor(account), target, title: 'Title', headRemote: 'origin' };
    const record = {
      key: 'request-one', inputDigest: digestMutationInput(input), kind: 'change-request-create', actor, target, state,
    };
    if (result !== undefined) record.result = result;
    const resolveRepo = vi.fn(async () => { throw new Error('repository unavailable'); });
    const resolveNetwork = vi.fn(async () => { throw new Error('network unavailable'); });
    const fetch = vi.fn(async () => { throw new Error('provider unavailable'); });
    vi.stubGlobal('fetch', fetch);
    const { app } = makeApp({ store: makeStore([record]), resolveRepo, resolveNetwork });

    const response = await request(app).post('/api/source-control/github/pr/create')
      .send({ ...context(account.accountId), title: 'Title' }).expect(status);
    expect(status === 200 ? response.body.status : response.body.code).toBe(expected);
    expect(resolveRepo).not.toHaveBeenCalled();
    expect(resolveNetwork).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('conflicts on stored binding authority before provider preflight', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const target = {
      repositoryId: 'repo-other', bindingRevision: 3, primaryRemote: 'origin',
      project: { id: 'acme/app', owner: 'acme', name: 'app' }, head: 'feature', base: 'main',
    };
    const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
    const record = {
      key: 'request-one',
      inputDigest: digestMutationInput({ kind: 'create', actor, credential: credentialFor(account), target, title: 'Title', headRemote: 'origin' }),
      kind: 'change-request-create', actor, target, state: 'succeeded', result: {},
    };
    const resolveRepo = vi.fn();
    const resolveNetwork = vi.fn();
    const { app } = makeApp({ store: makeStore([record]), resolveRepo, resolveNetwork });

    const response = await request(app).post('/api/source-control/github/pr/create')
      .send({ ...context(account.accountId), title: 'Title' }).expect(409);
    expect(response.body.code).toBe('SOURCE_CONTROL_MUTATION_CONFLICT');
    expect(resolveRepo).not.toHaveBeenCalled();
    expect(resolveNetwork).not.toHaveBeenCalled();
  });

  it('replays a succeeded record despite changed provider repository state', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const target = {
      repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
      project: { id: 'acme/app', owner: 'acme', name: 'app' }, head: 'feature', base: 'main',
    };
    const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
    const record = {
      key: 'request-one',
      inputDigest: digestMutationInput({ kind: 'create', actor, credential: credentialFor(account), target, title: 'Title', headRemote: 'origin' }),
      kind: 'change-request-create', actor, target, state: 'succeeded', result: {},
    };
    const resolveRepo = vi.fn(async () => ({ repo: { owner: 'moved', repo: 'elsewhere' } }));
    const resolveNetwork = vi.fn(async () => [{ owner: 'moved', repo: 'elsewhere', source: 'origin' }]);
    const { app } = makeApp({ store: makeStore([record]), resolveRepo, resolveNetwork });

    const response = await request(app).post('/api/source-control/github/pr/create')
      .send({ ...context(account.accountId), title: 'Title' }).expect(200);
    expect(response.body).toMatchObject({ status: 'succeeded', replayed: true, result: {} });
    expect(resolveRepo).not.toHaveBeenCalled();
    expect(resolveNetwork).not.toHaveBeenCalled();
  });

  it('replays when the stored target has provider metadata omitted by the request', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
    const target = {
      repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
      project: { id: 'acme/app', owner: 'acme', name: 'app' },
      number: 7, head: 'feature', base: 'main', headSha: 'abc123',
    };
    const record = {
      key: 'request-one',
      inputDigest: digestMutationInput({ kind: 'update', actor, credential: credentialFor(account), target, title: 'Updated' }),
      kind: 'change-request-update', actor, target, state: 'succeeded', result: {},
    };
    const resolveRepo = vi.fn(async () => { throw new Error('repository unavailable'); });
    const fetch = vi.fn(async () => { throw new Error('provider unavailable'); });
    vi.stubGlobal('fetch', fetch);
    const { app } = makeApp({ store: makeStore([record]), resolveRepo });

    const response = await request(app).post('/api/source-control/github/pr/update').send({
      ...context(account.accountId, {
        target: { project: { owner: 'acme', name: 'app' }, number: 7 },
      }),
      title: 'Updated',
    }).expect(200);

    expect(response.body.replayed).toBe(true);
    expect(response.body.target).toEqual(target);
    expect(resolveRepo).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires the exact local account before terminal replay', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const target = {
      repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
      project: { id: 'acme/app', owner: 'acme', name: 'app' }, head: 'feature', base: 'main',
    };
    const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
    const record = {
      key: 'request-one',
      inputDigest: digestMutationInput({ kind: 'create', actor, credential: credentialFor(account), target, title: 'Title', headRemote: 'origin' }),
      kind: 'change-request-create', actor, target, state: 'succeeded', result: {},
    };
    const store = makeStore([record]);
    const read = vi.spyOn(store, 'read');
    await auth.removeGitHubAuthAccountForHost('github.com', account.accountId);
    const { app } = makeApp({ store });

    await request(app).post('/api/source-control/github/pr/create')
      .send({ ...context(account.accountId), title: 'Title' }).expect(401);
    expect(read).not.toHaveBeenCalled();
  });

  it('stacks a new PR on the open PR whose branch it targets, and says when GitHub would not', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const base = pullRequest().base;
    const onLower = (overrides) => pullRequest({ base: { ...base, ref: 'lower', repo: { ...base.repo, default_branch: 'main' } }, ...overrides });
    let existingStack = null;
    let refuse = false;
    const writes = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      const { pathname, searchParams } = new URL(url);
      if (options.method === 'POST' && pathname === '/repos/acme/app/pulls') return jsonResponse(onLower({ number: 8 }), 201);
      if (pathname === '/repos/acme/app/pulls' && searchParams.get('head') === 'acme:lower') {
        return jsonResponse([pullRequest({ number: 6, head: { ...pullRequest().head, ref: 'lower' } })]);
      }
      if (pathname === '/repos/acme/app/stacks' && options.method === 'GET') return jsonResponse(existingStack ? [existingStack] : []);
      if (pathname.startsWith('/repos/acme/app/stacks') && options.method === 'POST') {
        writes.push({ path: pathname, body: JSON.parse(options.body) });
        return refuse ? jsonResponse({ message: 'Validation failed' }, 422) : jsonResponse({ number: 3 }, pathname.endsWith('/add') ? 200 : 201);
      }
      return jsonResponse(pullRequest());
    }));
    const { app } = makeApp();
    const create = (key) => request(app).post('/api/source-control/github/pr/create').send({
      ...context(account.accountId, { idempotencyKey: key, target: { project: { owner: 'acme', name: 'app' }, head: 'feature', base: 'lower' } }),
      title: 'Title',
    }).expect(200);

    // No stack yet: the parent and the new PR start one, bottom first.
    expect((await create('one')).body).toMatchObject({ target: { number: 8 }, result: { stacked: true } });
    expect(writes.at(-1)).toEqual({ path: '/repos/acme/app/stacks', body: { pull_requests: [6, 8] } });

    // The parent tops a stack: the new PR joins it.
    existingStack = { number: 3 };
    expect((await create('two')).body.result).toEqual({ stacked: true });
    expect(writes.at(-1)).toEqual({ path: '/repos/acme/app/stacks/3/add', body: { pull_requests: [8] } });

    // GitHub refuses: the PR stands on its base, outside the stack.
    refuse = true;
    expect((await create('three')).body.result).toEqual({ stacked: false });
  });

  it('never stacks a PR into the default branch on an open PR out of it, such as a release PR', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const base = pullRequest().base;
    const paths = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      const { pathname } = new URL(url);
      paths.push(`${options.method} ${pathname}`);
      if (options.method === 'POST' && pathname === '/repos/acme/app/pulls') {
        return jsonResponse(pullRequest({ number: 8, base: { ...base, repo: { ...base.repo, default_branch: 'main' } } }), 201);
      }
      // An open release PR from main would otherwise read as the parent.
      if (pathname === '/repos/acme/app/pulls') return jsonResponse([pullRequest({ number: 2, head: { ...pullRequest().head, ref: 'main' } })]);
      return jsonResponse(pullRequest());
    }));
    const { app } = makeApp();
    const response = await request(app).post('/api/source-control/github/pr/create')
      .send({ ...context(account.accountId), title: 'Title' }).expect(200);
    expect(response.body.result).toEqual({});
    expect(paths.some((path) => path.includes('/stacks'))).toBe(false);
  });

  it('revalidates an existing target once before update and performs one write without another lookup', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const methods = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      methods.push(options.method);
      return jsonResponse(pullRequest({ title: options.method === 'PATCH' ? 'Changed' : 'Title' }));
    }));
    const { app } = makeApp();
    const target = { project: { owner: 'acme', name: 'app' }, number: 7, head: 'feature', base: 'main', headSha: 'abc123' };

    const response = await request(app).post('/api/source-control/github/pr/update')
      .send({ ...context(account.accountId, { target }), title: 'Changed', body: 'private body' }).expect(200);
    expect(response.body.result).toEqual({});
    expect(response.body.target).toMatchObject({ number: 7, head: 'feature', base: 'main', headSha: 'abc123' });
    expect(methods).toEqual(['GET', 'PATCH']);
  });

  const mergeBody = (accountId) => ({
    ...context(accountId, {
      target: {
        project: { owner: 'acme', name: 'app' }, number: 7,
        head: 'feature', base: 'main', headSha: 'abc123',
      },
    }),
    method: 'merge',
  });

  it('binds merge to the exact head SHA validated before dispatch, through the asynchronous merge', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      requests.push({ method: options.method, path: new URL(url).pathname, body: options.body ? JSON.parse(options.body) : null });
      if (new URL(url).pathname === '/repos/acme/app/pulls') return jsonResponse([]);
      return options.method === 'GET'
        ? jsonResponse(pullRequest())
        : jsonResponse({ status: 'merged', details: { message: 'Merged', sha: 'def456' } });
    }));
    const { app } = makeApp();

    const response = await request(app).post('/api/source-control/github/pr/merge').send(mergeBody(account.accountId)).expect(200);

    expect(response.body.result).toEqual({ merged: true });
    expect(requests).toEqual([
      { method: 'GET', path: '/repos/acme/app/pulls/7', body: null },
      { method: 'GET', path: '/repos/acme/app/pulls', body: null },
      { method: 'PUT', path: '/repos/acme/app/pulls/7/merge-async', body: { merge_method: 'merge', sha: 'abc123', bypass_rules: true } },
    ]);
  });

  it('follows a background merge until it lands, and says so when it joins a merge queue', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    let final = 'merged';
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      const { pathname } = new URL(url);
      if (options.method === 'PUT') {
        return jsonResponse({ status: 'pending', details: { message: 'Merging', uuid: 'u-1', merge_method: 'merge', merge_action: 'default', expected_head_sha: 'abc123' } }, 202);
      }
      if (pathname.endsWith('/merge-async/u-1')) return jsonResponse({ status: final, details: { message: 'Done' } });
      if (pathname === '/repos/acme/app/pulls') return jsonResponse([]);
      return jsonResponse(pullRequest());
    }));
    const { app } = makeApp();

    expect((await request(app).post('/api/source-control/github/pr/merge').send(mergeBody(account.accountId)).expect(200)).body.result)
      .toEqual({ merged: true });
    final = 'enqueued';
    expect((await request(app).post('/api/source-control/github/pr/merge').send({ ...mergeBody(account.accountId), idempotencyKey: 'request-two' }).expect(200)).body.result)
      .toEqual({ merged: false, outcome: 'queued' });
  });

  it('enables auto-merge after a rule-blocked async result and cancels it through durable receipts', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    let autoMergeRequest = null;
    const queries = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      if (new URL(url).pathname === '/graphql') {
        const { query, variables } = JSON.parse(options.body);
        queries.push({ query, variables });
        if (query.includes('enablePullRequestAutoMerge')) {
          autoMergeRequest = { enabledAt: '2026-11-03T12:00:00Z', mergeMethod: 'MERGE' };
          return jsonResponse({ data: { enablePullRequestAutoMerge: { pullRequest: { autoMergeRequest } } } });
        }
        if (query.includes('disablePullRequestAutoMerge')) {
          autoMergeRequest = null;
          return jsonResponse({ data: { disablePullRequestAutoMerge: { pullRequest: { autoMergeRequest } } } });
        }
        return jsonResponse({ data: { repository: { mergeQueue: null, pullRequest: {
          id: 'PR_7', state: 'OPEN', headRefOid: 'abc123', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', isInMergeQueue: false, autoMergeRequest,
        } } } });
      }
      if (options.method === 'PUT') return jsonResponse({ status: 'failed', details: { message: 'Required checks have not passed' } });
      if (new URL(url).pathname === '/repos/acme/app/pulls' && new URL(url).searchParams.has('head')) return jsonResponse([]);
      return jsonResponse(pullRequest());
    }));
    const { app } = makeApp();
    const body = mergeBody(account.accountId);
    const enabled = await request(app).post('/api/source-control/github/pr/merge').send(body);
    expect(enabled.status).toBe(200);
    expect(queries).toHaveLength(2);
    expect(enabled.body).toMatchObject({ status: 'succeeded', result: { merged: false, outcome: 'auto-merge' } });
    expect(queries[1].variables.sha).toBe('abc123');
    const cancelled = { ...body, idempotencyKey: 'request-cancel', cancel: true };
    expect((await request(app).post('/api/source-control/github/pr/merge').send(cancelled).expect(200)).body.result)
      .toEqual({ merged: false, outcome: 'cancelled' });
    const count = queries.length;
    expect((await request(app).post('/api/source-control/github/pr/merge').send(cancelled).expect(200)).body.replayed).toBe(true);
    expect(queries).toHaveLength(count);
  });

  it('reports an accepted merge as running when following it fails, and passes on a refusal GitHub explains', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    let refuse = false;
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      const { pathname } = new URL(url);
      if (options.method === 'PUT') {
        return refuse
          ? jsonResponse({ message: 'Head branch was modified. Review and try the merge again.' }, 409)
          : jsonResponse({ status: 'pending', details: { message: 'Merging', uuid: 'u-1' } }, 202);
      }
      if (pathname.endsWith('/merge-async/u-1')) return jsonResponse({ message: 'Server Error' }, 502);
      if (pathname === '/repos/acme/app/pulls') return jsonResponse([]);
      return jsonResponse(pullRequest());
    }));
    const { app } = makeApp();

    expect((await request(app).post('/api/source-control/github/pr/merge').send(mergeBody(account.accountId)).expect(200)).body.result)
      .toEqual({ merged: false, outcome: 'merging' });
    refuse = true;
    const refused = await request(app).post('/api/source-control/github/pr/merge')
      .send({ ...mergeBody(account.accountId), idempotencyKey: 'request-two' }).expect(409);
    expect(refused.body).toEqual({ error: 'Head branch was modified. Review and try the merge again.', code: 'SOURCE_CONTROL_MUTATION_REJECTED' });
  });

  it('answers with GitHub\'s reason when a background merge fails, and merges the classic way on a host without it', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    let asyncAvailable = true;
    const paths = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      const { pathname } = new URL(url);
      paths.push(`${options.method} ${pathname}`);
      if (pathname === '/repos/acme/app/pulls') return jsonResponse([]);
      if (options.method === 'GET') return jsonResponse(pullRequest());
      if (pathname.endsWith('/merge-async')) {
        return asyncAvailable
          ? jsonResponse({ status: 'failed', details: { message: 'Required status check "ci" is failing.' } })
          : jsonResponse({ message: 'Not Found' }, 404);
      }
      return jsonResponse({ merged: true, message: 'Pull Request successfully merged' });
    }));
    const { app } = makeApp();

    const failed = await request(app).post('/api/source-control/github/pr/merge').send(mergeBody(account.accountId)).expect(422);
    expect(failed.body).toEqual({ error: 'Required status check "ci" is failing.', code: 'SOURCE_CONTROL_MUTATION_REJECTED' });

    asyncAvailable = false;
    paths.length = 0;
    const classic = await request(app).post('/api/source-control/github/pr/merge').send({ ...mergeBody(account.accountId), idempotencyKey: 'request-two' }).expect(200);
    expect(classic.body.result).toEqual({ merged: true });
    expect(paths).toEqual(['GET /repos/acme/app/pulls/7', 'GET /repos/acme/app/pulls', 'PUT /repos/acme/app/pulls/7/merge-async', 'PUT /repos/acme/app/pulls/7/merge']);
  });

  it.each([
    ['merged', 'merge', { merged: true }],
    ['enqueued', 'squash', { merged: false, outcome: 'queued' }],
    ['pending', 'rebase', { merged: false, outcome: 'merging' }],
  ])('merges a native upper layer with status %s through %s and durably replays it', async (status, method, result) => {
    // Given GitHub's live native stack containing the selected upper layer and its lower layer.
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const pr = pullRequest({ base: { ...pullRequest().base, ref: 'lower' } });
    const parent = pullRequest({ number: 6, head: { ...pr.head, ref: 'lower' } });
    const fetch = vi.fn(async (input, options) => {
      const url = new URL(input);
      if (options.method === 'PUT') return jsonResponse({ status });
      if (url.pathname.endsWith('/stacks')) {
        expect(url.searchParams.get('pull_request')).toBe('7');
        return jsonResponse([{ number: 90, open: true, pull_requests: [parent, pr] }]);
      }
      return url.searchParams.has('head') ? jsonResponse([parent]) : jsonResponse(pr);
    });
    vi.stubGlobal('fetch', fetch);
    const { app, store } = makeApp();
    const payload = { ...context(account.accountId, { target: {
      project: { owner: 'acme', name: 'app' }, number: 7, head: 'feature', base: 'lower', headSha: 'abc123',
    } }), method };

    // When the upstream native action selects the upper layer.
    const response = await request(app).post('/api/source-control/github/pr/merge').send(payload).expect(200);

    // Then the exact selected commit reaches native asynchronous merge once, including queued and pending outcomes.
    expect(response.body).toMatchObject({ target: payload.target, result, replayed: false });
    expect(store.records.get('request-one')).toMatchObject({ kind: 'change-request-merge', state: 'succeeded', result });
    expect(fetch.mock.calls.filter(([, options]) => options.method === 'PUT').map(([input, options]) => ({
      path: new URL(input).pathname, body: JSON.parse(options.body),
    }))).toEqual([{ path: '/repos/acme/app/pulls/7/merge-async', body: { merge_method: method, sha: 'abc123', bypass_rules: true } }]);
    fetch.mockClear();
    const replay = await request(makeApp({ store }).app).post('/api/source-control/github/pr/merge').send(payload).expect(200);
    expect(replay.body).toMatchObject({ target: payload.target, result, replayed: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed membership', null, 200],
    ['malformed stack identity', [{ number: '90', open: true, pull_requests: [{ number: 7 }] }], 200],
    ['forbidden membership', { message: 'Forbidden' }, 403],
    ['unavailable membership', { message: 'Unavailable' }, 503],
  ])('does not admit an upper native merge from %s', async (_label, membership, status) => {
    // Given an upper layer whose native membership cannot be established.
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const pr = pullRequest({ base: { ...pullRequest().base, ref: 'lower' }, stack: { number: 90 } });
    const parent = pullRequest({ number: 6, head: { ...pr.head, ref: 'lower' } });
    const fetch = vi.fn(async (input) => {
      const url = new URL(input);
      if (url.pathname.endsWith('/stacks')) return jsonResponse(membership, status);
      return url.searchParams.has('head') ? jsonResponse([parent]) : jsonResponse(pr);
    });
    vi.stubGlobal('fetch', fetch);
    const { app, store } = makeApp();

    // When the ordinary merge route resolves its live admission state.
    const response = await request(app).post('/api/source-control/github/pr/merge').send({
      ...context(account.accountId, { target: { project: { owner: 'acme', name: 'app' }, number: 7, headSha: 'abc123' } }), method: 'merge',
    }).expect(503);

    // Then a PR's stack hint cannot replace authoritative membership or cause a write.
    expect(response.body.code).toBe('SOURCE_CONTROL_MUTATION_STACK_UNAVAILABLE');
    expect(store.records.size).toBe(0);
    expect(fetch.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
  });

  it('keeps the explicit native stack merge route bottom-only', async () => {
    // Given a native stack whose selected PR is its upper layer.
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const provider = serveStackProvider({ native: true });
    const { app } = makeApp();

    // When the snapshot-checked stack control requests an upper-layer merge.
    await request(app).post('/api/source-control/github/pulls/stack/merge')
      .send(stackPayload(account.accountId, 'register')).expect(409);

    // Then it remains distinct from the upstream native whole-stack merge action.
    expect(provider.writes).toEqual([]);
  });

  it('rejects a moved native upper head before checking membership or writing', async () => {
    // Given a native upper-layer action that captured an older head commit.
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const pr = pullRequest({ base: { ...pullRequest().base, ref: 'lower' }, stack: { number: 90 } });
    const fetch = vi.fn(async () => jsonResponse(pr));
    vi.stubGlobal('fetch', fetch);
    const { app, store } = makeApp();

    // When the caller tries to merge that old snapshot.
    const response = await request(app).post('/api/source-control/github/pr/merge').send({
      ...context(account.accountId, { target: { project: { owner: 'acme', name: 'app' }, number: 7, headSha: 'old-head' } }), method: 'merge',
    }).expect(409);

    // Then native membership cannot override the target snapshot or claim its operation key.
    expect(response.body.code).toBe('SOURCE_CONTROL_MUTATION_TARGET_CHANGED');
    expect(store.records.size).toBe(0);
    expect(fetch.mock.calls.map(([input, options]) => [new URL(input).pathname, options.method]))
      .toEqual([['/repos/acme/app/pulls/7', 'GET']]);
  });

  it.each([
    'merge', 'squash', 'rebase',
  ])('rejects an inferred upper stack PR before claiming or dispatching a %s merge', async (method) => {
    // Given an open parent whose same-repository head is this PR's base.
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const pr = pullRequest({ base: { ...pullRequest().base, ref: 'lower' } });
    const parent = pullRequest({ number: 6, head: { ...pr.head, ref: 'lower' } });
    const fetch = vi.fn(async (url, options) => {
      if (options.method === 'PUT') return jsonResponse({ merged: true });
      if (new URL(url).pathname.endsWith('/stacks')) return jsonResponse([]);
      return new URL(url).searchParams.has('head') ? jsonResponse([parent]) : jsonResponse(pr);
    });
    vi.stubGlobal('fetch', fetch);
    const { app, store } = makeApp();

    // When the ordinary merge route targets the upper PR.
    const response = await request(app).post('/api/source-control/github/pr/merge').send({
      ...context(account.accountId, { target: { project: { owner: 'acme', name: 'app' }, number: 7, base: 'lower' } }), method,
    }).expect(409);

    // Then no durable claim or provider write occurs.
    expect(response.body.code).toBe('SOURCE_CONTROL_MUTATION_STACK_ORDER');
    expect(store.records.size).toBe(0);
    expect(fetch.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
    expect(new URL(fetch.mock.calls[1][0]).searchParams.get('head')).toBe('acme:lower');
  });

  it.each(['bottom', 'standalone', 'fork namesake'])('merges a %s PR through the durable executor', async (kind) => {
    // Given no same-repository open parent, even if a fork reuses the base name.
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const pr = pullRequest();
    const child = pullRequest({ number: 8, base: { ...pr.base, ref: 'feature' }, head: { ...pr.head, ref: 'upper' } });
    const fork = pullRequest({ number: 6, head: {
      ...pr.head, ref: 'main', repo: { owner: { login: 'contributor' }, name: 'app', html_url: 'https://github.com/contributor/app' },
    } });
    const pulls = kind === 'bottom' ? [pr, child] : kind === 'fork namesake' ? [fork, pr] : [pr];
    const fetch = vi.fn(async (url, options) => {
      if (options.method === 'PUT') return jsonResponse({ status: 'merged' });
      const head = new URL(url).searchParams.get('head');
      return jsonResponse(head ? pulls.filter((pull) => `acme:${pull.head.ref}` === head) : pr);
    });
    vi.stubGlobal('fetch', fetch);
    const { app, store } = makeApp();

    // When the ordinary merge route is called.
    const response = await request(app).post('/api/source-control/github/pr/merge').send({
      ...context(account.accountId, { target: { project: { owner: 'acme', name: 'app' }, number: 7 } }), method: 'merge',
    }).expect(200);

    // Then one provider write completes the durable merge record.
    expect(response.body.result).toEqual({ merged: true });
    expect(store.records.get('request-one')).toMatchObject({ kind: 'change-request-merge', state: 'succeeded' });
    expect(fetch.mock.calls.filter(([, options]) => options.method === 'PUT').map(([url, options]) => ({
      path: new URL(url).pathname, body: JSON.parse(options.body),
    }))).toEqual([{ path: '/repos/acme/app/pulls/7/merge-async', body: { merge_method: 'merge', sha: 'abc123', bypass_rules: true } }]);
  });

  it.each([
    ['missing collection', null, {}],
    ['malformed parent', [{}], {}],
    ['unknown head repository', [pullRequest({ head: { ...pullRequest().head, ref: 'main', repo: null } })], {}],
    ['full page', Array.from({ length: 100 }, () => pullRequest()), {}],
    ['next page', [], { link: '<https://api.github.com/repos/acme/app/pulls?page=2>; rel="next"' }],
  ])('fails closed before merge when the parent query returns %s', async (_label, parents, headers) => {
    // Given an answer that cannot prove the absence of an open parent.
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const fetch = vi.fn(async (url) => new URL(url).searchParams.has('head')
      ? Response.json(parents, { headers }) : jsonResponse(pullRequest()));
    vi.stubGlobal('fetch', fetch);
    const { app, store } = makeApp();

    // When the ordinary merge route checks stack order.
    const response = await request(app).post('/api/source-control/github/pr/merge').send({
      ...context(account.accountId, { target: { project: { owner: 'acme', name: 'app' }, number: 7 } }), method: 'merge',
    }).expect(500);

    // Then the unresolved order grants no mutation authority.
    expect(response.body.code).toBe('MALFORMED_PROVIDER_RESPONSE');
    expect(store.records.size).toBe(0);
    expect(fetch.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
  });

  it.each([
    403, 503,
  ])('keeps a failed parent read with status %s outside the mutation executor', async (status) => {
    // Given a provider refusal or outage while reading the parent PRs.
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const fetch = vi.fn(async (url) => new URL(url).searchParams.has('head')
      ? jsonResponse({ message: 'Unavailable' }, status) : jsonResponse(pullRequest()));
    vi.stubGlobal('fetch', fetch);
    const { app, store } = makeApp();

    // When stack order cannot be resolved.
    await request(app).post('/api/source-control/github/pr/merge').send({
      ...context(account.accountId, { target: { project: { owner: 'acme', name: 'app' }, number: 7 } }), method: 'merge',
    }).expect(status);

    // Then no write is claimed or dispatched and the read is not retried.
    expect(store.records.size).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
  });

  it.each([
    ['ready', 'running', { ready: true }, pullRequest({ draft: false })],
    ['merge', 'running', { merged: true }, pullRequest({ state: 'closed', merged: true, merged_at: '2026-01-01T00:00:00Z' })],
    ['merge', 'succeeded', { merged: true }, null],
  ])('replays a %s mutation in %s state without repeating the write', async (kind, state, result, providerState) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const target = {
      repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
      project: { id: 'acme/app', owner: 'acme', name: 'app' }, number: 7, head: 'feature', base: 'main', headSha: 'abc123',
    };
    const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
    const input = { kind, actor, credential: credentialFor(account), target };
    if (kind === 'merge') input.method = 'merge';
    const record = { key: 'request-one', inputDigest: digestMutationInput(input), kind: `change-request-${kind}`, actor, target, state };
    if (state === 'succeeded') record.result = result;
    const store = makeStore([record]);
    const fetch = vi.fn(async () => jsonResponse(providerState));
    vi.stubGlobal('fetch', fetch);
    const { app } = makeApp({ store });
    const body = context(account.accountId, {
      target: { project: { owner: 'acme', name: 'app' }, number: 7, head: 'feature', base: 'main', headSha: 'abc123' },
    });

    if (kind === 'merge') body.method = 'merge';
    const response = await request(app).post(`/api/source-control/github/pr/${kind}`)
      .send(body).expect(200);
    expect(response.body).toMatchObject({ replayed: true, result });
    expect(fetch).toHaveBeenCalledTimes(state === 'running' ? 1 : 0);
    expect(fetch.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
  });

  it.each([
    ['one create match', [pullRequest()], 200, 'succeeded'],
    ['no create match', [], 409, 'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN'],
    ['ambiguous create matches', [pullRequest(), pullRequest({ number: 8, html_url: 'https://github.com/acme/app/pull/8' })], 409, 'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN'],
  ])('reconciles restart create with %s', async (_label, pulls, status, expected) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const target = {
      repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
      project: { id: 'acme/app', owner: 'acme', name: 'app' }, head: 'feature', base: 'main',
    };
    const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
    const input = { kind: 'create', actor, credential: credentialFor(account), target, title: 'Title', headRemote: 'origin' };
    const store = makeStore([{
      key: 'request-one', inputDigest: digestMutationInput(input), kind: 'change-request-create', actor, target, state: 'running',
    }]);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(pulls)));
    const { app } = makeApp({ store });

    const response = await request(app).post('/api/source-control/github/pr/create')
      .send({ ...context(account.accountId), title: 'Title' }).expect(status);
    expect(status === 200 ? response.body.status : response.body.code).toBe(expected);
    if (status === 200) expect(response.body.target.number).toBe(7);
  });

  it('finishes the stacking an interrupted create left undone, and never stacks a PR twice', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const target = {
      repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
      project: { id: 'acme/app', owner: 'acme', name: 'app' }, head: 'feature', base: 'lower',
    };
    const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
    const input = { kind: 'create', actor, credential: credentialFor(account), target, title: 'Title', headRemote: 'origin' };
    const running = (key) => ({ key, inputDigest: digestMutationInput(input), kind: 'change-request-create', actor, target, state: 'running' });
    const base = pullRequest().base;
    const created = pullRequest({ number: 8, base: { ...base, ref: 'lower', repo: { ...base.repo, default_branch: 'main' } } });
    let alreadyStacked = true;
    const writes = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      const { pathname, searchParams } = new URL(url);
      if (pathname === '/repos/acme/app/stacks' && options.method === 'GET') return jsonResponse(alreadyStacked ? [{ number: 3 }] : []);
      if (pathname.startsWith('/repos/acme/app/stacks')) {
        writes.push({ path: pathname, body: JSON.parse(options.body) });
        return jsonResponse({ number: 4 }, 201);
      }
      if (searchParams.get('head') === 'acme:lower') return jsonResponse([pullRequest({ number: 6, head: { ...pullRequest().head, ref: 'lower' } })]);
      return jsonResponse([created]);
    }));
    const replay = async (key) => {
      const { app } = makeApp({ store: makeStore([running(key)]) });
      return (await request(app).post('/api/source-control/github/pr/create')
        .send({ ...context(account.accountId, { idempotencyKey: key, target }), title: 'Title' }).expect(200)).body;
    };

    // GitHub already keeps it in a stack: said so, nothing written.
    expect(await replay('one')).toMatchObject({ target: { number: 8 }, result: { stacked: true } });
    expect(writes).toEqual([]);

    // Not stacked yet: it joins the open PR its base belongs to.
    alreadyStacked = false;
    expect((await replay('two')).result).toEqual({ stacked: true });
    expect(writes).toEqual([{ path: '/repos/acme/app/stacks', body: { pull_requests: [6, 8] } }]);
  });

  describe('comments and reviews', () => {
    const pullTarget = { project: { owner: 'acme', name: 'app' }, number: 7 };
    const recordRequests = (respond) => {
      const requests = [];
      vi.stubGlobal('fetch', vi.fn(async (url, options) => {
        const entry = { method: options.method, path: new URL(String(url)).pathname, body: options.body ? JSON.parse(options.body) : null };
        requests.push(entry);
        return respond(entry);
      }));
      return requests;
    };

    it('comments on a pull request after checking it belongs to the bound repository', async () => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      const requests = recordRequests((entry) => (entry.method === 'GET' ? jsonResponse(pullRequest()) : jsonResponse({ id: 11 }, 201)));
      const { app, store } = makeApp();

      const response = await request(app).post('/api/source-control/github/pr/comment')
        .send({ ...context(account.accountId, { target: pullTarget }), body: 'Looks good' }).expect(200);

      expect(response.body.result).toEqual({});
      expect(requests).toEqual([
        { method: 'GET', path: '/repos/acme/app/pulls/7', body: null },
        { method: 'POST', path: '/repos/acme/app/issues/7/comments', body: { body: 'Looks good' } },
      ]);
      expect(store.records.get('request-one')).toMatchObject({ kind: 'change-request-comment', state: 'succeeded' });
    });

    it("comments on and merges a contributor's fork pull request from the upstream clone", async () => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      // The network is acme/app alone; the head lives in a fork outside it.
      const forkPull = pullRequest({
        head: {
          ref: 'feature', sha: 'abc123',
          repo: {
            owner: { login: 'contributor' }, name: 'app', html_url: 'https://github.com/contributor/app',
            clone_url: 'https://github.com/contributor/app.git', ssh_url: 'git@github.com:contributor/app.git',
          },
        },
      });
      const requests = recordRequests((entry) => {
        if (entry.path === '/repos/acme/app/pulls') return jsonResponse([]);
        if (entry.method === 'GET') return jsonResponse(forkPull);
        if (entry.path.endsWith('/merge-async')) return jsonResponse({ status: 'merged', details: { message: 'Merged', sha: 'def456' } });
        return jsonResponse({ id: 11 }, 201);
      });
      const resolveNetwork = vi.fn(async () => [{ owner: 'acme', repo: 'app', url: 'https://github.com/acme/app', source: 'origin' }]);
      const { app } = makeApp({ resolveNetwork });

      await request(app).post('/api/source-control/github/pr/comment')
        .send({ ...context(account.accountId, { target: pullTarget }), body: 'Thanks' }).expect(200);
      const merged = await request(app).post('/api/source-control/github/pr/merge')
        .send({ ...mergeBody(account.accountId), idempotencyKey: 'request-two' }).expect(200);

      expect(merged.body.result).toEqual({ merged: true });
      expect(requests.filter((entry) => entry.method !== 'GET').map((entry) => entry.path)).toEqual([
        '/repos/acme/app/issues/7/comments',
        '/repos/acme/app/pulls/7/merge-async',
      ]);
    });

    it('reviews the head commit the client read, with the text as the review body', async () => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      const requests = recordRequests((entry) => (entry.method === 'GET'
        ? jsonResponse(pullRequest())
        : jsonResponse({ id: 12, state: entry.body.event === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED' })));
      const { app } = makeApp();
      const target = { ...pullTarget, headSha: 'abc123' };

      const approved = await request(app).post('/api/source-control/github/pr/review')
        .send({ ...context(account.accountId, { target }), verdict: 'approve' }).expect(200);
      const requested = await request(app).post('/api/source-control/github/pr/review')
        .send({ ...context(account.accountId, { target, idempotencyKey: 'request-two' }), verdict: 'request-changes', body: 'Rename it' }).expect(200);

      expect(approved.body.result).toEqual({ commented: false });
      expect(requested.body.result).toEqual({ commented: true });
      expect(requests.filter((entry) => entry.path.endsWith('/reviews'))).toEqual([
        { method: 'POST', path: '/repos/acme/app/pulls/7/reviews', body: { commit_id: 'abc123', event: 'APPROVE' } },
        { method: 'POST', path: '/repos/acme/app/pulls/7/reviews', body: { commit_id: 'abc123', event: 'REQUEST_CHANGES', body: 'Rename it' } },
      ]);
    });

    describe('review drafts', () => {
      const reviewed = { ...pullTarget, headSha: 'abc123' };
      const pendingReview = (id, commit = pullRequest().head.sha) => ({ data: { repository: { pullRequest: { reviews: { nodes: id ? [{ id, viewerDidAuthor: true, commit: { oid: commit } }] : [] } } } } });
      const pendingComment = (overrides = {}) => ({
        data: { node: {
          __typename: 'PullRequestReviewComment', state: 'PENDING', viewerDidAuthor: true,
          pullRequest: { number: 7, repository: { name: 'app', owner: { login: 'acme' } } }, ...overrides,
        } },
      });
      const respondWith = (answers) => (entry) => {
        if (entry.method === 'GET') return jsonResponse({ ...pullRequest(), node_id: 'PR_node' });
        const found = Object.entries(answers).find(([name]) => entry.body.query.includes(name));
        return jsonResponse(found ? found[1] : { message: 'unexpected' }, found ? 200 : 500);
      };
      const writes = (requests) => requests.filter((entry) => /^\s*mutation/.test(entry.body?.query ?? ''));

      it('starts a pending review on the head commit, then adds the comment to it', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const requests = recordRequests(respondWith({
          'reviews(states': pendingReview(null),
          'addPullRequestReview(input': { data: { addPullRequestReview: { pullRequestReview: { id: 'PRR_new' } } } },
          addPullRequestReviewThread: { data: { addPullRequestReviewThread: { thread: { id: 'PRRT_1' } } } },
        }));
        const { app, store } = makeApp();

        await request(app).post('/api/source-control/github/pr/review/comment').send({
          ...context(account.accountId, { target: reviewed }), path: 'src/a.ts', side: 'new', startLine: 3, line: 5, body: 'Here',
        }).expect(200);

        expect(writes(requests).map((entry) => entry.body.variables)).toEqual([
          { pullRequestId: 'PR_node', commitOID: 'abc123' },
          { input: { pullRequestReviewId: 'PRR_new', path: 'src/a.ts', body: 'Here', subjectType: 'LINE', line: 5, side: 'RIGHT', startLine: 3, startSide: 'RIGHT' } },
        ]);
        expect(store.records.get('request-one')).toMatchObject({ kind: 'change-request-review-comment', state: 'succeeded' });
      });

      it('adds to the pending review that exists, on a whole file or an old line', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const requests = recordRequests(respondWith({
          'reviews(states': pendingReview('PRR_open'),
          addPullRequestReviewThread: { data: { addPullRequestReviewThread: { thread: { id: 'PRRT_1' } } } },
        }));
        const { app } = makeApp();

        await request(app).post('/api/source-control/github/pr/review/comment')
          .send({ ...context(account.accountId, { target: reviewed }), path: 'src/a.ts', body: 'File' }).expect(200);
        await request(app).post('/api/source-control/github/pr/review/comment')
          .send({ ...context(account.accountId, { target: reviewed, idempotencyKey: 'request-two' }), path: 'src/a.ts', side: 'old', line: 2, body: 'Gone' }).expect(200);

        expect(writes(requests).map((entry) => entry.body.variables.input)).toEqual([
          { pullRequestReviewId: 'PRR_open', path: 'src/a.ts', body: 'File', subjectType: 'FILE' },
          { pullRequestReviewId: 'PRR_open', path: 'src/a.ts', body: 'Gone', subjectType: 'LINE', line: 2, side: 'LEFT' },
        ]);
      });

      it('refuses a position that does not name real lines and writes nothing', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const requests = recordRequests(() => jsonResponse(pullRequest()));
        const { app } = makeApp();
        const send = (position, idempotencyKey) => request(app).post('/api/source-control/github/pr/review/comment')
          .send({ ...context(account.accountId, { target: reviewed, idempotencyKey }), path: 'a.ts', body: 'x', ...position });

        await send({ side: 'new', line: 0 }, 'one').expect(400);
        await send({ side: 'middle', line: 1 }, 'two').expect(400);
        await send({ side: 'new', line: 2, startLine: 2 }, 'three').expect(400);
        await send({ startLine: 2 }, 'four').expect(400);

        expect(requests).toEqual([]);
      });

      it('edits and deletes only the viewer\'s own unpublished comment', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        let node = pendingComment();
        const requests = recordRequests((entry) => respondWith({
          'on PullRequestReviewComment': node,
          updatePullRequestReviewComment: { data: { updatePullRequestReviewComment: { pullRequestReviewComment: { id: 'PRRC_1' } } } },
          deletePullRequestReviewComment: { data: { deletePullRequestReviewComment: { clientMutationId: null } } },
        })(entry));
        const { app } = makeApp();

        await request(app).post('/api/source-control/github/pr/review/comment/update')
          .send({ ...context(account.accountId, { target: pullTarget }), commentId: 'PRRC_1', body: 'New' }).expect(200);
        await request(app).post('/api/source-control/github/pr/review/comment/delete')
          .send({ ...context(account.accountId, { target: pullTarget, idempotencyKey: 'request-two' }), commentId: 'PRRC_1' }).expect(200);
        expect(writes(requests)).toHaveLength(2);

        node = pendingComment({ state: 'SUBMITTED' });
        const refused = await request(app).post('/api/source-control/github/pr/review/comment/delete')
          .send({ ...context(account.accountId, { target: pullTarget, idempotencyKey: 'request-three' }), commentId: 'PRRC_1' }).expect(409);
        expect(refused.body.code).toBe('SOURCE_CONTROL_MUTATION_TARGET_INVALID');
        expect(writes(requests)).toHaveLength(2);
      });

      it('sends a pending review with the verdict, so GitHub does not refuse a second one', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const requests = recordRequests(respondWith({
          'reviews(states': pendingReview('PRR_open'),
          submitPullRequestReview: { data: { submitPullRequestReview: { pullRequestReview: { state: 'APPROVED' } } } },
        }));
        const { app } = makeApp();

        const response = await request(app).post('/api/source-control/github/pr/review')
          .send({ ...context(account.accountId, { target: reviewed }), verdict: 'approve', body: 'Good' }).expect(200);

        expect(response.body.result).toEqual({ commented: true });
        expect(writes(requests).map((entry) => entry.body.variables)).toEqual([{ id: 'PRR_open', event: 'APPROVE', body: 'Good' }]);
        expect(requests.some((entry) => entry.path.endsWith('/reviews'))).toBe(false);
      });

      it('refuses a verdict on a draft from an older commit, and sends it as a comment', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const requests = recordRequests(respondWith({
          'reviews(states': pendingReview('PRR_open', 'older'),
          submitPullRequestReview: { data: { submitPullRequestReview: { pullRequestReview: { state: 'COMMENTED' } } } },
        }));
        const { app } = makeApp();

        const refused = await request(app).post('/api/source-control/github/pr/review')
          .send({ ...context(account.accountId, { target: reviewed }), verdict: 'approve' }).expect(409);
        expect(refused.body.error).toMatch(/older commit/);
        expect(writes(requests)).toEqual([]);

        await request(app).post('/api/source-control/github/pr/review')
          .send({ ...context(account.accountId, { target: reviewed, idempotencyKey: 'request-two' }), verdict: 'comment' }).expect(200);
        expect(writes(requests).map((entry) => entry.body.variables.event)).toEqual(['COMMENT']);
      });

      it('publishes a comment-only review, and asks for text when there is nothing to publish', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const requests = recordRequests((entry) => (entry.path.endsWith('/reviews')
          ? jsonResponse({ id: 12, state: 'COMMENTED' })
          : respondWith({ 'reviews(states': pendingReview(null) })(entry)));
        const { app } = makeApp();

        const empty = await request(app).post('/api/source-control/github/pr/review')
          .send({ ...context(account.accountId, { target: reviewed }), verdict: 'comment' }).expect(422);
        await request(app).post('/api/source-control/github/pr/review')
          .send({ ...context(account.accountId, { target: reviewed, idempotencyKey: 'request-two' }), verdict: 'comment', body: 'Note' }).expect(200);

        expect(empty.body.error).toBe('A review with no comments needs text');
        expect(requests.filter((entry) => entry.path.endsWith('/reviews')).map((entry) => entry.body))
          .toEqual([{ commit_id: 'abc123', event: 'COMMENT', body: 'Note' }]);
      });

      it('discards the pending review, and says so when there is none', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        let pending = 'PRR_open';
        const requests = recordRequests((entry) => respondWith({
          'reviews(states': pendingReview(pending),
          deletePullRequestReview: { data: { deletePullRequestReview: { clientMutationId: null } } },
        })(entry));
        const { app } = makeApp();

        await request(app).post('/api/source-control/github/pr/review/discard')
          .send(context(account.accountId, { target: pullTarget })).expect(200);
        expect(writes(requests).map((entry) => entry.body.variables)).toEqual([{ id: 'PRR_open' }]);

        pending = null;
        const none = await request(app).post('/api/source-control/github/pr/review/discard')
          .send(context(account.accountId, { target: pullTarget, idempotencyKey: 'request-two' })).expect(409);
        expect(none.body.code).toBe('SOURCE_CONTROL_MUTATION_TARGET_INVALID');
      });
    });

    it('refuses a review once the pull request moved past the commit the client read', async () => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      const requests = recordRequests(() => jsonResponse(pullRequest({ head: { ...pullRequest().head, sha: 'def456' } })));
      const { app } = makeApp();

      const response = await request(app).post('/api/source-control/github/pr/review')
        .send({ ...context(account.accountId, { target: { ...pullTarget, headSha: 'abc123' } }), verdict: 'approve' }).expect(409);

      expect(response.body.code).toBe('SOURCE_CONTROL_MUTATION_TARGET_CHANGED');
      expect(requests.map((entry) => entry.method)).toEqual(['GET']);
    });

    it('asks for text before requesting changes and for the reviewed commit, and writes nothing', async () => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      const requests = recordRequests(() => jsonResponse(pullRequest()));
      const { app } = makeApp();

      await request(app).post('/api/source-control/github/pr/review')
        .send({ ...context(account.accountId, { target: { ...pullTarget, headSha: 'abc123' } }), verdict: 'request-changes', body: '  ' }).expect(400);
      await request(app).post('/api/source-control/github/pr/comment')
        .send({ ...context(account.accountId, { target: pullTarget, idempotencyKey: 'request-two' }) }).expect(400);
      await request(app).post('/api/source-control/github/pr/review')
        .send({ ...context(account.accountId, { target: pullTarget, idempotencyKey: 'request-three' }), verdict: 'approve' }).expect(400);

      expect(requests).toEqual([]);
    });

    const threadOn = (number, repo = 'app') => ({
      data: { node: { __typename: 'PullRequestReviewThread', isResolved: false, pullRequest: { number, repository: { name: repo, owner: { login: 'acme' } } } } },
    });

    it('answers and resolves a review thread of the target pull request', async () => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      const requests = recordRequests((entry) => {
        if (entry.method === 'GET') return jsonResponse(pullRequest());
        const query = entry.body.query;
        if (query.includes('addPullRequestReviewThreadReply')) return jsonResponse({ data: { addPullRequestReviewThreadReply: { comment: { id: 'PRRC_1' } } } });
        if (query.includes('resolveReviewThread')) return jsonResponse({ data: { resolveReviewThread: { thread: { isResolved: true } } } });
        return jsonResponse(threadOn(7));
      });
      const { app, store } = makeApp();

      await request(app).post('/api/source-control/github/pr/thread/reply')
        .send({ ...context(account.accountId, { target: pullTarget }), threadId: 'PRRT_one', body: 'Fixed' }).expect(200);
      await request(app).post('/api/source-control/github/pr/thread/resolve')
        .send({ ...context(account.accountId, { target: pullTarget, idempotencyKey: 'request-two' }), threadId: 'PRRT_one', resolved: true }).expect(200);

      const writes = requests.filter((entry) => entry.method === 'POST' && /mutation/.test(entry.body.query));
      expect(writes.map((entry) => entry.body.variables)).toEqual([{ threadId: 'PRRT_one', body: 'Fixed' }, { threadId: 'PRRT_one' }]);
      expect(store.records.get('request-one')).toMatchObject({ kind: 'change-request-thread-reply', state: 'succeeded' });
      expect(store.records.get('request-two')).toMatchObject({ kind: 'change-request-thread-resolve', state: 'succeeded' });
    });

    it('host review jobs use canonical bound writes with exact commit, thread membership and durable replay', async () => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      const requests = recordRequests((entry) => {
        if (entry.method === 'GET') return jsonResponse(pullRequest());
        if (entry.body.query.includes('addPullRequestReviewThreadReply')) return jsonResponse({ data: { addPullRequestReviewThreadReply: { comment: { id: 'PRRC_1' } } } });
        return jsonResponse(threadOn(7));
      });
      const validate = vi.fn(async (body) => body);
      const { service, store } = makeApp({ validateMutationContext: validate });
      const input = { loop: { readContext: context(account.accountId), owner: 'acme', repo: 'app', number: 7 },
        receipt: { commit: 'abc123', destination: { ref: 'refs/heads/feature' } },
        operation: { kind: 'thread-reply', threadId: 'PRRT_one', body: 'Fixed', idempotencyKey: 'fix-review:one' } };
      await service.applyFixLoopReviewOperation(input);
      await service.applyFixLoopReviewOperation({ ...input, replayOnly: true });
      expect(validate).toHaveBeenCalledTimes(2);
      expect(validate.mock.calls[0][0].target).toEqual({ project: { owner: 'acme', name: 'app' }, number: 7, head: 'feature', headSha: 'abc123' });
      expect(requests.filter((entry) => entry.method === 'POST' && entry.body.query.includes('mutation'))).toHaveLength(1);
      expect(store.records.get('fix-review:one').state).toBe('succeeded');
      const count = requests.length;
      await expect(service.applyFixLoopReviewOperation({ ...input, replayOnly: true,
        operation: { ...input.operation, idempotencyKey: 'forgotten-operation' } })).rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN' });
      expect(requests).toHaveLength(count);
    });

    it('a host review write cannot replace canonical authorization or target checks', async () => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      const requests = recordRequests((entry) => entry.method === 'GET' ? jsonResponse(pullRequest()) : jsonResponse(threadOn(8)));
      const { service } = makeApp();
      const input = { loop: { readContext: context(account.accountId), owner: 'acme', repo: 'app', number: 7 },
        receipt: { commit: 'abc123', destination: { ref: 'refs/heads/feature' } },
        operation: { kind: 'thread-reply', threadId: 'PRRT_other', body: 'Fixed', idempotencyKey: 'fix-review:other' } };
      await expect(service.applyFixLoopReviewOperation(input)).rejects.toMatchObject({ code: 'SOURCE_CONTROL_MUTATION_TARGET_INVALID' });
      expect(requests.some((entry) => entry.method === 'POST' && entry.body.query.includes('mutation'))).toBe(false);
      const unavailable = makeApp({ validateMutationContext: async () => { throw Object.assign(new Error('Binding not authorized'), { status: 403 }); } });
      const count = requests.length;
      await expect(unavailable.service.applyFixLoopReviewOperation(input)).rejects.toMatchObject({ status: 403 });
      expect(requests).toHaveLength(count);
    });

    it('refuses a thread of another pull request and writes nothing', async () => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      const requests = recordRequests((entry) => (entry.method === 'GET' ? jsonResponse(pullRequest()) : jsonResponse(threadOn(8))));
      const { app } = makeApp();

      const response = await request(app).post('/api/source-control/github/pr/thread/reply')
        .send({ ...context(account.accountId, { target: pullTarget }), threadId: 'PRRT_other', body: 'Fixed' }).expect(409);

      expect(response.body.code).toBe('SOURCE_CONTROL_MUTATION_TARGET_INVALID');
      expect(requests.some((entry) => entry.method === 'POST' && /mutation/.test(entry.body.query))).toBe(false);
    });

    describe('discussions', () => {
      const discussionTarget = { project: { owner: 'acme', name: 'app' }, number: 5 };
      const discussionNode = (overrides = {}) => ({
        id: 'D_five', number: 5, closed: false, labels: { nodes: [{ id: 'LA_bug', name: 'bug' }] }, ...overrides,
      });
      const commentNode = (number = 5, overrides = {}) => ({
        __typename: 'DiscussionComment', isAnswer: false, replyTo: null, discussion: { number, repository: { name: 'app', owner: { login: 'acme' } } }, ...overrides,
      });
      // Every discussion read and write is one GraphQL POST; `writes` answers the mutations.
      const graphqlRequests = (writes, { discussion = discussionNode(), comment = commentNode(), labels = {} } = {}) => recordRequests((entry) => {
        const { query } = entry.body;
        if (/^mutation/.test(query.trim())) return jsonResponse({ data: writes(query, entry.body.variables) });
        if (query.includes('discussion(number:')) return jsonResponse({ data: { repository: { discussion } } });
        if (query.includes('label(name:')) {
          return jsonResponse({ data: { repository: Object.fromEntries(Object.entries(entry.body.variables)
            .filter(([key]) => /^l\d+$/.test(key)).map(([key, name]) => [key, labels[name] ? { id: labels[name], name } : null])) } });
        }
        return jsonResponse({ data: { node: comment } });
      });
      const graphqlWrites = (requests) => requests.filter((entry) => /^mutation/.test(entry.body.query.trim())).map((entry) => entry.body.variables);

      it('comments on a discussion and answers a comment of it in its thread', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const requests = graphqlRequests(() => ({ addDiscussionComment: { comment: { id: 'DC_new' } } }));
        const { app, store } = makeApp();

        await request(app).post('/api/source-control/github/discussions/comment')
          .send({ ...context(account.accountId, { target: discussionTarget }), body: 'Thanks' }).expect(200);
        await request(app).post('/api/source-control/github/discussions/comment')
          .send({ ...context(account.accountId, { target: discussionTarget, idempotencyKey: 'request-two' }), body: 'Agreed', replyTo: 'DC_one' }).expect(200);

        expect(graphqlWrites(requests)).toEqual([
          { discussionId: 'D_five', body: 'Thanks', replyToId: null },
          { discussionId: 'D_five', body: 'Agreed', replyToId: 'DC_one' },
        ]);
        expect(store.records.get('request-one')).toMatchObject({ kind: 'discussion-comment', state: 'succeeded', target: { number: 5 } });
      });

      it('refuses a reply to a comment of another discussion, or to a reply, and writes nothing', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const elsewhere = graphqlRequests(() => ({}), { comment: commentNode(6) });
        const { app } = makeApp();
        const response = await request(app).post('/api/source-control/github/discussions/comment')
          .send({ ...context(account.accountId, { target: discussionTarget }), body: 'Agreed', replyTo: 'DC_other' }).expect(409);
        expect(response.body.code).toBe('SOURCE_CONTROL_MUTATION_TARGET_INVALID');
        expect(graphqlWrites(elsewhere)).toEqual([]);

        const nested = graphqlRequests(() => ({}), { comment: commentNode(5, { replyTo: { id: 'DC_one' } }) });
        await request(app).post('/api/source-control/github/discussions/comment')
          .send({ ...context(account.accountId, { target: discussionTarget, idempotencyKey: 'request-two' }), body: 'Agreed', replyTo: 'DC_reply' }).expect(409);
        expect(graphqlWrites(nested)).toEqual([]);
      });

      it('closes a discussion for a reason, reopens it, and chooses an answer', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const requests = graphqlRequests((query) => {
          if (query.includes('closeDiscussion')) return { closeDiscussion: { discussion: { closed: true } } };
          if (query.includes('reopenDiscussion')) return { reopenDiscussion: { discussion: { closed: false } } };
          return { markDiscussionCommentAsAnswer: { discussion: { id: 'D_five' } } };
        });
        const { app, store } = makeApp();

        const closed = await request(app).post('/api/source-control/github/discussions/state')
          .send({ ...context(account.accountId, { target: discussionTarget }), state: 'closed', reason: 'outdated' }).expect(200);
        await request(app).post('/api/source-control/github/discussions/state')
          .send({ ...context(account.accountId, { target: discussionTarget, idempotencyKey: 'request-two' }), state: 'open' }).expect(200);
        await request(app).post('/api/source-control/github/discussions/answer')
          .send({ ...context(account.accountId, { target: discussionTarget, idempotencyKey: 'request-three' }), commentId: 'DC_one', answer: true }).expect(200);
        // Closing names why; reopening names none.
        await request(app).post('/api/source-control/github/discussions/state')
          .send({ ...context(account.accountId, { target: discussionTarget, idempotencyKey: 'request-four' }), state: 'closed' }).expect(400);

        expect(closed.body.result).toEqual({ state: 'closed' });
        expect(graphqlWrites(requests)).toEqual([{ discussionId: 'D_five', reason: 'OUTDATED' }, { discussionId: 'D_five' }, { id: 'DC_one' }]);
        expect(store.records.get('request-three')).toMatchObject({ kind: 'discussion-answer', state: 'succeeded' });
      });

      it('sets the labels as a whole set by their ids, and refuses a label the repository lacks', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const requests = graphqlRequests(() => ({ addLabelsToLabelable: { clientMutationId: null }, removeLabelsFromLabelable: { clientMutationId: null } }), {
          labels: { idea: 'LA_idea' },
        });
        const { app } = makeApp();

        await request(app).post('/api/source-control/github/discussions/labels')
          .send({ ...context(account.accountId, { target: discussionTarget }), labels: ['idea'] }).expect(200);
        const refused = await request(app).post('/api/source-control/github/discussions/labels')
          .send({ ...context(account.accountId, { target: discussionTarget, idempotencyKey: 'request-two' }), labels: ['idea', 'missing'] }).expect(422);

        expect(graphqlWrites(requests)).toEqual([{ id: 'D_five', labelIds: ['LA_idea'] }, { id: 'D_five', labelIds: ['LA_bug'] }]);
        expect(refused.body).toEqual({ error: 'Label missing does not exist in this repository', code: 'SOURCE_CONTROL_MUTATION_REJECTED' });
      });

      it('leaves a label change unknown when the labels were added and the removal was refused', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        recordRequests((entry) => {
          const { query } = entry.body;
          if (query.includes('removeLabelsFromLabelable')) return jsonResponse({ errors: [{ message: 'Refused' }] });
          if (query.includes('addLabelsToLabelable')) return jsonResponse({ data: { addLabelsToLabelable: { clientMutationId: null } } });
          if (query.includes('label(name:')) return jsonResponse({ data: { repository: { l0: { id: 'LA_idea', name: 'idea' } } } });
          return jsonResponse({ data: { repository: { discussion: discussionNode() } } });
        });
        const { app, store } = makeApp();

        await request(app).post('/api/source-control/github/discussions/labels')
          .send({ ...context(account.accountId, { target: discussionTarget }), labels: ['idea'] });

        expect(store.records.get('request-one')).toMatchObject({ kind: 'discussion-labels', state: 'outcome-unknown' });
      });
    });

    it("passes GitHub's reason when it refuses a review", async () => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      recordRequests((entry) => {
        if (entry.method === 'GET') return jsonResponse(pullRequest());
        if (entry.path.endsWith('/graphql')) return jsonResponse({ data: { repository: { pullRequest: { reviews: { nodes: [] } } } } });
        return jsonResponse({ message: 'Unprocessable Entity', errors: ['Review Can not approve your own pull request'] }, 422);
      });
      const { app, store } = makeApp();

      const response = await request(app).post('/api/source-control/github/pr/review')
        .send({ ...context(account.accountId, { target: { ...pullTarget, headSha: 'abc123' } }), verdict: 'approve' }).expect(422);

      expect(response.body).toEqual({ error: 'Review Can not approve your own pull request', code: 'SOURCE_CONTROL_MUTATION_REJECTED' });
      expect(store.records.get('request-one')).toMatchObject({ state: 'failed', result: { failureStatus: 422 } });
    });

    it('comments on an issue and refuses a pull request number on the issue route', async () => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      const requests = recordRequests((entry) => {
        if (entry.method === 'POST') return jsonResponse({ id: 13 }, 201);
        return entry.path.endsWith('/issues/8')
          ? jsonResponse({ number: 8, pull_request: { url: 'https://api.github.com/repos/acme/app/pulls/8' } })
          : jsonResponse({ number: 5 });
      });
      const { app, store } = makeApp();

      const response = await request(app).post('/api/source-control/github/issues/comment')
        .send({ ...context(account.accountId, { target: { project: pullTarget.project, number: 5 } }), body: 'On it' }).expect(200);
      const refused = await request(app).post('/api/source-control/github/issues/comment')
        .send({ ...context(account.accountId, { target: { project: pullTarget.project, number: 8 }, idempotencyKey: 'request-two' }), body: 'On it' }).expect(409);

      expect(response.body.target).toEqual({
        repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
        project: { id: 'acme/app', owner: 'acme', name: 'app' }, number: 5,
      });
      expect(refused.body.code).toBe('SOURCE_CONTROL_MUTATION_TARGET_INVALID');
      expect(requests.filter((entry) => entry.method === 'POST')).toEqual([
        { method: 'POST', path: '/repos/acme/app/issues/5/comments', body: { body: 'On it' } },
      ]);
      expect(store.records.get('request-one')).toMatchObject({ kind: 'issue-comment', state: 'succeeded' });
    });

    it('closes a pull request and reopens an issue, and passes GitHub\'s reason for a merged one', async () => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      const requests = recordRequests((entry) => {
        if (entry.path.endsWith('/pulls/7')) {
          return entry.method === 'GET' ? jsonResponse(pullRequest()) : jsonResponse(pullRequest({ state: 'closed' }));
        }
        if (entry.path.endsWith('/pulls/9')) {
          return entry.method === 'GET'
            ? jsonResponse(pullRequest({ number: 9, html_url: 'https://github.com/acme/app/pull/9', state: 'closed', merged: true }))
            : jsonResponse({ message: 'Validation Failed', errors: [{ message: 'state cannot be changed. The pull request has been merged.' }] }, 422);
        }
        return entry.method === 'GET' ? jsonResponse({ number: 5, state: 'closed' }) : jsonResponse({ number: 5, state: 'open' });
      });
      const { app, store } = makeApp();

      const closed = await request(app).post('/api/source-control/github/pr/state')
        .send({ ...context(account.accountId, { target: pullTarget }), state: 'closed' }).expect(200);
      const reopened = await request(app).post('/api/source-control/github/issues/state')
        .send({ ...context(account.accountId, { target: { project: pullTarget.project, number: 5 }, idempotencyKey: 'request-two' }), state: 'open' }).expect(200);
      const merged = await request(app).post('/api/source-control/github/pr/state')
        .send({ ...context(account.accountId, { target: { ...pullTarget, number: 9 }, idempotencyKey: 'request-three' }), state: 'open' }).expect(422);
      await request(app).post('/api/source-control/github/pr/state')
        .send({ ...context(account.accountId, { target: pullTarget, idempotencyKey: 'request-four' }), state: 'merged' }).expect(400);

      expect(closed.body.result).toEqual({ state: 'closed' });
      expect(reopened.body.result).toEqual({ state: 'open' });
      expect(merged.body).toEqual({ error: 'state cannot be changed. The pull request has been merged.', code: 'SOURCE_CONTROL_MUTATION_REJECTED' });
      expect(requests.filter((entry) => entry.method === 'PATCH')).toEqual([
        { method: 'PATCH', path: '/repos/acme/app/pulls/7', body: { state: 'closed' } },
        { method: 'PATCH', path: '/repos/acme/app/issues/5', body: { state: 'open' } },
        { method: 'PATCH', path: '/repos/acme/app/pulls/9', body: { state: 'open' } },
      ]);
      expect(store.records.get('request-two')).toMatchObject({ kind: 'issue-state', state: 'succeeded', result: { state: 'open' } });
    });

    it.each([
      ['closed', 'succeeded'],
      ['open', 'failed'],
    ])('reconciles an interrupted close from the issue being %s without writing again', async (current, outcome) => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      const target = {
        repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
        project: { id: 'acme/app', owner: 'acme', name: 'app' }, number: 5,
      };
      const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
      const input = { kind: 'issue-state', actor, credential: credentialFor(account), target, state: 'closed' };
      const store = makeStore([{ key: 'request-one', inputDigest: digestMutationInput(input), kind: 'issue-state', actor, target, state: 'running' }]);
      const fetch = vi.fn(async () => jsonResponse({ number: 5, state: current }));
      vi.stubGlobal('fetch', fetch);
      const { app } = makeApp({ store });

      await request(app).post('/api/source-control/github/issues/state')
        .send({ ...context(account.accountId, { target: { project: pullTarget.project, number: 5 } }), state: 'closed' })
        .expect(outcome === 'succeeded' ? 200 : 409);

      expect(store.records.get('request-one').state).toBe(outcome);
      expect(fetch).toHaveBeenCalledOnce();
    });

    it('sets labels as one sorted set on pull requests and issues', async () => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      const requests = recordRequests((entry) => {
        if (entry.method === 'PUT') return jsonResponse(entry.body.labels.map((name) => ({ name })));
        return entry.path.endsWith('/pulls/7') ? jsonResponse(pullRequest()) : jsonResponse({ number: 5, state: 'open' });
      });
      const { app, store } = makeApp();

      await request(app).post('/api/source-control/github/pr/labels')
        .send({ ...context(account.accountId, { target: pullTarget }), labels: ['docs', 'bug', 'docs'] }).expect(200);
      await request(app).post('/api/source-control/github/issues/labels')
        .send({ ...context(account.accountId, { target: { project: pullTarget.project, number: 5 }, idempotencyKey: 'request-two' }), labels: [] }).expect(200);
      await request(app).post('/api/source-control/github/pr/labels')
        .send({ ...context(account.accountId, { target: pullTarget, idempotencyKey: 'request-three' }), labels: ['  '] }).expect(400);

      expect(requests.filter((entry) => entry.method === 'PUT')).toEqual([
        { method: 'PUT', path: '/repos/acme/app/issues/7/labels', body: { labels: ['bug', 'docs'] } },
        { method: 'PUT', path: '/repos/acme/app/issues/5/labels', body: { labels: [] } },
      ]);
      expect(store.records.get('request-two')).toMatchObject({ kind: 'issue-labels', state: 'succeeded' });
    });

    it('asks and stops asking reviewers so the requested set matches', async () => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      const requests = recordRequests((entry) => {
        if (entry.path.endsWith('/requested_reviewers') && entry.method === 'GET') {
          return jsonResponse({ users: [{ login: 'ann' }, { login: 'bob' }], teams: [] });
        }
        if (entry.path.endsWith('/requested_reviewers')) return jsonResponse(pullRequest());
        return jsonResponse(pullRequest());
      });
      const { app } = makeApp();

      const response = await request(app).post('/api/source-control/github/pr/reviewers')
        .send({ ...context(account.accountId, { target: pullTarget }), reviewers: ['cid', 'ann'] }).expect(200);

      expect(response.body.result).toEqual({});
      expect(requests.filter((entry) => entry.method !== 'GET')).toEqual([
        { method: 'POST', path: '/repos/acme/app/pulls/7/requested_reviewers', body: { reviewers: ['cid'] } },
        { method: 'DELETE', path: '/repos/acme/app/pulls/7/requested_reviewers', body: { reviewers: ['bob'] } },
      ]);
    });

    it('leaves a comment interrupted mid-write as outcome unknown instead of posting it again', async () => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      const target = {
        repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
        project: { id: 'acme/app', owner: 'acme', name: 'app' }, number: 5,
      };
      const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
      const input = { kind: 'issue-comment', actor, credential: credentialFor(account), target, body: 'On it' };
      const store = makeStore([{ key: 'request-one', inputDigest: digestMutationInput(input), kind: 'issue-comment', actor, target, state: 'running' }]);
      const fetch = vi.fn(async () => jsonResponse({}));
      vi.stubGlobal('fetch', fetch);
      const { app } = makeApp({ store });

      const response = await request(app).post('/api/source-control/github/issues/comment')
        .send({ ...context(account.accountId, { target: { project: pullTarget.project, number: 5 } }), body: 'On it' }).expect(409);

      expect(response.body.code).toBe('SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN');
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it('does not retry or invalidate after a definite provider rejection', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const fetch = vi.fn(async () => jsonResponse({ message: 'A pull request already exists for acme:feature.' }, 422));
    vi.stubGlobal('fetch', fetch);
    // The shell's status cache captures Date.now when the app is created.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(500);
    const { app, store } = makeApp();
    const statusQuery = {
      directory: '/repo', branch: 'feature', repositoryId: 'repo-one', bindingRevision: 3,
      accountId: account.accountId, primaryRemote: 'origin', instance: 'github.com',
    };
    vi.setSystemTime(1_000);
    expect((await request(app).get('/api/source-control/github/pr/status').query(statusQuery)).body.fetchedAt).toBe(1_000);

    vi.setSystemTime(2_000);
    const response = await request(app).post('/api/source-control/github/pr/create')
      .send({ ...context(account.accountId), title: 'private title' }).expect(422);
    expect(response.body).toEqual({ error: 'A pull request already exists for acme:feature.', code: 'SOURCE_CONTROL_MUTATION_REJECTED' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(store.records.get('request-one')).toMatchObject({ state: 'failed', result: { failureStatus: 422, failureCode: 'GITHUB_MUTATION_REJECTED' } });
    vi.setSystemTime(3_000);
    expect((await request(app).get('/api/source-control/github/pr/status').query(statusQuery)).body.fetchedAt).toBe(1_000);
  });

  it('answers with GitHub\'s reason when it refuses a read before the write', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const restricted = 'Although you appear to have the correct authorization credentials, the `acme` organization has enabled OAuth App access restrictions.';
    const fetch = vi.fn(async () => jsonResponse({ message: restricted }, 403));
    vi.stubGlobal('fetch', fetch);
    const { app, store } = makeApp();

    const response = await request(app).post('/api/source-control/github/pr/merge')
      .send({ ...context(account.accountId, { target: { project: { owner: 'acme', name: 'app' }, number: 7 } }), method: 'squash' })
      .expect(403);

    expect(response.body).toEqual({ error: restricted, code: 'SOURCE_CONTROL_MUTATION_REJECTED' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(store.records.size).toBe(0);
  });

  it('invalidates canonical status only for the successful mutation authority', async () => {
    const acting = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const unrelated = await auth.setGitHubAuth({ accessToken: 'token-two', user: { id: 2, login: 'other' } });
    const fetch = vi.fn(async () => jsonResponse(pullRequest()));
    vi.stubGlobal('fetch', fetch);
    // The shell's status cache captures Date.now when the app is created.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(500);
    const { app } = makeApp();
    const statusQuery = (accountId, directory = '/repo', repositoryId = 'repo-one') => ({
      directory, branch: 'feature', repositoryId, bindingRevision: 3,
      accountId, primaryRemote: 'origin', instance: 'github.com',
    });

    vi.setSystemTime(1_000);
    expect((await request(app).get('/api/source-control/github/pr/status').query(statusQuery(acting.accountId))).body.fetchedAt).toBe(1_000);
    vi.setSystemTime(2_000);
    expect((await request(app).get('/api/source-control/github/pr/status').query(statusQuery(unrelated.accountId))).body.fetchedAt).toBe(2_000);
    vi.setSystemTime(2_100);
    expect((await request(app).get('/api/source-control/github/pr/status').query(statusQuery(acting.accountId, '/worktree'))).body.fetchedAt).toBe(2_100);
    vi.setSystemTime(2_200);
    expect((await request(app).get('/api/source-control/github/pr/status').query(statusQuery(acting.accountId, '/other', 'repo-two'))).body.fetchedAt).toBe(2_200);

    vi.setSystemTime(3_000);
    await request(app).post('/api/source-control/github/pr/create')
      .send({ ...context(acting.accountId), title: 'Title' }).expect(200);

    vi.setSystemTime(4_000);
    expect((await request(app).get('/api/source-control/github/pr/status').query(statusQuery(acting.accountId))).body.fetchedAt).toBe(4_000);
    vi.setSystemTime(5_000);
    expect((await request(app).get('/api/source-control/github/pr/status').query(statusQuery(unrelated.accountId))).body.fetchedAt).toBe(2_000);
    vi.setSystemTime(6_000);
    expect((await request(app).get('/api/source-control/github/pr/status').query(statusQuery(acting.accountId, '/worktree'))).body.fetchedAt).toBe(6_000);
    vi.setSystemTime(7_000);
    expect((await request(app).get('/api/source-control/github/pr/status').query(statusQuery(acting.accountId, '/other', 'repo-two'))).body.fetchedAt).toBe(2_200);
  });

  it('answers a landed write as succeeded even when dropping its caches fails', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const fetch = vi.fn(async () => jsonResponse(pullRequest()));
    vi.stubGlobal('fetch', fetch);
    const [octokit, summaries, rateLimit, patch, prStatus, checks, repo, forks, git] = await Promise.all([
      import('../github/octokit.js'), import('../github/pr-summaries.js'), import('../github/rate-limit.js'),
      import('../github/change-request-patch.js'), import('../github/pr-status.js'), import('../github/checks-summary.js'),
      import('../github/repo/index.js'), import('../github/repo/fork-detection.js'), import('../git/index.js'),
    ]);
    const invalidateRepoPullsCache = vi.fn(() => { throw new Error('cache module failed'); });
    const modules = async () => ({
      octokit, summaries, rateLimit, patch, checks, repo, forks, git,
      prStatus: { ...prStatus, invalidateRepoPullsCache },
    });
    const { app, store } = makeApp({ modules });

    const response = await request(app).post('/api/source-control/github/pr/create')
      .send({ ...context(account.accountId), title: 'Title' }).expect(200);

    expect(response.body).toMatchObject({ replayed: false });
    expect(invalidateRepoPullsCache).toHaveBeenCalledOnce();
    expect(store.records.get('request-one')).toMatchObject({ state: 'succeeded' });
  });

  it('does not let an older canonical status read refill an invalidated authority', async () => {
    const acting = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const unrelated = await auth.setGitHubAuth({ accessToken: 'token-two', user: { id: 2, login: 'other' } });
    let releaseStatus;
    let markStatusStarted;
    const heldStatus = new Promise((resolve) => { releaseStatus = resolve; });
    const statusStarted = new Promise((resolve) => { markStatusStarted = resolve; });
    const resolveStatus = vi.fn(async () => {
      if (resolveStatus.mock.calls.length === 1) {
        markStatusStarted();
        await heldStatus;
      }
      return { repo: null, pr: null, defaultBranch: null, resolvedRemoteName: null };
    });
    const fetch = vi.fn(async () => jsonResponse(pullRequest()));
    vi.stubGlobal('fetch', fetch);
    const { app } = makeApp({ resolveStatus });
    const query = (accountId) => ({
      directory: '/repo', branch: 'feature', repositoryId: 'repo-one', bindingRevision: 3,
      accountId, primaryRemote: 'origin', instance: 'github.com',
    });

    const staleRead = request(app).get('/api/source-control/github/pr/status')
      .query(query(acting.accountId)).expect(200).then((response) => response);
    await statusStarted;
    await request(app).post('/api/source-control/github/pr/create')
      .send({ ...context(acting.accountId), title: 'Title' }).expect(200);
    releaseStatus();
    await staleRead;

    await request(app).get('/api/source-control/github/pr/status').query(query(acting.accountId)).expect(200);
    await request(app).get('/api/source-control/github/pr/status').query(query(unrelated.accountId)).expect(200);
    await request(app).get('/api/source-control/github/pr/status').query(query(unrelated.accountId)).expect(200);
    expect(resolveStatus).toHaveBeenCalledTimes(3);
  });

  it('invalidates canonical pull context across linked worktree directories only', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const pullReads = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/repos/acme/app/pulls/7') {
        if (options.method === 'GET') pullReads.push(pathname);
        return jsonResponse(pullRequest({ title: options.method === 'PATCH' ? 'Changed' : 'Title' }));
      }
      return jsonResponse([]);
    }));
    const { app } = makeApp();
    const query = (directory, repositoryId = 'repo-one') => ({
      directory,
      number: 7,
      repositoryId,
      bindingRevision: 3,
      accountId: account.accountId,
      primaryRemote: 'origin',
      instance: 'github.com',
    });

    await request(app).get('/api/source-control/github/pulls/context').query(query('/repo')).expect(200);
    await request(app).get('/api/source-control/github/pulls/context').query(query('/worktree')).expect(200);
    await request(app).get('/api/source-control/github/pulls/context').query(query('/other', 'repo-two')).expect(200);
    expect(pullReads).toHaveLength(3);

    const target = { project: { owner: 'acme', name: 'app' }, number: 7, head: 'feature', base: 'main', headSha: 'abc123' };
    await request(app).post('/api/source-control/github/pr/update')
      .send({ ...context(account.accountId, { target }), title: 'Changed' }).expect(200);
    // The update revalidates its target with one read of its own.
    expect(pullReads).toHaveLength(4);

    const repoContext = await request(app).get('/api/source-control/github/pulls/context').query(query('/repo')).expect(200);
    expect(pullReads).toHaveLength(5);
    expect(repoContext.body.changeRequest).toMatchObject({ number: 7, id: 'acme/app#7' });
    await request(app).get('/api/source-control/github/pulls/context').query(query('/worktree')).expect(200);
    expect(pullReads).toHaveLength(6);
    await request(app).get('/api/source-control/github/pulls/context').query(query('/other', 'repo-two')).expect(200);
    expect(pullReads).toHaveLength(6);
  });

  it('does not let an older canonical pull context refill an invalidated target', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    let releaseContext;
    let markContextStarted;
    const heldContext = new Promise((resolve) => { releaseContext = resolve; });
    const contextStarted = new Promise((resolve) => { markContextStarted = resolve; });
    let pullGets = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/repos/acme/app/pulls/7') {
        if (options.method === 'GET') {
          pullGets += 1;
          if (pullGets === 1) {
            markContextStarted();
            await heldContext;
          }
        }
        return jsonResponse(pullRequest({ title: options.method === 'PATCH' ? 'Changed' : 'Title' }));
      }
      return jsonResponse([]);
    }));
    const { app } = makeApp();
    const query = {
      directory: '/worktree', number: 7, repositoryId: 'repo-one', bindingRevision: 3,
      accountId: account.accountId, primaryRemote: 'origin', instance: 'github.com',
    };

    const staleRead = request(app).get('/api/source-control/github/pulls/context')
      .query(query).expect(200).then((response) => response);
    await contextStarted;
    const target = { project: { owner: 'acme', name: 'app' }, number: 7, head: 'feature', base: 'main', headSha: 'abc123' };
    await request(app).post('/api/source-control/github/pr/update')
      .send({ ...context(account.accountId, { target }), title: 'Changed' }).expect(200);
    releaseContext();
    await staleRead;

    await request(app).get('/api/source-control/github/pulls/context').query(query).expect(200);
    expect(pullGets).toBe(3);
  });
});

describe('legacy GitHub mutations', () => {
  it('retires ambient reads and writes without provider calls', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const fetch = vi.fn(async () => jsonResponse(pullRequest()));
    vi.stubGlobal('fetch', fetch);
    const { app } = makeApp();
    const query = { directory: '/repo', branch: 'feature', remote: 'origin', accountId: account.accountId };

    await request(app).get('/api/github/pr/status').query(query).expect(410);
    await request(app).post('/api/github/pr/create').send({
      directory: '/repo', title: 'Title', head: 'feature', base: 'main', remote: 'origin', accountId: account.accountId,
    }).expect(410);
    expect(fetch).not.toHaveBeenCalled();
  });
});
