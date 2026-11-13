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

  const pullTarget = { project: { owner: 'acme', name: 'app' }, number: 7, head: 'feature', base: 'main', headSha: 'abc123' };

  it('points a pull request at another base and replays without a second write', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      const entry = { method: options.method, path: new URL(url).pathname, body: options.body ? JSON.parse(options.body) : null };
      requests.push(entry);
      if (options.method === 'PATCH') {
        return jsonResponse(pullRequest({ base: { ...pullRequest().base, ref: entry.body.base } }));
      }
      return jsonResponse(pullRequest());
    }));
    const { app, store } = makeApp();
    const payload = { ...context(account.accountId, { target: pullTarget }), base: 'release' };

    const response = await request(app).post('/api/source-control/github/pr/base').send(payload).expect(200);
    expect(response.body.result).toEqual({});
    // The receipt keeps the target the write started from; the move is provider state.
    expect(response.body.target).toMatchObject({ number: 7, head: 'feature', base: 'main', headSha: 'abc123' });
    expect(requests).toEqual([
      { method: 'GET', path: '/repos/acme/app/pulls/7', body: null },
      { method: 'PATCH', path: '/repos/acme/app/pulls/7', body: { base: 'release' } },
    ]);
    const record = store.records.get('request-one');
    expect(record).toMatchObject({ kind: 'change-request-base', state: 'succeeded' });
    expect(record.inputDigest).toBe(digestMutationInput({
      kind: 'base',
      actor: { provider: 'github', instance: 'github.com', accountId: account.accountId },
      credential: credentialFor(account),
      target: {
        repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
        project: { id: 'acme/app', owner: 'acme', name: 'app' }, number: 7, head: 'feature', base: 'main', headSha: 'abc123',
      },
      base: 'release',
    }));

    const replay = await request(app).post('/api/source-control/github/pr/base').send(payload).expect(200);
    expect(replay.body.replayed).toBe(true);
    expect(requests).toHaveLength(2);
  });

  it.each(['', '   ', 'release'.repeat(40), 'refs/heads/release', 7])('refuses an invalid base (%j) before any provider work', async (base) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { app } = makeApp();

    await request(app).post('/api/source-control/github/pr/base')
      .send({ ...context(account.accountId, { target: pullTarget }), base }).expect(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['release', 'succeeded', 200],
    ['main', 'outcome-unknown', 409],
  ])('reconciles an interrupted base change reading %s as %s', async (current, outcome, status) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const target = {
      repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
      project: { id: 'acme/app', owner: 'acme', name: 'app' }, number: 7, head: 'feature', base: 'main', headSha: 'abc123',
    };
    const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
    const input = { kind: 'base', actor, credential: credentialFor(account), target, base: 'release' };
    const store = makeStore([{
      key: 'request-one', inputDigest: digestMutationInput(input), kind: 'change-request-base', actor, target, state: 'running',
    }]);
    const fetch = vi.fn(async () => jsonResponse(pullRequest({ base: { ...pullRequest().base, ref: current } })));
    vi.stubGlobal('fetch', fetch);
    const { app } = makeApp({ store });

    await request(app).post('/api/source-control/github/pr/base')
      .send({ ...context(account.accountId, { target: { project: target.project, number: 7, head: 'feature', base: 'main', headSha: 'abc123' } }), base: 'release' })
      .expect(status);

    expect(store.records.get('request-one').state).toBe(outcome);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('does not record a base change as succeeded when GitHub answers another base', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      requests.push({ method: options.method, path: new URL(url).pathname });
      return options.method === 'PATCH'
        ? jsonResponse(pullRequest({ base: { ...pullRequest().base, ref: 'main' } }))
        : jsonResponse(pullRequest());
    }));
    const { app, store } = makeApp();

    const response = await request(app).post('/api/source-control/github/pr/base')
      .send({ ...context(account.accountId, { target: pullTarget }), base: 'release' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN');
    expect(store.records.get('request-one').state).toBe('outcome-unknown');
    expect(requests.filter((entry) => entry.method === 'PATCH')).toHaveLength(1);
  });

  const updateBranchHeadSha = 'a'.repeat(40);
  const updateBranchTarget = {
    project: { owner: 'acme', name: 'app' }, number: 7, head: 'feature', base: 'main', headSha: updateBranchHeadSha,
  };
  const updateBranchBody = (accountId) => ({
    ...context(accountId, { target: updateBranchTarget }), expectedHeadSha: updateBranchHeadSha,
  });

  it('asks GitHub to update the branch at the expected head, and replays without a second write', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      requests.push({ method: options.method, path: new URL(url).pathname, body: options.body ? JSON.parse(options.body) : null });
      return options.method === 'PUT'
        ? jsonResponse({ message: 'Updating pull request branch.' }, 202)
        : jsonResponse(pullRequest({ head: { ...pullRequest().head, sha: updateBranchHeadSha } }));
    }));
    const { app, store } = makeApp();

    const response = await request(app).post('/api/source-control/github/pr/update-branch')
      .send(updateBranchBody(account.accountId)).expect(200);
    expect(response.body.result).toEqual({});
    expect(requests).toEqual([
      { method: 'GET', path: '/repos/acme/app/pulls/7', body: null },
      { method: 'PUT', path: '/repos/acme/app/pulls/7/update-branch', body: { expected_head_sha: updateBranchHeadSha } },
    ]);
    const record = store.records.get('request-one');
    expect(record).toMatchObject({ kind: 'change-request-update-branch', state: 'succeeded' });
    expect(record.inputDigest).toBe(digestMutationInput({
      kind: 'update-branch',
      actor: { provider: 'github', instance: 'github.com', accountId: account.accountId },
      credential: credentialFor(account),
      target: {
        repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
        project: { id: 'acme/app', owner: 'acme', name: 'app' }, number: 7, head: 'feature', base: 'main',
        headSha: updateBranchHeadSha,
      },
      expectedHeadSha: updateBranchHeadSha,
    }));

    const replay = await request(app).post('/api/source-control/github/pr/update-branch')
      .send(updateBranchBody(account.accountId)).expect(200);
    expect(replay.body.replayed).toBe(true);
    expect(requests).toHaveLength(2);
  });

  it.each([
    ['missing', undefined],
    ['short', 'a'.repeat(39)],
    ['uppercase', 'A'.repeat(40)],
    ['non-hex', 'g'.repeat(40)],
    ['non-string', 7],
  ])('refuses a %s expectedHeadSha before any provider work', async (label, expectedHeadSha) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { app } = makeApp();
    const body = updateBranchBody(account.accountId);
    if (label !== 'missing') body.expectedHeadSha = expectedHeadSha;
    else delete body.expectedHeadSha;

    const response = await request(app).post('/api/source-control/github/pr/update-branch').send(body).expect(400);
    expect(response.body.error).toBe('expectedHeadSha is invalid');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses an expectedHeadSha that disagrees with the target head before any provider work', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { app } = makeApp();

    const response = await request(app).post('/api/source-control/github/pr/update-branch')
      .send({ ...updateBranchBody(account.accountId), expectedHeadSha: 'b'.repeat(40) }).expect(400);
    expect(response.body.error).toBe('expectedHeadSha does not match the target head');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['the head moved', 'b'.repeat(40), 'succeeded', 200],
    ['the same head still reads', updateBranchHeadSha, 'outcome-unknown', 409],
  ])('reconciles an interrupted branch update: %s', async (_label, currentHeadSha, state, status) => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const target = {
      repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
      project: { id: 'acme/app', owner: 'acme', name: 'app' }, number: 7, head: 'feature', base: 'main',
      headSha: updateBranchHeadSha,
    };
    const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
    const input = { kind: 'update-branch', actor, credential: credentialFor(account), target, expectedHeadSha: updateBranchHeadSha };
    const store = makeStore([{
      key: 'request-one', inputDigest: digestMutationInput(input), kind: 'change-request-update-branch', actor, target, state: 'running',
    }]);
    const fetch = vi.fn(async () => jsonResponse(pullRequest({ head: { ...pullRequest().head, sha: currentHeadSha } })));
    vi.stubGlobal('fetch', fetch);
    const { app } = makeApp({ store });

    await request(app).post('/api/source-control/github/pr/update-branch')
      .send(updateBranchBody(account.accountId)).expect(status);

    expect(store.records.get('request-one').state).toBe(state);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("passes GitHub's reason for a branch update it refused and records no success", async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const refusal = `Updating pull request branch is not possible. Expected head sha ${updateBranchHeadSha} did not match the current head sha ${'b'.repeat(40)}.`;
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => (options.method === 'PUT'
      ? jsonResponse({ message: refusal }, 422)
      : jsonResponse(pullRequest({ head: { ...pullRequest().head, sha: updateBranchHeadSha } })))));
    const { app, store } = makeApp();

    const response = await request(app).post('/api/source-control/github/pr/update-branch')
      .send(updateBranchBody(account.accountId)).expect(422);
    expect(response.body).toEqual({ error: refusal, code: 'SOURCE_CONTROL_MUTATION_REJECTED' });
    expect(store.records.get('request-one').state).toBe('failed');
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
    ['draft', { draft: true }, pullRequest({ draft: true })],
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

  it('converts an open pull request to a draft, and writes nothing when it already is one', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    let draft = false;
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      const entry = { method: options.method, path: new URL(String(url)).pathname, body: options.body ? JSON.parse(options.body) : null };
      requests.push(entry);
      if (entry.method === 'GET') return jsonResponse(pullRequest({ draft }));
      draft = true;
      return jsonResponse({ data: { convertPullRequestToDraft: { pullRequest: { id: 'PR_node', isDraft: true } } } });
    }));
    const { app } = makeApp();
    const body = context(account.accountId, {
      target: { project: { owner: 'acme', name: 'app' }, number: 7, head: 'feature', base: 'main', headSha: 'abc123' },
    });

    const response = await request(app).post('/api/source-control/github/pr/draft').send(body).expect(200);
    expect(response.body.result).toEqual({ draft: true });
    const mutation = requests.at(-1);
    expect(mutation.path).toBe('/graphql');
    expect(mutation.body.query).toContain('convertPullRequestToDraft');

    const again = await request(app).post('/api/source-control/github/pr/draft')
      .send({ ...body, idempotencyKey: 'request-two' }).expect(200);
    expect(again.body.result).toEqual({ draft: true });
    expect(requests.filter((entry) => entry.path === '/graphql')).toHaveLength(1);
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

    describe('conversation comment edits', () => {
      const issueTarget = { project: { owner: 'acme', name: 'app' }, number: 5 };
      const discussionTarget = { project: { owner: 'acme', name: 'app' }, number: 5 };
      const commentOf = (overrides = {}) => ({
        id: 13,
        body: 'Old text',
        html_url: 'https://github.com/acme/app/issues/5#issuecomment-13',
        issue_url: 'https://api.github.com/repos/acme/app/issues/5',
        user: { id: 1, login: 'actor' },
        ...overrides,
      });
      const commentWrites = (requests) => requests.filter((entry) => entry.method === 'PATCH' || entry.method === 'DELETE');
      const graphqlWrites = (requests) => requests
        .filter((entry) => /^mutation/.test(entry.body.query.trim()))
        .map((entry) => ({ query: entry.body.query, variables: entry.body.variables }));

      it('edits and deletes an issue comment with one REST write each', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const requests = recordRequests((entry) => {
          if (entry.path === '/repos/acme/app/issues/5') return jsonResponse({ number: 5 });
          if (entry.path !== '/repos/acme/app/issues/comments/13') throw new Error(`Unexpected request ${entry.method} ${entry.path}`);
          if (entry.method === 'DELETE') return new Response(null, { status: 204 });
          return jsonResponse(commentOf(entry.method === 'PATCH' ? { body: entry.body.body } : {}));
        });
        const { app, store } = makeApp();

        const updated = await request(app).post('/api/source-control/github/issues/comment/update')
          .send({ ...context(account.accountId, { target: issueTarget }), commentId: '13', body: 'Edited text' }).expect(200);
        const removed = await request(app).post('/api/source-control/github/issues/comment/delete')
          .send({ ...context(account.accountId, { target: issueTarget, idempotencyKey: 'request-two' }), commentId: '13' }).expect(200);

        expect(updated.body).toMatchObject({
          status: 'succeeded',
          target: {
            repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
            project: { id: 'acme/app', owner: 'acme', name: 'app' }, number: 5,
          },
          replayed: false,
          result: {},
        });
        expect(removed.body).toMatchObject({ status: 'succeeded', replayed: false, result: {} });
        expect(requests).toEqual([
          { method: 'GET', path: '/repos/acme/app/issues/5', body: null },
          { method: 'GET', path: '/repos/acme/app/issues/comments/13', body: null },
          { method: 'PATCH', path: '/repos/acme/app/issues/comments/13', body: { body: 'Edited text' } },
          { method: 'GET', path: '/repos/acme/app/issues/5', body: null },
          { method: 'GET', path: '/repos/acme/app/issues/comments/13', body: null },
          { method: 'DELETE', path: '/repos/acme/app/issues/comments/13', body: null },
        ]);
        expect(store.records.get('request-one')).toMatchObject({ kind: 'issue-comment-update', state: 'succeeded', result: {} });
        expect(store.records.get('request-two')).toMatchObject({ kind: 'issue-comment-delete', state: 'succeeded', result: {} });
      });

      it('edits and deletes a pull request conversation comment as an issue comment', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const requests = recordRequests((entry) => {
          if (entry.path === '/repos/acme/app/pulls/7') return jsonResponse(pullRequest());
          if (entry.path !== '/repos/acme/app/issues/comments/13') throw new Error(`Unexpected request ${entry.method} ${entry.path}`);
          if (entry.method === 'DELETE') return new Response(null, { status: 204 });
          const comment = {
            issue_url: 'https://api.github.com/repos/acme/app/issues/7',
            html_url: 'https://github.com/acme/app/pull/7#issuecomment-13',
          };
          if (entry.method === 'PATCH') comment.body = entry.body.body;
          return jsonResponse(commentOf(comment));
        });
        const { app, store } = makeApp();

        await request(app).post('/api/source-control/github/pr/comment/update')
          .send({ ...context(account.accountId, { target: pullTarget }), commentId: '13', body: 'Edited text' }).expect(200);
        await request(app).post('/api/source-control/github/pr/comment/delete')
          .send({ ...context(account.accountId, { target: pullTarget, idempotencyKey: 'request-two' }), commentId: '13' }).expect(200);

        expect(commentWrites(requests)).toEqual([
          { method: 'PATCH', path: '/repos/acme/app/issues/comments/13', body: { body: 'Edited text' } },
          { method: 'DELETE', path: '/repos/acme/app/issues/comments/13', body: null },
        ]);
        expect(store.records.get('request-one')).toMatchObject({ kind: 'change-request-comment-update', state: 'succeeded', result: {} });
        expect(store.records.get('request-two')).toMatchObject({ kind: 'change-request-comment-delete', state: 'succeeded', result: {} });
      });

      it('edits and deletes a discussion comment through GraphQL by node id', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const requests = recordRequests((entry) => {
          const { query, variables } = entry.body;
          if (query.includes('discussion(number:')) {
            return jsonResponse({ data: { repository: { discussion: { id: 'D_five', number: 5, closed: false, labels: { nodes: [] } } } } });
          }
          if (query.includes('updateDiscussionComment')) {
            return jsonResponse({ data: { updateDiscussionComment: { comment: { id: variables.commentId, body: variables.body } } } });
          }
          if (query.includes('deleteDiscussionComment')) {
            return jsonResponse({ data: { deleteDiscussionComment: { clientMutationId: null } } });
          }
          return jsonResponse({ data: { node: {
            __typename: 'DiscussionComment', isAnswer: false, body: 'Old text', replyTo: null,
            discussion: { number: 5, repository: { name: 'app', owner: { login: 'acme' } } },
          } } });
        });
        const { app, store } = makeApp();

        await request(app).post('/api/source-control/github/discussions/comment/update')
          .send({ ...context(account.accountId, { target: discussionTarget }), commentId: 'DC_one', body: 'Edited text' }).expect(200);
        await request(app).post('/api/source-control/github/discussions/comment/delete')
          .send({ ...context(account.accountId, { target: discussionTarget, idempotencyKey: 'request-two' }), commentId: 'DC_one' }).expect(200);

        const writes = graphqlWrites(requests);
        expect(writes.map((write) => write.variables)).toEqual([{ commentId: 'DC_one', body: 'Edited text' }, { id: 'DC_one' }]);
        expect(writes[0].query).toContain('updateDiscussionComment(input: { commentId: $commentId, body: $body })');
        expect(writes[0].query).toContain('comment { id body }');
        expect(writes[1].query).toContain('deleteDiscussionComment(input: { id: $id })');
        expect(store.records.get('request-one')).toMatchObject({ kind: 'discussion-comment-update', state: 'succeeded', result: {} });
        expect(store.records.get('request-two')).toMatchObject({ kind: 'discussion-comment-delete', state: 'succeeded', result: {} });
      });

      it('leaves a delete whose comment read is refused at outcome-unknown', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const requests = recordRequests((entry) => {
          if (entry.body.query.includes('discussion(number:')) {
            return jsonResponse({ data: { repository: { discussion: { id: 'D_five', number: 5, closed: false, labels: { nodes: [] } } } } });
          }
          return jsonResponse({ errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] });
        });
        const target = {
          repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
          project: { id: 'acme/app', owner: 'acme', name: 'app' }, number: 5,
        };
        const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
        const input = { kind: 'discussion-comment-delete', actor, credential: credentialFor(account), target, commentId: 'DC_one' };
        const store = makeStore([{
          key: 'request-one', inputDigest: digestMutationInput(input), kind: 'discussion-comment-delete', actor, target, state: 'running',
        }]);
        const { app } = makeApp({ store });

        const response = await request(app).post('/api/source-control/github/discussions/comment/delete')
          .send({ ...context(account.accountId, { target: discussionTarget }), commentId: 'DC_one' }).expect(409);

        expect(response.body.code).toBe('SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN');
        expect(store.records.get('request-one').state).toBe('outcome-unknown');
        expect(graphqlWrites(requests)).toHaveLength(0);
      });

      it('refuses a comment of another item and writes nothing', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const elsewhere = commentOf({
          issue_url: 'https://api.github.com/repos/acme/app/issues/6',
          html_url: 'https://github.com/acme/app/issues/6#issuecomment-13',
        });
        const issueRequests = recordRequests((entry) => (entry.path === '/repos/acme/app/issues/5' ? jsonResponse({ number: 5 }) : jsonResponse(elsewhere)));
        const { app } = makeApp();
        const refusedIssue = await request(app).post('/api/source-control/github/issues/comment/update')
          .send({ ...context(account.accountId, { target: issueTarget }), commentId: '13', body: 'Edited text' }).expect(409);
        expect(refusedIssue.body.code).toBe('SOURCE_CONTROL_MUTATION_TARGET_INVALID');
        expect(commentWrites(issueRequests)).toEqual([]);

        const pullRequests = recordRequests((entry) => (entry.path === '/repos/acme/app/pulls/7' ? jsonResponse(pullRequest()) : jsonResponse(elsewhere)));
        const { app: pullApp } = makeApp();
        const refusedPull = await request(pullApp).post('/api/source-control/github/pr/comment/delete')
          .send({ ...context(account.accountId, { target: pullTarget }), commentId: '13' }).expect(409);
        expect(refusedPull.body.code).toBe('SOURCE_CONTROL_MUTATION_TARGET_INVALID');
        expect(commentWrites(pullRequests)).toEqual([]);

        const discussionRequests = recordRequests((entry) => (entry.body.query.includes('discussion(number:')
          ? jsonResponse({ data: { repository: { discussion: { id: 'D_five', number: 5, closed: false, labels: { nodes: [] } } } } })
          : jsonResponse({ data: { node: {
            __typename: 'DiscussionComment', isAnswer: false, replyTo: null,
            discussion: { number: 6, repository: { name: 'app', owner: { login: 'acme' } } },
          } } })));
        const { app: discussionApp } = makeApp();
        const refusedDiscussion = await request(discussionApp).post('/api/source-control/github/discussions/comment/delete')
          .send({ ...context(account.accountId, { target: discussionTarget }), commentId: 'DC_other' }).expect(409);
        expect(refusedDiscussion.body.code).toBe('SOURCE_CONTROL_MUTATION_TARGET_INVALID');
        expect(graphqlWrites(discussionRequests)).toEqual([]);
      });

      it.each([
        ['/pr/comment/update', { project: { owner: 'acme', name: 'app' }, number: 7 }],
        ['/issues/comment/update', issueTarget],
        ['/discussions/comment/update', discussionTarget],
      ])('refuses an empty body and a missing comment id on %s without a provider call', async (route, target) => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const requests = recordRequests(() => jsonResponse({}));
        const { app } = makeApp();

        const empty = await request(app).post(`/api/source-control/github${route}`)
          .send({ ...context(account.accountId, { target }), commentId: '13', body: '   ' }).expect(400);
        const missing = await request(app).post(`/api/source-control/github${route}`)
          .send({ ...context(account.accountId, { target, idempotencyKey: 'request-two' }), body: 'Edited text' }).expect(400);

        expect(empty.body).toEqual({ error: 'body is required', code: 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT' });
        expect(missing.body).toEqual({ error: 'commentId is invalid', code: 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT' });
        expect(requests).toEqual([]);
      });

      it("passes GitHub's reason for a refused comment write and records it failed", async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        recordRequests((entry) => {
          if (entry.path === '/repos/acme/app/issues/5') return jsonResponse({ number: 5 });
          if (entry.method === 'PATCH') {
            return jsonResponse({ message: 'Validation Failed', errors: [{ message: 'Body is too long (maximum is 65536 characters)' }] }, 422);
          }
          return jsonResponse(commentOf());
        });
        const { app, store } = makeApp();

        const refused = await request(app).post('/api/source-control/github/issues/comment/update')
          .send({ ...context(account.accountId, { target: issueTarget }), commentId: '13', body: 'Edited text' }).expect(422);

        expect(refused.body).toEqual({ error: 'Body is too long (maximum is 65536 characters)', code: 'SOURCE_CONTROL_MUTATION_REJECTED' });
        expect(store.records.get('request-one')).toMatchObject({ state: 'failed', result: { failureStatus: 422 } });
      });

      it('replays a repeated comment edit without a second write', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const requests = recordRequests((entry) => {
          if (entry.path === '/repos/acme/app/issues/5') return jsonResponse({ number: 5 });
          if (entry.method === 'PATCH') return jsonResponse(commentOf({ body: entry.body.body }));
          return jsonResponse(commentOf());
        });
        const { app } = makeApp();
        const payload = { ...context(account.accountId, { target: issueTarget }), commentId: '13', body: 'Edited text' };

        await request(app).post('/api/source-control/github/issues/comment/update').send(payload).expect(200);
        const replay = await request(app).post('/api/source-control/github/issues/comment/update').send(payload).expect(200);

        expect(replay.body.replayed).toBe(true);
        expect(requests.filter((entry) => entry.method === 'PATCH')).toHaveLength(1);
      });

      it('finishes an interrupted edit or delete only from what the comment reads now', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
        const target = {
          repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
          project: { id: 'acme/app', owner: 'acme', name: 'app' }, number: 5,
        };
        const running = (kind, input) => makeStore([{
          key: 'request-one', kind, actor, target, state: 'running',
          inputDigest: digestMutationInput({ kind, actor, credential: credentialFor(account), target, ...input }),
        }]);

        // The comment reads as asked: the edit landed, no second write.
        const doneRequests = recordRequests(() => jsonResponse(commentOf({ body: 'Edited text' })));
        const { app: doneApp } = makeApp({ store: running('issue-comment-update', { commentId: 13, body: 'Edited text' }) });
        const done = await request(doneApp).post('/api/source-control/github/issues/comment/update')
          .send({ ...context(account.accountId, { target: issueTarget }), commentId: '13', body: 'Edited text' }).expect(200);
        expect(done.body.result).toEqual({});
        expect(commentWrites(doneRequests)).toEqual([]);

        // Someone edited it differently meanwhile: no claim either way.
        recordRequests(() => jsonResponse(commentOf({ body: 'Edited by a human' })));
        const { app: unknownApp, store: unknownStore } = makeApp({ store: running('issue-comment-update', { commentId: 13, body: 'Edited text' }) });
        await request(unknownApp).post('/api/source-control/github/issues/comment/update')
          .send({ ...context(account.accountId, { target: issueTarget }), commentId: '13', body: 'Edited text' }).expect(409);
        expect(unknownStore.records.get('request-one').state).toBe('outcome-unknown');

        // The comment reads 404: the delete landed.
        recordRequests(() => jsonResponse({ message: 'Not Found' }, 404));
        const { app: goneApp, store: goneStore } = makeApp({ store: running('issue-comment-delete', { commentId: 13 }) });
        const gone = await request(goneApp).post('/api/source-control/github/issues/comment/delete')
          .send({ ...context(account.accountId, { target: issueTarget }), commentId: '13' }).expect(200);
        expect(gone.body.result).toEqual({});
        expect(goneStore.records.get('request-one').state).toBe('succeeded');

        // Still there: never a definite not-applied.
        recordRequests(() => jsonResponse(commentOf()));
        const { app: keptApp, store: keptStore } = makeApp({ store: running('issue-comment-delete', { commentId: 13 }) });
        await request(keptApp).post('/api/source-control/github/issues/comment/delete')
          .send({ ...context(account.accountId, { target: issueTarget }), commentId: '13' }).expect(409);
        expect(keptStore.records.get('request-one').state).toBe('outcome-unknown');
      });
    });

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
        // Only the reply names a comment to read; a comment of its own names none.
        expect(requests.filter((entry) => entry.body.query.includes('node(id:'))
          .map((entry) => entry.body.variables)).toEqual([{ id: 'DC_one' }]);
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

      describe('upvotes', () => {
        const upvoteWrites = (requests) => requests.filter((entry) => /^mutation/.test(entry.body.query.trim()));

        it('votes a discussion up through addUpvote and stores the mutation without its node id', async () => {
          const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
          const requests = graphqlRequests(() => ({ addUpvote: { clientMutationId: null } }));
          const { app, store } = makeApp();

          const response = await request(app).post('/api/source-control/github/discussions/upvote')
            .send({ ...context(account.accountId, { target: discussionTarget }), upvoted: true }).expect(200);

          expect(response.body.result).toEqual({});
          const writes = upvoteWrites(requests);
          expect(writes).toHaveLength(1);
          expect(writes[0].body.query).toContain('addUpvote(input: { subjectId: $subjectId })');
          expect(writes[0].body.variables).toEqual({ subjectId: 'D_five' });
          expect(store.records.get('request-one')).toMatchObject({ kind: 'discussion-upvote', state: 'succeeded', result: {}, target: { number: 5 } });
        });

        it('takes the vote back through removeUpvote', async () => {
          const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
          const requests = graphqlRequests(() => ({ removeUpvote: { clientMutationId: null } }));
          const { app, store } = makeApp();

          const response = await request(app).post('/api/source-control/github/discussions/upvote')
            .send({ ...context(account.accountId, { target: discussionTarget }), upvoted: false }).expect(200);

          expect(response.body.result).toEqual({});
          const writes = upvoteWrites(requests);
          expect(writes).toHaveLength(1);
          expect(writes[0].body.query).toContain('removeUpvote(input: { subjectId: $subjectId })');
          expect(writes[0].body.variables).toEqual({ subjectId: 'D_five' });
          expect(store.records.get('request-one')).toMatchObject({ kind: 'discussion-upvote', state: 'succeeded', result: {} });
        });

        it('replays a repeated key without a second write', async () => {
          const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
          const requests = graphqlRequests(() => ({ addUpvote: { clientMutationId: null } }));
          const { app } = makeApp();
          const payload = { ...context(account.accountId, { target: discussionTarget }), upvoted: true };

          await request(app).post('/api/source-control/github/discussions/upvote').send(payload).expect(200);
          const replay = await request(app).post('/api/source-control/github/discussions/upvote').send(payload).expect(200);

          expect(replay.body.replayed).toBe(true);
          expect(upvoteWrites(requests)).toHaveLength(1);
          expect(requests).toHaveLength(2);
        });

        it('refuses a discussion another number names and writes nothing', async () => {
          const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
          const requests = graphqlRequests(() => ({}), { discussion: discussionNode({ number: 6 }) });
          const { app } = makeApp();

          const response = await request(app).post('/api/source-control/github/discussions/upvote')
            .send({ ...context(account.accountId, { target: discussionTarget }), upvoted: true }).expect(409);

          expect(response.body.code).toBe('SOURCE_CONTROL_MUTATION_TARGET_INVALID');
          expect(upvoteWrites(requests)).toEqual([]);
          expect(requests).toHaveLength(1);
        });

        it('refuses a non-boolean upvoted without a provider call', async () => {
          const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
          const requests = recordRequests(() => jsonResponse({}));
          const { app } = makeApp();

          const response = await request(app).post('/api/source-control/github/discussions/upvote')
            .send({ ...context(account.accountId, { target: discussionTarget }), upvoted: 'yes' }).expect(400);

          expect(response.body).toEqual({ error: 'upvoted is invalid', code: 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT' });
          expect(requests).toEqual([]);
        });

        const interrupted = (account, upvoted) => {
          const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
          const target = {
            repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
            project: { id: 'acme/app', owner: 'acme', name: 'app' }, number: 5,
          };
          return makeStore([{
            key: 'request-one',
            inputDigest: digestMutationInput({ kind: 'discussion-upvote', actor, credential: credentialFor(account), target, upvoted }),
            kind: 'discussion-upvote', actor, target, state: 'running',
          }]);
        };

        it('finishes an interrupted upvote that reads back the same, without writing again', async () => {
          const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
          const store = interrupted(account, true);
          const requests = graphqlRequests(() => ({}), { discussion: discussionNode({ viewerHasUpvoted: true }) });
          const { app } = makeApp({ store });

          const response = await request(app).post('/api/source-control/github/discussions/upvote')
            .send({ ...context(account.accountId, { target: discussionTarget }), upvoted: true }).expect(200);

          expect(response.body.result).toEqual({});
          expect(store.records.get('request-one').state).toBe('succeeded');
          expect(upvoteWrites(requests)).toEqual([]);
          expect(requests).toHaveLength(1);
        });

        it('leaves an upvote that reads back the other way at outcome-unknown, never not-applied', async () => {
          const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
          const store = interrupted(account, false);
          const requests = graphqlRequests(() => ({}), { discussion: discussionNode({ viewerHasUpvoted: true }) });
          const { app } = makeApp({ store });

          await request(app).post('/api/source-control/github/discussions/upvote')
            .send({ ...context(account.accountId, { target: discussionTarget }), upvoted: false }).expect(409);

          expect(store.records.get('request-one').state).toBe('outcome-unknown');
          expect(upvoteWrites(requests)).toEqual([]);
          expect(requests).toHaveLength(1);
        });
      });

      describe('categories', () => {
        const categoryWrites = (requests) => requests.filter((entry) => /^mutation/.test(entry.body.query.trim()));
        const movedTo = (categoryId) => ({ updateDiscussion: { discussion: { id: 'D_five', category: { id: categoryId } } } });

        it('moves a discussion to another category through updateDiscussion', async () => {
          const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
          const requests = graphqlRequests(() => movedTo('DIC_ideas'), { discussion: discussionNode({ category: { id: 'DIC_qa' } }) });
          const { app, store } = makeApp();

          const response = await request(app).post('/api/source-control/github/discussions/category')
            .send({ ...context(account.accountId, { target: discussionTarget }), categoryId: 'DIC_ideas' }).expect(200);

          expect(response.body.result).toEqual({});
          const writes = categoryWrites(requests);
          expect(writes).toHaveLength(1);
          expect(writes[0].body.query).toBe('mutation($discussionId: ID!, $categoryId: ID!) { updateDiscussion(input: { discussionId: $discussionId, categoryId: $categoryId }) { discussion { id category { id } } } }');
          expect(writes[0].body.variables).toEqual({ discussionId: 'D_five', categoryId: 'DIC_ideas' });
          expect(store.records.get('request-one')).toMatchObject({ kind: 'discussion-category', state: 'succeeded', result: {}, target: { number: 5 } });
        });

        it('leaves a move whose answer names another category outcome-unknown', async () => {
          const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
          const requests = graphqlRequests(() => movedTo('DIC_qa'), { discussion: discussionNode({ category: { id: 'DIC_qa' } }) });
          const { app, store } = makeApp();

          const response = await request(app).post('/api/source-control/github/discussions/category')
            .send({ ...context(account.accountId, { target: discussionTarget }), categoryId: 'DIC_ideas' }).expect(409);

          expect(response.body.code).toBe('SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN');
          expect(store.records.get('request-one').state).toBe('outcome-unknown');
          expect(categoryWrites(requests)).toHaveLength(1);
        });

        it('replays a repeated key without a second write', async () => {
          const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
          const requests = graphqlRequests(() => movedTo('DIC_ideas'), { discussion: discussionNode({ category: { id: 'DIC_qa' } }) });
          const { app } = makeApp();
          const payload = { ...context(account.accountId, { target: discussionTarget }), categoryId: 'DIC_ideas' };

          await request(app).post('/api/source-control/github/discussions/category').send(payload).expect(200);
          const replay = await request(app).post('/api/source-control/github/discussions/category').send(payload).expect(200);

          expect(replay.body.replayed).toBe(true);
          expect(categoryWrites(requests)).toHaveLength(1);
          expect(requests).toHaveLength(2);
        });

        it('refuses a missing or non-node categoryId without a provider call', async () => {
          const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
          const requests = recordRequests(() => jsonResponse({}));
          const { app } = makeApp();

          const missing = await request(app).post('/api/source-control/github/discussions/category')
            .send({ ...context(account.accountId, { target: discussionTarget }) }).expect(400);
          const malformed = await request(app).post('/api/source-control/github/discussions/category')
            .send({ ...context(account.accountId, { target: discussionTarget, idempotencyKey: 'request-two' }), categoryId: 'not a node id!' }).expect(400);

          expect(missing.body).toEqual({ error: 'categoryId is invalid', code: 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT' });
          expect(malformed.body).toEqual({ error: 'categoryId is invalid', code: 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT' });
          expect(requests).toEqual([]);
        });

        const interrupted = (account, categoryId) => {
          const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
          const target = {
            repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
            project: { id: 'acme/app', owner: 'acme', name: 'app' }, number: 5,
          };
          return makeStore([{
            key: 'request-one',
            inputDigest: digestMutationInput({ kind: 'discussion-category', actor, credential: credentialFor(account), target, categoryId }),
            kind: 'discussion-category', actor, target, state: 'running',
          }]);
        };

        it('finishes an interrupted move that reads back the same, without writing again', async () => {
          const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
          const store = interrupted(account, 'DIC_ideas');
          const requests = graphqlRequests(() => ({}), { discussion: discussionNode({ category: { id: 'DIC_ideas' } }) });
          const { app } = makeApp({ store });

          const response = await request(app).post('/api/source-control/github/discussions/category')
            .send({ ...context(account.accountId, { target: discussionTarget }), categoryId: 'DIC_ideas' }).expect(200);

          expect(response.body.result).toEqual({});
          expect(store.records.get('request-one').state).toBe('succeeded');
          expect(categoryWrites(requests)).toEqual([]);
          expect(requests).toHaveLength(1);
        });

        it('leaves a move that reads back another category at outcome-unknown, never not-applied', async () => {
          const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
          const store = interrupted(account, 'DIC_qa');
          const requests = graphqlRequests(() => ({}), { discussion: discussionNode({ category: { id: 'DIC_ideas' } }) });
          const { app } = makeApp({ store });

          await request(app).post('/api/source-control/github/discussions/category')
            .send({ ...context(account.accountId, { target: discussionTarget }), categoryId: 'DIC_qa' }).expect(409);

          expect(store.records.get('request-one').state).toBe('outcome-unknown');
          expect(categoryWrites(requests)).toEqual([]);
          expect(requests).toHaveLength(1);
        });
      });

    describe('conversation locks', () => {
      const issueTarget = { project: { owner: 'acme', name: 'app' }, number: 5 };
      const pullTarget = { project: { owner: 'acme', name: 'app' }, number: 7 };
      const discussionTarget = { project: { owner: 'acme', name: 'app' }, number: 5 };
      const restWrites = (requests) => requests
        .filter((entry) => entry.method === 'PUT' || entry.method === 'DELETE')
        .map(({ method, path }) => ({ method, path }));
      const lockWrites = (requests) => requests.filter((entry) => /^mutation/.test(entry.body.query.trim()));

      it('locks and unlocks an issue through the REST lock API, and replays without a second write', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const requests = recordRequests(() => jsonResponse({ number: 5, locked: true }));
        const { app, store } = makeApp();
        const payload = { ...context(account.accountId, { target: issueTarget }), locked: true };

        const locked = await request(app).post('/api/source-control/github/issues/lock').send(payload).expect(200);
        const replayed = await request(app).post('/api/source-control/github/issues/lock').send(payload).expect(200);
        const unlocked = await request(app).post('/api/source-control/github/issues/lock')
          .send({ ...context(account.accountId, { target: issueTarget, idempotencyKey: 'request-two' }), locked: false }).expect(200);

        expect(locked.body.result).toEqual({});
        expect(unlocked.body.result).toEqual({});
        expect(replayed.body.replayed).toBe(true);
        expect(restWrites(requests)).toEqual([
          { method: 'PUT', path: '/repos/acme/app/issues/5/lock' },
          { method: 'DELETE', path: '/repos/acme/app/issues/5/lock' },
        ]);
        expect(store.records.get('request-one')).toMatchObject({ kind: 'issue-lock', state: 'succeeded', result: {}, target: { number: 5 } });
        expect(store.records.get('request-two')).toMatchObject({ kind: 'issue-lock', state: 'succeeded', result: {} });
      });

      it('locks and unlocks a pull request conversation through the same REST lock API, and replays without a second write', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const requests = recordRequests((entry) => (entry.method === 'GET' ? jsonResponse(pullRequest()) : jsonResponse({})));
        const { app, store } = makeApp();
        const payload = { ...context(account.accountId, { target: pullTarget }), locked: true };

        const locked = await request(app).post('/api/source-control/github/pr/lock').send(payload).expect(200);
        const replayed = await request(app).post('/api/source-control/github/pr/lock').send(payload).expect(200);
        const unlocked = await request(app).post('/api/source-control/github/pr/lock')
          .send({ ...context(account.accountId, { target: pullTarget, idempotencyKey: 'request-two' }), locked: false }).expect(200);

        expect(locked.body.result).toEqual({});
        expect(unlocked.body.result).toEqual({});
        expect(replayed.body.replayed).toBe(true);
        expect(restWrites(requests)).toEqual([
          { method: 'PUT', path: '/repos/acme/app/issues/7/lock' },
          { method: 'DELETE', path: '/repos/acme/app/issues/7/lock' },
        ]);
        expect(store.records.get('request-one')).toMatchObject({ kind: 'change-request-lock', state: 'succeeded', result: {}, target: { number: 7 } });
        expect(store.records.get('request-two')).toMatchObject({ kind: 'change-request-lock', state: 'succeeded', result: {} });
      });

      it('locks and unlocks a discussion through GraphQL, and replays without a second write', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const requests = graphqlRequests((query) => (query.includes('unlockLockable(')
          ? { unlockLockable: { clientMutationId: null } }
          : { lockLockable: { clientMutationId: null } }));
        const { app, store } = makeApp();
        const payload = { ...context(account.accountId, { target: discussionTarget }), locked: true };

        const locked = await request(app).post('/api/source-control/github/discussions/lock').send(payload).expect(200);
        const replayed = await request(app).post('/api/source-control/github/discussions/lock').send(payload).expect(200);
        const unlocked = await request(app).post('/api/source-control/github/discussions/lock')
          .send({ ...context(account.accountId, { target: discussionTarget, idempotencyKey: 'request-two' }), locked: false }).expect(200);

        expect(locked.body.result).toEqual({});
        expect(unlocked.body.result).toEqual({});
        expect(replayed.body.replayed).toBe(true);
        expect(lockWrites(requests).map((entry) => [!entry.body.query.includes('unlockLockable('), entry.body.variables])).toEqual([
          [true, { lockableId: 'D_five' }],
          [false, { lockableId: 'D_five' }],
        ]);
        expect(store.records.get('request-one')).toMatchObject({ kind: 'discussion-lock', state: 'succeeded', result: {}, target: { number: 5 } });
        expect(store.records.get('request-two')).toMatchObject({ kind: 'discussion-lock', state: 'succeeded', result: {} });
      });

      it('refuses a number that names another discussion, and writes nothing', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const requests = graphqlRequests(() => ({}), { discussion: discussionNode({ number: 6 }) });
        const { app } = makeApp();

        const response = await request(app).post('/api/source-control/github/discussions/lock')
          .send({ ...context(account.accountId, { target: discussionTarget }), locked: true }).expect(409);

        expect(response.body.code).toBe('SOURCE_CONTROL_MUTATION_TARGET_INVALID');
        expect(lockWrites(requests)).toEqual([]);
      });

      it.each(['/issues/lock', '/pr/lock', '/discussions/lock'])('refuses a non-boolean locked on %s without a provider call', async (route) => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const requests = recordRequests(() => jsonResponse({}));
        const { app } = makeApp();

        const response = await request(app).post(`/api/source-control/github${route}`)
          .send({ ...context(account.accountId, { target: issueTarget }), locked: 'yes' }).expect(400);

        expect(response.body).toEqual({ error: 'locked is invalid', code: 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT' });
        expect(requests).toEqual([]);
      });

      it.each([
        ['issue-lock', '/issues/lock', issueTarget, 5, true, 'succeeded', 200],
        ['issue-lock', '/issues/lock', issueTarget, 5, false, 'outcome-unknown', 409],
        ['change-request-lock', '/pr/lock', pullTarget, 7, true, 'succeeded', 200],
        ['change-request-lock', '/pr/lock', pullTarget, 7, false, 'outcome-unknown', 409],
      ])('reconciles an interrupted %s from the REST issue reading back', async (kind, route, targetRef, number, current, outcome, status) => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const target = {
          repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
          project: { id: 'acme/app', owner: 'acme', name: 'app' }, number,
        };
        const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
        const input = { kind, actor, credential: credentialFor(account), target, locked: true };
        const store = makeStore([{ key: 'request-one', inputDigest: digestMutationInput(input), kind, actor, target, state: 'running' }]);
        const fetch = vi.fn(async () => jsonResponse({ number, locked: current }));
        vi.stubGlobal('fetch', fetch);
        const { app } = makeApp({ store });

        await request(app).post(`/api/source-control/github${route}`)
          .send({ ...context(account.accountId, { target: targetRef }), locked: true }).expect(status);

        expect(store.records.get('request-one').state).toBe(outcome);
        expect(fetch).toHaveBeenCalledOnce();
      });

      it.each([
        [true, 'succeeded', 200],
        [false, 'outcome-unknown', 409],
      ])('reconciles an interrupted discussion lock that reads back as %s', async (current, outcome, status) => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const target = {
          repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
          project: { id: 'acme/app', owner: 'acme', name: 'app' }, number: 5,
        };
        const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
        const input = { kind: 'discussion-lock', actor, credential: credentialFor(account), target, locked: true };
        const store = makeStore([{ key: 'request-one', inputDigest: digestMutationInput(input), kind: 'discussion-lock', actor, target, state: 'running' }]);
        const requests = graphqlRequests(() => ({}), { discussion: discussionNode({ locked: current }) });
        const { app } = makeApp({ store });

        await request(app).post('/api/source-control/github/discussions/lock')
          .send({ ...context(account.accountId, { target: discussionTarget }), locked: true }).expect(status);

        expect(store.records.get('request-one').state).toBe(outcome);
        expect(lockWrites(requests)).toEqual([]);
        expect(requests).toHaveLength(1);
      });
    });
    });

    describe('subscriptions', () => {
      const issueTarget = { project: { owner: 'acme', name: 'app' }, number: 5 };
      const pullTarget = { project: { owner: 'acme', name: 'app' }, number: 7 };
      const discussionTarget = { project: { owner: 'acme', name: 'app' }, number: 5 };
      const issueNode = { number: 5, node_id: 'I_five' };
      const discussionNode = (overrides = {}) => ({
        id: 'D_five', number: 5, closed: false, viewerSubscription: 'UNSUBSCRIBED', labels: { nodes: [] }, ...overrides,
      });
      const graphqlWrites = (requests) => requests.filter((entry) => /^mutation/.test(String(entry.body?.query ?? '').trim()));

      const writeResponse = (entry) => {
        if (entry.path === '/repos/acme/app/issues/5') return jsonResponse(issueNode);
        if (entry.path === '/repos/acme/app/pulls/7') return jsonResponse(pullRequest());
        return jsonResponse({ data: { updateSubscription: { clientMutationId: null } } });
      };

      it('follows and unfollows an issue through updateSubscription, and replays without a second write', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const requests = recordRequests(writeResponse);
        const { app, store } = makeApp();
        const payload = { ...context(account.accountId, { target: issueTarget }), subscribed: true };

        const followed = await request(app).post('/api/source-control/github/issues/subscription').send(payload).expect(200);
        const replayed = await request(app).post('/api/source-control/github/issues/subscription').send(payload).expect(200);
        const unfollowed = await request(app).post('/api/source-control/github/issues/subscription')
          .send({ ...context(account.accountId, { target: issueTarget, idempotencyKey: 'request-two' }), subscribed: false }).expect(200);

        expect(followed.body.result).toEqual({});
        expect(unfollowed.body.result).toEqual({});
        expect(replayed.body.replayed).toBe(true);
        expect(graphqlWrites(requests).map((entry) => entry.body.variables)).toEqual([
          { subscribableId: 'I_five', state: 'SUBSCRIBED' },
          { subscribableId: 'I_five', state: 'UNSUBSCRIBED' },
        ]);
        expect(graphqlWrites(requests)[0].body.query).toContain('updateSubscription(input: { subscribableId: $subscribableId, state: $state })');
        expect(store.records.get('request-one')).toMatchObject({ kind: 'issue-subscription', state: 'succeeded', result: {}, target: { number: 5 } });
        expect(store.records.get('request-two')).toMatchObject({ kind: 'issue-subscription', state: 'succeeded', result: {} });
      });

      it('follows and unfollows a pull request through the same mutation, and replays without a second write', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const requests = recordRequests(writeResponse);
        const { app, store } = makeApp();
        const payload = { ...context(account.accountId, { target: pullTarget }), subscribed: true };

        const followed = await request(app).post('/api/source-control/github/pr/subscription').send(payload).expect(200);
        const replayed = await request(app).post('/api/source-control/github/pr/subscription').send(payload).expect(200);
        const unfollowed = await request(app).post('/api/source-control/github/pr/subscription')
          .send({ ...context(account.accountId, { target: pullTarget, idempotencyKey: 'request-two' }), subscribed: false }).expect(200);

        expect(followed.body.result).toEqual({});
        expect(unfollowed.body.result).toEqual({});
        expect(replayed.body.replayed).toBe(true);
        expect(graphqlWrites(requests).map((entry) => entry.body.variables)).toEqual([
          { subscribableId: 'PR_node', state: 'SUBSCRIBED' },
          { subscribableId: 'PR_node', state: 'UNSUBSCRIBED' },
        ]);
        expect(store.records.get('request-one')).toMatchObject({ kind: 'change-request-subscription', state: 'succeeded', result: {}, target: { number: 7 } });
        expect(store.records.get('request-two')).toMatchObject({ kind: 'change-request-subscription', state: 'succeeded', result: {} });
      });

      it('follows and unfollows a discussion through updateSubscription, and replays without a second write', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const requests = recordRequests((entry) => {
          const { query } = entry.body ?? {};
          if (/^mutation/.test(String(query).trim())) return jsonResponse({ data: { updateSubscription: { clientMutationId: null } } });
          return jsonResponse({ data: { repository: { discussion: discussionNode() } } });
        });
        const { app, store } = makeApp();
        const payload = { ...context(account.accountId, { target: discussionTarget }), subscribed: true };

        const followed = await request(app).post('/api/source-control/github/discussions/subscription').send(payload).expect(200);
        const replayed = await request(app).post('/api/source-control/github/discussions/subscription').send(payload).expect(200);
        const unfollowed = await request(app).post('/api/source-control/github/discussions/subscription')
          .send({ ...context(account.accountId, { target: discussionTarget, idempotencyKey: 'request-two' }), subscribed: false }).expect(200);

        expect(followed.body.result).toEqual({});
        expect(unfollowed.body.result).toEqual({});
        expect(replayed.body.replayed).toBe(true);
        expect(graphqlWrites(requests).map((entry) => entry.body.variables)).toEqual([
          { subscribableId: 'D_five', state: 'SUBSCRIBED' },
          { subscribableId: 'D_five', state: 'UNSUBSCRIBED' },
        ]);
        expect(store.records.get('request-one')).toMatchObject({ kind: 'discussion-subscription', state: 'succeeded', result: {}, target: { number: 5 } });
        expect(store.records.get('request-two')).toMatchObject({ kind: 'discussion-subscription', state: 'succeeded', result: {} });
      });

      it('refuses a discussion number that names another discussion, and writes nothing', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const requests = recordRequests(() => jsonResponse({ data: { repository: { discussion: discussionNode({ number: 6 }) } } }));
        const { app } = makeApp();

        const response = await request(app).post('/api/source-control/github/discussions/subscription')
          .send({ ...context(account.accountId, { target: discussionTarget }), subscribed: true }).expect(409);

        expect(response.body.code).toBe('SOURCE_CONTROL_MUTATION_TARGET_INVALID');
        expect(graphqlWrites(requests)).toEqual([]);
      });

      it.each([
        ['/issues/subscription', issueTarget],
        ['/pr/subscription', pullTarget],
        ['/discussions/subscription', discussionTarget],
      ])('refuses a non-boolean subscribed on %s without a provider call', async (route, targetRef) => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const requests = recordRequests(() => jsonResponse({}));
        const { app } = makeApp();

        const response = await request(app).post(`/api/source-control/github${route}`)
          .send({ ...context(account.accountId, { target: targetRef }), subscribed: 'yes' }).expect(400);

        expect(response.body).toEqual({ error: 'subscribed is invalid', code: 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT' });
        expect(requests).toEqual([]);
      });

      it.each([
        ['issue-subscription', 'issue-subscription', '/issues/subscription', issueTarget, 5, 'SUBSCRIBED', 'succeeded', 200],
        ['issue-subscription', 'issue-subscription', '/issues/subscription', issueTarget, 5, 'UNSUBSCRIBED', 'outcome-unknown', 409],
        ['subscription', 'change-request-subscription', '/pr/subscription', pullTarget, 7, 'SUBSCRIBED', 'succeeded', 200],
        ['subscription', 'change-request-subscription', '/pr/subscription', pullTarget, 7, 'UNSUBSCRIBED', 'outcome-unknown', 409],
        ['discussion-subscription', 'discussion-subscription', '/discussions/subscription', discussionTarget, 5, 'SUBSCRIBED', 'succeeded', 200],
        ['discussion-subscription', 'discussion-subscription', '/discussions/subscription', discussionTarget, 5, 'UNSUBSCRIBED', 'outcome-unknown', 409],
      ])('reconciles an interrupted %s from a single read that answers %s', async (digestKind, recordKind, route, targetRef, number, viewerSubscription, outcome, status) => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const target = {
          repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
          project: { id: 'acme/app', owner: 'acme', name: 'app' }, number,
        };
        const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
        const input = { kind: digestKind, actor, credential: credentialFor(account), target, subscribed: true };
        const store = makeStore([{ key: 'request-one', inputDigest: digestMutationInput(input), kind: recordKind, actor, target, state: 'running' }]);
        const fetch = vi.fn(async (_url, options) => {
          const { query } = JSON.parse(options.body);
          return query.includes('discussion(number:')
            ? jsonResponse({ data: { repository: { discussion: discussionNode({ viewerSubscription }) } } })
            : jsonResponse({ data: { repository: { issueOrPullRequest: { viewerSubscription } } } });
        });
        vi.stubGlobal('fetch', fetch);
        const { app } = makeApp({ store });

        await request(app).post(`/api/source-control/github${route}`)
          .send({ ...context(account.accountId, { target: targetRef }), subscribed: true }).expect(status);

        expect(store.records.get('request-one').state).toBe(outcome);
        expect(fetch).toHaveBeenCalledOnce();
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

    describe('editing titles and bodies', () => {
      const issueTarget = { project: { owner: 'acme', name: 'app' }, number: 5 };
      const discussionTarget = { project: { owner: 'acme', name: 'app' }, number: 5 };
      const discussion = (overrides = {}) => ({
        id: 'D_five', number: 5, title: 'Old title', body: 'Old body', closed: false, labels: { nodes: [] }, ...overrides,
      });
      const mutationWrites = (requests) => requests.filter((entry) => entry.method === 'PATCH' || entry.body?.query?.includes('updateDiscussion'));

      it('retitles and rewrites an issue with one REST write', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const requests = recordRequests((entry) => (
          entry.method === 'GET'
            ? jsonResponse({ number: 5, title: 'Old title', body: 'Old body' })
            : jsonResponse({ number: 5, title: 'New title', body: 'New body' })
        ));
        const { app, store } = makeApp();

        const response = await request(app).post('/api/source-control/github/issues/update')
          .send({ ...context(account.accountId, { target: issueTarget }), title: '  New title  ', body: 'New body' }).expect(200);

        expect(response.body.result).toEqual({});
        expect(mutationWrites(requests)).toEqual([
          { method: 'PATCH', path: '/repos/acme/app/issues/5', body: { title: 'New title', body: 'New body' } },
        ]);
        expect(store.records.get('request-one')).toMatchObject({ kind: 'issue-update', state: 'succeeded', result: {} });
      });

      it('retitles and rewrites a discussion through one GraphQL write', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const requests = recordRequests((entry) => {
          const { query, variables } = entry.body;
          if (query.includes('updateDiscussion')) {
            return jsonResponse({ data: { updateDiscussion: { discussion: { id: 'D_five', title: variables.title } } } });
          }
          return jsonResponse({ data: { repository: { discussion: discussion() } } });
        });
        const { app, store } = makeApp();

        const response = await request(app).post('/api/source-control/github/discussions/update')
          .send({ ...context(account.accountId, { target: discussionTarget }), title: 'New title', body: '' }).expect(200);

        expect(response.body.result).toEqual({});
        const writes = mutationWrites(requests);
        expect(writes).toHaveLength(1);
        expect(writes[0].path).toBe('/graphql');
        expect(writes[0].body.variables).toEqual({ discussionId: 'D_five', title: 'New title', body: '' });
        expect(writes[0].body.query).toContain('updateDiscussion(input: { discussionId: $discussionId, title: $title, body: $body })');
        expect(store.records.get('request-one')).toMatchObject({ kind: 'discussion-update', state: 'succeeded', result: {} });
      });

      it('refuses a pull request number on the issue route and a discussion outside the network, writing nothing', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const requests = recordRequests((entry) => (
          entry.path.endsWith('/issues/8')
            ? jsonResponse({ number: 8, title: 'A pull request', pull_request: { url: 'https://api.github.com/repos/acme/app/pulls/8' } })
            : jsonResponse({ number: 5, title: 'Old title' })
        ));
        const { app } = makeApp();

        const refusedIssue = await request(app).post('/api/source-control/github/issues/update')
          .send({ ...context(account.accountId, { target: { project: issueTarget.project, number: 8 } }), title: 'New title' }).expect(409);
        expect(refusedIssue.body.code).toBe('SOURCE_CONTROL_MUTATION_TARGET_INVALID');
        expect(mutationWrites(requests)).toEqual([]);

        const resolveNetwork = vi.fn(async () => [{ owner: 'acme', repo: 'app', url: 'https://github.com/acme/app', source: 'origin' }]);
        const outside = recordRequests(() => jsonResponse({ data: {} }));
        const { app: outsideApp } = makeApp({ resolveNetwork });
        const refusedDiscussion = await request(outsideApp).post('/api/source-control/github/discussions/update')
          .send({ ...context(account.accountId, { target: { project: { owner: 'other', name: 'app' }, number: 5 } }), title: 'New title' }).expect(409);
        expect(refusedDiscussion.body.code).toBe('SOURCE_CONTROL_MUTATION_TARGET_INVALID');
        expect(outside).toEqual([]);
      });

      it.each(['/issues/update', '/discussions/update'])('refuses an empty title on %s without a provider call', async (route) => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const requests = recordRequests(() => jsonResponse({}));
        const { app } = makeApp();

        const response = await request(app).post(`/api/source-control/github${route}`)
          .send({ ...context(account.accountId, { target: issueTarget }), title: '   ' }).expect(400);
        expect(response.body).toEqual({ error: 'title is required', code: 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT' });
        expect(requests).toEqual([]);
      });

      it("passes GitHub's reason for a refused REST write and a refused GraphQL write", async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        recordRequests((entry) => (
          entry.method === 'GET'
            ? jsonResponse({ number: 5, title: 'Old title' })
            : jsonResponse({ message: 'Validation Failed', errors: [{ message: 'Title is too long' }] }, 422)
        ));
        const { app, store } = makeApp();

        const refused = await request(app).post('/api/source-control/github/issues/update')
          .send({ ...context(account.accountId, { target: issueTarget }), title: 'New title' }).expect(422);
        expect(refused.body).toEqual({ error: 'Title is too long', code: 'SOURCE_CONTROL_MUTATION_REJECTED' });
        expect(store.records.get('request-one')).toMatchObject({ state: 'failed', result: { failureStatus: 422 } });

        recordRequests((entry) => (
          entry.body.query.includes('updateDiscussion')
            ? jsonResponse({ errors: [{ message: 'Title is invalid' }] })
            : jsonResponse({ data: { repository: { discussion: discussion() } } })
        ));
        const { app: graphqlApp, store: graphqlStore } = makeApp();
        const refusedDiscussion = await request(graphqlApp).post('/api/source-control/github/discussions/update')
          .send({ ...context(account.accountId, { target: discussionTarget }), title: 'New title' }).expect(422);
        expect(refusedDiscussion.body).toEqual({ error: 'Title is invalid', code: 'SOURCE_CONTROL_MUTATION_REJECTED' });
        expect(graphqlStore.records.get('request-one')).toMatchObject({ state: 'failed', result: { failureStatus: 422 } });
      });

      it('leaves an edit that reads differently after a crash unknown, never not-applied', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
        const target = {
          repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
          project: { id: 'acme/app', owner: 'acme', name: 'app' }, number: 5,
        };
        const issueRequests = recordRequests(() => jsonResponse({ number: 5, title: 'Edited by a human' }));
        const store = makeStore([{
          key: 'request-one', inputDigest: digestMutationInput({ kind: 'issue-update', actor, credential: credentialFor(account), target, title: 'New title' }),
          kind: 'issue-update', actor, target, state: 'running',
        }]);
        const { app } = makeApp({ store });
        await request(app).post('/api/source-control/github/issues/update')
          .send({ ...context(account.accountId, { target: issueTarget }), title: 'New title' }).expect(409);
        expect(store.records.get('request-one').state).toBe('outcome-unknown');
        expect(mutationWrites(issueRequests)).toEqual([]);

        const discussionRequests = recordRequests((entry) => (
          entry.body?.query?.includes('updateDiscussion')
            ? jsonResponse({ data: {} })
            : jsonResponse({ data: { repository: { discussion: discussion({ body: 'Edited by a human' }) } } })
        ));
        const discussionStore = makeStore([{
          key: 'request-one', inputDigest: digestMutationInput({ kind: 'discussion-update', actor, credential: credentialFor(account), target, title: 'New title', body: 'New body' }),
          kind: 'discussion-update', actor, target, state: 'running',
        }]);
        const { app: discussionApp } = makeApp({ store: discussionStore });
        await request(discussionApp).post('/api/source-control/github/discussions/update')
          .send({ ...context(account.accountId, { target: discussionTarget }), title: 'New title', body: 'New body' }).expect(409);
        expect(discussionStore.records.get('request-one').state).toBe('outcome-unknown');
        expect(discussionRequests.filter((entry) => entry.body?.query?.includes('updateDiscussion'))).toEqual([]);
      });

      it('finishes an interrupted edit whose item already reads as asked, without writing again', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
        const target = {
          repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
          project: { id: 'acme/app', owner: 'acme', name: 'app' }, number: 5,
        };
        const issueRequests = recordRequests(() => jsonResponse({ number: 5, title: 'New title', body: 'New body' }));
        const store = makeStore([{
          key: 'request-one', inputDigest: digestMutationInput({ kind: 'issue-update', actor, credential: credentialFor(account), target, title: 'New title', body: 'New body' }),
          kind: 'issue-update', actor, target, state: 'running',
        }]);
        const { app } = makeApp({ store });
        const issueDone = await request(app).post('/api/source-control/github/issues/update')
          .send({ ...context(account.accountId, { target: issueTarget }), title: 'New title', body: 'New body' }).expect(200);
        expect(issueDone.body.result).toEqual({});
        expect(store.records.get('request-one').state).toBe('succeeded');
        expect(mutationWrites(issueRequests)).toEqual([]);

        const discussionRequests = recordRequests((entry) => (
          entry.body?.query?.includes('updateDiscussion')
            ? jsonResponse({ data: {} })
            : jsonResponse({ data: { repository: { discussion: discussion({ title: 'New title', body: 'New body' }) } } })
        ));
        const discussionStore = makeStore([{
          key: 'request-one', inputDigest: digestMutationInput({ kind: 'discussion-update', actor, credential: credentialFor(account), target, title: 'New title', body: 'New body' }),
          kind: 'discussion-update', actor, target, state: 'running',
        }]);
        const { app: discussionApp } = makeApp({ store: discussionStore });
        const discussionDone = await request(discussionApp).post('/api/source-control/github/discussions/update')
          .send({ ...context(account.accountId, { target: discussionTarget }), title: 'New title', body: 'New body' }).expect(200);
        expect(discussionDone.body.result).toEqual({});
        expect(discussionStore.records.get('request-one').state).toBe('succeeded');
        expect(discussionRequests.filter((entry) => entry.body?.query?.includes('updateDiscussion'))).toEqual([]);
      });

      it('replays a repeated key without a second provider write', async () => {
        const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
        const requests = recordRequests((entry) => {
          if (entry.body?.query?.includes('updateDiscussion')) {
            return jsonResponse({ data: { updateDiscussion: { discussion: { id: 'D_five', title: 'New title' } } } });
          }
          if (entry.body?.query) return jsonResponse({ data: { repository: { discussion: discussion() } } });
          return entry.method === 'GET'
            ? jsonResponse({ number: 5, title: 'Old title' })
            : jsonResponse({ number: 5, title: 'New title' });
        });
        const { app } = makeApp();

        const issuePayload = { ...context(account.accountId, { target: issueTarget }), title: 'New title' };
        await request(app).post('/api/source-control/github/issues/update').send(issuePayload).expect(200);
        const issueReplay = await request(app).post('/api/source-control/github/issues/update').send(issuePayload).expect(200);
        expect(issueReplay.body.replayed).toBe(true);

        const discussionPayload = { ...context(account.accountId, { target: discussionTarget, idempotencyKey: 'request-two' }), title: 'New title' };
        await request(app).post('/api/source-control/github/discussions/update').send(discussionPayload).expect(200);
        const discussionReplay = await request(app).post('/api/source-control/github/discussions/update').send(discussionPayload).expect(200);
        expect(discussionReplay.body.replayed).toBe(true);

        expect(requests.filter((entry) => entry.method === 'PATCH')).toHaveLength(1);
        expect(requests.filter((entry) => entry.body?.query?.includes('updateDiscussion'))).toHaveLength(1);
      });
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

    it('closes an issue with a reason, and refuses one on a reopen or a pull request', async () => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      const requests = recordRequests((entry) => (
        entry.method === 'GET'
          ? jsonResponse({ number: 5, state: 'open' })
          : jsonResponse({ number: 5, state: 'closed' })
      ));
      const { app, store } = makeApp();
      const issueTarget = { project: pullTarget.project, number: 5 };

      const closed = await request(app).post('/api/source-control/github/issues/state')
        .send({ ...context(account.accountId, { target: issueTarget }), state: 'closed', reason: 'not_planned' }).expect(200);
      expect(closed.body.result).toEqual({ state: 'closed' });
      expect(requests.filter((entry) => entry.method === 'PATCH')).toEqual([
        { method: 'PATCH', path: '/repos/acme/app/issues/5', body: { state: 'closed', state_reason: 'not_planned' } },
      ]);
      expect(store.records.get('request-one')).toMatchObject({ kind: 'issue-state', state: 'succeeded' });

      // A reason is only ever sent while closing an issue.
      await request(app).post('/api/source-control/github/issues/state')
        .send({ ...context(account.accountId, { target: issueTarget, idempotencyKey: 'request-two' }), state: 'open', reason: 'completed' }).expect(400);
      await request(app).post('/api/source-control/github/issues/state')
        .send({ ...context(account.accountId, { target: issueTarget, idempotencyKey: 'request-three' }), state: 'closed', reason: 'duplicate' }).expect(400);
      await request(app).post('/api/source-control/github/pr/state')
        .send({ ...context(account.accountId, { target: pullTarget, idempotencyKey: 'request-four' }), state: 'closed', reason: 'completed' }).expect(400);
      expect(requests.filter((entry) => entry.method === 'PATCH')).toHaveLength(1);
    });

    it.each([
      ['completed', 'succeeded', 200],
      ['not_planned', 'outcome-unknown', 409],
    ])('reconciles a close whose reason reads back as %s', async (stateReason, outcome, status) => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      const target = {
        repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
        project: { id: 'acme/app', owner: 'acme', name: 'app' }, number: 5,
      };
      const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
      const input = { kind: 'issue-state', actor, credential: credentialFor(account), target, state: 'closed', reason: 'completed' };
      const store = makeStore([{ key: 'request-one', inputDigest: digestMutationInput(input), kind: 'issue-state', actor, target, state: 'running' }]);
      const fetch = vi.fn(async () => jsonResponse({ number: 5, state: 'closed', state_reason: stateReason }));
      vi.stubGlobal('fetch', fetch);
      const { app } = makeApp({ store });

      await request(app).post('/api/source-control/github/issues/state')
        .send({ ...context(account.accountId, { target: { project: pullTarget.project, number: 5 } }), state: 'closed', reason: 'completed' })
        .expect(status);

      expect(store.records.get('request-one').state).toBe(outcome);
      expect(fetch).toHaveBeenCalledOnce();
    });

    it('sets the assignees of an issue as one sorted set and refuses a pull request number', async () => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      const requests = recordRequests((entry) => {
        // Number 7 is a pull request, which GitHub lists among issues.
        if (entry.path === '/repos/acme/app/issues/7') return jsonResponse({ number: 7, pull_request: {} });
        if (entry.method === 'GET') return jsonResponse({ number: 5, state: 'open' });
        return jsonResponse({ number: 5, assignees: [{ login: 'carol' }, { login: 'bob' }] });
      });
      const { app, store } = makeApp();
      const issueTarget = { project: pullTarget.project, number: 5 };

      const saved = await request(app).post('/api/source-control/github/issues/assignees')
        .send({ ...context(account.accountId, { target: issueTarget }), assignees: ['bob', 'carol', 'bob'] }).expect(200);
      expect(saved.body.result).toEqual({});
      expect(requests.filter((entry) => entry.method === 'PATCH')).toEqual([
        { method: 'PATCH', path: '/repos/acme/app/issues/5', body: { assignees: ['bob', 'carol'] } },
      ]);
      expect(store.records.get('request-one')).toMatchObject({ kind: 'issue-assignees', state: 'succeeded' });

      // GitHub lists pull requests among issues; this write is for issues only.
      const pull = await request(app).post('/api/source-control/github/issues/assignees')
        .send({ ...context(account.accountId, { target: pullTarget, idempotencyKey: 'request-two' }), assignees: ['bob'] })
        .expect(409);
      expect(pull.body.code).toBe('SOURCE_CONTROL_MUTATION_TARGET_INVALID');
      expect(requests.filter((entry) => entry.method === 'PATCH')).toHaveLength(1);
    });

    it.each([
      [['bob'], 'succeeded', 200],
      [['bob', 'carol'], 'outcome-unknown', 409],
    ])('reconciles an interrupted assignee change from the issue (%j)', async (current, outcome, status) => {
      const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
      const target = {
        repositoryId: 'repo-one', bindingRevision: 3, primaryRemote: 'origin',
        project: { id: 'acme/app', owner: 'acme', name: 'app' }, number: 5,
      };
      const actor = { provider: 'github', instance: 'github.com', accountId: account.accountId };
      const input = { kind: 'issue-assignees', actor, credential: credentialFor(account), target, assignees: ['bob'] };
      const store = makeStore([{ key: 'request-one', inputDigest: digestMutationInput(input), kind: 'issue-assignees', actor, target, state: 'running' }]);
      const fetch = vi.fn(async () => jsonResponse({ number: 5, assignees: current.map((login) => ({ login })) }));
      vi.stubGlobal('fetch', fetch);
      const { app } = makeApp({ store });

      await request(app).post('/api/source-control/github/issues/assignees')
        .send({ ...context(account.accountId, { target: { project: pullTarget.project, number: 5 } }), assignees: ['bob'] })
        .expect(status);

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
