import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMutationExecutor, digestMutationInput } from '../source-control/mutation-executor.js';

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

const makeApp = ({ store = makeStore(), validateMutationContext, resolveRepo, resolveNetwork, resolveStatus } = {}) => {
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
  auth = await import('./auth.js');
  ({ registerGitHubRoutes } = await import('./routes.js'));
});

afterEach(async () => {
  if (previousDataDirectory === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = previousDataDirectory;
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
    expect(canonical.body.code).toBe('SOURCE_CONTROL_MUTATION_UNAVAILABLE');
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
        project: { id: 'acme/app', owner: 'acme', name: 'app' }, head: 'feature', base: 'main',
      },
      replayed: false,
      result: {},
    });
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

    const [owner, duplicate] = await Promise.all([
      request(app).post('/api/source-control/github/pr/create').send(payload),
      request(app).post('/api/source-control/github/pr/create').send(payload),
    ]);
    expect([owner.body.replayed, duplicate.body.replayed].sort()).toEqual([false, true]);
    expect(fetch).toHaveBeenCalledOnce();

    const replay = await request(app).post('/api/source-control/github/pr/create').send(payload).expect(200);
    expect(replay.body.replayed).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();

    const conflict = await request(app).post('/api/source-control/github/pr/create')
      .send({ ...payload, title: 'Changed' }).expect(409);
    expect(conflict.body.code).toBe('SOURCE_CONTROL_MUTATION_CONFLICT');
    expect(fetch).toHaveBeenCalledOnce();
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
    await auth.removeGitHubAuthAccount(account.accountId);
    const { app } = makeApp({ store });

    await request(app).post('/api/source-control/github/pr/create')
      .send({ ...context(account.accountId), title: 'Title' }).expect(401);
    expect(read).not.toHaveBeenCalled();
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

  it('binds merge to the exact head SHA validated before dispatch', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      requests.push({ method: options.method, body: options.body ? JSON.parse(options.body) : null });
      return options.method === 'GET'
        ? jsonResponse(pullRequest())
        : jsonResponse({ merged: true, message: 'Pull Request successfully merged' });
    }));
    const { app } = makeApp();

    const response = await request(app).post('/api/source-control/github/pr/merge').send({
      ...context(account.accountId, {
        target: {
          project: { owner: 'acme', name: 'app' }, number: 7,
          head: 'feature', base: 'main', headSha: 'abc123',
        },
      }),
      method: 'merge',
    }).expect(200);

    expect(response.body.result).toEqual({ merged: true });
    expect(requests).toEqual([
      { method: 'GET', body: null },
      { method: 'PUT', body: { merge_method: 'merge', sha: 'abc123' } },
    ]);
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
  });

  it('does not retry or invalidate after a definite provider rejection', async () => {
    const account = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const fetch = vi.fn(async () => jsonResponse({ message: 'rejected private payload' }, 422));
    vi.stubGlobal('fetch', fetch);
    const { app, store } = makeApp();
    const now = vi.spyOn(Date, 'now');
    const statusQuery = {
      directory: '/repo', branch: 'feature', repositoryId: 'repo-one', bindingRevision: 3,
      accountId: account.accountId, primaryRemote: 'origin', instance: 'github.com',
    };
    now.mockReturnValue(1_000);
    expect((await request(app).get('/api/source-control/github/pr/status').query(statusQuery)).body.fetchedAt).toBe(1_000);

    now.mockReturnValue(2_000);
    const response = await request(app).post('/api/source-control/github/pr/create')
      .send({ ...context(account.accountId), title: 'private title' }).expect(422);
    expect(response.body).toEqual({ error: 'GitHub mutation failed', code: 'GITHUB_MUTATION_REJECTED' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(store.records.get('request-one')).toMatchObject({ state: 'failed', result: { failureStatus: 422, failureCode: 'GITHUB_MUTATION_REJECTED' } });
    now.mockReturnValue(3_000);
    expect((await request(app).get('/api/source-control/github/pr/status').query(statusQuery)).body.fetchedAt).toBe(1_000);
  });

  it('invalidates canonical status only for the successful mutation authority', async () => {
    const acting = await auth.setGitHubAuth({ accessToken: 'token-one', user: { id: 1, login: 'actor' } });
    const unrelated = await auth.setGitHubAuth({ accessToken: 'token-two', user: { id: 2, login: 'other' } });
    const fetch = vi.fn(async () => jsonResponse(pullRequest()));
    vi.stubGlobal('fetch', fetch);
    const { app } = makeApp();
    const now = vi.spyOn(Date, 'now');
    const statusQuery = (accountId, directory = '/repo', repositoryId = 'repo-one') => ({
      directory, branch: 'feature', repositoryId, bindingRevision: 3,
      accountId, primaryRemote: 'origin', instance: 'github.com',
    });

    now.mockReturnValue(1_000);
    expect((await request(app).get('/api/source-control/github/pr/status').query(statusQuery(acting.accountId))).body.fetchedAt).toBe(1_000);
    now.mockReturnValue(2_000);
    expect((await request(app).get('/api/source-control/github/pr/status').query(statusQuery(unrelated.accountId))).body.fetchedAt).toBe(2_000);
    now.mockReturnValue(2_100);
    expect((await request(app).get('/api/source-control/github/pr/status').query(statusQuery(acting.accountId, '/worktree'))).body.fetchedAt).toBe(2_100);
    now.mockReturnValue(2_200);
    expect((await request(app).get('/api/source-control/github/pr/status').query(statusQuery(acting.accountId, '/other', 'repo-two'))).body.fetchedAt).toBe(2_200);

    now.mockReturnValue(3_000);
    await request(app).post('/api/source-control/github/pr/create')
      .send({ ...context(acting.accountId), title: 'Title' }).expect(200);

    now.mockReturnValue(4_000);
    expect((await request(app).get('/api/source-control/github/pr/status').query(statusQuery(acting.accountId))).body.fetchedAt).toBe(4_000);
    now.mockReturnValue(5_000);
    expect((await request(app).get('/api/source-control/github/pr/status').query(statusQuery(unrelated.accountId))).body.fetchedAt).toBe(2_000);
    now.mockReturnValue(6_000);
    expect((await request(app).get('/api/source-control/github/pr/status').query(statusQuery(acting.accountId, '/worktree'))).body.fetchedAt).toBe(6_000);
    now.mockReturnValue(7_000);
    expect((await request(app).get('/api/source-control/github/pr/status').query(statusQuery(acting.accountId, '/other', 'repo-two'))).body.fetchedAt).toBe(2_200);
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

    await request(app).get('/api/source-control/github/pulls/context').query(query('/repo')).expect(200);
    await request(app).get('/api/source-control/github/pulls/context').query(query('/worktree')).expect(200);
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
