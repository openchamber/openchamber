import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMutationExecutor, digestMutationInput } from './mutation-executor.js';

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

const makeApp = ({ store = makeStore(), validateMutationContext, resolveRepo, resolveNetwork, resolveStatus, modules } = {}) => {
  const app = express();
  app.use(express.json());
  const routeOptions = {
    validateReadContext: async (input) => input,
    validateMutationContext: validateMutationContext ?? (async (body) => ({ ...body, target: { ...body.target, project: { ...body.target.project } } })),
    mutationExecutor: createMutationExecutor({ store }),
    resolveGitHubRepoFromDirectory: resolveRepo ?? (async (_directory, remote) => ({
      repo: remote === 'upstream' ? { owner: 'upstream', repo: 'app' } : { owner: 'acme', repo: 'app' },
    })),
    resolveRepoNetwork: resolveNetwork ?? (async () => null),
  };
  if (resolveStatus) routeOptions.resolveGitHubPrStatus = resolveStatus;
  if (modules) routeOptions.modules = modules;
  registerGitHubRoutes(app, routeOptions);
  return { app, store };
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
      return options.method === 'GET'
        ? jsonResponse(pullRequest())
        : jsonResponse({ status: 'merged', details: { message: 'Merged', sha: 'def456' } });
    }));
    const { app } = makeApp();

    const response = await request(app).post('/api/source-control/github/pr/merge').send(mergeBody(account.accountId)).expect(200);

    expect(response.body.result).toEqual({ merged: true });
    expect(requests).toEqual([
      { method: 'GET', path: '/repos/acme/app/pulls/7', body: null },
      { method: 'PUT', path: '/repos/acme/app/pulls/7/merge-async', body: { merge_method: 'merge', sha: 'abc123' } },
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
      return jsonResponse(pullRequest());
    }));
    const { app } = makeApp();

    expect((await request(app).post('/api/source-control/github/pr/merge').send(mergeBody(account.accountId)).expect(200)).body.result)
      .toEqual({ merged: true });
    final = 'enqueued';
    expect((await request(app).post('/api/source-control/github/pr/merge').send({ ...mergeBody(account.accountId), idempotencyKey: 'request-two' }).expect(200)).body.result)
      .toEqual({ merged: false, outcome: 'queued' });
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
    expect(paths).toEqual(['GET /repos/acme/app/pulls/7', 'PUT /repos/acme/app/pulls/7/merge-async', 'PUT /repos/acme/app/pulls/7/merge']);
  });

  it.each([
    ['ready', { ready: true }, pullRequest({ draft: false })],
    ['merge', { merged: true }, pullRequest({ state: 'closed', merged: true, merged_at: '2026-01-01T00:00:00Z' })],
  ])('reconciles a running %s mutation from provider state without repeating the write', async (kind, result, providerState) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const target = {
      repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
      project: { id: 'acme/app', owner: 'acme', name: 'app' }, number: 7, head: 'feature', base: 'main', headSha: 'abc123',
    };
    const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
    const input = { kind, actor, credential: credentialFor(account), target };
    if (kind === 'merge') input.method = 'merge';
    const record = { key: 'request-one', inputDigest: digestMutationInput(input), kind: `change-request-${kind}`, actor, target, state: 'running' };
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
    expect(fetch).toHaveBeenCalledOnce();
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
      expect(requests.filter((entry) => entry.method === 'POST')).toEqual([
        { method: 'POST', path: '/repos/acme/app/pulls/7/reviews', body: { commit_id: 'abc123', event: 'APPROVE' } },
        { method: 'POST', path: '/repos/acme/app/pulls/7/reviews', body: { commit_id: 'abc123', event: 'REQUEST_CHANGES', body: 'Rename it' } },
      ]);
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

    it('refuses a thread of another pull request and writes nothing', async () => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      const requests = recordRequests((entry) => (entry.method === 'GET' ? jsonResponse(pullRequest()) : jsonResponse(threadOn(8))));
      const { app } = makeApp();

      const response = await request(app).post('/api/source-control/github/pr/thread/reply')
        .send({ ...context(account.accountId, { target: pullTarget }), threadId: 'PRRT_other', body: 'Fixed' }).expect(409);

      expect(response.body.code).toBe('SOURCE_CONTROL_MUTATION_TARGET_INVALID');
      expect(requests.some((entry) => entry.method === 'POST' && /mutation/.test(entry.body.query))).toBe(false);
    });

    it("passes GitHub's reason when it refuses a review", async () => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      recordRequests((entry) => (entry.method === 'GET'
        ? jsonResponse(pullRequest())
        : jsonResponse({ message: 'Unprocessable Entity', errors: ['Review Can not approve your own pull request'] }, 422)));
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
